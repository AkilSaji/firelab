// createPerf(): chip detection, tier choice, adaptive resolution, the meter
// and the window.firelab hook, wired together.

import { TIERS, lighterTier, normalizeTier, pick as pickTier } from './tiers.js';
import { detectDevice } from './chips.js';
import { resolveTier, safeStorage, STORAGE_SUFFIX } from './resolve.js';
import { createFrameStats } from './stats.js';
import { createAdaptiveResolution } from './adaptive.js';
import { autoAdapter, computeScaleInfo } from './adapters.js';
import { createHookObject, updateHook } from './hook.js';
import { createMeter } from './meter.js';
import { listenForToggle, DEFAULT_TOGGLE_KEYS } from './keys.js';

/** @typedef {import('./tiers.js').TierId} TierId */
/** @typedef {import('./chips.js').Detection} Detection */
/** @typedef {import('./resolve.js').TierSource} TierSource */
/** @typedef {import('./resolve.js').StorageLike} StorageLike */
/** @typedef {import('./adapters.js').RenderAdapter} RenderAdapter */
/** @typedef {import('./adapters.js').ScaleInfo} ScaleInfo */
/** @typedef {import('./adaptive.js').AdaptiveOptions} AdaptiveOptions */
/** @typedef {import('./hook.js').FirelabHook} FirelabHook */

/**
 * Everything createPerf reads from the browser, so that it can run (and be
 * tested) anywhere. browserEnv() builds the real one.
 * @typedef {object} PerfEnv
 * @property {EventTarget | null} window              receives resize / key listeners; the hook is set on it
 * @property {Document | null} document
 * @property {Navigator | undefined} [navigator]
 * @property {() => string} search                     location.search
 * @property {StorageLike | null} storage
 * @property {() => number} now
 * @property {(cb: (t: number) => void) => number} requestAnimationFrame
 * @property {(id: number) => void} cancelAnimationFrame
 * @property {(cb: () => void, ms: number) => unknown} setInterval
 * @property {(id: unknown) => void} clearInterval
 * @property {() => number} devicePixelRatio
 * @property {() => { width: number, height: number }} viewport
 * @property {() => number | undefined} heapMB
 * @property {() => boolean} hidden
 * @property {() => void} [reload]
 */

/** @returns {PerfEnv} */
export function browserEnv() {
  const w = typeof window !== 'undefined' ? window : /** @type {any} */ (null);
  /** @type {StorageLike | null} */
  let storage = null;
  try {
    storage = w ? w.localStorage : null;
  } catch {
    storage = null;
  }
  return {
    window: w,
    document: typeof document !== 'undefined' ? document : null,
    navigator: typeof navigator !== 'undefined' ? navigator : undefined,
    search: () => (w && w.location ? w.location.search : ''),
    storage,
    now: () => performance.now(),
    requestAnimationFrame: (cb) => (w ? w.requestAnimationFrame(cb) : 0),
    cancelAnimationFrame: (id) => w && w.cancelAnimationFrame(id),
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (id) => clearInterval(/** @type {any} */ (id)),
    devicePixelRatio: () => (w && w.devicePixelRatio) || 1,
    viewport: () => ({ width: (w && w.innerWidth) || 0, height: (w && w.innerHeight) || 0 }),
    heapMB: () => {
      const m = /** @type {any} */ (performance).memory;
      return m && m.usedJSHeapSize ? m.usedJSHeapSize / 1048576 : undefined;
    },
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    reload: () => w && w.location.reload(),
  };
}

/**
 * @typedef {object} TierOverrides
 * @property {number} [maxHeight]  tallest drawing buffer at scale 1, in device pixels
 * @property {number} [minScale]
 * @property {number} [maxScale]
 */

