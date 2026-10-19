/**
 * The in-page probe (docs/ENGINE.md 5.1): one small script installed once per
 * page load, then read with one evaluate per step. It reads discrete UI facts
 * (UI structure first, pixels last, as DroidBot and APE do [5, 6]) and app
 * state straight from the page, as game agents do [16, 19].
 *
 * The script keeps its state on a non-enumerable `window.__firelabEngine` so it
 * never shows up in the app's own `JSON.stringify(window)`-style code.
 */
import type { FocusInfo, Probe, VideoInfo } from './types.js';
import { parseGpuFailures } from '../fit/gpu-shim.js';

export const PROBE_GLOBAL = '__firelabEngine';

/** Installs listeners and counters. Returns true. Safe to send twice. */
export const PROBE_INSTALL = `(() => {
  /* FIRELAB_ENGINE_PROBE_INSTALL v1 */
  if (window.${PROBE_GLOBAL}) return true;
  const P = { v: 1, raf: 0, ticks: 0, draws: 0, drew: false, sawDraw: false, errors: 0, lastError: '', glLost: 0 };
  addEventListener('error', (e) => {
    if (!(e instanceof ErrorEvent)) return; /* resource load errors are not exceptions */
    P.errors++;
    const f = String(e.filename || '').split('/').pop();
    P.lastError = String(e.message || 'error').slice(0, 160) + '@' + f + ':' + (e.lineno || 0);
  });
  addEventListener('unhandledrejection', (e) => {
    P.errors++;
    const r = e && e.reason;
    P.lastError = 'unhandled rejection: ' + String((r && r.message) || r).slice(0, 160);
  });
  addEventListener('webglcontextlost', () => { P.glLost++; }, true);
  /* Count frames that drew something: a game whose loop stopped keeps the browser's rAF running. */
  const patch = (proto, names) => {
    if (!proto) return;
    for (const n of names) {
      const f = proto[n];
      if (typeof f !== 'function' || f.__firelabEngine) continue;
      const w = function () { P.drew = true; return f.apply(this, arguments); };
      w.__firelabEngine = true;
      try { proto[n] = w; } catch (e) {}
    }
  };
  const GL = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];
  try { patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype, GL); } catch (e) {}
  try { patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, GL); } catch (e) {}
  try { patch(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, ['drawImage', 'fillRect', 'putImageData', 'fill', 'stroke', 'fillText']); } catch (e) {}
  const tick = () => {
    P.ticks++;
    if (P.drew) { P.draws++; P.drew = false; P.sawDraw = true; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    }
    return true;
  };
  const path = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 5; n = n.parentElement, i++) {
      if (n.id) { parts.unshift('#' + n.id); break; }
      const p = n.parentElement;
      const k = p ? Array.prototype.indexOf.call(p.children, n) + 1 : 1;
      parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + k + ')');
    }
    return parts.join('>');
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const text = String(el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    const out = { id: el.id ? '#' + el.id : path(el), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    if (text) out.text = text;
    const role = el.getAttribute('role');
    if (role) out.role = role;
    return out;
  };
  const fromMark = (m) => (m && typeof m === 'object' && typeof m.id === 'string' && Array.isArray(m.rect)) ? { id: m.id, rect: m.rect.slice(0, 4).map(Number), text: m.text } : null;
  const TABBABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  P.focus = (cfg) => {
    const hook = window.firelab;
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== document.documentElement) return describe(ae);
    if (cfg.focusSelector) {
      const el = document.querySelector(cfg.focusSelector);
      if (el && visible(el)) return describe(el);
    }
    const m = hook && hook.marks && fromMark(hook.marks.focus);
    if (m) return m;
    const expected = !!cfg.focusSelector || !!(hook && hook.marks && 'focus' in hook.marks) || !!document.querySelector(TABBABLE);
    return expected ? null : undefined;
  };
  P.focusables = (cfg) => {
    const hook = window.firelab;
    if (hook && typeof hook.focusables === 'function') {
      try { return (hook.focusables() || []).map(fromMark).filter(Boolean); } catch (e) { return []; }
    }
    const set = new Set(Array.prototype.slice.call(document.querySelectorAll(TABBABLE)));
    if (cfg.focusSelector) {
      /* A class-drawn focus: the focused element's siblings of the same tag could take focus too. */
      const el = document.querySelector(cfg.focusSelector);
      if (el && el.parentElement) for (const c of el.parentElement.children) if (c.tagName === el.tagName) set.add(c);
    }
    return Array.from(set).filter(visible).map(describe);
  };
  P.read = (cfg) => {
    const hook = window.firelab && typeof window.firelab === 'object' ? window.firelab : null;
    const out = { url: location.pathname + location.search + location.hash, title: document.title, hook: !!hook, raf: P.sawDraw ? P.draws : P.ticks, rafSource: P.sawDraw ? 'draws' : 'raf', errors: P.errors, glLost: P.glLost, viewport: [innerWidth, innerHeight] };
    if (P.lastError) out.lastError = P.lastError;
    const Gp = window.__firelabGpu;
    if (Gp) {
      out.gpu = { model: Gp.model, webgl: Gp.contexts.webgl, webgl2: Gp.contexts.webgl2, refused: Gp.contexts.refused, drew1: !!Gp.contexts.drew1 };
      if (Gp.fails.length) out.gpuFails = Gp.fails.slice(0, 50).map((f) => ({ key: f.key, sev: f.sev, call: f.call, detail: f.detail, n: f.n }));
    }
    if (hook) {
      if (typeof hook.paused === 'boolean') out.paused = hook.paused;
      if (typeof hook.targetFps === 'number') out.targetFps = hook.targetFps;
      if (typeof hook.fps === 'number') out.fps = hook.fps;
      if (hook.frameMs && typeof hook.frameMs.p50 === 'number') out.frameMs = { p50: hook.frameMs.p50, p95: hook.frameMs.p95 };
      if (typeof hook.heapMB === 'number') out.heapMB = hook.heapMB;
      const marks = {};
      let any = false;
      for (const k in hook.marks || {}) {
        const v = hook.marks[k];
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') { marks[k] = v; any = true; }
      }
      if (any) out.marks = marks;
      if (typeof marks.scene === 'string') out.scene = marks.scene;
      if (hook.invariants && typeof hook.invariants === 'object') {
        const inv = {};
        for (const k in hook.invariants) {
          try { const r = hook.invariants[k](); inv[k] = r === true ? true : String(r); } catch (e) { inv[k] = 'threw: ' + String(e && e.message || e); }
        }
        out.invariants = inv;
      }
    }
    if (!out.heapMB && performance.memory) out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
    if (cfg.state) {
      try { out.app = JSON.parse(JSON.stringify(cfg.state())); } catch (e) { out.app = { __error: String(e && e.message || e).slice(0, 120) }; }
    }
    const f = P.focus(cfg);
    if (f !== undefined) out.focus = f;
    const dialogs = document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]');
    for (let i = dialogs.length - 1; i >= 0; i--) {
      if (visible(dialogs[i])) { out.modal = dialogs[i].id || path(dialogs[i]); break; }
    }
    const vids = document.getElementsByTagName('video');
    if (vids.length) {
      out.video = [];
      for (let i = 0; i < vids.length && i < 4; i++) {
        const v = vids[i];
        const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
        const o = { id: v.id || 'video' + i, t: Math.round(v.currentTime * 100) / 100, paused: v.paused, readyState: v.readyState };
        if (q) { o.dropped = q.droppedVideoFrames; o.total = q.totalVideoFrames; }
        out.video.push(o);
      }
    }
    return out;
  };
  Object.defineProperty(window, '${PROBE_GLOBAL}', { value: P, enumerable: false, configurable: true });
  return true;
})()`;

