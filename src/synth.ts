/**
 * Plays the tab itself for videos without a backing track: every note at its
 * pitch (tuning + fret), chords as chords, in the buzzy voice of a pocket
 * stylus synth. The count-in is clicked (click.ts) so you know when to start.
 *
 * Synthesised from scratch, nothing sampled. Like the click, it is generated on
 * the video's timeline: a slowed-down video plays slower at the same pitch.
 */
import { clickTimes, clickTrack, CLICK_SAMPLE_RATE } from './click.ts';
import type { Timeline } from './layout.ts';
import type { Note, Song } from './model.ts';

export const SYNTH_SAMPLE_RATE = CLICK_SAMPLE_RATE;

/** Played without picking the string again: the note before it keeps ringing into it. */
const LEGATO = new Set(['hammer', 'pull', 'tap', 'slide']);

/** Semitones above the open string that a natural harmonic at a fret sounds. */
const HARMONICS: Record<number, number> = { 12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28, 16: 28, 3: 31 };

/** The pulse wave's duty cycle: 30% is nasal and reedy (50% would be a hollower square wave). */
const DUTY = 0.3;

/** Loudness of one note on its own; chords share out a little more than this. */
const LEVEL = 0.3;

/** Notes struck together are spread out by this much (low string first), like a quick strum. */
const STRUM = 0.006;

/** The mono samples (-1..1) for a video of `song` with timeline `tl` at `speed` (1 = 100%). */
export function tabTrack(song: Song, tl: Timeline, speed: number, rate = SYNTH_SAMPLE_RATE): Float32Array {
  const duration = (tl.end - tl.start) / speed;
  const notes = song.notes
    .filter((n) => n.time < tl.end && n.time + n.duration > tl.start)
    .sort((a, b) => a.time - b.time || b.string - a.string);

  const out = new Float32Array(Math.ceil(duration * rate));
  const pitchOf = (n: Note) => song.tuning[n.string] + (n.harmonic ? (HARMONICS[n.fret] ?? n.fret + 12) : n.fret);
  const { prev, next } = neighboursOnString(notes);
  const touching = (a: Note, b: Note) => b.time - (a.time + a.duration) < 0.05;
  const legatoInto = (n: Note) => !!n.technique && LEGATO.has(n.technique) && !!prev.get(n) && touching(prev.get(n)!, n);

  let chordStart = NaN, inChord = 0, chordSize = 1;
  for (const [i, n] of notes.entries()) {
    if (n.time !== chordStart) {
      chordStart = n.time;
      inChord = 0;
      chordSize = 1;
      while (notes[i + chordSize]?.time === n.time) chordSize++;
    }
    const legatoIn = legatoInto(n);
    const nextNote = next.get(n);
    const legatoOut = !!nextNote && legatoInto(nextNote);
    const from = prev.get(n);
    playNote(out, rate, {
      start: (n.time - tl.start) / speed + (legatoIn ? 0 : inChord++ * STRUM),
      length: n.duration / speed,
      midi: pitchOf(n),
      level: (LEVEL / Math.sqrt(chordSize)) * (legatoIn ? 0.8 : 1) * (n.palmMute ? 0.8 : 1) * (n.dead ? 0.6 : 1),
      legatoIn,
      legatoOut,
      slideFrom: n.technique === 'slide' && legatoIn && from ? pitchOf(from) : undefined,
      note: n,
    });
  }

  speaker(out, rate);
  // A dense passage can add up past full scale: turn the whole track down rather than clip it.
  let loudest = 0;
  for (const x of out) loudest = Math.max(loudest, Math.abs(x));
  if (loudest > 0.9) for (let i = 0; i < out.length; i++) out[i] *= 0.9 / loudest;

  const clicks = clickTrack(clickTimes(song, tl, speed, 'count-in'), duration, rate);
  for (let i = 0; i < out.length; i++) out[i] += clicks[i];
  return out;
}

/** Each note's previous and next note on the same string. */
function neighboursOnString(notes: Note[]) {
  const prev = new Map<Note, Note>(), next = new Map<Note, Note>();
  const last = new Map<number, Note>();
  for (const n of notes) {
    const p = last.get(n.string);
    if (p) {
      prev.set(n, p);
      next.set(p, n);
    }
    last.set(n.string, n);
  }
  return { prev, next };
}

