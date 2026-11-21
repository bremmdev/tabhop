import { createCanvas } from '@napi-rs/canvas';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Worker } from 'node:worker_threads';
import { CLICK_SAMPLE_RATE, clickTimes, clickTrack } from './click.ts';
import { tabTrack } from './synth.ts';
import { buildTimeline, makeGeometry } from './layout.ts';
import type { Song } from './model.ts';
import { Renderer, type NoteShape } from './render/renderer.ts';

export const SOUNDS = ['tab', 'click', 'none'] as const;
export type Sound = (typeof SOUNDS)[number];

export interface VideoOptions {
  speed: number; // 1 = 100%
  fps: number;
  width: number;
  height: number;
  zoom: number;
  countInBars: number;
  crf: number;
  encoder: string; // e.g. libx264, h264_nvenc
  noteShape?: NoteShape;
  /** What to play when there's no backing track: the tab on a synth, a metronome click, or nothing (the default). */
  sound?: Sound;
}

/**
 * What the renders in progress have open, so an interrupted render (Ctrl-C) can
 * stop and clean up after itself: see `stopRenders`.
 */
const running = {
  files: new Set<string>(),
  workers: new Set<Worker>(),
  ffmpeg: new Set<ChildProcess>(),
};

/** Registers a file the render writes and removes again; returns the path. */
function tempFile(path: string): string {
  running.files.add(path);
  return path;
}

function removeTemp(path: string): void {
  rmSync(path, { force: true });
  running.files.delete(path);
}

/** Registers an ffmpeg process; returns it. */
function tracked<T extends ChildProcess>(child: T): T {
  running.ffmpeg.add(child);
  child.on('close', () => running.ffmpeg.delete(child));
  return child;
}

/**
 * Stops the renders in progress and deletes their unfinished files. A video that
 * was already there is left alone: renders only replace it once they've finished.
 * Returns the files that couldn't be deleted.
 */
