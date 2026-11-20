#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { availableParallelism } from 'node:os';
import { parseCliArgs } from './args.ts';
import { describeLeadIn, leadIn, loadSong, sliceBars } from './load.ts';
import { parseTime } from './parsers/asciiTab.ts';
import { noteName, tuningLabel, type Song } from './model.ts';
import { parseSyncPoints, syncToAudio, type SyncPoint, type SyncSegment } from './sync.ts';
import { syncCommand } from './syncCommand.ts';
import { clock, parseSyncFile, samePath, syncFilePath } from './syncFile.ts';
import { NOTE_SHAPES, type NoteShape } from './render/renderer.ts';
import { renderPng, renderVideo, type VideoOptions } from './video.ts';

const HELP = `tabhop — turn a guitar tab into a scrolling practice video

Usage:
  tabhop render <tab-file> [options]   Render MP4 video(s)
  tabhop frame  <tab-file> --at <sec>  Render a single PNG frame (preview)
  tabhop info   <tab-file>             Show what was parsed
  tabhop sync   <tab-file> --audio <f> Find sync points for a recording from the tab's
                                       crash cymbals; saves them to <tab-file>.sync.txt

Input formats:
  .gp .gp3 .gp4 .gp5 .gpx   Guitar Pro (exact rhythm, recommended)
  .musicxml .xml .mxl       MusicXML
  .atex .alphatex .tex      alphaTex
  .txt .tab                 ASCII tab with a small header (see README.md)

Options:
  -s, --speed <list>    Playback speed(s) in percent, e.g. 100 or 100,90,80  [100]
  -o, --out <path>      Output file (single speed) or directory              [./out]
  -t, --track <n>       Track number for multi-track files (see "info")
  -b, --bars <a-b>      Only render bars a..b (1-based), e.g. 9-16
      --fps <n>         Frames per second                                    [60]
      --size <WxH>      Resolution                                           [1920x1080]
      --zoom <x>        Horizontal note spacing multiplier                   [1]
      --note-shape <s>  tile, round, hex or outline                          [tile]
      --count-in <n>    Count-in bars before the first note                  [1]
      --no-chords       Don't auto-detect chord names
      --encoder <name>  ffmpeg video encoder (libx264, h264_nvenc, ...)      [libx264]
      --crf <n>         Quality (lower = better/larger)                      [18]
      --workers <n>     Parallel render threads                              [auto]
      --audio <file>    Backing track (mp3/wav/...); slowed videos are time-stretched
      --audio-start <t> Position in the audio where bar 1 of the tab starts (s or m:ss;
                        negative if the tab starts with silence the recording lacks)
      --sync <points>   Pin bars to times in the recording, e.g. "2=0.05,110=2:42.5";
                        the tab is stretched between them to follow the band's tempo.
                        (sync) Points you already know; the rest are fitted around them
      --no-sync         Ignore the saved sync points in <tab-file>.sync.txt
      --no-audio       Ignore the audio set in the tab file
      --at <sec>        (frame) Song time in seconds to render
`;

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

let parsed: ReturnType<typeof parseCliArgs>;
try {
  parsed = parseCliArgs(process.argv.slice(2));
} catch (e) {
  fail(`${(e as Error).message}\nRun with --help for the list of options.`);
}
const { values, positionals } = parsed;

const [command, file] = positionals;
if (values.help || !command) {
  console.log(HELP);
  process.exit(0);
}
if (!file) fail(`Missing <tab-file>.\n\n${HELP}`);

const sizeMatch = /^(\d+)x(\d+)$/.exec(values.size);
if (!sizeMatch) fail('--size must look like 1920x1080');
const width = Number(sizeMatch[1]);
const height = Number(sizeMatch[2]);
if (width % 2 || height % 2) fail('--size width and height must be even numbers');

let song: Song;
let tracks: string[] | undefined;
try {
  ({ song, tracks } = loadSong(file, {
    track: values.track !== undefined ? Number(values.track) : undefined,
    autoChords: !values['no-chords'],
  }));
} catch (e) {
  fail((e as Error).message);
}

if (command === 'sync') {
  const audioPath = values['no-audio'] ? undefined : (values.audio ?? song.audio?.path);
  if (!audioPath) fail('sync needs --audio <file> (or "audio:" in the tab file)');
  if (values['audio-start'] !== undefined) fail('sync works out where the audio starts; to fix a point yourself, use --sync "bar=time"');
  if (values.bars) fail('sync always fits the whole song; use --bars when rendering');
  let pinned: SyncPoint[] | undefined;
  try {
    if (values.sync !== undefined) pinned = parseSyncPoints(values.sync);
  } catch (e) {
    fail(`--sync: ${(e as Error).message}`);
  }
  console.log(`Listening for crash cymbals in ${audioPath} ...`);
  try {
    console.log(`\n${await syncCommand(song, { tabPath: file, audioPath, pinned, out: values.out })}`);
  } catch (e) {
    fail((e as Error).message);
  }
  process.exit(0);
}

