import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { detectChords } from './chords.ts';
import { assignFingers } from './fingering.ts';
import type { Song } from './model.ts';
import { parseAsciiTab } from './parsers/asciiTab.ts';
import { describeTracks, loadScore, scoreToSong } from './parsers/guitarPro.ts';

export const TEXT_EXTENSIONS = ['.txt', '.tab'];
/** Formats read by alphaTab (Guitar Pro, MusicXML, alphaTex). */
export const SCORE_EXTENSIONS = ['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.musicxml', '.xml', '.mxl', '.atex', '.alphatex', '.tex'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.avif', '.pdf'];

function unsupportedFormat(path: string, ext: string): Error {
  const what = ext ? `"${ext}" files aren't supported` : `"${path}" has no file extension`;
  const hint = IMAGE_EXTENSIONS.includes(ext)
    ? '\nImages and PDFs of tabs can\'t be read. Copy the tab as text into a .txt file, or export it from Guitar Pro / MuseScore / TuxGuitar.'
    : '';
  return new Error(
    `${what}.${hint}\nSupported formats: ${[...SCORE_EXTENSIONS, ...TEXT_EXTENSIONS].join(' ')}`,
  );
}

export interface LoadOptions {
  track?: number;
  autoChords?: boolean;
}

export function loadSong(path: string, opts: LoadOptions = {}): { song: Song; tracks?: string[] } {
  const ext = extname(path).toLowerCase();
  let song: Song;
  let tracks: string[] | undefined;
  if (TEXT_EXTENSIONS.includes(ext)) {
    song = parseAsciiTab(readFileSync(path, 'utf8'));
    // Audio paths in the tab header are relative to the tab file.
    if (song.audio) song.audio.path = resolve(dirname(path), song.audio.path);
  } else {
    if (!SCORE_EXTENSIONS.includes(ext)) throw unsupportedFormat(path, ext);
    const score = loadScore(readFileSync(path), ext);
    tracks = describeTracks(score);
    song = scoreToSong(score, opts.track);
  }
  if (song.notes.length === 0) throw new Error('The tab contains no notes');
  assignFingers(song.notes);
  if (opts.autoChords !== false && song.chords.length === 0) song.chords = detectChords(song);
  return { song, tracks };
}

export interface LeadIn {
  /** Song time of the first sound (s after the start of bar 1). */
  time: number;
  /** Whole bars before it with no notes in any instrument. */
  silentBars: number;
}

/**
 * Silence at the start of the song, or undefined if the music starts right away.
 * Matters for audio alignment: `--audio-start` is where bar 1 begins, so a tab
 * with an empty first bar needs a negative start if the recording doesn't have one.
 */
export function leadIn(song: Song): LeadIn | undefined {
  const first = song.firstSound ?? Math.min(...song.notes.map((n) => n.time));
  const barOne = song.bars[0] ?? 0;
  if (!Number.isFinite(first) || first - barOne < 0.1) return undefined;
  const silentBars = song.bars.filter((_, i) => (song.bars[i + 1] ?? song.end) <= first + 1e-6).length;
  return { time: first - barOne, silentBars };
}

const seconds = (t: number) => `${Number(t.toFixed(3))} s`;

export function describeLeadIn({ time, silentBars }: LeadIn): string {
  if (silentBars === 0) return `the first note is at ${seconds(time)}, part-way into bar 1`;
  const bars = silentBars === 1 ? 'bar 1 is' : `bars 1-${silentBars} are`;
  return `${bars} silent, the first note is at ${seconds(time)}`;
}

/** Cuts the song to bars [fromBar, toBar] (1-based, inclusive) and shifts it to start at 0. */
export function sliceBars(song: Song, fromBar: number, toBar: number): Song {
  if (fromBar > toBar) throw new Error(`Invalid bar range ${fromBar}-${toBar}: the first bar must not come after the last`);
  const a = song.bars[Math.max(0, fromBar - 1)];
  if (a === undefined) throw new Error(`Song only has ${song.bars.length} bars`);
  const b = song.bars[toBar] ?? song.end;
  const inRange = <T extends { time: number }>(x: T) => x.time >= a - 1e-6 && x.time < b - 1e-6;
  const shift = <T extends { time: number }>(x: T) => ({ ...x, time: x.time - a });
  // Keep the label of the section we start in.
  const current = song.sections.filter((s) => s.time <= a + 1e-6).pop();
  const sections = song.sections.filter(inRange).map(shift);
  if (current && !sections.some((s) => s.time < 1e-6)) sections.unshift({ time: 0, text: current.text });
  return {
    ...song,
    notes: song.notes.filter(inRange).map((n) => ({ ...shift(n), duration: Math.min(n.duration, b - n.time) })),
    bars: song.bars.filter((t) => t >= a - 1e-6 && t < b - 1e-6).map((t) => t - a),
    beats: song.beats.filter((t) => t >= a - 1e-6 && t < b - 1e-6).map((t) => t - a),
    sections,
    chords: song.chords.filter(inRange).map(shift),
    end: b - a,
    audio: song.audio ? { ...song.audio, start: song.audio.start + a } : undefined,
    firstSound: undefined, // describes the whole song, not the slice
    cymbals: song.cymbals?.filter((t) => t >= a - 1e-6 && t < b - 1e-6).map((t) => t - a),
  };
}
