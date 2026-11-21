/**
 * A metronome click for videos without a backing track: one click per beat,
 * count-in included, with the first beat of every bar accented.
 *
 * Clicks are placed on the video's timeline, so a slowed-down video clicks at
 * the slowed-down tempo; the click sound itself is the same at every speed.
 *
 * The sound is synthesised here (a buzzy pocket-synth beep), not sampled; synth.ts
 * plays the tab itself in the same voice.
 */
import type { Timeline } from './layout.ts';
import type { Song } from './model.ts';

export const CLICK_SAMPLE_RATE = 48000;

export interface Click {
  /** Seconds into the video. */
  time: number;
  accent: boolean;
}

/**
 * When the clicks happen in a video of `song` rendered with timeline `tl` at `speed` (1 = 100%):
 * on every beat, or only on the count-in.
 */
export function clickTimes(song: Song, tl: Timeline, speed: number, which: 'all' | 'count-in' = 'all'): Click[] {
  const key = (t: number) => Math.round(t * 1e6);
  const barStarts = new Set(song.bars.map(key));
  const countIn = tl.countInBeats.map((t, i) => ({ t, accent: i % song.beatsPerBar === 0 }));
  const beats = which === 'all' ? song.beats.map((t) => ({ t, accent: barStarts.has(key(t)) })) : [];
  return [...countIn, ...beats]
    .filter(({ t }) => t >= tl.start && t <= tl.end)
    .map(({ t, accent }) => ({ time: (t - tl.start) / speed, accent }));
}

/** The clicks as mono samples (-1..1) for a video of `duration` seconds. */
export function clickTrack(clicks: Click[], duration: number, rate = CLICK_SAMPLE_RATE): Float32Array {
  const out = new Float32Array(Math.ceil(duration * rate));
  // A4 on the accent, E4 on the other beats.
  const sounds = { accent: blip(440, 0.6, rate), beat: blip(329.63, 0.4, rate) };
  for (const { time, accent } of clicks) {
    const sound = accent ? sounds.accent : sounds.beat;
    const from = Math.round(time * rate);
    for (let i = Math.max(0, -from); i < sound.length && from + i < out.length; i++) out[from + i] += sound[i];
  }
  return out;
}

/**
 * A short buzzy beep, like a stylus tapped on a pocket synth: a pulse wave
 * switched on and off (no fade beyond a few ms to avoid pops), played through
 * a "small speaker" that takes away the deep lows and the highest highs.
 * Its loudest sample is `level`.
 */
function blip(pitch: number, level: number, rate: number): Float32Array {
  const attack = 0.001;
  const hold = 0.06;
  const release = 0.012;
  const out = new Float32Array(Math.round((attack + hold + release + 0.005) * rate));

  // A pulse wave with a 30% duty cycle (nasal and reedy; 50% would be a hollower square),
  // built from its harmonics up to just below half the sample rate so it doesn't alias.
  const duty = 0.3;
  const harmonics: number[] = [];
  for (let k = 1; k * pitch < rate * 0.45; k++) harmonics.push(Math.sin(Math.PI * k * duty) / k);

  // One-pole high-pass (~250 Hz) and low-pass (~4 kHz): the tinny speaker.
  const hp = Math.exp((-2 * Math.PI * 250) / rate);
  const lp = 1 - Math.exp((-2 * Math.PI * Math.min(4000, rate * 0.45)) / rate);
  let hpIn = 0, hpOut = 0, lpOut = 0;

  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const gate = t < attack ? t / attack
      : t < attack + hold ? 1
      : Math.max(0, 1 - (t - attack - hold) / release);
    let x = 0;
    for (let k = 0; k < harmonics.length; k++) x += harmonics[k] * Math.cos(2 * Math.PI * (k + 1) * pitch * t);
    x *= gate;
    hpOut = hp * (hpOut + x - hpIn);
    hpIn = x;
    lpOut += lp * (hpOut - lpOut);
    out[i] = lpOut;
  }

  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  for (let i = 0; i < out.length; i++) out[i] *= level / peak;
  return out;
}
