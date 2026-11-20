/**
 * Finding cymbal crashes in a recording, as landmarks for `tabhop sync`.
 *
 * Above ~7 kHz a mix is mostly cymbals. A crash shows up there as a fast jump
 * in level that rings on for a while; hi-hats and ride hits are shorter. Guitar
 * and bass attacks are useless as landmarks in dense music: they come every 8th
 * note, so matching them happily slips by one.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const SAMPLE_RATE = 24000;
/** Envelope frames are 1 ms. */
const HOP = SAMPLE_RATE / 1000;

export interface Attack {
  /** Seconds into the recording. */
  time: number;
  /** 0..1: how crash-like (sharp and ringing) it is. */
  strength: number;
}

/** The recording above 7 kHz as mono samples at SAMPLE_RATE. Needs ffmpeg. */
export async function readHighBand(path: string): Promise<Float32Array> {
  const args = ['-v', 'error', '-i', path, '-af', 'highpass=f=7000,highpass=f=7000', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'];
  let stdout: Buffer;
  try {
    ({ stdout } = await promisify(execFile)('ffmpeg', args, { encoding: 'buffer', maxBuffer: 2 ** 31 }));
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer };
    if (err.code === 'ENOENT') throw new Error('ffmpeg was not found on PATH');
    throw new Error(`ffmpeg could not read "${path}": ${err.stderr?.toString().trim() || err.message}`);
  }
  // Copy: the Buffer may not be 4-byte aligned.
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + (stdout.length & ~3)));
}

/** Level in dB per 1 ms frame, smoothed over ±4 ms. */
export function envelope(samples: Float32Array): Float32Array {
  const n = Math.floor(samples.length / HOP);
  const raw = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let k = f * HOP; k < (f + 1) * HOP; k++) e += samples[k] * samples[k];
    raw[f] = 10 * Math.log10(1e-12 + e / HOP);
  }
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    let c = 0;
    for (let d = -4; d <= 4; d++) {
      if (f + d >= 0 && f + d < n) {
        s += raw[f + d];
        c++;
      }
    }
    out[f] = s / c;
  }
  return out;
}

const mean = (env: Float32Array, from: number, to: number) => {
  let s = 0;
  let c = 0;
  for (let f = Math.max(0, from); f < Math.min(env.length, to); f++) {
    s += env[f];
    c++;
  }
  return c ? s / c : -120;
};

/**
 * Attacks in the high band: places where the level jumps by at least 4 dB
 * within 20 ms. Strength combines the jump and how long the sound then rings
 * above the level before it.
 */
export function findAttacks(env: Float32Array): Attack[] {
  const RISE = 20;
  const rise = (f: number) => env[f] - env[Math.max(0, f - RISE)];
  const attacks: Attack[] = [];
  for (let f = RISE; f < env.length; f++) {
    const r = rise(f);
    if (r < 4) continue;
    // Strongest rise within ±30 ms only.
    let peak = true;
    for (let d = -30; d <= 30 && peak; d++) {
      const g = f + d;
      if (d !== 0 && g >= RISE && g < env.length && (rise(g) > r || (rise(g) === r && d < 0))) peak = false;
    }
    if (!peak) continue;
    const before = mean(env, f - 100 - RISE, f - RISE);
    const ring = mean(env, f + 50, f + 250) - before;
    const sharp = Math.min(1, (r - 4) / 10);
    const rings = Math.min(1, Math.max(0, ring / 8));
    // The 20 ms rise is about as big anywhere from the onset to the peak, so time the
    // attack by where the level climbs fastest.
    let onset = f;
    let steepest = -Infinity;
    for (let g = Math.max(2, f - RISE); g <= f && g + 2 < env.length; g++) {
      const s = env[g + 2] - env[g - 2];
      if (s > steepest) {
        steepest = s;
        onset = g;
      }
    }
    attacks.push({ time: onset / 1000, strength: 0.2 + 0.8 * Math.sqrt(sharp * rings) });
  }
  return attacks;
}
