import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envelope, findAttacks, SAMPLE_RATE } from '../src/audio.ts';

/** Deterministic noise in -1..1. */
function noise(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return (x / 2147483648) * 2 - 1;
  };
}

/** Quiet noise, with bursts that start at `at` and decay over `decay` seconds. */
function signal(seconds: number, bursts: { at: number; level: number; decay: number }[]): Float32Array {
  const rnd = noise(7);
  const x = new Float32Array(seconds * SAMPLE_RATE);
  for (let i = 0; i < x.length; i++) {
    const t = i / SAMPLE_RATE;
    let a = 0.005;
    for (const b of bursts) if (t >= b.at) a += b.level * Math.exp(-(t - b.at) / b.decay);
    x[i] = a * rnd();
  }
  return x;
}

test('audio: a crash is a sharp attack that rings; a hi-hat is short', () => {
  const x = signal(4, [
    { at: 1.0, level: 0.5, decay: 0.5 }, // crash
    { at: 2.0, level: 0.3, decay: 0.015 }, // hi-hat
    { at: 3.0, level: 0.5, decay: 0.5 }, // crash
  ]);
  const attacks = findAttacks(envelope(x));
  const near = (t: number) => attacks.filter((a) => Math.abs(a.time - t) < 0.03);
  for (const t of [1.0, 3.0]) {
    assert.equal(near(t).length, 1, `one attack at ${t}`);
    assert.ok(Math.abs(near(t)[0].time - t) < 0.004, `on time: ${near(t)[0].time}`);
    assert.ok(near(t)[0].strength > 0.9, `crash strength ${near(t)[0].strength}`);
  }
  assert.equal(near(2.0).length, 1);
  assert.ok(near(2.0)[0].strength < 0.5, `hi-hat strength ${near(2.0)[0].strength}`);
  // Nothing in the quiet parts.
  assert.equal(attacks.length, 3);
});

test('audio: the envelope is in dB per millisecond', () => {
  const env = envelope(new Float32Array(SAMPLE_RATE).fill(0.1));
  assert.equal(env.length, 1000);
  assert.ok(Math.abs(env[500] - -20) < 0.01);
});
