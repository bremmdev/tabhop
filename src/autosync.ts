/**
 * Suggesting sync points automatically (`tabhop sync`).
 *
 * The tab's crash cymbals are matched to crash-like attacks in the recording
 * (see audio.ts). Knots every couple of bars get a time in the recording; in
 * between, the tab is stretched linearly, as with `--sync`.
 *
 * The knots are found by dynamic programming over all monotonic paths, so the
 * fit can't get stuck on a wrong start: first coarsely over the whole
 * recording, then twice more finely around that, preferring a steady tempo.
 * Cymbals alone are often ambiguous (a pattern repeats every bar, or the band
 * plays it a little differently), and a band keeps its tempo for a while.
 *
 * To say how far the result can be trusted, the fit is repeated on half the
 * cymbals and checked against the other half, and each section is checked for
 * whether the cymbals fit just as well shifted (see `SectionCheck`).
 */
import type { Attack } from './audio.ts';
import type { Song } from './model.ts';
import { barTime, type SyncPoint } from './sync.ts';

export interface AutoSyncOptions {
  /** Bars between knots before thinning. */
  every?: number;
  /** Points the user already knows; kept exactly. */
  pinned?: SyncPoint[];
}

export interface SectionCheck {
  fromBar: number;
  /** Inclusive. */
  toBar: number;
  label?: string;
  /** Cymbals in the tab within the recording (runs left out). */
  cymbals: number;
  /** Held-out cymbals with a crash heard within 50 ms of where the fit puts them. */
  heard: number;
  /** Median distance of the held-out cymbals to the nearest crash (s), if any were found. */
  medianError?: number;
  /** How much faster the recording is than the tab here (1.03 = 3% faster). */
  tempoFactor: number;
  /** The section's cymbals fit about as well this many seconds later (or earlier, if negative). */
  alsoFits?: number;
}

export interface AutoSyncResult {
  points: SyncPoint[];
  checks: SectionCheck[];
  /** Cymbals in the tab (whole song), and how many have a crash within 50 ms in the final fit (runs left out). */
  cymbals: number;
  matched: number;
  /** The recording ends inside this bar, if before the end of the tab. */
  recordingEndsInBar?: number;
  /** Runs of cymbals in the tab (rolls, fills) the recording mostly doesn't have; left out of the fit. */
  unheardRuns: { fromBar: number; toBar: number; cymbals: number }[];
}

/** Recording seconds per tab second. Breaks and pauses held longer than written need room to slow down. */
const MIN_SLOPE = 0.75;
const MAX_SLOPE = 1.6;
/** Cost of a tempo change, per unit of log slope; one well-matched crash is worth about 1. */
const TEMPO_COST = 4;
const HEARD = 0.05;

interface Knot {
  bar: number;
  tab: number;
  pinned?: number;
}

/** Crash evidence per 1 ms of recording: 1 at a clear crash, falling off over `sigma`. */
export function evidence(attacks: Attack[], duration: number, sigma: number): Float32Array {
  const e = new Float32Array(Math.ceil(duration * 1000) + 1);
  const reach = Math.ceil(3 * sigma * 1000);
  for (const a of attacks) {
    // Squared, so the many weaker attacks (strums, hi-hats) count for less than clear crashes.
    const w = a.strength * a.strength;
    const c = Math.round(a.time * 1000);
    for (let f = Math.max(0, c - reach); f <= Math.min(e.length - 1, c + reach); f++) {
      const d = (f / 1000 - a.time) / sigma;
      const v = w * Math.exp(-0.5 * d * d);
      if (v > e[f]) e[f] = v;
    }
  }
  return e;
}

interface Segment {
  dt: number;
  /** Cymbals inside, as a fraction of the segment, with a weight. */
  cymbals: { u: number; w: number }[];
}

interface Cymbal {
  t: number;
  w: number;
}

/**
 * How much each cymbal counts. A run of them (a roll, or crashes on every 8th)
 * counts about as much as one crash: it's easy to match a step off, and the band
 * may well play it differently. A crash on the first beat of a bar marks a
 * phrase and is nearly always played as written, so it counts most.
 */
function weigh(song: Song, times: number[]): Cymbal[] {
  return times.map((t) => {
    const run = times.filter((x) => Math.abs(x - t) < 0.25).length;
    const downbeat = Math.abs(t - song.bars[barOf(song, t) - 1]) < 1e-3;
    return { t, w: (downbeat ? 1 : 0.6) / run };
  });
}

