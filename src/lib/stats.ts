/** Small statistics helpers used by the sweep and watch sessions. */

/** Percentile with linear interpolation between closest ranks (p in 0..100). */
export function percentile(values: readonly number[], p: number): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return NaN;
  if (xs.length === 1) return xs[0] as number;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = xs[lo] as number;
  const b = xs[hi] as number;
  return a + (b - a) * (rank - lo);
}

export const median = (values: readonly number[]): number => percentile(values, 50);

export function mean(values: readonly number[]): number {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

// Loops, not Math.max(...xs): spreading a long session's samples overflows the stack.
export function max(values: readonly number[]): number {
  let m = NaN;
  for (const v of values) if (Number.isFinite(v) && !(v <= m)) m = v;
  return m;
}

export function min(values: readonly number[]): number {
  let m = NaN;
  for (const v of values) if (Number.isFinite(v) && !(v >= m)) m = v;
  return m;
}

export type Summary = { n: number; median: number; p10: number; p90: number; min: number; max: number; mean: number };

export function summarize(values: readonly number[]): Summary {
  const xs = values.filter((v) => Number.isFinite(v));
  return {
    n: xs.length,
    median: median(xs),
    p10: percentile(xs, 10),
    p90: percentile(xs, 90),
    min: min(xs),
    max: max(xs),
    mean: mean(xs),
  };
}
