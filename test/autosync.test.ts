import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Attack } from '../src/audio.ts';
import { autoSync } from '../src/autosync.ts';
import type { Song } from '../src/model.ts';
import { barTime, syncToAudio, type SyncPoint } from '../src/sync.ts';

/** 120 BPM 4/4 (2 s bars) with a crash on most downbeats and some on beat 4, like a real drum part. */
function song(bars = 40, extraCymbals: number[] = []): Song {
  const starts = Array.from({ length: bars }, (_, i) => 2 * i);
  const cymbals: number[] = [];
  for (let b = 1; b < bars; b++) {
    if ((b * 7) % 5 !== 4) cymbals.push(starts[b]); // downbeat
    if ((b * 3) % 7 === 1) cymbals.push(starts[b] + 1.5); // beat 4
  }
  return {
    title: 'T', artist: '', tuning: [64, 59, 55, 50, 45, 40], notes: [{ time: 2, duration: 1, string: 5, fret: 0 }],
    bars: starts, beats: starts.flatMap((s) => [s, s + 0.5, s + 1, s + 1.5]), sections: [], chords: [],
    end: 2 * bars, bpm: 120, beatsPerBar: 4, cymbals: [...cymbals, ...extraCymbals].sort((a, b) => a - b),
  };
}

/**
 * A band 5% faster than the tab, starting 3 s into the recording, that holds
 * bars 20-21 a second longer than written.
 */
const truth = (t: number) => 3 + t / 1.05 + (t > 38 ? Math.min(1, (t - 38) / 4) : 0);

/** Crashes where the band plays them (a few ms off), and weaker attacks on every 8th. */
function recording(s: Song, map = truth, skip: (t: number) => boolean = () => false): { attacks: Attack[]; duration: number } {
  const attacks: Attack[] = [];
  s.cymbals!.forEach((t, i) => {
    if (!skip(t)) attacks.push({ time: map(t) + ((i * 37) % 11 - 5) / 1000, strength: 0.95 });
  });
  for (let t = 0; t < s.end; t += 0.25) {
    const a = map(t) + 0.003;
    if (!attacks.some((x) => Math.abs(x.time - a) < 0.03)) attacks.push({ time: a, strength: 0.45 + 0.1 * ((t * 4) % 3) });
  }
  attacks.sort((a, b) => a.time - b.time);
  return { attacks, duration: map(s.end) + 2 };
}

/** Worst error over the bar lines from `from` to `to`, in seconds. */
function worstError(s: Song, points: SyncPoint[], from: number, to: number, map = truth): number {
  const synced = syncToAudio(s, points, 'x.mp3').song;
  let worst = 0;
  for (let b = from; b <= to; b++) worst = Math.max(worst, Math.abs(synced.bars[b - 1] + synced.audio!.start - map(s.bars[b - 1])));
  return worst;
}

test('autosync: follows a band that plays faster than the tab and holds a pause longer', () => {
  const s = song();
  const { attacks, duration } = recording(s);
  const r = autoSync(s, attacks, duration);
  // Bars 20-21 (the pause) have no cymbals inside, so only the bar lines around them are exact.
  assert.ok(worstError(s, r.points, 2, 20) < 0.02, `before the pause: ${worstError(s, r.points, 2, 20)}`);
  assert.ok(worstError(s, r.points, 22, 40) < 0.02, `after the pause: ${worstError(s, r.points, 22, 40)}`);
  assert.equal(r.cymbals, s.cymbals!.length);
  assert.equal(r.matched, s.cymbals!.length);
  for (const c of r.checks) assert.equal(c.alsoFits, undefined, `bars ${c.fromBar}-${c.toBar}`);
  assert.deepEqual(r.unheardRuns, []);
  assert.equal(r.recordingEndsInBar, undefined);
});

test('autosync: reports the tempo per section and how many held-out cymbals were heard', () => {
  const s = song();
  const { attacks, duration } = recording(s);
  const r = autoSync(s, attacks, duration);
  assert.deepEqual(r.checks.map((c) => [c.fromBar, c.toBar]), [[1, 16], [17, 32], [33, 40]]);
  assert.ok(Math.abs(r.checks[0].tempoFactor - 1.05) < 0.005, String(r.checks[0].tempoFactor));
  for (const c of r.checks) {
    assert.ok(c.cymbals > 0);
    // Held out, a few around the pause fit less well: half the cymbals pin it down less.
    assert.ok(c.heard >= 0.75 * c.cymbals, `bars ${c.fromBar}-${c.toBar}: ${c.heard} of ${c.cymbals}`);
    assert.ok(c.medianError! < 0.01);
  }
});

test('autosync: points given by the user are kept exactly', () => {
  const s = song();
  const { attacks, duration } = recording(s);
  const r = autoSync(s, attacks, duration, { pinned: [{ bar: 21, time: 43.5 }] });
  assert.deepEqual(r.points.find((p) => p.bar === 21), { bar: 21, time: 43.5 });
});

test('autosync: a cymbal roll the band doesn\'t play is reported and left out', () => {
  // 16ths through bar 30, a 32nd off the 8th notes so the weaker attacks there don't count as hearing it.
  const roll = Array.from({ length: 16 }, (_, i) => 2 * 29 + 0.0625 + i * 0.125);
  const s = song(40, roll);
  const { attacks, duration } = recording(s, truth, (t) => roll.includes(t));
  const r = autoSync(s, attacks, duration);
  assert.deepEqual(r.unheardRuns, [{ fromBar: 30, toBar: 30, cymbals: 16 }]);
  assert.ok(worstError(s, r.points, 22, 40) < 0.02);
});

test('autosync: a recording that stops early', () => {
  const s = song();
  const { attacks } = recording(s);
  const end = truth(barTime(s, 31)) - 0.5; // inside bar 30
  const r = autoSync(s, attacks.filter((a) => a.time < end), end);
  assert.equal(r.recordingEndsInBar, 30);
  assert.ok(worstError(s, r.points, 22, 29) < 0.02);
  assert.ok(r.checks.every((c) => c.fromBar <= 30));
});

test('autosync: needs crash cymbals in the tab', () => {
  const s = song();
  assert.throws(() => autoSync({ ...s, cymbals: undefined }, [], 60), /no crash cymbals/);
  assert.throws(() => autoSync({ ...s, cymbals: [2, 4] }, [], 60), /only has 2 crash cymbals.*\n.*--sync/);
});
