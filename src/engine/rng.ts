/** Seeded randomness: every random choice in the engine goes through one of these, so runs are repeatable. */

export type Rng = {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  /** Index drawn with probability proportional to weights (non-negative). */
  weighted(weights: readonly number[]): number;
  /** A child generator with its own stream (for sub-components). */
  fork(label: string): Rng;
};

/** FNV-1a over a string: a stable 32-bit seed from a label. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for test-input generation. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => {
      if (!xs.length) throw new Error('pick from an empty list');
      return xs[Math.floor(next() * xs.length)] as T;
    },
    weighted: (weights) => {
      let total = 0;
      for (const w of weights) total += Math.max(0, w);
      if (total <= 0) return Math.floor(next() * weights.length);
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= Math.max(0, weights[i] as number);
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
    fork: (label) => createRng((hashSeed(label) ^ Math.floor(next() * 4294967296)) >>> 0),
  };
  return rng;
}