function segments(knots: Knot[], cymbals: Cymbal[]): Segment[] {
  let c = 0;
  return knots.slice(1).map((k, j) => {
    const [a, b] = [knots[j].tab, k.tab];
    const last = j === knots.length - 2;
    // 1 µs of slack: a cymbal on a knot's bar line belongs to the segment it starts.
    while (c < cymbals.length && cymbals[c].t < a - 1e-6) c++;
    const cs: Segment['cymbals'] = [];
    for (let i = c; i < cymbals.length && (cymbals[i].t < b - 1e-6 || (last && cymbals[i].t <= b + 1e-6)); i++) {
      cs.push({ u: (cymbals[i].t - a) / (b - a), w: cymbals[i].w });
    }
    return { dt: b - a, cymbals: cs };
  });
}

/** Evidence for a segment that starts at `a` in the recording and lasts `span`. */
function segmentScore(seg: Segment, ev: Float32Array, a: number, span: number): number {
  let s = 0;
  for (const { u, w } of seg.cymbals) {
    const f = Math.round((a + u * span) * 1000);
    if (f >= 0 && f < ev.length) s += w * ev[f];
  }
  return s;
}

function bestPath(score: Float64Array, back: Int32Array[]): number[] {
  let q = 0;
  for (let k = 1; k < score.length; k++) if (score[k] > score[q]) q = k;
  if (score[q] === -Infinity) {
    throw new Error("The sync points can't be fitted: the recording is too short, or two of them are too close together");
  }
  const path = [q];
  for (let j = back.length - 1; j >= 0; j--) path.unshift((q = back[j][q]));
  return path;
}

/**
 * Coarse alignment: the best time for every knot among `S[j]`. A tempo away
 * from the tab's costs a little, so a stretch with little evidence stays sane.
 */
function viterbi1(segs: Segment[], ev: Float32Array, S: Float64Array[]): number[] {
  let score = new Float64Array(S[0].length);
  const back: Int32Array[] = [];
  segs.forEach((seg, j) => {
    const [from, to] = [S[j], S[j + 1]];
    const next = new Float64Array(to.length).fill(-Infinity);
    const arg = new Int32Array(to.length).fill(-1);
    let lo = 0;
    for (let p = 0; p < from.length; p++) {
      if (score[p] === -Infinity) continue;
      const a = from[p];
      while (lo < to.length && to[lo] < a + MIN_SLOPE * seg.dt) lo++;
      for (let q = lo; q < to.length && to[q] <= a + MAX_SLOPE * seg.dt; q++) {
        const span = to[q] - a;
        const s = score[p] - TEMPO_COST * Math.abs(Math.log(span / seg.dt)) + segmentScore(seg, ev, a, span);
        if (s > next[q]) {
          next[q] = s;
          arg[q] = p;
        }
      }
    }
    back.push(arg);
    score = next;
  });
  return bestPath(score, back).map((s, j) => S[j][s]);
}

/**
 * Refinement: like viterbi1, but what costs is a change of tempo from one
 * segment to the next, so of two readings that fit the cymbals about equally,
 * the steadier one wins. States are pairs (previous knot, this knot).
 */
function viterbi2(segs: Segment[], ev: Float32Array, S: Float64Array[]): number[] {
  const n = (j: number) => S[j].length;
  /** Log slope of segment j between state p of knot j and state q of knot j+1, or NaN if out of range. */
  const slope = (j: number, p: number, q: number) => {
    const r = (S[j + 1][q] - S[j][p]) / segs[j].dt;
    return r >= MIN_SLOPE && r <= MAX_SLOPE ? Math.log(r) : NaN;
  };
  // score[p * n(j+1) + q]: best path with knot j at state p and knot j+1 at state q.
  let score = new Float64Array(n(0) * n(1)).fill(-Infinity);
  for (let p = 0; p < n(0); p++) {
    for (let q = 0; q < n(1); q++) {
      if (!Number.isNaN(slope(0, p, q))) score[p * n(1) + q] = segmentScore(segs[0], ev, S[0][p], S[1][q] - S[0][p]);
    }
  }
  const back: Int32Array[] = [];
  for (let j = 1; j < segs.length; j++) {
    const [np, nq, nr] = [n(j - 1), n(j), n(j + 1)];
    const prevSlope = new Float64Array(np);
    const next = new Float64Array(nq * nr).fill(-Infinity);
    const arg = new Int32Array(nq * nr).fill(-1);
    for (let q = 0; q < nq; q++) {
      for (let p = 0; p < np; p++) prevSlope[p] = slope(j - 1, p, q);
      for (let r = 0; r < nr; r++) {
        const l = slope(j, q, r);
        if (Number.isNaN(l)) continue;
        let best = -Infinity;
        let bp = -1;
        for (let p = 0; p < np; p++) {
          const prev = score[p * nq + q];
          if (prev === -Infinity) continue;
          const s = prev - TEMPO_COST * Math.abs(l - prevSlope[p]);
          if (s > best) {
            best = s;
            bp = p;
          }
        }
        if (bp < 0) continue;
        next[q * nr + r] = best + segmentScore(segs[j], ev, S[j][q], S[j + 1][r] - S[j][q]);
        arg[q * nr + r] = bp * nq + q;
      }
    }
    back.push(arg);
    score = next;
  }
  // path[k] is the pair (knot k, knot k+1).
  const path = bestPath(score, back);
  return [S[0][Math.floor(path[0] / n(1))], ...path.map((pair, k) => S[k + 1][pair % n(k + 1)])];
}

