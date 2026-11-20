/**
 * Screen geometry and the bouncing-ball trajectory.
 *
 * Everything scrolls in "world space": a note at song time `t` is drawn at
 *   x = ballX + (t - now) * pxPerSec
 * so the ball stays at a fixed x and the chart moves underneath it.
 */
import { groupByOnset } from './fingering.ts';
import type { Note, Song } from './model.ts';

export interface Geometry {
  width: number;
  height: number;
  s: number; // scale factor relative to 1080p
  ballX: number;
  pxPerSec: number;
  stringYs: number[];
  noteR: number;
  ballR: number;
  boardTop: number;
  boardBottom: number;
  chordY: number;
  sectionY: number;
  pmY: number;
  restY: number;
  footerTop: number;
}

export function makeGeometry(width: number, height: number, stringCount: number, zoom: number): Geometry {
  const s = height / 1080;
  const top = 610 * s;
  const bottom = 960 * s;
  const gap = Math.min(76 * s, (bottom - top) / Math.max(1, stringCount - 1));
  const stringYs = Array.from({ length: stringCount }, (_, i) => top + i * gap);
  const noteR = Math.min(31 * s, gap * 0.43);
  const ballR = 19 * s;
  return {
    width,
    height,
    s,
    ballX: Math.round(width * 0.33),
    pxPerSec: 470 * s * zoom,
    stringYs,
    noteR,
    ballR,
    boardTop: top - gap * 0.75,
    boardBottom: stringYs[stringYs.length - 1] + gap * 0.6,
    chordY: top - gap * 0.75 - 26 * s,
    sectionY: top - gap * 0.75 - 104 * s,
    pmY: top - noteR - 14 * s,
    restY: top - gap * 0.75 - ballR - 6 * s,
    footerTop: height - 72 * s,
  };
}

export interface Landing {
  time: number;
  y: number;
  /** Notes landed on (empty for count-in / rest bounces). */
  notes: Note[];
  /** 1-based count-in number, if this is a count-in beat. */
  count?: number;
}

export interface Timeline {
  landings: Landing[];
  start: number; // song time where the video starts
  end: number; // song time where the video ends
  beatLen: number;
  countInBeats: number[];
  pmSpans: [number, number][];
  prevOnString: Map<Note, Note>;
}

export function buildTimeline(song: Song, g: Geometry, countInBars: number): Timeline {
  const beatLen =
    song.beats.length > 1 ? median(song.beats.slice(1).map((b, i) => b - song.beats[i])) : 60 / song.bpm;
  const firstBar = song.bars[0] ?? 0;
  const countInBeats: number[] = [];
  for (let k = countInBars * song.beatsPerBar; k >= 1; k--) countInBeats.push(firstBar - k * beatLen);

  const end = lastNoteEnd(song) + Math.max(1.5, 2 * beatLen);
  const start = (countInBeats[0] ?? firstBar) - Math.max(0.6, beatLen);

  // Beat grid covering count-in, the song and the outro.
  const grid = [...countInBeats, ...song.beats];
  let lastBeat = grid[grid.length - 1] ?? 0;
  while (lastBeat < end + beatLen) grid.push((lastBeat += beatLen));

  const noteLandings: Landing[] = groupByOnset(song.notes).map((group) => ({
    time: group[0].time,
    y: Math.min(...group.map((n) => g.stringYs[n.string])) - g.noteR - g.ballR * 0.55,
    notes: group,
  }));

  // Fill gaps longer than ~1.5 beats with bounces on the beat so the ball keeps time.
  const landings: Landing[] = [];
  const restAt = (t: number): Landing => {
    const idx = countInBeats.findIndex((b) => Math.abs(b - t) < 1e-6);
    return { time: t, y: g.restY, notes: [], count: idx >= 0 ? idx + 1 : undefined };
  };
  const bounds = [{ time: -Infinity } as Landing, ...noteLandings, { time: Infinity } as Landing];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    if (i > 0) landings.push(a);
    if (b.time - a.time > 1.6 * beatLen) {
      for (const t of grid) {
        if (t > a.time + 0.6 * beatLen && t < b.time - 0.6 * beatLen && t >= start && t <= end + beatLen) {
          landings.push(restAt(t));
        }
      }
    }
  }

  // Palm-mute spans: runs of consecutive palm-muted onsets.
  const pmSpans: [number, number][] = [];
  for (const l of noteLandings) {
    const pm = l.notes.every((n) => n.palmMute);
    const last = pmSpans[pmSpans.length - 1];
    const endT = l.time + Math.min(...l.notes.map((n) => n.duration));
    if (!pm) continue;
    if (last && l.time - last[1] < beatLen * 1.05 && !noteLandings.some((o) => o.time > last[1] - 1e-6 && o.time < l.time && !o.notes.every((n) => n.palmMute))) {
      last[1] = endT;
    } else pmSpans.push([l.time, endT]);
  }

  const prevOnString = new Map<Note, Note>();
  const last = new Map<number, Note>();
  for (const n of [...song.notes].sort((a, b) => a.time - b.time)) {
    const p = last.get(n.string);
    if (p) prevOnString.set(n, p);
    last.set(n.string, n);
  }

  return { landings, start, end, beatLen, countInBeats, pmSpans, prevOnString };
}

/** Ball height at song time t. */
export function ballY(tl: Timeline, g: Geometry, t: number): number {
  const L = tl.landings;
  if (L.length === 0) return g.restY;
  if (t <= L[0].time) {
    // Drop in from above before the first landing.
    const u = Math.max(0, 1 - (L[0].time - t) / tl.beatLen);
    return L[0].y - (1 - u * u) * 160 * g.s;
  }
  let lo = 0;
  let hi = L.length - 1;
  if (t >= L[hi].time) return L[hi].y;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (L[mid].time <= t) lo = mid;
    else hi = mid;
  }
  const a = L[lo];
  const b = L[hi];
  const u = (t - a.time) / (b.time - a.time);
  const dx = (b.time - a.time) * g.pxPerSec;
  const h = Math.min(190 * g.s, Math.max(20 * g.s, dx * 0.3));
  return a.y + (b.y - a.y) * u - h * 4 * u * (1 - u);
}

function lastNoteEnd(song: Song): number {
  return song.notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
