// Adaptive resolution: hold a target frame rate by stepping the render scale
// between a floor and a ceiling.
//
// The controller is a pure state machine fed with frame durations. It keeps
// its own clock (the sum of the durations it was fed), so it behaves the same
// in a test as on a TV and never reads performance.now() itself.
//
// How it decides, every `windowMs` of measured frames:
// - fps below `dropBelow`   -> one step down (two when below `fastDropBelow`).
// - fps above `raiseAbove`  for `raiseAfter` windows in a row, and at least
//   `cooldownMs` since the last change -> one step up.
// - anything in between      -> hold (and the run of good windows restarts).
// It ignores the first `warmupMs` (shader compiles, texture uploads) and the
// first `settleMs` after every change or resume, and the slowest `trim` share
// of frames in each window (a garbage-collection pause or a one-off hitch is
// not a reason to blur the picture).
// Anti-oscillation: if a raise has to be undone within `retreatMs`, that
// level is blocked for `blockMs`, doubling each time it fails again.
// Fallback: at the floor and still below `fallbackBelow` for
// `fallbackWindows` windows in a row -> onFallback() fires once: this tier is
// too rich for the device even at the lowest resolution.

/**
 * @typedef {object} AdaptiveOptions
 * @property {number} [targetFps=30]
 * @property {number} [minScale=0.6]        floor, as a share of the tier's resolution budget
 * @property {number} [maxScale=1]          ceiling
 * @property {number} [initialScale=0.75]
 * @property {number} [stepDown=0.1]
 * @property {number} [stepUp=0.1]
 * @property {number} [windowMs=2000]       length of one measurement window
 * @property {number} [warmupMs=3000]       ignored at the start
 * @property {number} [settleMs=1000]       ignored after each change or resume
 * @property {number} [dropBelow]           default 0.9 x target (27 at 30 fps)
 * @property {number} [fastDropBelow]       default 0.67 x target: step down twice
 * @property {number} [raiseAbove]          default 0.95 x target (28.5 at 30 fps)
 * @property {number} [raiseAfter=3]        good windows in a row before a raise
 * @property {number} [cooldownMs=10000]    minimum time between a change and a raise
 * @property {number} [retreatMs=8000]      a drop this soon after a raise blocks that level
 * @property {number} [blockMs=180000]      how long (doubles on each repeat failure, up to 30 min)
 * @property {number} [trim=0.05]           share of slowest frames ignored in each window
 * @property {boolean} [fallback=true]
 * @property {number} [fallbackBelow]       default 0.75 x target (22.5 at 30 fps)
 * @property {number} [fallbackWindows=4]
 * @property {(scale: number, prev: number, why: ScaleReason) => void} [onChange]
 * @property {(info: { fps: number, scale: number, windows: number }) => void} [onFallback]
 * @property {(info: WindowResult) => void} [onWindow]  every evaluated window, for meters and logs
 */

/** @typedef {'down' | 'up' | 'reset'} ScaleReason */

/**
 * @typedef {object} WindowResult
 * @property {number} fps         trimmed frames per second of the window
 * @property {number} scale       scale after the decision
 * @property {'down' | 'up' | 'hold' | 'floor' | 'ceiling' | 'blocked' | 'cooldown'} action
 */

/**
 * @typedef {object} AdaptiveController
 * @property {number} scale
 * @property {boolean} paused
 * @property {(dtMs: number) => WindowResult | null} frame   feed one frame's duration
 * @property {(paused: boolean) => void} setPaused
 * @property {(scale?: number) => void} reset                 forget history (e.g. after a tier change)
 * @property {(range: { minScale?: number, maxScale?: number }) => void} setRange
 * @property {() => object} state                               internals, for debugging and tests
 * @property {Required<Omit<AdaptiveOptions, 'onChange' | 'onFallback' | 'onWindow'>>} options
 */

const EPS = 1e-6;
const round = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;

/**
 * @param {AdaptiveOptions} [options]
 * @returns {AdaptiveController}
 */