interface Voice {
  /** Seconds into the video, and how long the note lasts in the video. */
  start: number;
  length: number;
  midi: number;
  level: number;
  /** Hammered, pulled, tapped or slid into: no fresh attack. */
  legatoIn: boolean;
  /** The next note on the string is legato: ring right up to it. */
  legatoOut: boolean;
  slideFrom?: number;
  note: Note;
}

function playNote(out: Float32Array, rate: number, v: Voice): void {
  const { note } = v;
  const attack = v.legatoIn ? 0.004 : 0.002;
  const release = v.legatoOut ? 0.006 : 0.01;
  // A short gap before the next note, as the finger lifts; muted and dead notes are cut short.
  let gate = v.length - (v.legatoOut ? 0 : Math.min(0.02, v.length * 0.15));
  if (note.palmMute) gate = Math.min(gate, 0.07);
  if (note.dead) gate = Math.min(gate, 0.025);
  gate = Math.max(gate, attack);

  const glide = v.slideFrom === undefined ? 0 : Math.min(0.08, gate * 0.4);
  const bendTime = Math.min(0.15, gate * 0.4);
  const slideOutTime = Math.min(0.15, gate * 0.4);

  /** Semitones away from the note's own pitch, `t` seconds into it. */
  const offset = (t: number): number => {
    let s = 0;
    if (glide && t < glide) s += (v.slideFrom! - v.midi) * (1 - t / glide);
    if (note.bend) s += note.bend * Math.min(1, t / bendTime);
    if (note.slideOut) {
      const into = t - (gate - slideOutTime);
      if (into > 0) s += (note.slideOut === 'up' ? 7 : -7) * (into / slideOutTime);
    }
    if (note.vibrato && t > 0.12) s += 0.25 * Math.sin(2 * Math.PI * 5.5 * (t - 0.12));
    return s;
  };

  const first = Math.max(0, Math.round(v.start * rate));
  const last = Math.min(out.length, Math.round((v.start + gate + release) * rate));
  let phase = 0;
  let noise = 12345; // dead notes are mostly noise: a fixed seed so every render sounds the same
  for (let i = first; i < last; i++) {
    const t = i / rate - v.start;
    if (t < 0) continue;
    let env = t < attack ? t / attack : t < gate ? 1 : 1 - (t - gate) / release;
    if (note.slideOut) env *= Math.min(1, Math.max(0, (gate - t) / slideOutTime) + 0.3);
    if (env <= 0) continue;

    const dt = (440 * 2 ** ((v.midi + offset(t) - 69) / 12)) / rate;
    let y = (phase < DUTY ? 1 : -1) + polyBlep(phase, dt) - polyBlep((phase + 1 - DUTY) % 1, dt);
    if (note.dead) {
      noise = (noise * 1103515245 + 12345) >>> 0;
      y = 0.3 * y + 0.7 * (noise / 2 ** 31 - 1);
    }
    out[i] += v.level * env * y;
    phase += dt;
    if (phase >= 1) phase -= 1;
  }
}

/** Smooths a jump in a waveform so it doesn't alias (a 2-sample polynomial band-limited step). */
function polyBlep(phase: number, dt: number): number {
  if (phase < dt) {
    const x = phase / dt;
    return x + x - x * x - 1;
  }
  if (phase > 1 - dt) {
    const x = (phase - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** A small speaker: no deep lows (one-pole high-pass, ~120 Hz), no top end (one-pole low-pass, ~5 kHz). */
function speaker(samples: Float32Array, rate: number): void {
  const hp = Math.exp((-2 * Math.PI * 120) / rate);
  const lp = 1 - Math.exp((-2 * Math.PI * Math.min(5000, rate * 0.45)) / rate);
  let hpIn = 0, hpOut = 0, lpOut = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    hpOut = hp * (hpOut + x - hpIn);
    hpIn = x;
    lpOut += lp * (hpOut - lpOut);
    samples[i] = lpOut;
  }
}
