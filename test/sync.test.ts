import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sliceBars } from '../src/load.ts';
import type { Song } from '../src/model.ts';
import { barTime, parseSyncPoints, syncToAudio } from '../src/sync.ts';

/** 4 bars of 4/4 at 60 bpm: bars start at 0, 4, 8, 12 s and the song ends at 16 s. */
function song(overrides: Partial<Song> = {}): Song {
  return {
    title: 'T',
    artist: '',
    tuning: [64, 59, 55, 50, 45, 40],
    notes: [0, 4, 6, 8, 12, 15].map((time) => ({ time, duration: 1, string: 0, fret: 1 })),
    bars: [0, 4, 8, 12],
    beats: Array.from({ length: 16 }, (_, i) => i),
    sections: [{ time: 8, text: 'Verse' }],
    chords: [{ time: 4, text: 'E5' }],
    end: 16,
    bpm: 60,
    beatsPerBar: 4,
    ...overrides,
  };
}

const times = (s: Song) => s.notes.map((n) => n.time);
const close = (a: number[], b: number[]) =>
  assert.ok(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9), `${a} ≈ ${b}`);

test('parseSyncPoints: bar=time pairs, times in seconds or m:ss, sorted by bar', () => {
  assert.deepEqual(parseSyncPoints('2=0.05, 110=2:42.5'), [
    { bar: 2, time: 0.05 },
    { bar: 110, time: 162.5 },
  ]);
  assert.deepEqual(parseSyncPoints('216.75=4:29.8,1=-1.5'), [
    { bar: 1, time: -1.5 },
    { bar: 216.75, time: 269.8 },
  ]);
});

test('parseSyncPoints: rejects malformed or contradictory points', () => {
  assert.throws(() => parseSyncPoints(''), /Invalid sync point ""/);
  assert.throws(() => parseSyncPoints('110'), /Invalid sync point "110" \(use bar=time/);
  assert.throws(() => parseSyncPoints('2=soon'), /Invalid time "soon"/);
  assert.throws(() => parseSyncPoints('0=1'), /Bars are numbered from 1/);
  assert.throws(() => parseSyncPoints('2=1,2=3'), /Bar 2 is synced twice/);
  assert.throws(() => parseSyncPoints('2=10,3=5'), /bar 3 \(5 s\) must come after bar 2 \(10 s\)/);
});

test('barTime: whole and fractional bar positions', () => {
  assert.equal(barTime(song(), 1), 0);
  assert.equal(barTime(song(), 3), 8);
  assert.equal(barTime(song(), 2.5), 6);
  assert.equal(barTime(song(), 4.25), 13);
  assert.equal(barTime(song(), 5), 16); // the end of the last bar
  assert.throws(() => barTime(song(), 5.5), /Song only has 4 bars/);
  assert.throws(() => barTime(song(), 6), /Song only has 4 bars/);
});

test('sync: a single point only moves the audio, like --audio-start', () => {
  const { song: s, segments } = syncToAudio(song(), parseSyncPoints('2=10'), 'a.mp3');
  assert.deepEqual(s.audio, { path: 'a.mp3', start: 6 });
  assert.deepEqual(times(s), times(song()));
  assert.equal(s.bpm, 60);
  assert.deepEqual(segments, []);
});

test('sync: two points stretch the whole timeline to the recording', () => {
  // Bar 3 (8 s in the tab) is played 4 s into the recording: the band plays twice as fast.
  const { song: s, segments } = syncToAudio(song(), parseSyncPoints('1=0,3=4'), 'a.mp3');
  assert.deepEqual(s.audio, { path: 'a.mp3', start: 0 });
  close(times(s), [0, 2, 3, 4, 6, 7.5]);
  close(s.notes.map((n) => n.duration), [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  close(s.bars, [0, 2, 4, 6]); // past the last point the same correction carries on
  close(s.beats.slice(0, 3), [0, 0.5, 1]);
  assert.equal(s.end, 8);
  assert.equal(s.bpm, 120);
  close([s.chords[0].time, s.sections[0].time], [2, 4]);
  assert.deepEqual(segments, [{ fromBar: 1, toBar: 3, tempoFactor: 2 }]);
});

test('sync: each section between points gets its own correction', () => {
  // Bar 2 at 10 s, bar 3 at 14 s (tab tempo is right), bar 4 at 16 s (twice as fast).
  const { song: s, segments } = syncToAudio(song(), parseSyncPoints('2=10,3=14,4=16'), 'a.mp3');
  // Before the first point the first section's correction applies: bar 1 is at 6 s.
  assert.equal(s.audio?.start, 6);
  close(s.bars, [0, 4, 8, 10]);
  close(times(s), [0, 4, 6, 8, 10, 11.5]);
  assert.equal(s.end, 12);
  assert.equal(s.bpm, 60);
  assert.deepEqual(segments.map((x) => x.tempoFactor), [1, 2]);
});

test('sync: fractional bar positions', () => {
  // Halfway through bar 2 (6 s in the tab) is at 3 s: twice as fast from bar 1.
  const { song: s } = syncToAudio(song(), parseSyncPoints('1=0,2.5=3'), 'a.mp3');
  close(s.bars, [0, 2, 4, 6]);
});

test('sync: a negative time for a silent first bar', () => {
  const { song: s } = syncToAudio(song(), parseSyncPoints('2=0.05'), 'a.mp3');
  assert.ok(Math.abs(s.audio!.start - -3.95) < 1e-9);
});

test('sync: the original song is left alone, and --bars stays aligned afterwards', () => {
  const original = song({ firstSound: 4 });
  const before = structuredClone(original);
  const { song: s } = syncToAudio(original, parseSyncPoints('1=0,3=4'), 'a.mp3');
  assert.deepEqual(original, before);
  assert.equal(s.firstSound, 2);
  // Bar 3 is 4 s into the recording, so a slice starting there plays the audio from 4 s.
  assert.equal(sliceBars(s, 3, 4).audio?.start, 4);
});

test('sync: sync points past the end of the song are rejected', () => {
  assert.throws(() => syncToAudio(song(), parseSyncPoints('2=1,9=20'), 'a.mp3'), /Song only has 4 bars/);
});
