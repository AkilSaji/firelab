/**
 * Statistics for the evaluation protocol and (later) the perf oracle, as in
 * docs/ENGINE.md 13.1. Non-parametric tests with effect sizes, as Arcuri and
 * Briand recommend for randomized algorithms [36], and Klees et al. for
 * fuzzers [37].
 */
import { median, percentile } from '../lib/stats.js';
import { createRng, type Rng } from './rng.js';

export { median, percentile };

/** Percentile bootstrap CI of a statistic [39]. */
export function bootstrapCI(
  stat: (xs: readonly number[]) => number,
  xs: readonly number[],
  opts: { B?: number; alpha?: number; rng?: Rng } = {},
): [lo: number, hi: number] {
  const B = opts.B ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rng = opts.rng ?? createRng(1);
  if (!xs.length) return [NaN, NaN];
  const reps: number[] = new Array(B);
  const sample: number[] = new Array(xs.length);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < xs.length; i++) sample[i] = xs[Math.floor(rng.next() * xs.length)] as number;
    reps[b] = stat(sample);
  }
  return [percentile(reps, (alpha / 2) * 100), percentile(reps, (1 - alpha / 2) * 100)];
}

/** Bootstrap CI of median(B) - median(A), resampling each group on its own [39]. */
export function bootstrapMedianDiffCI(A: readonly number[], B: readonly number[], opts: { B?: number; alpha?: number; rng?: Rng } = {}): [number, number] {
  const reps = opts.B ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rng = opts.rng ?? createRng(1);
  if (!A.length || !B.length) return [NaN, NaN];
  const out: number[] = new Array(reps);
  const ra: number[] = new Array(A.length);
  const rb: number[] = new Array(B.length);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < A.length; i++) ra[i] = A[Math.floor(rng.next() * A.length)] as number;
    for (let i = 0; i < B.length; i++) rb[i] = B[Math.floor(rng.next() * B.length)] as number;
    out[r] = median(rb) - median(ra);
  }
  return [percentile(out, (alpha / 2) * 100), percentile(out, (1 - alpha / 2) * 100)];
}

/** Average ranks (1-based) of xs; ties get the mean rank. Also returns the tie group sizes. */
export function ranks(xs: readonly number[]): { ranks: number[]; ties: number[] } {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  const ties: number[] = [];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as readonly [number, number])[0] === (idx[i] as readonly [number, number])[0]) j++;
    const mean = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[(idx[k] as readonly [number, number])[1]] = mean;
    if (j > i) ties.push(j - i + 1);
    i = j + 1;
  }
  return { ranks: r, ties };
}

/** Standard normal CDF (erf from Abramowitz and Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Number of arrangements giving each U for sample sizes m, n (no ties): the exact null distribution. */
function exactUCounts(m: number, n: number): number[] {
  // f[i][j][u]: arrangements of i A's and j B's with U = u (A above B pairs).
  let prev: number[][] = Array.from({ length: n + 1 }, () => [1]);
  for (let i = 1; i <= m; i++) {
    const cur: number[][] = [];
    cur[0] = [1];
    for (let j = 1; j <= n; j++) {
      const a = prev[j] as number[]; // last element is an A: it beats all j B's -> shift by j
      const b = cur[j - 1] as number[]; // last element is a B
      const len = Math.max(a.length + j, b.length);
      const row = new Array<number>(len).fill(0);
      for (let u = 0; u < a.length; u++) row[u + j] = (row[u + j] as number) + (a[u] as number);
      for (let u = 0; u < b.length; u++) row[u] = (row[u] as number) + (b[u] as number);
      cur[j] = row;
    }
    prev = cur;
  }
  return prev[n] as number[];
}

export type MannWhitney = { U: number; p: number; z?: number; exact: boolean };

/**
 * Two-sided Mann-Whitney U test [36]. U is for A (pairs where A > B, ties half).
 * Exact null distribution when both groups have at most 8 values and there
 * are no ties; otherwise the tie-corrected normal approximation with
 * continuity correction.
 */
export function mannWhitney(A: readonly number[], B: readonly number[]): MannWhitney {
  const nA = A.length;
  const nB = B.length;
  if (!nA || !nB) return { U: NaN, p: NaN, exact: false };
  const { ranks: r, ties } = ranks([...A, ...B]);
  let sumA = 0;
  for (let i = 0; i < nA; i++) sumA += r[i] as number;
  const U = sumA - (nA * (nA + 1)) / 2;
  if (nA <= 8 && nB <= 8 && ties.length === 0) {
    const counts = exactUCounts(nA, nB);
    const total = counts.reduce((a, b) => a + b, 0);
    let le = 0;
    let ge = 0;
    for (let u = 0; u < counts.length; u++) {
      if (u <= U) le += counts[u] as number;
      if (u >= U) ge += counts[u] as number;
    }
    return { U, p: Math.min(1, (2 * Math.min(le, ge)) / total), exact: true };
  }
  const n = nA + nB;
  const mu = (nA * nB) / 2;
  const tieSum = ties.reduce((s, t) => s + (t * t * t - t), 0);
  const sigma = Math.sqrt(((nA * nB) / 12) * (n + 1 - tieSum / (n * (n - 1))));
  if (!(sigma > 0)) return { U, p: 1, z: 0, exact: false };
  const z = Math.max(0, Math.abs(U - mu) - 0.5) / sigma;
  return { U, p: Math.min(1, 2 * (1 - normalCdf(z))), z, exact: false };
}

