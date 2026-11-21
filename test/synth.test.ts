import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTimeline, makeGeometry } from '../src/layout.ts';
import type { Note, Song } from '../src/model.ts';
import { tabTrack } from '../src/synth.ts';

const RATE = 48000;

/** 60 bpm 4/4 in standard tuning: a beat is 1 s. String 0 is the high E (MIDI 64), so fret 5 there is A4 = 440 Hz. */
function song(notes: Note[]): Song {
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
  };
}

/** Renders `notes` without a count-in: the video starts 1 s before song time 0, so song time t is video time t + 1 (at 100%). */
function play(notes: Note[], speed = 1, countInBars = 0) {
  const s = song(notes);
  const tl = buildTimeline(s, makeGeometry(1920, 1080, 6, 1), countInBars);
  return { samples: tabTrack(s, tl, speed, RATE), tl };
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** How strongly `freq` is present in samples[from..to) seconds (Goertzel), normalised by length. */
function strength(samples: Float32Array, freq: number, from: number, to: number): number {
  const a = Math.round(from * RATE), b = Math.round(to * RATE);
  const w = (2 * Math.PI * freq) / RATE;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) {
    const s = samples[i] + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / (b - a);
}

function peak(samples: Float32Array, from: number, to: number): number {
  let p = 0;
  for (let i = Math.round(from * RATE); i < Math.min(samples.length, Math.round(to * RATE)); i++) p = Math.max(p, Math.abs(samples[i]));
  return p;
}

test('synth: a note sounds at its pitch, when it is played, for as long as it lasts', () => {
  const { samples, tl } = play([{ time: 0, duration: 1, string: 0, fret: 5 }]);
  assert.equal(samples.length, Math.ceil((tl.end - tl.start) * RATE));
  assert.equal(peak(samples, 0, 0.999), 0, 'silent before the note');
  assert.ok(peak(samples, 1, 1.01) > 0.1, 'the note starts on time');
  assert.ok(strength(samples, 440, 1.1, 1.9) > 10 * strength(samples, hz(68), 1.1, 1.9), 'A4, not G#4');
  assert.ok(strength(samples, 440, 1.1, 1.9) > 10 * strength(samples, hz(70), 1.1, 1.9), 'A4, not A#4');
  assert.ok(peak(samples, 1.9, 1.95) > 0.1, 'still sounding near its end');
  assert.ok(peak(samples, 2.05, tl.end - tl.start) < 0.001, 'and silent after it');
});

test('synth: every note of a chord sounds, without clipping', () => {
  // An E minor shape on the top three strings: G3 (open G), B3 (open B), E4 (open E).
  const chord = [0, 1, 2].map((string) => ({ time: 0, duration: 1, string, fret: 0 }));
  const { samples } = play(chord);
  for (const midi of [55, 59, 64]) {
    assert.ok(strength(samples, hz(midi), 1.1, 1.9) > 5 * strength(samples, hz(midi + 1), 1.1, 1.9), `MIDI ${midi} sounds`);
  }
  assert.ok(peak(samples, 0, 3) <= 1, 'no clipping');
});

test('synth: a slowed-down video plays the notes longer, at the same pitch', () => {
  const { samples } = play([{ time: 0, duration: 1, string: 0, fret: 5 }], 0.5);
  // At 50% song time t is video time (t + 1) * 2: the note runs from 2 s to 4 s.
  assert.equal(peak(samples, 0, 1.999), 0);
  assert.ok(peak(samples, 3.8, 3.95) > 0.1, 'still sounding at 3.9 s');
  assert.ok(strength(samples, 440, 2.1, 3.9) > 10 * strength(samples, hz(70), 2.1, 3.9), 'still A4');
});

test('synth: a bend rises to the bent pitch', () => {
  const { samples } = play([{ time: 0, duration: 1, string: 0, fret: 5, bend: 2 }]);
  // Starts on A4, ends a whole step up on B4.
  assert.ok(strength(samples, hz(71), 1.5, 1.95) > 5 * strength(samples, 440, 1.5, 1.95), 'held at B4');
});

test('synth: a slide glides from the previous note into the next', () => {
  const { samples } = play([
    { time: 0, duration: 0.5, string: 0, fret: 5 },
    { time: 0.5, duration: 0.5, string: 0, fret: 7, technique: 'slide' },
  ]);
  assert.ok(strength(samples, 440, 1.1, 1.45) > 5 * strength(samples, hz(71), 1.1, 1.45), 'A4 first');
  assert.ok(strength(samples, hz(71), 1.65, 1.95) > 5 * strength(samples, 440, 1.65, 1.95), 'then B4');
  // No gap: the string keeps sounding through the slide.
  assert.ok(peak(samples, 1.48, 1.52) > 0.1, 'no gap between the notes');
});

test('synth: dead and palm-muted notes are short', () => {
  for (const extra of [{ dead: true }, { palmMute: true }]) {
    const { samples } = play([{ time: 0, duration: 1, string: 5, fret: 0, ...extra }]);
    assert.ok(peak(samples, 1, 1.03) > 0.05, `${Object.keys(extra)[0]}: sounds`);
    assert.ok(peak(samples, 1.15, 2) < 0.001, `${Object.keys(extra)[0]}: but stops well before the note's length`);
  }
});

test('synth: a harmonic sounds the harmonic, not the fretted note', () => {
  // The 7th-fret harmonic on the high E is B5 (an octave and a fifth up), not the fretted B4.
  const { samples } = play([{ time: 0, duration: 1, string: 0, fret: 7, harmonic: true }]);
  assert.ok(strength(samples, hz(83), 1.1, 1.9) > 10 * strength(samples, hz(71), 1.1, 1.9));
});

test('synth: the count-in is clicked before the tab plays', () => {
  const { samples, tl } = play([{ time: 0, duration: 1, string: 0, fret: 5 }], 1, 1);
  // Count-in beats at song time -4..-1, so video time 1..4 s; the note at 5 s.
  assert.equal(tl.start, -5);
  for (const t of [1, 2, 3, 4]) assert.ok(peak(samples, t, t + 0.02) > 0.1, `click at ${t} s`);
  assert.ok(peak(samples, 4.2, 4.99) < 0.001, 'nothing between the count-in and the first note');
  assert.ok(peak(samples, 5, 5.01) > 0.1, 'then the note');
});
