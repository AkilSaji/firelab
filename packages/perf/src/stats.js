// Frame statistics without allocations per frame: two typed-array rings
// (frame end times and durations), read a few times a second.

/**
 * Percentile with linear interpolation between closest ranks (the method
 * NumPy and most spreadsheets use by default). Does not modify the input.
 * Returns NaN for an empty input.
 *
 * @param {ArrayLike<number>} values  unsorted samples
 * @param {number} p                   0..1 (0.5 = median, 0.95 = p95)
 * @returns {number}
 */
export function percentile(values, p) {
  const n = values.length;
  if (!n) return NaN;
  const sorted = Float64Array.from(values).sort();
  return sortedPercentile(sorted, p, n);
}

/**
 * Percentile of the first `n` entries of an already ascending array.
 * @param {ArrayLike<number>} sorted
 * @param {number} p
 * @param {number} [n]
 * @returns {number}
 */
export function sortedPercentile(sorted, p, n = sorted.length) {
  if (!n) return NaN;
  const q = Math.min(1, Math.max(0, p));
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Median of the samples (NaN when empty).
 * @param {ArrayLike<number>} values
 */
export function median(values) {
  return percentile(values, 0.5);
}

/**
 * @typedef {object} FrameStats
 * @property {(dtMs: number, now: number) => void} push  record one frame: its duration and when it ended
 * @property {(now: number) => number} fps               frames per second over the last ~1 s
 * @property {() => number} fpsMedian                    median of the per-second rates over the last ~10 s
 * @property {(now: number) => { p50: number, p95: number }} frameMs  frame-time percentiles over the last ~2 s
 * @property {() => number} count                        frames recorded since the last reset
 * @property {() => void} reset
 */

/**
 * @param {{ capacity?: number, fpsWindowMs?: number, statsWindowMs?: number, medianSeconds?: number }} [opts]
 * @returns {FrameStats}
 */
export function createFrameStats(opts = {}) {
  const cap = Math.max(16, opts.capacity ?? 1024);
  const fpsWindow = opts.fpsWindowMs ?? 1000;
  const statsWindow = opts.statsWindowMs ?? 2000;
  const medianSeconds = Math.max(1, opts.medianSeconds ?? 10);
  const ends = new Float64Array(cap);
  const durs = new Float32Array(cap);
  const scratch = new Float32Array(cap);
  const perSecond = new Float32Array(medianSeconds);
  const scratchSec = new Float32Array(medianSeconds);
  let head = 0; // next write position
  let size = 0;
  let total = 0;
  let bucketAt = NaN;
  let bucketFrames = 0;
  let secHead = 0;
  let secSize = 0;

  /** Walks back from the newest frame while `end > since`; returns how many. @param {number} since */
  function countSince(since) {
    // A frame ending within 1 µs of the boundary counts as outside it, so that
    // floating-point noise does not add a 31st frame to a steady 30 fps.
    const edge = since + 1e-3;
    let n = 0;
    for (let i = 0; i < size; i++) {
      const idx = (head - 1 - i + cap) % cap;
      if (ends[idx] <= edge) break;
      n++;
    }
    return n;
  }

  return {
    push(dtMs, now) {
      if (!(dtMs >= 0) || !Number.isFinite(dtMs) || !Number.isFinite(now)) return;
      ends[head] = now;
      durs[head] = dtMs;
      head = (head + 1) % cap;
      if (size < cap) size++;
      total++;
      if (Number.isNaN(bucketAt)) bucketAt = now - dtMs;
      bucketFrames++;
      const span = now - bucketAt;
      if (span >= 1000) {
        perSecond[secHead] = (bucketFrames * 1000) / span;
        secHead = (secHead + 1) % medianSeconds;
        if (secSize < medianSeconds) secSize++;
        bucketAt = now;
        bucketFrames = 0;
      }
    },
    fps(now) {
      // Frames that ended in the last second, divided by the time they took.
      // (Counting frames in a 1 s window alone reads 29 or 30 at a steady 30
      // fps depending on where between two frames you look.) Once frames stop
      // coming, the gap since the last one is added, so the rate decays to 0.
      const n = countSince(now - fpsWindow);
      if (!n) return 0;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += durs[(head - 1 - i + cap) % cap];
      const gap = now - ends[(head - 1 + cap) % cap];
      const span = gap > (2 * sum) / n ? sum + gap : sum;
      return span > 0 ? (n * 1000) / span : 0;
    },
    fpsMedian() {
      if (!secSize) return 0;
      for (let i = 0; i < secSize; i++) scratchSec[i] = perSecond[i];
      const view = scratchSec.subarray(0, secSize).sort();
      return sortedPercentile(view, 0.5, secSize);
    },
    frameMs(now) {
      const n = countSince(now - statsWindow);
      if (!n) return { p50: 0, p95: 0 };
      for (let i = 0; i < n; i++) scratch[i] = durs[(head - 1 - i + cap) % cap];
      const view = scratch.subarray(0, n).sort();
      return { p50: sortedPercentile(view, 0.5, n), p95: sortedPercentile(view, 0.95, n) };
    },
    count() {
      return total;
    },
    reset() {
      head = size = total = bucketFrames = secHead = secSize = 0;
      bucketAt = NaN;
    },
  };
}