/**
 * @typedef {object} PerfOptions
 * @property {number | ((tier: TierId, detection: Detection) => number)} [targetFps=30]  a number, or a function of the starting tier (e.g. 30 on TV tiers, 60 on 'high')
 * @property {TierId | string} [tier]               force a tier from code (the URL still wins)
 * @property {string} [param='q']                    URL parameter that forces a tier (?q=tv-hd, ?q=auto)
 * @property {string} [meterParam='perf']           URL parameter that shows the meter (?perf=1)
 * @property {string} [scaleParam='scale']          URL parameter that pins the render scale (?scale=0.8)
 * @property {string} [storageKey='firelab-tier']   localStorage key prefix
 * @property {boolean | AdaptiveOptions} [adaptive=true]
 * @property {boolean} [fallback=true]              persist a lighter tier when the auto-picked one cannot hold the target
 * @property {number} [scale]                        pin the render scale from code (turns adaptive off)
 * @property {boolean | 'auto' | { position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right', keys?: string[], visible?: boolean }} [meter='auto']
 * @property {boolean} [hook=true]                   publish window.firelab
 * @property {boolean} [pauseWhileVideo=false]      pause measurement while any <video> plays
 * @property {RenderAdapter | object} [renderer]    three.js renderer, Babylon engine, Pixi app, canvas, or an adapter
 * @property {RenderAdapter} [adapter]
 * @property {(scale: number, info: ScaleInfo) => void} [setScale]  the simplest adapter: a callback
 * @property {HTMLCanvasElement} [canvas]           canvas to measure when setScale is a bare callback
 * @property {Partial<Record<TierId, TierOverrides>>} [tiers]
 * @property {Detection} [detection]                skip detection (e.g. you already ran detectDevice())
 * @property {boolean} [autoFrames=true]             count requestAnimationFrame callbacks until perf.frame() is called
 * @property {number} [updateMs=250]                 how often the hook and the meter refresh
 * @property {Partial<PerfEnv>} [env]
 */

/**
 * @typedef {'scale' | 'tier' | 'fallback' | 'sample' | 'window' | 'pause'} PerfEvent
 */

/**
 * Sets up chip detection, the tier, adaptive resolution, the meter and the
 * window.firelab hook.
 *
 *   const perf = createPerf();
 *   const renderer = new THREE.WebGLRenderer({ antialias: perf.tier !== 'low' });
 *   perf.attach(renderer);
 *   renderer.setAnimationLoop(() => { renderer.render(scene, camera); perf.frame(); });
 *
 * @param {PerfOptions} [options]
 */
