import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clickTimes, clickTrack } from '../src/click.ts';
import { buildTimeline, makeGeometry } from '../src/layout.ts';
import type { Song } from '../src/model.ts';

/** 2 bars of 4/4 at 60 bpm: a beat is 1 s, bars start at 0 and 4 s. */
function song(overrides: Partial<Song> = {}): Song {
  return {
    title: 'T',
    artist: '',
    tuning: [64, 59, 55, 50, 45, 40],
    notes: [
      { time: 0, duration: 1, string: 5, fret: 0 },
      { time: 7, duration: 1, string: 5, fret: 3 },
    ],
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

const timeline = (s: Song, countInBars = 1) => buildTimeline(s, makeGeometry(1920, 1080, 6, 1), countInBars);

test('click: one click per beat, count-in included, the first beat of each bar accented', () => {
  const s = song();
  const tl = timeline(s);
  // The count-in starts at -4 s and the video 1 s before it, so song time t is video time t + 5.
  assert.equal(tl.start, -5);
  assert.deepEqual(clickTimes(s, tl, 1), [
    { time: 1, accent: true }, { time: 2, accent: false }, { time: 3, accent: false }, { time: 4, accent: false },
    { time: 5, accent: true }, { time: 6, accent: false }, { time: 7, accent: false }, { time: 8, accent: false },
    { time: 9, accent: true }, { time: 10, accent: false }, { time: 11, accent: false }, { time: 12, accent: false },
  ]);
});

test('click: a slowed-down video spreads the clicks out with it', () => {
  const s = song();
  const tl = timeline(s);
  const half = clickTimes(s, tl, 0.5);
  assert.deepEqual(half.map((c) => c.time), clickTimes(s, tl, 1).map((c) => c.time * 2));
});

test('click: no count-in, no count-in clicks', () => {
  const s = song();
  assert.deepEqual(clickTimes(s, timeline(s, 0), 1).filter((c) => c.accent).length, 2);
  assert.equal(clickTimes(s, timeline(s, 0), 1).length, 8);
});

test('click: each click is a short sound at its time, silence in between, accents louder', () => {
  const rate = 8000;
  const samples = clickTrack([{ time: 0.5, accent: true }, { time: 1, accent: false }], 1.5, rate);
  assert.equal(samples.length, 1.5 * rate);
  const peak = (from: number, to: number) => Math.max(...samples.subarray(from * rate, to * rate).map(Math.abs));
  assert.equal(peak(0, 0.5), 0, 'nothing before the first click');
  assert.ok(peak(0.5, 0.52) > 0.3, 'the click starts on time');
  assert.ok(peak(0.7, 0.99) < 0.001, 'and dies away well before the next');
  assert.ok(peak(0.5, 0.6) > peak(1, 1.1) * 1.3, 'an accent is louder');
  assert.ok(peak(0, 1.5) <= 1, 'no clipping');
});
