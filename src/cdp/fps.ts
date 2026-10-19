import type { WebViewSession } from './webview.js';

/**
 * Frame-rate sampling inside a page.
 *
 * 1. If the page publishes `window.firelab` (see @firelab/perf), use its fps
 *    (and skip the moments it reports `paused: true`: menus, videos).
 * 2. Else, if the caller gave an expression (e.g. an app's own meter), use it.
 * 3. Else, inject a probe that counts requestAnimationFrame callbacks and, for
 *    WebGL apps, the frames in which something was actually drawn. Games that
 *    cap themselves at 30 fps still get a rAF callback 60 times a second, so
 *    "frames with draw calls" is the honest number for them.
 */
export const PROBE_SOURCE = `(() => {
  if (window.__firelabProbe) return 'present';
  const P = { v: 1, buckets: [], gl: false };
  let drew = false;
  // Note WebGL contexts made from now on (in a sweep the probe runs before the
  // page's own scripts), so a game sitting on a menu reads as idle, not 60 fps.
  const watchCtx = (proto) => {
    if (!proto || !proto.getContext || proto.getContext.__firelab) return;
    const g = proto.getContext;
    const w = function (type) { const c = g.apply(this, arguments); if (c && /webgl/i.test(String(type))) P.gl = true; return c; };
    w.__firelab = true;
    try { proto.getContext = w; } catch (e) {}
  };
  try { watchCtx(window.HTMLCanvasElement && HTMLCanvasElement.prototype); } catch (e) {}
  try { watchCtx(window.OffscreenCanvas && OffscreenCanvas.prototype); } catch (e) {}
  const patch = (proto) => {
    if (!proto) return;
    for (const n of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'drawBuffers']) {
      const f = proto[n];
      if (typeof f !== 'function' || f.__firelab) continue;
      const w = function () { drew = true; return f.apply(this, arguments); };
      w.__firelab = true;
      try { proto[n] = w; } catch (e) {}
    }
  };
  try { patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype); } catch (e) {}
  try { patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch (e) {}
  let start = performance.now(), frames = 0, drawFrames = 0;
  const tick = (t) => {
    frames++;
    if (drew) { drawFrames++; drew = false; P.gl = true; }
    if (t - start >= 1000) {
      P.buckets.push({ t: Date.now(), ms: t - start, frames, drawFrames, gl: P.gl });
      if (P.buckets.length > 300) P.buckets.shift();
      start = t; frames = 0; drawFrames = 0;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  P.take = () => { const b = P.buckets; P.buckets = []; return b; };
  Object.defineProperty(window, '__firelabProbe', { value: P, enumerable: false, configurable: true });
  return 'installed';
})()`;

export type FpsSample = {
  ts: number;
  fps: number;
  /** page = window.firelab, expr = app's own meter, raf = injected probe, surface = SurfaceFlinger (any app). */
  source: 'page' | 'expr' | 'raf' | 'surface';
  /** For 'raf': whether frames with WebGL draw calls or plain rAF callbacks were counted. */
  counter?: 'draws' | 'raf';
  scale?: number;
  fpsMedian?: number;
  tier?: string;
};

type Bucket = { t: number; ms: number; frames: number; drawFrames: number; gl?: boolean };
type ReadResult = {
  hook: { fps?: number; fpsMedian?: number; scale?: number; tier?: string; gpu?: string; heapMB?: number; canvas?: { width: number; height: number }; marks?: Record<string, unknown>; paused?: boolean; targetFps?: number } | null;
  probe: Bucket[] | null;
  custom?: number | null;
  hidden: boolean;
};

const readExpr = (customExpr?: string) => `(() => {
  const f = window.firelab;
  const p = window.__firelabProbe;
  let custom = null;
  ${customExpr ? `try { const v = (${customExpr}); custom = typeof v === 'number' && isFinite(v) ? v : null; } catch (e) { custom = null; }` : ''}
  return {
    hook: f && typeof f.fps === 'number' ? { fps: f.fps, fpsMedian: f.fpsMedian, scale: f.scale, tier: f.tier, gpu: f.gpu, heapMB: f.heapMB, canvas: f.canvas, marks: f.marks, paused: f.paused === true, targetFps: f.targetFps } : null,
    probe: p ? p.take() : null,
    custom,
    hidden: document.hidden,
  };
})()`;

/**
 * Converts probe buckets to fps samples. For WebGL apps (a WebGL context was
 * created or drawn to) a second counts the frames that drew something; a
 * second with no draws while rAF ran freely means the app wasn't rendering (a
 * menu or a video), not that it was slow, so it is skipped. Pages without
 * WebGL count rAF callbacks.
 */
export function bucketsToSamples(buckets: Bucket[], knownWebgl = false): FpsSample[] {
  const drawing = knownWebgl || buckets.some((b) => b.drawFrames > 0 || b.gl);
  const out: FpsSample[] = [];
  for (const b of buckets) {
    if (!(b.ms > 0)) continue;
    const perSec = (n: number) => Math.round((n * 1000 * 10) / b.ms) / 10;
    if (drawing && b.drawFrames > 0) out.push({ ts: b.t, fps: perSec(b.drawFrames), source: 'raf', counter: 'draws' });
    else if (drawing && perSec(b.frames) >= 10) continue; // idle, not slow
    else out.push({ ts: b.t, fps: perSec(b.frames), source: 'raf', counter: 'raf' });
  }
  return out;
}

export class FpsSampler {
  lastHook: ReadResult['hook'] = null;
  /** Sticky: once the page has shown WebGL, idle seconds are skipped, not counted as 60 fps. */
  private webgl = false;
  constructor(
    private readonly session: WebViewSession,
    private readonly opts: { fpsExpr?: string } = {},
  ) {}

  /** Installs the probe (idempotent). */
  async install(): Promise<void> {
    await this.session.eval(PROBE_SOURCE, { timeoutMs: 8000 });
  }

  /** Drops whatever the probe counted so far (e.g. loading frames). */
  async reset(): Promise<void> {
    await this.session.eval('window.__firelabProbe ? (window.__firelabProbe.take(), 1) : 0', { timeoutMs: 5000 }).catch(() => 0);
  }

  /** Reads new samples. Call about once a second (the probe buffers between calls). */
  async read(): Promise<FpsSample[]> {
    const r = await this.session.eval<ReadResult>(readExpr(this.opts.fpsExpr), { timeoutMs: 5000 });
    const now = Date.now();
    if (!r) return [];
    this.lastHook = r.hook;
    if (r.hidden) return [];
    if (this.opts.fpsExpr && typeof r.custom === 'number') return [{ ts: now, fps: r.custom, source: 'expr' }];
    if (r.hook && typeof r.hook.fps === 'number') {
      // The page says it isn't rendering (menu, video, tab hidden): not a perf signal.
      if (r.hook.paused) return [];
      const s: FpsSample = { ts: now, fps: r.hook.fps, source: 'page' };
      if (typeof r.hook.scale === 'number') s.scale = r.hook.scale;
      if (typeof r.hook.fpsMedian === 'number') s.fpsMedian = r.hook.fpsMedian;
      if (r.hook.tier) s.tier = r.hook.tier;
      return [s];
    }
    if (r.probe === null) {
      // Page reloaded since install: put the probe back.
      await this.install().catch(() => {});
      return [];
    }
    if (r.probe.some((b) => b.drawFrames > 0 || b.gl)) this.webgl = true;
    return bucketsToSamples(r.probe, this.webgl);
  }
}