function grid(from: number, to: number, step: number): Float64Array {
  const n = Math.max(1, Math.floor((to - from) / step) + 1);
  return Float64Array.from({ length: n }, (_, i) => from + i * step);
}

/** Recording time for a tab time, linear between knots and carrying on past the ends. */
function interpolate(tab: number[], audio: number[], t: number): number {
  if (tab.length === 1) return audio[0] + t - tab[0];
  let i = 0;
  while (i < tab.length - 2 && t >= tab[i + 1]) i++;
  return audio[i] + ((t - tab[i]) * (audio[i + 1] - audio[i])) / (tab[i + 1] - tab[i]);
}

interface Evidence {
  coarse: Float32Array;
  fine: Float32Array;
  duration: number;
}

interface Fit {
  knots: Knot[];
  audio: number[];
}

function fit(knotsIn: Knot[], cymbals: Cymbal[], ev: Evidence): Fit {
  const states = (knots: Knot[], at: (j: number) => Float64Array) =>
    knots.map((k, j) => (k.pinned !== undefined ? Float64Array.of(k.pinned) : at(j)));
  let knots = knotsIn;
  // 1. Every 25 ms anywhere in the recording: roughly where the song is.
  const wide = grid(-2, ev.duration + 10, 0.025);
  let audio = viterbi1(segments(knots, cymbals), ev.coarse, states(knots, () => wide));
  // Knots with no cymbals on either side only bend the line without evidence: drop them,
  // so a stretch without cymbals keeps one steady tempo between the ones around it.
  const hasCymbals = (a: number, b: number) => cymbals.some(({ t }) => t >= a - 1e-6 && t <= b + 1e-6);
  const keep = knots.map((k, j) => j === 0 || j === knots.length - 1 || k.pinned !== undefined
    || hasCymbals(knots[j - 1].tab, knots[j + 1].tab));
  knots = knots.filter((_, j) => keep[j]);
  audio = audio.filter((_, j) => keep[j]);
  const segs = segments(knots, cymbals);
  if (segs.length < 2) return { knots, audio };
  // 2. Within ±0.6 s, preferring a steady tempo: fixes readings a beat or two off.
  const a1 = audio;
  audio = viterbi2(segs, ev.coarse, states(knots, (j) => grid(a1[j] - 0.6, a1[j] + 0.6, 0.025)));
  // 3. Every 2 ms within ±40 ms.
  const a2 = audio;
  audio = viterbi2(segs, ev.fine, states(knots, (j) => grid(a2[j] - 0.04, a2[j] + 0.04, 0.002)));
  return { knots, audio };
}

const mapWith = (f: Fit, t: number) => interpolate(f.knots.map((k) => k.tab), f.audio, t);

/** Distance from each predicted time to the nearest clear attack, or undefined if none within 100 ms. */
function errors(predicted: number[], attacks: Attack[]): (number | undefined)[] {
  const clear = attacks.filter((a) => a.strength >= 0.4).map((a) => a.time);
  return predicted.map((p) => {
    let best: number | undefined;
    // Binary search for the first attack after p - 0.1.
    let lo = 0;
    let hi = clear.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (clear[m] < p - 0.1) lo = m + 1;
      else hi = m;
    }
    for (let i = lo; i < clear.length && clear[i] <= p + 0.1; i++) {
      const d = Math.abs(clear[i] - p);
      if (best === undefined || d < best) best = d;
    }
    return best;
  });
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * The best shift of a section's cymbals by less than a bar, if it fits nearly
 * as well as no shift: a sign the section may be a beat or so off. (Shifts by
 * whole bars nearly always fit too, since patterns repeat every bar; the
 * steady-tempo passes and the sections around rule those out.)
 */
