import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ballY, buildTimeline, makeGeometry } from '../src/layout.ts';
import type { Note, Song } from '../src/model.ts';

const g = makeGeometry(1920, 1080, 6, 1);

function note(time: number, string = 0, extra: Partial<Note> = {}): Note {
  return { time, duration: 0.5, string, fret: 3, ...extra };
}

/** 60 bpm 4/4 (one beat per second), two bars, beats at 0..7 s. */
function song(notes: Note[], overrides: Partial<Song> = {}): Song {
  return {
    title: 'T',
    artist: '',
    tuning: [64, 59, 55, 50, 45, 40],
    notes,
    bars: [0, 4],
    beats: [0, 1, 2, 3, 4, 5, 6, 7],
    sections: [],
    chords: [],
    end: 8,
    bpm: 60,
    beatsPerBar: 4,
    ...overrides,
  };
}

const landings = (s: Song, countIn = 1) =>
  buildTimeline(s, g, countIn).landings.map((l) => ({ time: l.time, notes: l.notes.length, count: l.count }));

test('timeline: count-in beats before bar 1, numbered 1..n', () => {
  const tl = buildTimeline(song([note(0), note(1)]), g, 1);
  assert.equal(tl.beatLen, 1);
  assert.deepEqual(tl.countInBeats, [-4, -3, -2, -1]);
  assert.deepEqual(
    tl.landings.slice(0, 4).map((l) => [l.time, l.count, l.y]),
    [[-4, 1, g.restY], [-3, 2, g.restY], [-2, 3, g.restY], [-1, 4, g.restY]],
  );
  // The video starts a beat before the first count.
  assert.equal(tl.start, -5);
});

test('timeline: two bars of count-in, and none', () => {
  assert.equal(buildTimeline(song([note(0)]), g, 2).countInBeats.length, 8);
  const none = buildTimeline(song([note(0), note(1)]), g, 0);
  assert.deepEqual(none.countInBeats, []);
  assert.ok(none.landings.every((l) => l.count === undefined));
  assert.equal(none.start, -1);
});

test('timeline: ends two beats after the last note stops ringing', () => {
  const tl = buildTimeline(song([note(0), note(3, 0, { duration: 2 })]), g, 0);
  assert.equal(tl.end, 3 + 2 + 2);
});

test('timeline: notes played together are one landing, aimed at the highest string', () => {
  const tl = buildTimeline(song([note(0, 4), note(0, 3), note(0.002, 5)]), g, 0);
  const first = tl.landings[0];
  assert.equal(first.time, 0);
  assert.equal(first.notes.length, 3);
  assert.equal(first.y, g.stringYs[3] - g.noteR - g.ballR * 0.55);
});

test('timeline: long gaps between notes are filled with bounces on the beat', () => {
  // Notes at 0 and 4: a 4-beat gap gets bounces at 1, 2 and 3.
  assert.deepEqual(
    landings(song([note(0), note(4)]), 0).filter((l) => l.time >= 0 && l.time <= 4),
    [
      { time: 0, notes: 1, count: undefined },
      { time: 1, notes: 0, count: undefined },
      { time: 2, notes: 0, count: undefined },
      { time: 3, notes: 0, count: undefined },
      { time: 4, notes: 1, count: undefined },
    ],
  );
  // A gap of 1.5 beats is short enough for the ball to jump straight across.
  assert.deepEqual(
    landings(song([note(0), note(1.5)]), 0).filter((l) => l.time >= 0 && l.time <= 1.5).map((l) => l.time),
    [0, 1.5],
  );
});

test('timeline: filler bounces keep clear of the notes either side', () => {
  // Gap 0.3 → 2.5: beat 1 is 0.7 beats after a note (kept), beat 2 only 0.5 before one (skipped).
  const times = landings(song([note(0.3), note(2.5)]), 0).filter((l) => l.time >= 0.3 && l.time <= 2.5).map((l) => l.time);
  assert.deepEqual(times, [0.3, 1, 2.5]);
});