export type ProbeConfig = { stateExpr?: string; focusSelector?: string };

function cfgSource(cfg: ProbeConfig): string {
  // stateExpr is the user's own expression for their own app (--state-expr); it runs as written.
  const state = cfg.stateExpr ? `state: () => (${cfg.stateExpr}),` : '';
  const sel = cfg.focusSelector ? `focusSelector: ${JSON.stringify(cfg.focusSelector)},` : '';
  return `{ ${state} ${sel} }`;
}

/** One probe read. Returns null when the page was reloaded since the install (install again). */
export function probeReadExpression(cfg: ProbeConfig): string {
  return `(() => { /* FIRELAB_ENGINE_PROBE_READ */ const P = window.${PROBE_GLOBAL}; return P ? P.read(${cfgSource(cfg)}) : null; })()`;
}

export function focusablesExpression(cfg: ProbeConfig): string {
  return `(() => { /* FIRELAB_ENGINE_PROBE_FOCUSABLES */ const P = window.${PROBE_GLOBAL}; return P ? P.focusables(${cfgSource(cfg)}) : null; })()`;
}

// ---------- parsing (the page is untrusted input: check every field) ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);

export function parseFocus(v: unknown): FocusInfo | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || typeof v.id !== 'string' || !Array.isArray(v.rect)) return undefined;
  const r = v.rect.slice(0, 4).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0));
  while (r.length < 4) r.push(0);
  const f: FocusInfo = { id: v.id.slice(0, 120), rect: [r[0] as number, r[1] as number, r[2] as number, r[3] as number] };
  const text = str(v.text, 60);
  if (text) f.text = text;
  const role = str(v.role, 30);
  if (role) f.role = role;
  return f;
}

export function parseFocusables(v: unknown): FocusInfo[] {
  if (!Array.isArray(v)) return [];
  const out: FocusInfo[] = [];
  for (const x of v.slice(0, 200)) {
    const f = parseFocus(x);
    if (f) out.push(f);
  }
  return out;
}