function rivalShift(times: number[], weights: number[], ev: Float32Array, barLength: number): number | undefined {
  const at = (d: number) => times.reduce((s, t, i) => {
    const f = Math.round((t + d) * 1000);
    return s + (f >= 0 && f < ev.length ? weights[i] * ev[f] : 0);
  }, 0);
  let here = 0;
  for (let d = -0.05; d <= 0.05; d += 0.005) here = Math.max(here, at(d));
  let best = 0;
  let bestShift = 0;
  const reach = 0.75 * barLength;
  for (let d = -reach; d <= reach; d += 0.01) {
    if (Math.abs(d) < 0.15) continue;
    const s = at(d);
    if (s > best) {
      best = s;
      bestShift = d;
    }
  }
  return best >= 0.8 * here && best > 0 ? Math.round(bestShift * 100) / 100 : undefined;
}

const barOf = (song: Song, t: number) => Math.max(1, song.bars.findLastIndex((b) => b <= t + 1e-6) + 1);

/** Throws unless the tab has enough crash cymbals to line up with. */
export function checkCymbals(song: Song): void {
  const n = song.cymbals?.length ?? 0;
  if (n >= 4) return;
  const instead = 'Line it up by ear instead, with --audio-start or --sync "bar=time, ..." (see README.md).';
  throw new Error(
    n
      ? `The tab only has ${n} crash cymbal${n === 1 ? '' : 's'}: too few to line it up automatically.\n${instead}`
      : `The tab has no crash cymbals to line up with the recording: it needs a drum track with crashes (Guitar Pro, MusicXML or alphaTex).\n${instead}`,
  );
}

