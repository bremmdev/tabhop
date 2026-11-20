import { createCanvas } from '@napi-rs/canvas';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildTimeline, makeGeometry } from './layout.ts';
import type { Song } from './model.ts';
import { Renderer, type NoteShape } from './render/renderer.ts';

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

  const ff = spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${opts.width}x${opts.height}`, '-r', String(opts.fps), '-i', '-',
      ...encoderArgs(opts.encoder, opts.crf),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      outPath,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
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
 * Renders the whole video, then adds the backing track if the song has one.
 */
export async function renderVideo(
  song: Song,
  opts: VideoOptions,
  outPath: string,
  workers: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (!song.audio) return renderSilentVideo(song, opts, outPath, workers, onProgress);
  if (!existsSync(song.audio.path)) throw new Error(`Audio file not found: ${song.audio.path}`);
  const silent = `${outPath}.video.mp4`;
  try {
    await renderSilentVideo(song, opts, silent, workers, onProgress);
    await muxAudio(song, opts, silent, outPath);
  } finally {
    rmSync(silent, { force: true });
  }
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
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
  const progress = new Array<number>(chunks).fill(0);
  const jobs: Promise<void>[] = [];
  for (let k = 0; k < chunks; k++) {
    const from = Math.floor((total * k) / chunks);
    const to = Math.floor((total * (k + 1)) / chunks);
    const part = `${outPath}.part${k}.mp4`;
    parts.push(part);
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { song, opts, from, to, out: part },
    });
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
    const list = `${outPath}.parts.txt`;
    writeFileSync(list, parts.map((p) => `file '${resolvePath(p).replace(/'/g, String.raw`'\''`)}'`).join('\n'));
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d));
    const [code] = await once(ff, 'close');
    rmSync(list, { force: true });
    if (code !== 0) throw new Error(`Joining video parts failed:\n${stderr}`);
  } finally {
    for (const p of parts) rmSync(p, { force: true });
  }
}