export async function stopRenders(): Promise<string[]> {
  // A terminated worker closes its ffmpeg's input, so that ffmpeg finishes and exits too.
  await Promise.all([...running.workers].map((w) => w.terminate()));
  const children = [...running.ffmpeg].filter((c) => c.exitCode === null && c.signalCode === null);
  for (const c of children) c.kill();
  await Promise.all(children.map((c) => once(c, 'close')));
  const left: string[] = [];
  for (const path of running.files) {
    // Windows keeps a file locked until the process writing it has gone, which can take a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(path, { force: true });
        break;
      } catch {
        if (attempt === 50) {
          left.push(path);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
  running.files.clear();
  return left;
}

export function prepare(song: Song, opts: VideoOptions) {
  const g = makeGeometry(opts.width, opts.height, song.tuning.length, opts.zoom);
  const tl = buildTimeline(song, g, opts.countInBars);
  const videoDuration = (tl.end - tl.start) / opts.speed;
  const renderer = new Renderer(song, g, tl, { speed: opts.speed, videoDuration, noteShape: opts.noteShape });
  return { g, tl, renderer, videoDuration };
}

export async function renderPng(song: Song, opts: VideoOptions, songTime: number): Promise<Buffer> {
  const { renderer, tl } = prepare(song, opts);
  const canvas = createCanvas(opts.width, opts.height);
  const ctx = canvas.getContext('2d');
  renderer.draw(ctx, songTime, (songTime - tl.start) / opts.speed);
  return canvas.encode('png');
}

function encoderArgs(encoder: string, crf: number): string[] {
  if (encoder === 'libx264') return ['-c:v', 'libx264', '-preset', 'faster', '-crf', String(crf), '-tune', 'animation'];
  if (encoder.endsWith('_nvenc')) return ['-c:v', encoder, '-preset', 'p5', '-cq', String(crf + 1), '-b:v', '0'];
  if (encoder.endsWith('_qsv')) return ['-c:v', encoder, '-global_quality', String(crf + 2)];
  if (encoder.endsWith('_amf')) return ['-c:v', encoder, '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf + 2)];
  return ['-c:v', encoder];
}

/** Renders frames [from, to) of the video into a single file. */
export async function renderFrames(
  song: Song,
  opts: VideoOptions,
  from: number,
  to: number,
  outPath: string,
  onProgress?: (framesDone: number) => void,
): Promise<void> {
  const { renderer, tl } = prepare(song, opts);
  const canvas = createCanvas(opts.width, opts.height);
  const ctx = canvas.getContext('2d');

  const ff = tracked(
    spawn(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${opts.width}x${opts.height}`, '-r', String(opts.fps), '-i', '-',
        ...encoderArgs(opts.encoder, opts.crf),
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        outPath,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    ),
  );
  let stderr = '';
  ff.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise<number>((resolve, reject) => {
    ff.on('error', (e) => reject(new Error(`Could not start ffmpeg (is it on PATH?): ${e.message}`)));
    ff.on('close', (code) => resolve(code ?? 1));
  });
  const failedEarly = exited.then((code) => {
    throw new Error(`ffmpeg exited early (code ${code}):\n${stderr}`);
  });
  failedEarly.catch(() => {});

  for (let i = from; i < to; i++) {
    const videoTime = i / opts.fps;
    renderer.draw(ctx, tl.start + videoTime * opts.speed, videoTime);
    if (!ff.stdin.write(canvas.data())) await Promise.race([once(ff.stdin, 'drain'), failedEarly]);
    onProgress?.(i + 1 - from);
  }
  ff.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg failed (code ${code}):\n${stderr}`);
}

/**
 * Renders the whole video, then adds the backing track if the song has one,
 * or else the generated sound `opts.sound` asks for.
 * It's made under a temporary name and only replaces `outPath` once finished,
 * so an interrupted render never leaves a broken video (or deletes a good one).
 */
export async function renderVideo(
  song: Song,
  opts: VideoOptions,
  outPath: string,
  workers: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (song.audio && !existsSync(song.audio.path)) throw new Error(`Audio file not found: ${song.audio.path}`);
  const partial = tempFile(`${outPath}.partial.mp4`);
  try {
    if (!song.audio && (opts.sound ?? 'none') === 'none') await renderSilentVideo(song, opts, partial, workers, onProgress);
    else {
      const silent = tempFile(`${outPath}.video.mp4`);
      try {
        await renderSilentVideo(song, opts, silent, workers, onProgress);
        await (song.audio ? muxAudio : muxSynth)(song, opts, silent, partial);
      } finally {
        removeTemp(silent);
      }
    }
    try {
      renameSync(partial, outPath);
    } catch (e) {
      throw new Error(`Could not replace ${outPath} (is it open in a video player?): ${(e as Error).message}`);
    }
  } finally {
    removeTemp(partial);
  }
}

/** Adds the tab played on a synth (synth.ts) or a metronome click (click.ts), generated to fit the video exactly. */
async function muxSynth(song: Song, opts: VideoOptions, videoPath: string, outPath: string): Promise<void> {
  const { tl, videoDuration } = prepare(song, opts);
  const samples =
    opts.sound === 'click' ? clickTrack(clickTimes(song, tl, opts.speed), videoDuration) : tabTrack(song, tl, opts.speed);
  const ff = tracked(
    spawn(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', videoPath,
        '-f', 'f32le', '-ar', String(CLICK_SAMPLE_RATE), '-ac', '1', '-i', '-',
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-t', videoDuration.toFixed(3),
        '-movflags', '+faststart',
        outPath,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    ),
  );
  let stderr = '';
  ff.stderr.on('data', (d) => (stderr += d));
  // If ffmpeg fails before reading it all, the write fails too; the exit code says why.
  ff.stdin.on('error', () => {});
  ff.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  const [code] = await once(ff, 'close');
  if (code !== 0) throw new Error(`Adding the ${opts.sound === 'click' ? 'click track' : 'synth track'} failed:\n${stderr}`);
}

/** atempo only accepts 0.5–2.0 per instance, so chain it for larger changes. */
function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${s.toFixed(6)}`);
  return out;
}

/**
 * Adds the backing track. Song time t plays audio position `audio.start + t`;
 * slowed-down videos time-stretch the audio (pitch is preserved).
 */
async function muxAudio(song: Song, opts: VideoOptions, videoPath: string, outPath: string): Promise<void> {
  const { tl, videoDuration } = prepare(song, opts);
  const audio = song.audio!;
  const from = audio.start + tl.start; // audio position at the first video frame
  const filters = [
    ...(from < 0 ? [`adelay=${Math.round(-from * 1000)}:all=1`] : []),
    ...atempoChain(opts.speed),
    `apad`,
    `atrim=0:${videoDuration.toFixed(3)}`,
    `afade=t=in:st=0:d=0.4`,
    `afade=t=out:st=${Math.max(0, videoDuration - 0.8).toFixed(3)}:d=0.8`,
  ];
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    ...(from > 0 ? ['-ss', from.toFixed(3)] : []),
    '-i', audio.path,
    '-filter_complex', `[1:a]${filters.join(',')}[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-t', videoDuration.toFixed(3),
    '-movflags', '+faststart',
    outPath,
  ];
  const ff = tracked(spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }));
  let stderr = '';
  ff.stderr.on('data', (d) => (stderr += d));
  const [code] = await once(ff, 'close');
  if (code !== 0) throw new Error(`Adding audio failed:
${stderr}`);
}

/**
 * Renders the video frames. The frame range is split into chunks rendered by
 * worker threads in parallel, then joined without re-encoding.
 */
async function renderSilentVideo(
  song: Song,
  opts: VideoOptions,
  outPath: string,
  workers: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const { videoDuration } = prepare(song, opts);
  const total = Math.ceil(videoDuration * opts.fps);
  const chunks = Math.max(1, Math.min(workers, Math.floor(total / 120)));
  if (chunks === 1) {
    await renderFrames(song, opts, 0, total, outPath, (d) => onProgress?.(d, total));
    return;
  }

  const parts: string[] = [];
  const pool: Worker[] = [];
  const progress = new Array<number>(chunks).fill(0);
  const jobs: Promise<void>[] = [];
  for (let k = 0; k < chunks; k++) {
    const from = Math.floor((total * k) / chunks);
    const to = Math.floor((total * (k + 1)) / chunks);
    const part = tempFile(`${outPath}.part${k}.mp4`);
    parts.push(part);
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { song, opts, from, to, out: part },
    });
    pool.push(worker);
    running.workers.add(worker);
    worker.on('exit', () => running.workers.delete(worker));
    jobs.push(
      new Promise<void>((resolve, reject) => {
        worker.on('message', (m: { done?: number; finished?: boolean }) => {
          if (m.done !== undefined) {
            progress[k] = m.done;
            onProgress?.(progress.reduce((a, b) => a + b, 0), total);
          }
          if (m.finished) resolve();
        });
        worker.on('error', reject);
        worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Render worker ${k} exited with code ${code}`))));
      }),
    );
  }
  try {
    await Promise.all(jobs);
    const list = tempFile(`${outPath}.parts.txt`);
    writeFileSync(list, parts.map((p) => `file '${resolvePath(p).replace(/'/g, String.raw`'\''`)}'`).join('\n'));
    const ff = tracked(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outPath], { stdio: ['ignore', 'ignore', 'pipe'] }));
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d));
    const [code] = await once(ff, 'close');
    removeTemp(list);
    if (code !== 0) throw new Error(`Joining video parts failed:\n${stderr}`);
  } finally {
    // If one worker failed, stop the others rather than let them write parts that are about to be deleted.
    await Promise.all(pool.map((w) => w.terminate()));
    for (const p of parts) removeTemp(p);
  }
}
