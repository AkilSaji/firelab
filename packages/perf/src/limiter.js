// Frame limiter: render at a steady rate below the display's refresh rate.
//
// On a 60 Hz TV, a stick that manages 35-45 fps looks smoother locked to an
// even 30 (every other refresh) than running unevenly. Call ready() at the
// top of your requestAnimationFrame callback and skip the frame when it
// returns false.

/**
 * @typedef {object} FrameLimiter
 * @property {(now: number) => boolean} ready   true when this rAF callback should render
 * @property {number} fps                        0 = no limit
 * @property {(fps: number) => void} setFps
 */

/**
 * @param {number} fps  frames per second to render at; 0 or Infinity disables the limit
 * @param {{ slackMs?: number }} [opts]  how early a frame may come and still count (default 2 ms, for vsync jitter)
 * @returns {FrameLimiter}
 */
export function createFrameLimiter(fps, opts = {}) {
  const slack = opts.slackMs ?? 2;
  let interval = fps > 0 && Number.isFinite(fps) ? 1000 / fps : 0;
  let last = -Infinity;
  return {
    get fps() {
      return interval ? 1000 / interval : 0;
    },
    setFps(f) {
      interval = f > 0 && Number.isFinite(f) ? 1000 / f : 0;
    },
    ready(now) {
      if (!interval) return true;
      const elapsed = now - last;
      if (elapsed < interval - slack) return false;
      // Stay on the original grid so the rate does not drift, unless we fell
      // far behind (a stall, a hidden tab): then start again from now.
      last = elapsed > interval * 3 ? now : last + interval * Math.max(1, Math.floor((elapsed + slack) / interval));
      return true;
    },
  };
}
