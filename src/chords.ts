import { groupByOnset } from './fingering.ts';
import { noteName, type Marker, type Song } from './model.ts';

const TEMPLATES: [string, number[]][] = [
  ['5', [0, 7]],
  ['', [0, 4, 7]],
  ['m', [0, 3, 7]],
  ['7', [0, 4, 7, 10]],
  ['7', [0, 4, 10]],
  ['maj7', [0, 4, 7, 11]],
  ['maj7', [0, 4, 11]],
  ['m7', [0, 3, 7, 10]],
  ['m7', [0, 3, 10]],
  ['sus2', [0, 2, 7]],
  ['sus4', [0, 5, 7]],
  ['7sus4', [0, 5, 7, 10]],
  ['dim', [0, 3, 6]],
  ['m7b5', [0, 3, 6, 10]],
  ['aug', [0, 4, 8]],
  ['6', [0, 4, 7, 9]],
  ['m6', [0, 3, 7, 9]],
  ['add9', [0, 2, 4, 7]],
  ['madd9', [0, 2, 3, 7]],
  ['9', [0, 2, 4, 7, 10]],
];

function same(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Names a set of MIDI pitches, e.g. [40, 47, 52] -> "E5". Returns null if unknown. */
export function nameChord(pitches: number[]): string | null {
  const sorted = [...pitches].sort((a, b) => a - b);
  const pcs = [...new Set(sorted.map((p) => p % 12))];
  if (pcs.length < 2) return null;
  const bass = sorted[0] % 12;
  // Try the bass note as root first, then the other notes (slash chords).
  const roots = [bass, ...pcs.filter((p) => p !== bass)];
  for (const root of roots) {
    const intervals = [...new Set(pcs.map((p) => (p - root + 12) % 12))].sort((a, b) => a - b);
    for (const [suffix, tpl] of TEMPLATES) {
      if (same(intervals, tpl)) {
        const name = noteName(root) + suffix;
        return root === bass ? name : `${name}/${noteName(bass)}`;
      }
    }
  }
  return null;
}

/**
 * Detects chord names for simultaneous notes. A label is emitted when the
 * chord changes, or again at the first chord of each new bar.
 */
export function detectChords(song: Song): Marker[] {
  const out: Marker[] = [];
  let lastName: string | null = null;
  let lastBar = -1;
  for (const group of groupByOnset(song.notes)) {
    const playable = group.filter((n) => !n.dead);
    if (playable.length < 2) {
      lastName = null;
      continue;
    }
    const name = nameChord(playable.map((n) => song.tuning[n.string] + n.fret));
    if (!name) continue;
    const t = group[0].time;
    const bar = barIndex(song, t);
    if (name !== lastName || bar !== lastBar) out.push({ time: t, text: name });
    lastName = name;
    lastBar = bar;
  }
  return out;
}

/** 0-based bar that song time t falls in. */
function barIndex(song: Song, t: number): number {
  return Math.max(0, song.bars.findLastIndex((b) => b <= t + 1e-6));
}

/**
 * The file's own chord names, plus detected ones in the bars it doesn't name.
 * Files often name only some chords (one chord line in an ASCII tab, a few
 * diagrams in a Guitar Pro file); where they do, their names win.
 */
export function withDetectedChords(song: Song): Marker[] {
  const named = new Set(song.chords.map((c) => barIndex(song, c.time)));
  const detected = detectChords(song).filter((c) => !named.has(barIndex(song, c.time)));
  return [...song.chords, ...detected].sort((a, b) => a.time - b.time);
}