export function createPerf(options = {}) {
  const env = /** @type {PerfEnv} */ ({ ...browserEnv(), ...(options.env || {}) });
  const storage = safeStorage(env.storage);
  const storageKey = options.storageKey ?? 'firelab-tier';
  const search = env.search() || '';
  const params = safeParams(search);
  const updateMs = options.updateMs ?? 250;

  /** @type {RenderAdapter | null} */
  let adapter = resolveAdapter(options);
  const detection = options.detection ?? detectDevice({ document: env.document || undefined, navigator: env.navigator, gl: adapter?.gl ?? null });
  const choice = resolveTier({
    auto: detection.tier,
    search,
    param: options.param ?? 'q',
    code: options.tier,
    storage,
    storageKey,
    gpu: detection.gpu,
  });
  if (options.tier !== undefined && !normalizeTier(options.tier)) console.warn(`[firelab/perf] unknown tier "${options.tier}" ignored`);

  let tier = choice.tier;
  /** @type {TierSource} */
  let source = choice.source;
  const rawTarget = typeof options.targetFps === 'function' ? options.targetFps(tier, detection) : options.targetFps;
  const targetFps = typeof rawTarget === 'number' && rawTarget > 0 ? rawTarget : 30;

  // Pinned scale: ?scale=0.8 (handy in sweeps) or options.scale.
  const pinnedRaw = params.get(options.scaleParam ?? 'scale');
  const pinnedUrl = pinnedRaw !== null && Number.isFinite(parseFloat(pinnedRaw)) ? parseFloat(pinnedRaw) : undefined;
  const pinned = pinnedUrl ?? options.scale;
  const adaptiveWanted = options.adaptive !== false && pinned === undefined;
  /** @type {AdaptiveOptions} */
  const adaptiveOpts = typeof options.adaptive === 'object' ? options.adaptive : {};

  const stats = createFrameStats();
  const hook = createHookObject({ tier, autoTier: detection.tier, gpu: detection.gpu, targetFps });
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  /** @type {Set<string>} */
  const pauseReasons = new Set();
  /** @type {Record<string, string | number | boolean | null>} */
  const marks = hook.marks;
  /** @type {{ drawCalls?: number, triangles?: number }} */
  let reported = {};
  /** @type {ReturnType<typeof createAdaptiveResolution> | null} */
  let controller = null;
  let scale = pinned ?? 1;
  /** @type {ScaleInfo | null} */
  let info = null;
  let lastFrameAt = NaN;
  let skipNext = false;
  let manualFrames = false;
  let rafId = 0;
  let destroyed = false;
  /** @type {Array<() => void>} */
  const cleanups = [];

  /** @param {string} type @param {any} payload */
  function emit(type, payload) {
    const set = listeners.get(type);
    if (set) for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        console.error('[firelab/perf] listener failed', e);
      }
    }
  }

  function preset() {
    return { ...TIERS[tier], ...(options.tiers?.[tier] || {}) };
  }

  function view() {
    const c = adapter?.canvas;
    const vp = env.viewport();
    const cssWidth = (c && c.clientWidth) || vp.width;
    const cssHeight = (c && c.clientHeight) || vp.height;
    return { maxHeight: preset().maxHeight, cssWidth, cssHeight, devicePixelRatio: env.devicePixelRatio(), tier };
  }

  /** @param {number} s */
  function applyScale(s) {
    scale = s;
    if (!adapter) return;
    info = computeScaleInfo(s, view());
    try {
      adapter.setScale(s, info);
    } catch (e) {
      console.error('[firelab/perf] setScale failed', e);
    }
  }

  function buildController() {
    const p = preset();
    controller = createAdaptiveResolution({
      targetFps,
      // Desktops start sharp; TVs start at 0.75 of the budget (960x540 on a
      // 'tv' stick) and climb when the scene allows it.
      initialScale: tier === 'high' ? 1 : 0.75,
      ...adaptiveOpts,
      minScale: p.minScale ?? adaptiveOpts.minScale ?? 0.6,
      maxScale: p.maxScale ?? adaptiveOpts.maxScale ?? 1,
      fallback: options.fallback !== false && (adaptiveOpts.fallback ?? true),
      onChange(next, prev, why) {
        applyScale(next);
        emit('scale', { scale: next, prev, reason: why, info });
        adaptiveOpts.onChange?.(next, prev, why);
      },
      onFallback(f) {
        handleFallback(f.fps);
        adaptiveOpts.onFallback?.(f);
      },
      onWindow(w) {
        emit('window', w);
        adaptiveOpts.onWindow?.(w);
      },
    });
    if (pauseReasons.size) controller.setPaused(true);
    scale = controller.scale;
  }

  /** @param {number} fps */
  function handleFallback(fps) {
    const to = lighterTier(tier);
    if (!to) return;
    const persisted = source === 'auto' || source === 'fallback';
    if (persisted) {
      storage.setItem(storageKey + STORAGE_SUFFIX.fallback, JSON.stringify({ tier: to, from: tier, gpu: detection.gpu, at: Date.now() }));
      console.info(`[firelab/perf] "${tier}" cannot hold ${targetFps} fps on this device even at the lowest resolution (${fps.toFixed(1)} fps): "${to}" from the next launch.`);
    }
    emit('fallback', { from: tier, to, fps, persisted });
  }

  /** @param {any} target */
  function attach(target) {
    const a = autoAdapter(target);
    if (!a) throw new TypeError('[firelab/perf] attach(): expected a three.js renderer, Babylon engine, Pixi app, canvas, or { setScale }');
    adapter = a;
    if (adaptiveWanted) {
      if (!controller) buildController();
      applyScale(/** @type {any} */ (controller).scale);
    } else applyScale(pinned ?? 1);
    publish();
    return api;
  }

  /** @param {number} now */
  function onFrame(now) {
    if (destroyed) return;
    if (!Number.isNaN(lastFrameAt) && !skipNext) {
      const dt = now - lastFrameAt;
      // A gap of seconds is a hidden tab or a paused render loop, not a frame.
      if (dt > 0 && dt < 5000) {
        stats.push(dt, now);
        controller?.frame(dt);
      }
    }
    skipNext = false;
    lastFrameAt = now;
  }

  /** @param {number} t */
  function rafLoop(t) {
    if (destroyed || manualFrames) return;
    onFrame(t);
    rafId = env.requestAnimationFrame(rafLoop);
  }

  /** @param {string} reason @param {boolean} on */
  function setPausedReason(reason, on) {
    const before = pauseReasons.size > 0;
    if (on) pauseReasons.add(reason);
    else pauseReasons.delete(reason);
    const after = pauseReasons.size > 0;
    if (before !== after) {
      controller?.setPaused(after);
      if (!after) skipNext = true;
      emit('pause', { paused: after, reasons: [...pauseReasons] });
    }
  }

  function publish() {
    const now = env.now();
    const ms = stats.frameMs(now);
    const s = adapter?.stats ? safeCall(adapter.stats) : {};
    const drawCalls = reported.drawCalls ?? s.drawCalls;
    const triangles = reported.triangles ?? s.triangles;
    const canvas = adapter?.canvas;
    updateHook(hook, {
      tier,
      fps: stats.fps(now),
      fpsMedian: stats.fpsMedian(),
      p50: ms.p50,
      p95: ms.p95,
      scale,
      width: canvas ? canvas.width : info ? info.width : 0,
      height: canvas ? canvas.height : info ? info.height : 0,
      drawCalls: drawCalls ?? null,
      triangles: triangles ?? null,
      heapMB: env.heapMB() ?? null,
      paused: pauseReasons.size > 0,
    });
    if (meter) {
      meter.update({
        fps: hook.fps,
        fpsMedian: hook.fpsMedian,
        targetFps,
        p50: hook.frameMs.p50,
        p95: hook.frameMs.p95,
        scale: hook.scale,
        width: hook.canvas.width,
        height: hook.canvas.height,
        tier,
        tierSource: source,
        gpu: detection.gpu,
        drawCalls: hook.drawCalls,
        triangles: hook.triangles,
        heapMB: hook.heapMB,
        paused: hook.paused,
        pauseReason: [...pauseReasons][0],
        adaptive: Boolean(controller),
      });
    }
    emit('sample', hook);
  }

  // ---- meter ----
  const meterOpt = options.meter ?? 'auto';
  const meterCfg = typeof meterOpt === 'object' ? meterOpt : {};
  const meter = meterOpt === false || !env.document ? null : createMeter({ document: env.document, devicePixelRatio: env.devicePixelRatio(), position: meterCfg.position });
  if (meter) {
    const flag = params.get(options.meterParam ?? 'perf');
    const fromUrl = flag !== null && /^(1|true|on|yes|)$/i.test(flag);
    if (meterOpt === true || meterCfg.visible || fromUrl) meter.show();
    if (env.window) cleanups.push(listenForToggle({ target: env.window, keys: meterCfg.keys ?? DEFAULT_TOGGLE_KEYS, now: env.now, onToggle: () => meter.toggle() }));
  }

  // ---- hook ----
  if (options.hook !== false && env.window) {
    const w = /** @type {any} */ (env.window);
    w.firelab = hook;
  }

  // ---- browser events ----
  if (env.window) {
    const onResize = () => adapter && applyScale(scale);
    env.window.addEventListener('resize', onResize);
    cleanups.push(() => env.window && env.window.removeEventListener('resize', onResize));
  }
  if (env.document) {
    const doc = env.document;
    const onVis = () => setPausedReason('hidden', env.hidden());
    doc.addEventListener('visibilitychange', onVis);
    cleanups.push(() => doc.removeEventListener('visibilitychange', onVis));
    if (env.hidden()) setPausedReason('hidden', true);
    if (options.pauseWhileVideo) {
      const onMedia = (/** @type {Event} */ e) => {
        if (!e.target || /** @type {any} */ (e.target).tagName !== 'VIDEO') return;
        const playing = Array.from(doc.getElementsByTagName('video')).some((v) => !v.paused && !v.ended);
        setPausedReason('video', playing);
      };
      for (const type of ['playing', 'pause', 'ended', 'emptied']) doc.addEventListener(type, onMedia, true);
      cleanups.push(() => {
        for (const type of ['playing', 'pause', 'ended', 'emptied']) doc.removeEventListener(type, onMedia, true);
      });
    }
  }

  const timer = env.setInterval(publish, updateMs);
  cleanups.push(() => env.clearInterval(timer));
  if (options.autoFrames !== false) rafId = env.requestAnimationFrame(rafLoop);

  const api = {
    /** current tier */
    get tier() {
      return tier;
    },
    /** what chip detection picked */
    get autoTier() {
      return detection.tier;
    },
    /** where the current tier came from */
    get source() {
      return source;
    },
    detection,
    targetFps,
    /** the current tier's preset ({ maxHeight, ... }) */
    get preset() {
      return preset();
    },
    /** current render scale (share of the tier's resolution budget) */
    get scale() {
      return scale;
    },
    /** the pixel ratio and buffer size the last scale produced */
    get scaleInfo() {
      return info;
    },
    get paused() {
      return pauseReasons.size > 0;
    },
    /** the live window.firelab object */
    hook,
    meter: {
      show: () => meter?.show(),
      hide: () => meter?.hide(),
      toggle: () => (meter ? meter.toggle() : false),
      get visible() {
        return meter ? meter.visible : false;
      },
    },
    /**
     * The value for the current tier from a partial map (nearest lighter tier wins).
     * @template T
     * @param {Partial<Record<TierId, T>>} map
     * @returns {T | undefined}
     */
    pick(map) {
      return pickTier(tier, map);
    },
    /**
     * Call once per rendered frame (after rendering). Stops the built-in
     * requestAnimationFrame counting the first time it is called.
     * @param {number} [now]
     */
    frame(now) {
      if (!manualFrames) {
        manualFrames = true;
        if (rafId) env.cancelAnimationFrame(rafId);
        rafId = 0;
        lastFrameAt = NaN;
      }
      onFrame(now ?? env.now());
    },
    attach,
    /** Stop sending scales to the renderer (keeps measuring). */
    detach() {
      adapter = null;
    },
    /**
     * Pause measurement, e.g. while a video covers the scene. Reasons stack:
     * measurement resumes when every reason has been resumed.
     * @param {string} [reason]
     */
    pause(reason = 'app') {
      setPausedReason(reason, true);
    },
    /** @param {string} [reason] */
    resume(reason = 'app') {
      setPausedReason(reason, false);
    },
    /**
     * Expose app state on window.firelab.marks (e.g. mark('scene', 'menu')).
     * @param {string} key
     * @param {string | number | boolean | null | undefined} value  undefined removes the mark
     */
    mark(key, value) {
      if (value === undefined) delete marks[key];
      else marks[key] = value;
    },
    /**
     * Report draw calls / triangles yourself (when the adapter cannot).
     * @param {{ drawCalls?: number, triangles?: number }} s
     */
    report(s) {
      reported = { ...reported, ...s };
    },
    /**
     * Switch tier at run time. persist (default true) remembers it for next
     * launch; 'auto' clears the saved choice. Listen to 'tier' to rebuild what
     * depends on it, or pass reload: true.
     * @param {TierId | 'auto'} next
     * @param {{ persist?: boolean, reload?: boolean }} [opts]
     * @returns {TierId}
     */
    setTier(next, opts = {}) {
      const persist = opts.persist ?? true;
      const prev = tier;
      if (next === 'auto') {
        if (persist) storage.removeItem(storageKey + STORAGE_SUFFIX.saved);
        const again = resolveTier({ auto: detection.tier, storage, storageKey, gpu: detection.gpu });
        tier = again.tier;
        source = again.source;
      } else {
        const t = normalizeTier(next);
        if (!t) throw new RangeError(`[firelab/perf] unknown tier "${next}"`);
        tier = t;
        source = persist ? 'saved' : 'code';
        if (persist) storage.setItem(storageKey + STORAGE_SUFFIX.saved, t);
      }
      hook.tier = tier;
      if (opts.reload && env.reload) {
        env.reload();
        return tier;
      }
      if (controller) {
        const p = preset();
        controller.setRange({ minScale: p.minScale ?? adaptiveOpts.minScale ?? 0.6, maxScale: p.maxScale ?? adaptiveOpts.maxScale ?? 1 });
        controller.reset(adaptiveOpts.initialScale ?? (tier === 'high' ? 1 : 0.75));
        scale = controller.scale;
      }
      if (adapter) applyScale(scale);
      if (prev !== tier) emit('tier', { tier, prev, source });
      return tier;
    },
    /** Forget a stored automatic fallback (e.g. after an optimisation). */
    clearFallback() {
      storage.removeItem(storageKey + STORAGE_SUFFIX.fallback);
    },
    /**
     * @param {PerfEvent} type
     * @param {(payload: any) => void} fn
     * @returns {() => void} unsubscribe
     */
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      /** @type {Set<Function>} */ (listeners.get(type)).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    /** A JSON copy of window.firelab right now. */
    snapshot() {
      publish();
      return /** @type {FirelabHook} */ (JSON.parse(JSON.stringify(hook)));
    },
    /** The adaptive controller's internals (null when adaptive is off or nothing is attached). */
    adaptiveState() {
      return controller ? controller.state() : null;
    },
    /** Remove listeners, timers, the meter and the hook. */
    destroy() {
      destroyed = true;
      if (rafId) env.cancelAnimationFrame(rafId);
      for (const fn of cleanups.splice(0)) fn();
      meter?.destroy();
      const w = /** @type {any} */ (env.window);
      if (w && w.firelab === hook) delete w.firelab;
      listeners.clear();
    },
  };

  if (adapter) attach(adapter);
  if (env.window && options.hook !== false) {
    try {
      Object.defineProperty(env.window, '__firelabPerf', { value: api, configurable: true, writable: true, enumerable: false });
    } catch {
      /* frozen window in some test environments */
    }
  }
  publish();
  return api;
}

/** @param {PerfOptions} o @returns {RenderAdapter | null} */
function resolveAdapter(o) {
  if (o.adapter) return o.adapter;
  if (o.setScale) return { name: 'callback', setScale: o.setScale, canvas: o.canvas ?? null };
  if (o.renderer) return autoAdapter(o.renderer);
  if (o.canvas) return autoAdapter(o.canvas);
  return null;
}

/** @param {string} search */
function safeParams(search) {
  try {
    return new URLSearchParams(search);
  } catch {
    return new URLSearchParams();
  }
}

/** @param {() => { drawCalls?: number, triangles?: number }} fn */
function safeCall(fn) {
  try {
    return fn() || {};
  } catch {
    return {};
  }
}

