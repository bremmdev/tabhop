import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeLeadIn, leadIn, sliceBars } from '../src/load.ts';
import { parseAsciiTab } from '../src/parsers/asciiTab.ts';
import type { Note, Song } from '../src/model.ts';

/** 4 bars of 4/4 at 60 bpm: bars start at 0, 4, 8, 12 s and the song ends at 16 s. */
function song(overrides: Partial<Song> = {}): Song {
  const note = (time: number, fret: number, duration = 1): Note => ({ time, duration, string: 0, fret });
  return {
    title: 'T',
    artist: '',
    tuning: [64, 59, 55, 50, 45, 40],
    notes: [note(0, 1), note(4, 2), note(6, 3, 3), note(8, 4), note(12, 5), note(15, 6)],
    bars: [0, 4, 8, 12],
    beats: Array.from({ length: 16 }, (_, i) => i),
    sections: [
      { time: 0, text: 'Intro' },
      { time: 8, text: 'Verse' },
    ],
    chords: [
      { time: 4, text: 'E5' },
      { time: 8, text: 'G5' },
    ],
    end: 16,
    bpm: 60,
    beatsPerBar: 4,
    ...overrides,
  };
}

test('sliceBars: keeps only the chosen bars and shifts them to start at 0', () => {
  const s = sliceBars(song(), 2, 3);
  assert.deepEqual(s.notes.map((n) => [n.time, n.fret]), [[0, 2], [2, 3], [4, 4]]);
  assert.deepEqual(s.bars, [0, 4]);
  assert.deepEqual(s.beats, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(s.chords, [{ time: 0, text: 'E5' }, { time: 4, text: 'G5' }]);
  assert.equal(s.end, 8);
});

test('sliceBars: a single bar, and a range ending at the last bar', () => {
  const one = sliceBars(song(), 3, 3);
  assert.deepEqual(one.notes.map((n) => n.fret), [4]);
  assert.equal(one.end, 4);

  const last = sliceBars(song(), 4, 4);
  assert.deepEqual(last.notes.map((n) => [n.time, n.fret]), [[0, 5], [3, 6]]);
  assert.equal(last.end, 4);
});

test('sliceBars: an end bar past the song is clamped to the end', () => {
  const s = sliceBars(song(), 3, 99);
  assert.deepEqual(s.notes.map((n) => n.fret), [4, 5, 6]);
  assert.equal(s.end, 8);
});

test('sliceBars: notes ringing past the end of the range are cut at the range end', () => {
  // The note at 6 s lasts 3 s, so it would ring 1 s into bar 3.
  const s = sliceBars(song(), 2, 2);
  assert.deepEqual(s.notes.map((n) => [n.time, n.duration]), [[0, 1], [2, 2]]);
});

test('sliceBars: keeps the label of the section the range starts in', () => {
  // Starting inside the Intro: its label is carried to time 0.
  assert.deepEqual(sliceBars(song(), 2, 3).sections, [
    { time: 0, text: 'Intro' },
    { time: 4, text: 'Verse' },
  ]);
  // Starting exactly on a section: no duplicate label.
  assert.deepEqual(sliceBars(song(), 3, 4).sections, [{ time: 0, text: 'Verse' }]);
  // No sections at all.
  assert.deepEqual(sliceBars(song({ sections: [] }), 2, 3).sections, []);
});

test('sliceBars: moves the audio start so the backing track stays aligned', () => {
  const s = sliceBars(song({ audio: { path: 'a.mp3', start: 10 } }), 3, 4);
  assert.deepEqual(s.audio, { path: 'a.mp3', start: 18 });
  assert.equal(sliceBars(song(), 3, 4).audio, undefined);
});

test('sliceBars: does not change the original song', () => {
  const original = song({ audio: { path: 'a.mp3', start: 10 } });
  const before = structuredClone(original);
  sliceBars(original, 2, 2);
  assert.deepEqual(original, before);
});

test('sliceBars: rejects ranges that select no bars', () => {
  assert.throws(() => sliceBars(song(), 3, 2), /Invalid bar range 3-2: the first bar must not come after the last/);
  assert.throws(() => sliceBars(song(), 5, 6), /Song only has 4 bars/);
});

test('leadIn: counts the silent bars before the first sound', () => {
  // First note at the start of bar 3.
  assert.deepEqual(leadIn(song({ notes: [{ time: 8, duration: 1, string: 0, fret: 1 }] })), { time: 8, silentBars: 2 });
  // A pickup: the first note is part-way into bar 1.
  assert.deepEqual(leadIn(song({ notes: [{ time: 3, duration: 1, string: 0, fret: 1 }] })), { time: 3, silentBars: 0 });
  // Starts right away.
  assert.equal(leadIn(song()), undefined);
});

test('leadIn: uses firstSound when other instruments play before this track', () => {
  const s = song({ notes: [{ time: 8, duration: 1, string: 0, fret: 1 }] });
  assert.equal(leadIn({ ...s, firstSound: 0 }), undefined);
  assert.deepEqual(leadIn({ ...s, firstSound: 4 }), { time: 4, silentBars: 1 });
});

test('leadIn: ignores notes ordered out of time', () => {
  const n = (time: number) => ({ time, duration: 1, string: 0, fret: 1 });
  assert.deepEqual(leadIn(song({ notes: [n(9), n(4.5)] })), { time: 4.5, silentBars: 1 });
});

test('leadIn: an ASCII tab whose first bar is all dashes', () => {
  const tab = parseAsciiTab(`bpm: 120
e|--------|--------|
B|--------|--------|
G|--------|--------|
D|--------|--------|
A|--------|-2------|
E|--------|-0------|`);
  assert.deepEqual(leadIn(tab), { time: 2, silentBars: 1 });
});

test('describeLeadIn: says which bars are silent and when the music starts', () => {
  assert.equal(describeLeadIn({ time: 1.548, silentBars: 1 }), 'bar 1 is silent, the first note is at 1.548 s');
  assert.equal(describeLeadIn({ time: 8, silentBars: 2 }), 'bars 1-2 are silent, the first note is at 8 s');
  assert.equal(describeLeadIn({ time: 1.5, silentBars: 0 }), 'the first note is at 1.5 s, part-way into bar 1');
});

test('sliceBars: drops firstSound, which only describes the full song', () => {
  assert.equal(sliceBars(song({ firstSound: 2 }), 2, 3).firstSound, undefined);
});