function parseVideo(v: unknown): VideoInfo[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: VideoInfo[] = [];
  for (const x of v) {
    if (!isObj(x)) continue;
    const t = num(x.t);
    const readyState = num(x.readyState);
    if (t === undefined || readyState === undefined) continue;
    const vi: VideoInfo = { id: str(x.id, 60) ?? 'video', t, paused: x.paused === true, readyState };
    const dropped = num(x.dropped);
    const total = num(x.total);
    if (dropped !== undefined) vi.dropped = dropped;
    if (total !== undefined) vi.total = total;
    out.push(vi);
  }
  return out;
}

/** Turns an evaluate() result into a Probe, or undefined when it isn't one. */
export function parseProbe(v: unknown): Probe | undefined {
  if (!isObj(v)) return undefined;
  const raf = num(v.raf);
  const errors = num(v.errors);
  if (raf === undefined || errors === undefined) return undefined;
  const p: Probe = { raf, errors };
  const s = (k: 'url' | 'title' | 'scene' | 'modal' | 'lastError') => {
    const x = str(v[k]);
    if (x !== undefined) p[k] = x;
  };
  s('url');
  s('title');
  s('scene');
  s('modal');
  s('lastError');
  if (typeof v.hook === 'boolean') p.hook = v.hook;
  if (typeof v.paused === 'boolean') p.paused = v.paused;
  for (const k of ['targetFps', 'fps', 'heapMB', 'glLost'] as const) {
    const x = num(v[k]);
    if (x !== undefined) p[k] = x;
  }
  if (isObj(v.frameMs)) {
    const p50 = num(v.frameMs.p50);
    const p95 = num(v.frameMs.p95);
    if (p50 !== undefined && p95 !== undefined) p.frameMs = { p50, p95 };
  }
  if (isObj(v.marks)) {
    const marks: Record<string, string | number | boolean> = {};
    for (const [k, x] of Object.entries(v.marks)) if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') marks[k] = x;
    p.marks = marks;
    if (p.scene === undefined && typeof marks.scene === 'string') p.scene = marks.scene;
  }
  if ('app' in v) p.app = v.app;
  if ('focus' in v) {
    const f = parseFocus(v.focus);
    if (f !== undefined) p.focus = f;
  }
  const video = parseVideo(v.video);
  if (video) p.video = video;
  if (isObj(v.invariants)) {
    const inv: Record<string, true | string> = {};
    for (const [k, x] of Object.entries(v.invariants)) inv[k] = x === true ? true : String(x).slice(0, 200);
    p.invariants = inv;
  }
  if (Array.isArray(v.viewport) && v.viewport.length === 2) {
    const w = num(v.viewport[0]);
    const h = num(v.viewport[1]);
    if (w && h) p.viewport = [w, h];
  }
  if (v.rafSource === 'draws' || v.rafSource === 'raf') p.rafSource = v.rafSource;
  if (isObj(v.gpu) && typeof v.gpu.model === 'string') p.gpu = { model: v.gpu.model, webgl: num(v.gpu.webgl) ?? 0, webgl2: num(v.gpu.webgl2) ?? 0, refused: num(v.gpu.refused) ?? 0, drew1: v.gpu.drew1 === true };
  const gf = parseGpuFailures(v.gpuFails);
  if (gf.length) p.gpuFails = gf;
  return p;
}

// ---------- canonical app state and the settle digest ----------

/** Numbers to 1 significant digit (5.3), so a score or a timer does not make every frame a new state. */
export function bucketNumber(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x === 0 ? 0 : NaN;
  return Number(x.toPrecision(1));
}

/** Small, stable JSON of the app state: sorted keys, bucketed numbers, capped strings and arrays. */
export function canonicalApp(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(bucketNumber(v));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v.slice(0, 60));
  if (depth >= 3) return '"…"';
  if (Array.isArray(v)) return `[${v.slice(0, 8).map((x) => canonicalApp(x, depth + 1)).join(',')}${v.length > 8 ? `,"+${v.length - 8}"` : ''}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v as object).sort().slice(0, 24);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalApp((v as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
  }
  return 'null';
}

/** Hash input of the discrete probe fields only: no fps, no counters, no positions (5.2). */
export function probeDigest(p: Probe | undefined): string {
  if (!p) return '';
  const marks = p.marks ? Object.keys(p.marks).sort().map((k) => (typeof p.marks?.[k] === 'number' ? '' : `${k}=${String(p.marks?.[k])}`)).join(';') : '';
  return JSON.stringify([p.url, p.title, p.scene, p.modal, 'app' in p ? canonicalApp(p.app) : '', p.focus === undefined ? '-' : (p.focus?.id ?? 'null'), marks]);
}
