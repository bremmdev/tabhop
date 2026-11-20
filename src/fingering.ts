import type { Finger, Note } from './model.ts';

/**
 * Assigns fretting-hand fingers (used for note colours) with a simple
 * "one finger per fret" hand-position model:
 *  - open strings get finger 0
 *  - the hand stays put while notes fit in a 4-fret window
 *  - when a note falls outside, the hand moves to the lowest fret of the
 *    longest upcoming run of notes that fits in a 4-fret window
 * Explicit fingerings from the source file are kept.
 */
export function assignFingers(notes: Note[]): void {
  const groups = groupByOnset(notes);
  const fretted = (g: Note[]) => g.filter((n) => n.fret > 0 && !n.dead);
  let pos: number | null = null;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = fretted(groups[gi]);
    for (const n of groups[gi]) if ((n.fret === 0 || n.dead) && n.finger === undefined) n.finger = 0;
    if (group.length === 0) continue;
    const min = Math.min(...group.map((n) => n.fret));
    const max = Math.max(...group.map((n) => n.fret));

    if (group.length > 1 && max - min <= 3) {
      // Chord shapes (power chords, barres) are anchored with the index finger on the lowest fret.
      pos = min;
    } else if (pos === null || min < pos || max > pos + 3) {
      // Look ahead: extend the window while upcoming notes still fit in 4 frets.
      let lo = min;
      let hi = max;
      for (let k = gi + 1; k < groups.length && k < gi + 16; k++) {
        const g = fretted(groups[k]);
        if (!g.length) continue;
        const nlo = Math.min(lo, ...g.map((n) => n.fret));
        const nhi = Math.max(hi, ...g.map((n) => n.fret));
        if (nhi - nlo > 3) break;
        lo = nlo;
        hi = nhi;
      }
      pos = hi - lo <= 3 ? Math.min(lo, min) : min;
      if (max - pos > 3) pos = Math.max(1, max - 3);
    }
    for (const n of group) {
      if (n.finger === undefined) n.finger = Math.min(4, Math.max(1, n.fret - pos + 1)) as Finger;
    }
  }
}

export function groupByOnset(notes: Note[], epsilon = 0.005): Note[][] {
  const sorted = [...notes].sort((a, b) => a.time - b.time);
  const groups: Note[][] = [];
  for (const n of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[0].time - n.time) < epsilon) last.push(n);
    else groups.push([n]);
  }
  return groups;
}