export function createAdaptiveResolution(options = {}) {
  const target = options.targetFps ?? 30;
  if (!(target > 0)) throw new RangeError('targetFps must be > 0');
  const o = {
    targetFps: target,
    minScale: options.minScale ?? 0.6,
    maxScale: options.maxScale ?? 1,
    initialScale: options.initialScale ?? 0.75,
    stepDown: options.stepDown ?? 0.1,
    stepUp: options.stepUp ?? 0.1,
    windowMs: options.windowMs ?? 2000,
    warmupMs: options.warmupMs ?? 3000,
    settleMs: options.settleMs ?? 1000,
    dropBelow: options.dropBelow ?? target * 0.9,
    fastDropBelow: options.fastDropBelow ?? target * 0.67,
    raiseAbove: options.raiseAbove ?? target * 0.95,
    raiseAfter: options.raiseAfter ?? 3,
    cooldownMs: options.cooldownMs ?? 10000,
    retreatMs: options.retreatMs ?? 8000,
    blockMs: options.blockMs ?? 180000,
    trim: Math.min(0.5, Math.max(0, options.trim ?? 0.05)),
    fallback: options.fallback ?? true,
    fallbackBelow: options.fallbackBelow ?? target * 0.75,
    fallbackWindows: options.fallbackWindows ?? 4,
  };
  if (o.minScale > o.maxScale) throw new RangeError('minScale must be <= maxScale');
  if (o.raiseAbove <= o.dropBelow) throw new RangeError('raiseAbove must be greater than dropBelow (hysteresis)');

  const clamp = (/** @type {number} */ s) => round(Math.min(o.maxScale, Math.max(o.minScale, s)));
  // Frame durations of the current window, for the trimmed mean.
  let buf = new Float32Array(512);
  let n = 0;
  let winMs = 0;
  let scale = clamp(o.initialScale);
  let t = 0;
  let measureFrom = o.warmupMs;
  let good = 0;
  let slow = 0;
  let lastChangeAt = -Infinity;
  let raisedAt = -Infinity;
  let paused = false;
  let fallbackFired = false;
  /** @type {Map<number, { until: number, strikes: number }>} */
  const blocked = new Map();

  /** @param {number} level */
  function isBlocked(level) {
    for (const [lv, b] of blocked) if (lv <= level + EPS && t < b.until) return true;
    return false;
  }

  /** @param {number} level */
  function block(level) {
    const prev = blocked.get(level);
    const strikes = (prev ? prev.strikes : 0) + 1;
    blocked.set(level, { until: t + Math.min(o.blockMs * 2 ** (strikes - 1), 30 * 60000), strikes });
  }

  /** @param {number} next @param {ScaleReason} why */
  function change(next, why) {
    const prev = scale;
    scale = next;
    lastChangeAt = t;
    good = 0;
    measureFrom = t + o.settleMs;
    options.onChange?.(scale, prev, why);
  }

  function windowFps() {
    // Trimmed mean: drop the slowest `trim` share of frames from both the
    // frame count and the elapsed time.
    let ms = winMs;
    let count = n;
    const drop = Math.floor(n * o.trim);
    if (drop > 0) {
      const sorted = buf.subarray(0, n).sort();
      for (let i = 0; i < drop; i++) ms -= sorted[n - 1 - i];
      count -= drop;
    }
    return ms > 0 ? (count * 1000) / ms : 0;
  }

  /** @param {number} fps @returns {WindowResult} */
  function evaluate(fps) {
    const atFloor = scale <= o.minScale + EPS;
    if (o.fallback && !fallbackFired) {
      if (atFloor && fps < o.fallbackBelow) {
        slow++;
        if (slow >= o.fallbackWindows) {
          fallbackFired = true;
          options.onFallback?.({ fps, scale, windows: slow });
        }
      } else slow = 0;
    }
    if (fps < o.dropBelow) {
      good = 0;
      if (atFloor) return { fps, scale, action: 'floor' };
      if (t - raisedAt < o.retreatMs) block(scale);
      const steps = fps < o.fastDropBelow ? 2 : 1;
      change(clamp(scale - o.stepDown * steps), 'down');
      return { fps, scale, action: 'down' };
    }
    if (fps >= o.raiseAbove) {
      good++;
      const next = clamp(scale + o.stepUp);
      if (next <= scale + EPS) return { fps, scale, action: 'ceiling' };
      if (isBlocked(next)) return { fps, scale, action: 'blocked' };
      if (good < o.raiseAfter || t - lastChangeAt < o.cooldownMs) return { fps, scale, action: 'cooldown' };
      raisedAt = t;
      change(next, 'up');
      return { fps, scale, action: 'up' };
    }
    good = 0;
    return { fps, scale, action: 'hold' };
  }

  return {
    get scale() {
      return scale;
    },
    get paused() {
      return paused;
    },
    options: o,
    frame(dtMs) {
      if (!(dtMs > 0) || !Number.isFinite(dtMs)) return null;
      t += dtMs;
      if (paused || t <= measureFrom) return null;
      if (n === buf.length) {
        const bigger = new Float32Array(buf.length * 2);
        bigger.set(buf);
        buf = bigger;
      }
      buf[n++] = dtMs;
      winMs += dtMs;
      // (1 ms of slack: 60 frames at 30 fps are 1999.99 ms, not 2000.)
      if (winMs < o.windowMs - 1) return null;
      const fps = windowFps();
      n = 0;
      winMs = 0;
      const result = evaluate(fps);
      options.onWindow?.(result);
      return result;
    },
    setPaused(p) {
      if (p === paused) return;
      paused = p;
      n = 0;
      winMs = 0;
      good = 0;
      slow = 0;
      if (!p) measureFrom = t + o.settleMs;
    },
    reset(s) {
      n = 0;
      winMs = 0;
      good = 0;
      slow = 0;
      fallbackFired = false;
      blocked.clear();
      raisedAt = -Infinity;
      measureFrom = t + o.warmupMs;
      const next = clamp(s ?? o.initialScale);
      if (Math.abs(next - scale) > EPS) change(next, 'reset');
      else lastChangeAt = t;
    },
    setRange(range) {
      if (range.minScale !== undefined) o.minScale = range.minScale;
      if (range.maxScale !== undefined) o.maxScale = range.maxScale;
      if (o.minScale > o.maxScale) throw new RangeError('minScale must be <= maxScale');
      const next = clamp(scale);
      if (Math.abs(next - scale) > EPS) change(next, 'reset');
    },
    state() {
      return {
        t,
        scale,
        paused,
        goodWindows: good,
        slowWindows: slow,
        fallbackFired,
        measuring: !paused && t > measureFrom,
        blocked: [...blocked].map(([level, b]) => ({ level, until: b.until, strikes: b.strikes })),
      };
    },
  };
}