let syncPoints: SyncPoint[] | undefined;
let syncSegments: SyncSegment[] = [];
/** Where the sync points came from, if a file. */
let syncFrom: string | undefined;
let syncNote: string | undefined;
const tabBpm = song.bpm;
function applySync(points: SyncPoint[], audioPath: string, what: string) {
  try {
    syncPoints = points;
    ({ song, segments: syncSegments } = syncToAudio(song, points, audioPath));
  } catch (e) {
    fail(`${what}: ${(e as Error).message}`);
  }
}
/** Sync points saved by "tabhop sync", if they're for the recording being used. */
function savedSync(): boolean {
  const path = syncFilePath(file);
  if (values['no-sync'] || values['audio-start'] !== undefined || !existsSync(path)) return false;
  let saved: ReturnType<typeof parseSyncFile>;
  try {
    saved = parseSyncFile(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`${path}: ${(e as Error).message}\n(Fix the file, or ignore it with --no-sync.)`);
  }
  const audioPath = values.audio ?? song.audio?.path ?? saved.audio;
  if (!audioPath) return false;
  if (saved.audio && !samePath(audioPath, saved.audio)) {
    syncNote = `Not using ${path}: its sync points are for ${saved.audio}`;
    return false;
  }
  syncFrom = path;
  applySync(saved.points, audioPath, path);
  return true;
}

if (values.sync !== undefined) {
  const path = values['no-audio'] ? undefined : (values.audio ?? song.audio?.path);
  if (!path) fail('--sync needs --audio <file> (or "audio:" in the tab file)');
  if (values['audio-start'] !== undefined) fail('Use either --sync or --audio-start: a sync point already says where the audio starts');
  let points: SyncPoint[] = [];
  try {
    points = parseSyncPoints(values.sync);
  } catch (e) {
    fail(`--sync: ${(e as Error).message}`);
  }
  applySync(points, path, '--sync');
} else if (values['no-audio']) song.audio = undefined;
else if (!savedSync() && (values.audio || values['audio-start'])) {
  const path = values.audio ?? song.audio?.path;
  if (!path) fail('--audio-start needs --audio <file> (or "audio:" in the tab file)');
  let start = song.audio?.start ?? 0;
  try {
    if (values['audio-start'] !== undefined) start = parseTime(values['audio-start']);
  } catch (e) {
    fail(`--audio-start: ${(e as Error).message}`);
  }
  song.audio = { path, start };
}

// Measured on the whole song, before --bars: --audio-start always refers to bar 1 of the file.
const lead = leadIn(song);
/** A tab that starts with silence needs a negative --audio-start if the recording starts on the first note. */
function audioStartHint(): string | undefined {
  if (!lead || !song.audio || song.audio.start < 0 || syncPoints) return undefined;
  const start = Number(song.audio.start.toFixed(3));
  const suggested = Number((song.audio.start - lead.time).toFixed(3));
  return (
    `The tab starts with silence: ${describeLeadIn(lead)}. --audio-start is where bar 1 begins.\n` +
    `If ${start} s is where the first note sounds in the recording, use --audio-start=${suggested}`
  );
}
const hint = audioStartHint();

/** What the sync points do, so a typo (or a half-time tab) is easy to spot. */
function syncSummary(): string | undefined {
  if (!syncPoints) return syncNote;
  const from = syncFrom ? ` (from ${syncFrom})` : '';
  const big = (s: SyncSegment) => s.tempoFactor > 1.5 || s.tempoFactor < 0.67;
  const describe = (f: number) => `${(Math.abs(f - 1) * 100).toFixed(1)}% ${f >= 1 ? 'faster' : 'slower'}`;
  const warning = '  <- check this: a big change, or the tab is in half/double time';
  if (syncPoints.length > 6) {
    // Too many to list: the range of corrections, and any that look wrong.
    const [lo, hi] = [Math.min(...syncSegments.map((s) => s.tempoFactor)), Math.max(...syncSegments.map((s) => s.tempoFactor))];
    return [
      `Sync:     ${syncPoints.length} points, bars ${syncPoints[0].bar}-${syncPoints[syncPoints.length - 1].bar}${from}`,
      `          the recording is ${describe(lo)} to ${describe(hi)} than the tab`,
      ...syncSegments.filter(big).map((s) => `          bars ${s.fromBar}-${s.toBar}: ${describe(s.tempoFactor)}${warning}`),
    ].join('\n');
  }
  const lines = [`Sync:     ${syncPoints.map((p) => `bar ${p.bar} = ${clock(p.time)}`).join(', ')}${from}`];
  for (const s of syncSegments) {
    // Only the first section's BPM is known exactly (the tab's starting tempo).
    const bpmNote = s === syncSegments[0] ? ` (${Number(tabBpm.toFixed(1))} → ${Number((tabBpm * s.tempoFactor).toFixed(1))} BPM)` : '';
    lines.push(`          bars ${s.fromBar}-${s.toBar}: the recording is ${describe(s.tempoFactor)} than the tab${bpmNote}${big(s) ? warning : ''}`);
  }
  return lines.join('\n');
}
const sync = syncSummary();

