// The page hook: `window.firelab`, a plain data object that the FireLab
// tester reads over the Chrome DevTools Protocol (docs/CONTRACT.md).
//
// It holds data only (no functions, no cycles), so
// `JSON.stringify(window.firelab)` and CDP's returnByValue always work. It is
// updated in place, a few times a second, without allocating.

/** @typedef {import('./tiers.js').TierId} TierId */

export const HOOK_VERSION = '1';

/**
 * @typedef {object} FirelabHook
 * @property {'1'} version
 * @property {TierId} tier                current tier
 * @property {TierId} autoTier            what chip detection picked
 * @property {string} gpu
 * @property {number} fps                 last ~1 s
 * @property {number} fpsMedian           last ~10 s
 * @property {{ p50: number, p95: number }} frameMs   last ~2 s
 * @property {number} scale               render scale chosen by adaptive resolution (share of the tier's resolution budget)
 * @property {{ width: number, height: number }} canvas  drawing buffer size
 * @property {number} [drawCalls]
 * @property {number} [triangles]
 * @property {number} [heapMB]
 * @property {Record<string, string | number | boolean | null>} marks  free-form app state
 * @property {boolean} paused             the app says frames are not representative right now (video, menu, hidden)
 * @property {number} targetFps
 */

/**
 * @typedef {object} HookUpdate
 * @property {TierId} [tier]
 * @property {TierId} [autoTier]
 * @property {string} [gpu]
 * @property {number} [fps]
 * @property {number} [fpsMedian]
 * @property {number} [p50]
 * @property {number} [p95]
 * @property {number} [scale]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number | null} [drawCalls]
 * @property {number | null} [triangles]
 * @property {number | null} [heapMB]
 * @property {boolean} [paused]
 * @property {number} [targetFps]
 */

const r1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;
const r2 = (/** @type {number} */ x) => Math.round(x * 100) / 100;

/**
 * A fresh hook object with the contract's shape.
 * @param {{ tier: TierId, autoTier: TierId, gpu?: string, targetFps?: number }} init
 * @returns {FirelabHook}
 */
export function createHookObject(init) {
  return {
    version: HOOK_VERSION,
    tier: init.tier,
    autoTier: init.autoTier,
    gpu: init.gpu || '',
    fps: 0,
    fpsMedian: 0,
    frameMs: { p50: 0, p95: 0 },
    scale: 1,
    canvas: { width: 0, height: 0 },
    marks: {},
    paused: false,
    targetFps: init.targetFps ?? 30,
  };
}

/**
 * Writes new numbers into the hook in place (rounded so that it reads well).
 * Optional fields are removed when the value is null, kept when undefined.
 * @param {FirelabHook} hook
 * @param {HookUpdate} u
 * @returns {FirelabHook}
 */
export function updateHook(hook, u) {
  if (u.tier !== undefined) hook.tier = u.tier;
  if (u.autoTier !== undefined) hook.autoTier = u.autoTier;
  if (u.gpu !== undefined) hook.gpu = u.gpu;
  if (u.fps !== undefined) hook.fps = r1(u.fps);
  if (u.fpsMedian !== undefined) hook.fpsMedian = r1(u.fpsMedian);
  if (u.p50 !== undefined) hook.frameMs.p50 = r1(u.p50);
  if (u.p95 !== undefined) hook.frameMs.p95 = r1(u.p95);
  if (u.scale !== undefined) hook.scale = r2(u.scale);
  if (u.width !== undefined) hook.canvas.width = Math.round(u.width);
  if (u.height !== undefined) hook.canvas.height = Math.round(u.height);
  if (u.paused !== undefined) hook.paused = u.paused;
  if (u.targetFps !== undefined) hook.targetFps = u.targetFps;
  setOptional(hook, 'drawCalls', u.drawCalls, Math.round);
  setOptional(hook, 'triangles', u.triangles, Math.round);
  setOptional(hook, 'heapMB', u.heapMB, Math.round);
  return hook;
}

/**
 * @param {FirelabHook} hook
 * @param {'drawCalls' | 'triangles' | 'heapMB'} key
 * @param {number | null | undefined} value
 * @param {(x: number) => number} fmt
 */
function setOptional(hook, key, value, fmt) {
  if (value === undefined) return;
  if (value === null || !Number.isFinite(value)) delete hook[key];
  else hook[key] = fmt(value);
}

/**
 * Checks that an object read from a page has the contract's shape. Used by
 * tests and handy for tools that read the hook: returns a list of problems,
 * empty when the hook is valid.
 * @param {unknown} hook
 * @returns {string[]}
 */
export function validateHook(hook) {
  /** @type {string[]} */
  const errors = [];
  if (!hook || typeof hook !== 'object') return ['not an object'];
  const h = /** @type {Record<string, any>} */ (hook);
  const num = (/** @type {string} */ k, /** @type {any} */ v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${k} must be a finite number`);
  };
  if (h.version !== HOOK_VERSION) errors.push(`version must be '${HOOK_VERSION}'`);
  for (const k of ['tier', 'autoTier']) {
    if (!['low', 'tv', 'tv-hd', 'high'].includes(h[k])) errors.push(`${k} must be a tier id`);
  }
  if (typeof h.gpu !== 'string') errors.push('gpu must be a string');
  num('fps', h.fps);
  num('fpsMedian', h.fpsMedian);
  if (!h.frameMs || typeof h.frameMs !== 'object') errors.push('frameMs must be an object');
  else {
    num('frameMs.p50', h.frameMs.p50);
    num('frameMs.p95', h.frameMs.p95);
  }
  num('scale', h.scale);
  if (!h.canvas || typeof h.canvas !== 'object') errors.push('canvas must be an object');
  else {
    num('canvas.width', h.canvas.width);
    num('canvas.height', h.canvas.height);
  }
  for (const k of ['drawCalls', 'triangles', 'heapMB']) if (k in h) num(k, h[k]);
  if (!h.marks || typeof h.marks !== 'object' || Array.isArray(h.marks)) errors.push('marks must be an object');
  return errors;
}