export function autoSync(song: Song, attacks: Attack[], duration: number, opts: AutoSyncOptions = {}): AutoSyncResult {
  checkCymbals(song);
  const all = song.cymbals!;
  const every = opts.every ?? 2;
  const pinned = (opts.pinned ?? []).map((p) => ({ bar: p.bar, tab: barTime(song, p.bar), pinned: p.time }));
  const firstBar = barOf(song, all[0]);
  const lastBar = Math.min(song.bars.length + 1, barOf(song, all[all.length - 1]) + 1);
  let knots: Knot[] = [];
  for (let b = firstBar; b < lastBar + every; b += every) {
    const bar = Math.min(b, lastBar);
    // Pinned points replace regular knots near them.
    if (!pinned.some((p) => Math.abs(p.bar - bar) < every / 2) && !knots.some((k) => k.bar === bar)) knots.push({ bar, tab: barTime(song, bar) });
  }
  knots.push(...pinned);
  knots.sort((a, b) => a.tab - b.tab);

  const ev: Evidence = { coarse: evidence(attacks, duration, 0.04), fine: evidence(attacks, duration, 0.015), duration };
  let weighted = weigh(song, all);
  let first = fit(knots, weighted, ev);
  const past = first.audio.findIndex((a) => a > duration);
  if (past >= 0 && past < first.knots.length - 1) {
    // The recording ends before the tab. Knots after the first one past its end are only
    // guesses, and get squeezed into the range searched: fit again without them.
    const end = first.knots[past].tab + 1e-6;
    knots = knots.filter((k) => k.tab <= end || k.pinned !== undefined);
    weighted = weighted.filter(({ t }) => t <= end);
    first = fit(knots, weighted, ev);
  }

  // Runs of 6 or more cymbals less than 0.3 s apart that the recording mostly doesn't have
  // (a roll the drummer doesn't play) only pull the fit around: leave them out and fit again.
  const inRecordingFor = (f: Fit) => (t: number) => mapWith(f, t) <= duration;
  const heardIn = (f: Fit, ts: number[]) => {
    const e = errors(ts.map((t) => mapWith(f, t)), attacks);
    return ts.filter((_, i) => e[i] !== undefined && e[i]! <= HEARD);
  };
  const unheardRuns: AutoSyncResult['unheardRuns'] = [];
  const skip = new Set<number>();
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1] - all[j] < 0.3) j++;
    const run = all.slice(i, j + 1).filter(inRecordingFor(first));
    const heard = new Set(heardIn(first, run));
    if (run.length >= 6 && heard.size < run.length / 4) {
      // The crashes around a roll may well be played: only leave out what isn't heard.
      const missing = run.filter((t) => !heard.has(t));
      unheardRuns.push({ fromBar: barOf(song, missing[0]), toBar: barOf(song, missing[missing.length - 1]), cymbals: missing.length });
      for (const t of missing) skip.add(t);
    }
    i = j + 1;
  }
  const used = weighted.filter(({ t }) => !skip.has(t));
  const final = skip.size ? fit(knots, used, ev) : first;

  // Held out: fit on every other cymbal, check the rest.
  const heldOut = new Map<number, number | undefined>();
  for (const parity of [0, 1]) {
    const train = used.filter((_, i) => i % 2 === parity);
    const test = used.filter((_, i) => i % 2 !== parity).map((c) => c.t);
    const f = fit(knots, train, ev);
    errors(test.map((t) => mapWith(f, t)), attacks).forEach((e, i) => heldOut.set(test[i], e));
  }

  const inRecording = inRecordingFor(final);
  // The last bar that starts inside the recording, if the tab goes on past its end.
  const endsIn = mapWith(final, song.end) > duration ? song.bars.findLastIndex((b) => mapWith(final, b) <= duration) + 1 : undefined;
  const usedInRecording = used.filter(({ t }) => inRecording(t));

  // Report per section, or per 16 bars without sections.
  const starts = song.sections.length >= 2
    ? song.sections.map((s) => ({ bar: barOf(song, s.time), label: s.text as string | undefined }))
    : Array.from({ length: Math.ceil(song.bars.length / 16) }, (_, i) => ({ bar: 1 + 16 * i, label: undefined as string | undefined }));
  const checks: SectionCheck[] = starts
    .map((s, i) => {
      const toBar = (starts[i + 1]?.bar ?? song.bars.length + 1) - 1;
      const [a, b] = [barTime(song, s.bar), barTime(song, toBar + 1)];
      const cs = usedInRecording.filter(({ t }) => t >= a - 1e-6 && t < b - 1e-6);
      const errs = cs.map(({ t }) => heldOut.get(t)).filter((e): e is number => e !== undefined);
      const barLength = (mapWith(final, b) - mapWith(final, a)) / (toBar + 1 - s.bar);
      const rival = cs.length ? rivalShift(cs.map(({ t }) => mapWith(final, t)), cs.map(({ w }) => w), ev.coarse, barLength) : undefined;
      return {
        fromBar: s.bar,
        toBar,
        ...(s.label ? { label: s.label } : {}),
        cymbals: cs.length,
        heard: errs.filter((e) => e <= HEARD).length,
        medianError: median(errs),
        tempoFactor: (b - a) / (mapWith(final, b) - mapWith(final, a)),
        ...(rival !== undefined ? { alsoFits: rival } : {}),
      };
    })
    .filter((c) => mapWith(final, barTime(song, c.fromBar)) < duration);

  // Output points: drop knots the line through their neighbours already puts within 5 ms.
  const pts = final.knots.map((k, j) => ({ bar: k.bar, tab: k.tab, time: final.audio[j], pinned: k.pinned !== undefined }));
  for (;;) {
    let drop = -1;
    let least = 0.005;
    for (let j = 1; j < pts.length - 1; j++) {
      if (pts[j].pinned) continue;
      const [a, b] = [pts[j - 1], pts[j + 1]];
      const d = Math.abs(a.time + ((pts[j].tab - a.tab) * (b.time - a.time)) / (b.tab - a.tab) - pts[j].time);
      if (d < least) {
        least = d;
        drop = j;
      }
    }
    if (drop < 0) break;
    pts.splice(drop, 1);
  }
  // Points past the end of the recording would only be guesses; keep one for the last tempo.
  while (pts.length > 2 && pts[pts.length - 2].time > duration) pts.pop();

  return {
    points: pts.map((p) => ({ bar: p.bar, time: Math.round(p.time * 1000) / 1000 })),
    checks,
    cymbals: all.length,
    matched: heardIn(final, usedInRecording.map(({ t }) => t)).length,
    ...(endsIn ? { recordingEndsInBar: endsIn } : {}),
    unheardRuns,
  };
}