if (values.bars) {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(values.bars);
  if (!m) fail('--bars must look like 9-16');
  try {
    song = sliceBars(song, Number(m[1]), Number(m[2]));
  } catch (e) {
    fail((e as Error).message);
  }
}

const noteShape = values['note-shape'] as NoteShape;
if (!NOTE_SHAPES.includes(noteShape)) fail(`--note-shape must be one of: ${NOTE_SHAPES.join(', ')}`);

const baseOpts: Omit<VideoOptions, 'speed'> = {
  fps: Number(values.fps),
  width,
  height,
  zoom: Number(values.zoom),
  countInBars: Number(values['count-in']),
  crf: Number(values.crf),
  encoder: values.encoder,
  noteShape,
};

function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*]+/g, '').trim();
}

if (command === 'info') {
  const dur = song.end;
  console.log(`Title:    ${song.title}`);
  console.log(`Artist:   ${song.artist || '-'}`);
  const tuningName = tuningLabel(song.tuning)?.name ?? 'Standard';
  console.log(`Tuning:   ${[...song.tuning].reverse().map(noteName).join(' ')} (low → high) — ${tuningName}`);
  console.log(`Tempo:    ${Number(song.bpm.toFixed(1))} BPM, ${song.beatsPerBar} beats per bar`);
  console.log(`Length:   ${song.bars.length} bars, ${dur.toFixed(1)}s at 100%`);
  console.log(`Notes:    ${song.notes.length}`);
  if (song.sections.length) console.log(`Sections: ${song.sections.map((s) => `${s.text} @${s.time.toFixed(1)}s`).join(', ')}`);
  if (song.chords.length) console.log(`Chords:   ${[...new Set(song.chords.map((c) => c.text))].join(' ')}`);
  if (tracks) console.log(`Tracks:\n  ${tracks.join('\n  ')}`);
  if (song.audio) console.log(`Audio:    ${song.audio.path} (bar 1 at ${song.audio.start.toFixed(3)}s)`);
  if (sync) console.log(sync);
  if (lead) console.log(`Lead-in:  ${describeLeadIn(lead)}`);
  if (hint) console.log(`\n${hint}`);
  console.log('\nFirst notes (time s, string 1=high e, fret, finger):');
  for (const n of song.notes.slice(0, 16)) {
    const extra = [n.technique, n.bend ? `bend ${n.bend}` : '', n.palmMute ? 'PM' : '', n.dead ? 'dead' : ''].filter(Boolean).join(' ');
    console.log(`  ${n.time.toFixed(3).padStart(8)}  s${n.string + 1}  fret ${String(n.fret).padStart(2)}  f${n.finger}  ${extra}`);
  }
} else if (command === 'frame') {
  if (values.at === undefined) fail('frame needs --at <seconds>');
  const out = values.out ?? join('out', `${safeName(basename(file, extname(file)))}-frame-${values.at}.png`);
  mkdirSync(dirname(out), { recursive: true });
  const speed = Number(values.speed.split(',')[0]) / 100;
  writeFileSync(out, await renderPng(song, { ...baseOpts, speed }, Number(values.at)));
  console.log(`Wrote ${out}`);
} else if (command === 'render') {
  const speeds = values.speed.split(',').map((s) => Number(s.trim().replace('%', '')));
  if (speeds.some((s) => !(s > 0 && s <= 200))) fail('--speed values must be percentages between 1 and 200');
  const songName = safeName(song.artist ? `${song.artist} - ${song.title}` : song.title);
  const workers = values.workers ? Number(values.workers) : Math.max(1, Math.min(8, Math.floor(availableParallelism() / 3)));
  if (hint) console.warn(`Note: ${hint}\n`);
  if (sync) console.log(`${sync}\n`);
  const single = speeds.length === 1 && values.out && extname(values.out).toLowerCase() === '.mp4';
  for (const pct of speeds) {
    const suffix = values.bars ? ` (bars ${values.bars})` : '';
    const out = single ? values.out! : join(values.out ?? 'out', `${songName}${suffix} (${pct}%).mp4`);
    mkdirSync(dirname(out), { recursive: true });
    const started = Date.now();
    let lastLog = 0;
    process.stdout.write(`Rendering ${out}\n`);
    try {
      await renderVideo(song, { ...baseOpts, speed: pct / 100 }, out, workers, (done, total) => {
        const now = Date.now();
        if (now - lastLog < 500 && done !== total) return;
        lastLog = now;
        const fps = done / Math.max(0.001, (now - started) / 1000);
        process.stdout.write(`\r  ${((done / total) * 100).toFixed(0).padStart(3)}%  frame ${done}/${total}  ${fps.toFixed(0)} fps   `);
      });
    } catch (e) {
      process.stdout.write('\n');
      fail((e as Error).message);
    }
    process.stdout.write(`\n  done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  }
} else {
  fail(`Unknown command "${command}".\n\n${HELP}`);
}