test('timeline: landings are in time order with no duplicates', () => {
  const tl = buildTimeline(song([note(0), note(0.5), note(4), note(7)]), g, 1);
  const times = tl.landings.map((l) => l.time);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], `landing ${i} at ${times[i]} after ${times[i - 1]}`);
});

test('timeline: beat length comes from the beat grid, or the bpm if there is none', () => {
  // 120 bpm grid but a wrong bpm field: the grid wins.
  const grid = buildTimeline(song([note(0)], { beats: [0, 0.5, 1, 1.5], bpm: 60 }), g, 0);
  assert.equal(grid.beatLen, 0.5);
  const noGrid = buildTimeline(song([note(0)], { beats: [], bpm: 120 }), g, 0);
  assert.equal(noGrid.beatLen, 0.5);
});

test('timeline: consecutive palm-muted notes form one span, a normal note breaks it', () => {
  const pm = { palmMute: true };
  const tl = buildTimeline(
    song([note(0, 5, pm), note(0.5, 5, pm), note(1, 5, pm), note(1.5, 5), note(2, 5, pm), note(2.5, 5, pm)]),
    g,
    0,
  );
  assert.deepEqual(tl.pmSpans, [[0, 1.5], [2, 3]]);
});

test('timeline: a chord is only palm-muted if all its notes are', () => {
  const tl = buildTimeline(song([note(0, 5, { palmMute: true }), note(0, 4)]), g, 0);
  assert.deepEqual(tl.pmSpans, []);
});

test('timeline: links each note to the previous note on the same string', () => {
  const a = note(0, 1);
  const b = note(1, 2);
  const c = note(2, 1);
  const tl = buildTimeline(song([c, b, a]), g, 0);
  assert.equal(tl.prevOnString.get(c), a);
  assert.equal(tl.prevOnString.has(a), false);
  assert.equal(tl.prevOnString.has(b), false);
});

test('ball: touches down exactly on every landing', () => {
  const tl = buildTimeline(song([note(0, 0), note(0.5, 5), note(4, 2), note(7, 1)]), g, 1);
  for (const l of tl.landings) assert.ok(Math.abs(ballY(tl, g, l.time) - l.y) < 1e-9, `landing at ${l.time}`);
});

test('ball: arcs upwards between landings, higher for longer jumps', () => {
  const tl = buildTimeline(song([note(0), note(0.25), note(1.25)]), g, 0);
  const y0 = tl.landings[0].y; // all on the same string
  const short = ballY(tl, g, 0.125);
  const long = ballY(tl, g, 0.75);
  assert.ok(short < y0, 'above the string mid-jump (smaller y is higher)');
  assert.ok(long < short, 'longer jump goes higher');
  // Height is capped.
  assert.ok(y0 - long <= 190 * g.s + 1e-9);
});

test('ball: drops in from above before the first landing and stays put after the last', () => {
  const tl = buildTimeline(song([note(0), note(1)]), g, 0);
  const first = tl.landings[0];
  const last = tl.landings[tl.landings.length - 1];
  assert.equal(ballY(tl, g, first.time - 10), first.y - 160 * g.s);
  assert.ok(ballY(tl, g, first.time - 0.5) > first.y - 160 * g.s);
  assert.equal(ballY(tl, g, last.time + 10), last.y);
});

test('ball: with nothing to land on it rests above the board', () => {
  const tl = buildTimeline(song([note(0)]), g, 0);
  assert.equal(ballY({ ...tl, landings: [] }, g, 0), g.restY);
});

test('ball: the path is continuous (no jumps between frames)', () => {
  const tl = buildTimeline(song([note(0, 0), note(0.25, 5), note(0.5, 2), note(3, 4), note(3.1, 0)]), g, 1);
  const maxStep = 60 * g.s; // px per 1/240 s frame; far above any real arc speed
  let prev = ballY(tl, g, tl.start);
  for (let t = tl.start; t <= tl.end; t += 1 / 240) {
    const y = ballY(tl, g, t);
    assert.ok(Number.isFinite(y), `finite at ${t}`);
    assert.ok(Math.abs(y - prev) < maxStep, `jump of ${Math.abs(y - prev)}px at t=${t.toFixed(3)}`);
    prev = y;
  }
});
