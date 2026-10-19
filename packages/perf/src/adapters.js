// Renderer adapters: how a render scale reaches your engine.
//
// None of them imports an engine. They are duck-typed, so they add no
// dependency and work across engine versions.

/** @typedef {import('./tiers.js').TierId} TierId */

/**
 * @typedef {object} ScaleInfo
 * @property {number} pixelRatio     device pixels per CSS pixel to render at
 * @property {number} width          resulting drawing buffer width
 * @property {number} height         resulting drawing buffer height
 * @property {number} maxPixelRatio  the pixel ratio at scale 1 (the tier's resolution budget)
 * @property {number} cssWidth
 * @property {number} cssHeight
 * @property {TierId} tier
 */

/**
 * @typedef {object} RenderAdapter
 * @property {(scale: number, info: ScaleInfo) => void} setScale
 * @property {() => { drawCalls?: number, triangles?: number }} [stats]   read a few times a second
 * @property {HTMLCanvasElement | null} [canvas]
 * @property {WebGLRenderingContext | WebGL2RenderingContext | null} [gl]
 * @property {string} [name]
 */

/**
 * The pixel ratio for a scale. Scale 1 is the tier's budget: its maxHeight
 * in device pixels (720 on 'tv'), never more than the screen has.
 *
 *   computeScaleInfo(0.6, { maxHeight: 720, cssWidth: 960, cssHeight: 540, devicePixelRatio: 2 })
 *   // -> pixelRatio 0.8, 768 x 432
 *
 * @param {number} scale
 * @param {{ maxHeight: number, cssWidth: number, cssHeight: number, devicePixelRatio?: number, maxPixelRatio?: number, tier?: TierId }} view
 * @returns {ScaleInfo}
 */
export function computeScaleInfo(scale, view) {
  const cssW = view.cssWidth > 0 ? view.cssWidth : 1280;
  const cssH = view.cssHeight > 0 ? view.cssHeight : 720;
  const dpr = view.devicePixelRatio && view.devicePixelRatio > 0 ? view.devicePixelRatio : 1;
  const budget = view.maxPixelRatio ?? Math.min(view.maxHeight / cssH, dpr);
  // Rounded up to 4 decimals: renderers floor() the buffer size, so a ratio a
  // hair below 4/3 would give a 1279x719 buffer instead of 1280x720.
  const pixelRatio = Math.max(0.05, Math.ceil(scale * budget * 1e4 - 1e-6) / 1e4);
  return {
    pixelRatio,
    width: Math.max(1, Math.floor(cssW * pixelRatio)),
    height: Math.max(1, Math.floor(cssH * pixelRatio)),
    maxPixelRatio: budget,
    cssWidth: cssW,
    cssHeight: cssH,
    tier: view.tier ?? 'tv',
  };
}

/**
 * three.js: `renderer.setPixelRatio()`, plus draw calls and triangles from
 * `renderer.info.render`.
 * @param {{ setPixelRatio(r: number): void, domElement?: HTMLCanvasElement, info?: { render?: { calls?: number, triangles?: number } }, getContext?: () => any }} renderer
 * @returns {RenderAdapter}
 */
export function threeAdapter(renderer) {
  return {
    name: 'three',
    canvas: renderer.domElement ?? null,
    gl: renderer.getContext ? renderer.getContext() : null,
    setScale(_scale, info) {
      renderer.setPixelRatio(info.pixelRatio);
    },
    stats() {
      const r = renderer.info && renderer.info.render;
      return r ? { drawCalls: r.calls, triangles: r.triangles } : {};
    },
  };
}

/**
 * Babylon.js: `engine.setHardwareScalingLevel(1 / pixelRatio)` then `resize()`.
 * Pass the scene to report triangles.
 * @param {{ setHardwareScalingLevel(level: number): void, resize(): void, getRenderingCanvas?: () => HTMLCanvasElement | null, _gl?: any, _drawCalls?: { current: number } }} engine
 * @param {{ scene?: { getActiveIndices?: () => number } }} [opts]
 * @returns {RenderAdapter}
 */
export function babylonAdapter(engine, opts = {}) {
  return {
    name: 'babylon',
    canvas: engine.getRenderingCanvas ? engine.getRenderingCanvas() : null,
    gl: engine._gl ?? null,
    setScale(_scale, info) {
      engine.setHardwareScalingLevel(1 / info.pixelRatio);
      engine.resize();
    },
    stats() {
      /** @type {{ drawCalls?: number, triangles?: number }} */
      const out = {};
      if (engine._drawCalls && typeof engine._drawCalls.current === 'number') out.drawCalls = engine._drawCalls.current;
      const idx = opts.scene?.getActiveIndices?.();
      if (typeof idx === 'number') out.triangles = idx / 3;
      return out;
    },
  };
}

/**
 * PixiJS (v7 and v8): sets `renderer.resolution` and resizes to the current
 * screen size.
 * @param {{ renderer: { resolution: number, resize(w: number, h: number): void, gl?: any }, screen: { width: number, height: number }, canvas?: HTMLCanvasElement, view?: HTMLCanvasElement }} app
 * @returns {RenderAdapter}
 */
export function pixiAdapter(app) {
  return {
    name: 'pixi',
    canvas: app.canvas ?? app.view ?? null,
    gl: app.renderer.gl ?? null,
    setScale(_scale, info) {
      app.renderer.resolution = info.pixelRatio;
      app.renderer.resize(app.screen.width, app.screen.height);
    },
  };
}

/**
 * A plain canvas (raw WebGL, 2D or your own engine): sets the drawing buffer
 * size, then calls `onResize(width, height, pixelRatio)` so you can update the
 * viewport and projection.
 * @param {HTMLCanvasElement} canvas
 * @param {{ onResize?: (width: number, height: number, pixelRatio: number) => void, gl?: WebGLRenderingContext | WebGL2RenderingContext | null, stats?: () => { drawCalls?: number, triangles?: number } }} [opts]
 * @returns {RenderAdapter}
 */
export function canvasAdapter(canvas, opts = {}) {
  return {
    name: 'canvas',
    canvas,
    gl: opts.gl ?? null,
    setScale(_scale, info) {
      if (canvas.width !== info.width) canvas.width = info.width;
      if (canvas.height !== info.height) canvas.height = info.height;
      if (opts.gl) opts.gl.viewport(0, 0, info.width, info.height);
      opts.onResize?.(info.width, info.height, info.pixelRatio);
    },
    stats: opts.stats,
  };
}

/**
 * Recognises a three.js renderer, a Babylon engine, a Pixi application or a
 * canvas element and wraps it in the matching adapter. Returns null when it
 * cannot tell.
 * @param {any} target
 * @returns {RenderAdapter | null}
 */
export function autoAdapter(target) {
  if (!target) return null;
  if (typeof target.setScale === 'function') return /** @type {RenderAdapter} */ (target);
  if (typeof target.setPixelRatio === 'function' && target.domElement) return threeAdapter(target);
  if (typeof target.setHardwareScalingLevel === 'function') return babylonAdapter(target);
  if (target.renderer && 'resolution' in target.renderer && target.screen) return pixiAdapter(target);
  if (typeof target.getContext === 'function' && 'width' in target && 'height' in target) return canvasAdapter(target);
  return null;
}