/** Cliff's delta [38]: (#{a > b} - #{a < b}) / (nA nB). */
export function cliffsDelta(A: readonly number[], B: readonly number[]): number {
  if (!A.length || !B.length) return NaN;
  let gt = 0;
  let lt = 0;
  for (const a of A)
    for (const b of B) {
      if (a > b) gt++;
      else if (a < b) lt++;
    }
  return (gt - lt) / (A.length * B.length);
}

/** Vargha-Delaney A12 [36]: the probability that a value from A beats one from B (ties count half). */
export const a12 = (A: readonly number[], B: readonly number[]): number => (cliffsDelta(A, B) + 1) / 2;

/** Vargha-Delaney magnitude labels (0.56 small, 0.64 medium, 0.71 large). */
export function a12Magnitude(a: number): 'negligible' | 'small' | 'medium' | 'large' {
  const d = Math.abs(a - 0.5);
  return d >= 0.21 ? 'large' : d >= 0.14 ? 'medium' : d >= 0.06 ? 'small' : 'negligible';
}

/** Theil-Sen slope [40]: the median of pairwise slopes; intercept = median(y - slope x). */
export function theilSen(x: readonly number[], y: readonly number[]): { slope: number; intercept: number } {
  const slopes: number[] = [];
  for (let i = 0; i < x.length; i++)
    for (let j = i + 1; j < x.length; j++) {
      const dx = (x[j] as number) - (x[i] as number);
      if (dx !== 0) slopes.push(((y[j] as number) - (y[i] as number)) / dx);
    }
  const slope = median(slopes);
  const intercept = median(x.map((xi, i) => (y[i] as number) - slope * xi));
  return { slope, intercept };
}

/**
 * PELT [33] with the segment cost "sum of squared errors around the segment
 * mean". Returns the changepoints: indices where a new segment starts.
 */
export function pelt(y: readonly number[], penalty: number): number[] {
  const n = y.length;
  if (n < 2) return [];
  const s1 = new Float64Array(n + 1);
  const s2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    s1[i + 1] = (s1[i] as number) + (y[i] as number);
    s2[i + 1] = (s2[i] as number) + (y[i] as number) * (y[i] as number);
  }
  // cost of y[s..t-1] (0-based, half-open)
  const cost = (s: number, t: number) => {
    const m = t - s;
    const sum = (s1[t] as number) - (s1[s] as number);
    return (s2[t] as number) - (s2[s] as number) - (sum * sum) / m;
  };
  const F = new Float64Array(n + 1);
  F[0] = -penalty;
  const last = new Int32Array(n + 1);
  let R = [0];
  for (let t = 1; t <= n; t++) {
    let best = Infinity;
    let arg = 0;
    const vals: number[] = [];
    for (const s of R) {
      const v = (F[s] as number) + cost(s, t) + penalty;
      vals.push(v);
      if (v < best) (best = v), (arg = s);
    }
    F[t] = best;
    last[t] = arg;
    // Pruning keeps it linear in expectation: drop s that can never be optimal again.
    R = R.filter((s, i) => (vals[i] as number) - penalty <= best).concat([t]);
  }
  const cps: number[] = [];
  for (let t = n; t > 0; t = last[t] as number) if ((last[t] as number) > 0) cps.unshift(last[t] as number);
  return cps;
}

const logFact = (() => {
  const cache: number[] = [0];
  return (n: number): number => {
    for (let i = cache.length; i <= n; i++) cache[i] = (cache[i - 1] as number) + Math.log(i);
    return cache[n] as number;
  };
})();

/**
 * Fisher's exact test for the 2x2 table [[a, b], [c, d]], two-sided: the sum of
 * the probabilities of all tables with the same margins that are no more
 * likely than the observed one [36].
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const r1 = a + b;
  const r2 = c + d;
  const c1 = a + c;
  const n = r1 + r2;
  const logP = (x: number) => logFact(r1) + logFact(r2) + logFact(c1) + logFact(n - c1) - logFact(n) - logFact(x) - logFact(r1 - x) - logFact(c1 - x) - logFact(r2 - c1 + x);
  const lo = Math.max(0, c1 - r2);
  const hi = Math.min(r1, c1);
  const pObs = logP(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logP(x);
    if (lp <= pObs + 1e-7) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/** Median and inter-quartile range. */
export function iqr(xs: readonly number[]): { median: number; q1: number; q3: number } {
  return { median: median(xs), q1: percentile(xs, 25), q3: percentile(xs, 75) };
}
