/**
 * Lining a tab up with a recording that doesn't follow the tab's tempo exactly.
 *
 * Sync points pin bar positions to times in the recording ("bar 110 starts at
 * 2:42.5"). The tab's timeline is stretched piecewise-linearly between them, so
 * the notes follow the band's real timing and the recording plays untouched.
 * Before the first and after the last point, the nearest section's correction
 * carries on. A single point just moves the audio, like `--audio-start`.
 */
import type { Song } from './model.ts';
import { parseTime } from './parsers/asciiTab.ts';

export interface SyncPoint {
  /** 1-based bar; the fraction is a position inside the bar (216.75 = three quarters through bar 216). */
  bar: number;
  /** Seconds into the recording. */
  time: number;
}

export interface SyncSegment {
  fromBar: number;
  toBar: number;
  /** How much faster the recording is than the tab between these points (1.03 = 3% faster). */
  tempoFactor: number;
}

/** Parses "2=0.05, 110=2:42.5". */
export function parseSyncPoints(value: string): SyncPoint[] {
  const points = value.split(',').map((part) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*=\s*(\S.*?)\s*$/.exec(part);
    if (!m) throw new Error(`Invalid sync point "${part.trim()}" (use bar=time, e.g. 110=2:42.5)`);
    const bar = Number(m[1]);
    if (bar < 1) throw new Error(`Bars are numbered from 1 (got sync point "${part.trim()}")`);
    return { bar, time: parseTime(m[2]) };
  });
  points.sort((a, b) => a.bar - b.bar);
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (a.bar === b.bar) throw new Error(`Bar ${a.bar} is synced twice`);
    if (b.time <= a.time) {
      throw new Error(`Sync points out of order: bar ${b.bar} (${b.time} s) must come after bar ${a.bar} (${a.time} s) in the recording`);
    }
  }
  return points;
}

/** Song time of a (fractional) bar position; bar `bars.length + 1` is the end of the song. */
export function barTime(song: Song, bar: number): number {
  const k = Math.floor(bar);
  const frac = bar - k;
  const start = k === song.bars.length + 1 && frac === 0 ? song.end : song.bars[k - 1];
  if (start === undefined) throw new Error(`Song only has ${song.bars.length} bars (sync point at bar ${bar})`);
  const next = song.bars[k] ?? song.end;
  return start + frac * (next - start);
}

/**
 * Returns the song re-timed to the recording: song time t then plays at
 * `audio.start + t` in the audio file, and bar 1 still starts at song time 0.
 */
export function syncToAudio(song: Song, points: SyncPoint[], audioPath: string): { song: Song; segments: SyncSegment[] } {
  const anchors = points.map((p) => ({ tab: barTime(song, p.bar), audio: p.time }));
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].tab <= anchors[i - 1].tab) throw new Error(`Sync points at bars ${points[i - 1].bar} and ${points[i].bar} are at the same time in the tab`);
  }
  const slope = (i: number) => (anchors[i + 1].audio - anchors[i].audio) / (anchors[i + 1].tab - anchors[i].tab);
  /** Recording time for a tab time. */
  const toAudio = (t: number): number => {
    if (anchors.length === 1) return anchors[0].audio + (t - anchors[0].tab);
    let i = 0;
    while (i < anchors.length - 2 && t >= anchors[i + 1].tab) i++;
    return anchors[i].audio + (t - anchors[i].tab) * slope(i);
  };
  const start = toAudio(song.bars[0] ?? 0);
  const map = (t: number) => toAudio(t) - start;
  const at = <T extends { time: number }>(x: T): T => ({ ...x, time: map(x.time) });

  const firstSlope = anchors.length > 1 ? slope(0) : 1;
  const segments = anchors.slice(1).map((_, i) => ({
    fromBar: points[i].bar,
    toBar: points[i + 1].bar,
    tempoFactor: 1 / slope(i),
  }));
  return {
    song: {
      ...song,
      notes: song.notes.map((n) => ({ ...n, time: map(n.time), duration: map(n.time + n.duration) - map(n.time) })),
      bars: song.bars.map(map),
      beats: song.beats.map(map),
      sections: song.sections.map(at),
      chords: song.chords.map(at),
      end: map(song.end),
      bpm: song.bpm / firstSlope,
      firstSound: song.firstSound === undefined ? undefined : map(song.firstSound),
      cymbals: song.cymbals?.map(map),
      audio: { path: audioPath, start },
    },
    segments,
  };
}
