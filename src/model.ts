/**
 * Core song model shared by parsers, layout and renderer.
 *
 * All times are in seconds at 100% playback speed. A slowed-down video simply
 * samples this timeline more slowly; the chart itself never changes.
 *
 * Strings are indexed 0..stringCount-1 from the HIGHEST pitched string (top of
 * the screen) to the LOWEST (bottom of the screen), matching how tabs are read.
 */

export type Technique =
  | 'hammer' // hammer-on into this note
  | 'pull' // pull-off into this note
  | 'slide' // slide into this note from the previous note on the string
  | 'tap';

export type Finger = 0 | 1 | 2 | 3 | 4; // 0 = open string, 1 = index ... 4 = pinky

export interface Note {
  time: number;
  duration: number;
  string: number;
  fret: number;
  /** Optional explicit fingering; otherwise assigned by `assignFingers`. */
  finger?: Finger;
  technique?: Technique;
  /** Bend amount in semitones (1 = half step, 2 = full). */
  bend?: number;
  palmMute?: boolean;
  dead?: boolean;
  harmonic?: boolean;
  vibrato?: boolean;
  /** Slide out of the note into nothing ("7\\" or "7/" in tab). */
  slideOut?: 'up' | 'down';
}

export interface Marker {
  time: number;
  text: string;
}

export interface Song {
  title: string;
  artist: string;
  /** MIDI note numbers per string, index 0 = highest string. */
  tuning: number[];
  notes: Note[];
  /** Start times of every bar (measure). */
  bars: number[];
  /** Start times of every beat (used for faint grid lines and count-in bounces). */
  beats: number[];
  sections: Marker[];
  chords: Marker[];
  /** Time at which the song content ends. */
  end: number;
  /** Tempo in BPM at the start (informational; used for count-in). */
  bpm: number;
  beatsPerBar: number;
  /** Optional backing track: `start` is the position (s) in the audio file where song time 0 happens. */
  audio?: { path: string; start: number };
  /**
   * Time of the first note in ANY instrument, for multi-track files where other
   * tracks (e.g. drums) may start before this one. Without it, the first note is used.
   */
  firstSound?: number;
  /**
   * Crash, china and splash hits in the file's drum tracks (sorted song times).
   * Loud, sharp landmarks for lining the tab up with a recording (`tabhop sync`).
   */
  cymbals?: number[];
}

export const STANDARD_TUNING = [64, 59, 55, 50, 45, 40];

/** Standard tuning per string count (4/5 = bass, 6-8 = guitar), index 0 = highest string. */
export const STANDARD_TUNINGS: Record<number, number[]> = {
  4: [43, 38, 33, 28],
  5: [43, 38, 33, 28, 23],
  6: STANDARD_TUNING,
  7: [64, 59, 55, 50, 45, 40, 35],
  8: [64, 59, 55, 50, 45, 40, 35, 30],
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** Spelling guitarists use for tunings: "Eb standard", "Drop C#", "Bb standard". */
const TUNING_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function noteName(midi: number): string {
  return NOTE_NAMES[((midi % 12) + 12) % 12];
}

const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function tuningNote(midi: number, flats = false): string {
  return (flats ? FLAT_NAMES : TUNING_NAMES)[((midi % 12) + 12) % 12];
}

/**
 * Describes a non-standard tuning, e.g. { name: "Eb Standard", notes: "Eb Ab Db Gb Bb Eb" }.
 * Returns undefined for standard tuning (or an unknown string count). `notes` is low → high.
 */
export function tuningLabel(tuning: number[]): { name: string; notes: string } | undefined {
  const ref = STANDARD_TUNINGS[tuning.length];
  if (!ref) return undefined;
  const diff = tuning.map((m, i) => m - ref[i]);
  const shift = diff[0];
  // Down-tuned guitars are spelled with flats: "Eb Ab Db Gb Bb Eb".
  const notes = [...tuning].reverse().map((m) => tuningNote(m, shift < 0)).join(' ');
  const low = diff.length - 1;
  const restShifted = diff.slice(0, low).every((d) => d === shift);
  // Tunings are named after the note the E string(s) are tuned to.
  const eString = ref.findIndex((m) => m % 12 === 4);
  if (restShifted && diff[low] === shift) {
    return shift === 0 ? undefined : { name: `${tuningNote(ref[eString] + shift)} Standard`, notes };
  }
  if (restShifted && diff[low] === shift - 2) return { name: `Drop ${tuningNote(tuning[low])}`, notes };
  return { name: notes, notes };
}

export function parseNoteName(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)?$/.exec(name.trim());
  if (!m) throw new Error(`Invalid note name in tuning: "${name}"`);
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = m[3] !== undefined ? Number(m[3]) : 4;
  return (octave + 1) * 12 + base + acc;
}
