/**
 * The GPU capability shim: a script that runs before the page's own scripts
 * and makes WebGL report only what one Fire TV model's GPU supports. It
 * copies features and limits (WebGL1/WebGL2, MAX_TEXTURE_SIZE and friends,
 * the extension list, compressed texture formats, shader precision, the
 * renderer string), never speed: frame rates under the shim still belong to
 * the machine it runs on.
 *
 * Where the game asks for more than the GPU has, the shim answers the way a
 * driver does: getContext and getExtension return null, an oversized texture
 * or renderbuffer is not created and getError() reports INVALID_VALUE, a
 * shader the GPU can't compile fails to compile. Every such call is recorded
 * on `window.__firelabGpu` and logged as a `[firelab-gpu]` console warning.
 *
 * Pure (no imports): the engine's probe and the fit CLI both use it.
 */

export type GpuFactSource = 'measured' | 'spec' | 'estimated';

/** One value the shim copies, with where it came from. */
export type GpuFact = { name: string; value: string; source: GpuFactSource; note?: string };

export type PrecisionFormat = { rangeMin: number; rangeMax: number; precision: number };

/** Everything the shim needs, as plain JSON (stored in run configs and traces). */
export type GpuEmulation = {
  model: string;
  name: string;
  /** UNMASKED_RENDERER_WEBGL, e.g. "PowerVR Rogue GE8300". */
  renderer: string;
  /** UNMASKED_VENDOR_WEBGL. */
  vendor: string;
  webgl1: boolean;
  webgl2: boolean;
  /** getParameter limits by GL enum (decimal string keys); arrays for MAX_VIEWPORT_DIMS. Missing = the host's value. */
  limits: Record<string, number | [number, number]>;
  /** Extension names the GPU exposes, per context type. */
  extensions: { webgl1: string[]; webgl2: string[] };
  /** Compressed texture families the GPU decodes (etc1, etc2, astc, pvrtc, ...). */
  compressed: string[];
  /** getShaderPrecisionFormat overrides, keyed "<shaderType>:<precisionType>" as GL enums. */
  precision: Record<string, PrecisionFormat>;
  /** False on GPUs without highp in fragment shaders (Mali Utgard): a fragment shader that declares highp without the GL_FRAGMENT_PRECISION_HIGH guard fails to compile. */
  fragmentHighp: boolean;
  /** No WebGPU in the Fire TV WebView. */
  webgpu: boolean;
  /** Where each value came from, for the report. */
  facts: GpuFact[];
  notes: string[];
};

/** One WebGL call that failed under the shim (counted once per key). */
export type GpuFailure = {
  key: string;
  /** fail = the call failed (null context, no texture, no shader); warn = a capability the page may have a fallback for. */
  sev: 'fail' | 'warn';
  call: string;
  detail: string;
  n: number;
  /** ms after page load of the first occurrence. */
  t?: number;
};

export type GpuShimReport = {
  installed: boolean;
  model?: string;
  url?: string;
  failures: GpuFailure[];
  /** Failed calls in all (repeats included). */
  total: number;
  /** Contexts the page asked for and got, by type. */
  /** drew1: the page drew with a WebGL1 context (so a refused WebGL2 had a working fallback). */
  contexts: { webgl: number; webgl2: number; refused: number; drew1: boolean };
  /** Extensions the stick has that this browser lacks: they can't be emulated here. */
  hostMissing: string[];
};

/** GL enums the shim limits, by name (the values are what getParameter takes). */
export const GL = {
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_SAMPLES: 0x8d57,
  MAX_3D_TEXTURE_SIZE: 0x8073,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  LOW_FLOAT: 0x8df0,
  MEDIUM_FLOAT: 0x8df1,
  HIGH_FLOAT: 0x8df2,
} as const;

export const GL_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(GL).map(([k, v]) => [v, k]));

export const GPU_GLOBAL = '__firelabGpu';
export const GPU_LOG_PREFIX = '[firelab-gpu]';

/** The script body; `__CAPS__` is replaced with the emulation JSON. Plain ES2017, no template literals inside. */
const SHIM_BODY = `(() => {
  if (window.__firelabGpu) return;
  const C = __CAPS__;
  const fails = [];
  const byKey = {};
  const G = { v: 1, model: C.model, name: C.name, renderer: C.renderer, fails: fails, total: 0, contexts: { webgl: 0, webgl2: 0, refused: 0, drew1: false }, hostMissing: [] };
  Object.defineProperty(window, '__firelabGpu', { value: G, enumerable: false, configurable: true });
  const now = () => { try { return Math.round(performance.now()); } catch (e) { return 0; } };
  const fail = (sev, call, detail) => {
    G.total++;
    const key = call + ' ' + detail;
    const f = byKey[key];
    if (f) { f.n++; return; }
    if (fails.length >= 200) return;
    byKey[key] = { key: key, sev: sev, call: call, detail: detail, n: 1, t: now() };
    fails.push(byKey[key]);
    try { console.warn('[firelab-gpu] ' + C.model + ' (' + C.renderer + '): ' + call + ' ' + detail); } catch (e) {}
  };
  G.report = () => { try { console.table(fails.map((f) => ({ sev: f.sev, call: f.call, detail: f.detail, times: f.n }))); } catch (e) {} return fails; };
  const gpu = C.renderer;
  const ext = { 1: {}, 2: {} };
  C.extensions.webgl1.forEach((e) => { ext[1][e.toLowerCase()] = true; });
  C.extensions.webgl2.forEach((e) => { ext[2][e.toLowerCase()] = true; });
  const comp = {};
  C.compressed.forEach((c) => { comp[c] = true; });
  const W1 = window.WebGLRenderingContext && WebGLRenderingContext.prototype;
  const W2 = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  const isGl2 = (gl) => !!(window.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext);
  const lim = (p) => C.limits[String(p)];
  /* Pending synthetic errors per context, returned by getError before the real ones. */
  const errs = new WeakMap();
  const raise = (gl, code) => { const q = errs.get(gl) || []; if (q.indexOf(code) < 0) q.push(code); errs.set(gl, q); };
  const INVALID_ENUM = 0x0500, INVALID_VALUE = 0x0501, INVALID_OPERATION = 0x0502;

  /* ---- contexts ---- */
  const wrapCanvas = (proto) => {
    if (!proto || typeof proto.getContext !== 'function') return;
    const orig = proto.getContext;
    proto.getContext = function (type) {
      const t = String(type);
      if (t === 'webgl2' && !C.webgl2) { G.contexts.refused++; fail('fail', 'getContext("webgl2")', 'returned null: no WebGL2 on ' + gpu); return null; }
      if ((t === 'webgl' || t === 'experimental-webgl') && !C.webgl1) { G.contexts.refused++; fail('fail', 'getContext("' + t + '")', 'returned null: no WebGL on ' + gpu); return null; }
      const ctx = orig.apply(this, arguments);
      if (ctx && t === 'webgl2') G.contexts.webgl2++;
      else if (ctx && (t === 'webgl' || t === 'experimental-webgl')) G.contexts.webgl++;
      return ctx;
    };
  };
  wrapCanvas(window.HTMLCanvasElement && HTMLCanvasElement.prototype);
  wrapCanvas(window.OffscreenCanvas && OffscreenCanvas.prototype);

  /* ---- WebGPU ---- */
  if (!C.webgpu && window.Navigator && 'gpu' in Navigator.prototype) {
    try {
      Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => { fail('warn', 'navigator.gpu', 'is undefined: the Fire TV WebView has no WebGPU'); return undefined; } });
    } catch (e) {}
  }

  const COMPRESSED_FAMILY = (f) => {
    if (f === 0x8d64) return 'etc1';
    if (f >= 0x9270 && f <= 0x9279) return 'etc2';
    if ((f >= 0x93b0 && f <= 0x93bd) || (f >= 0x93d0 && f <= 0x93dd)) return 'astc';
    if ((f >= 0x83f0 && f <= 0x83f3) || (f >= 0x8c4c && f <= 0x8c4f)) return 's3tc';
    if (f >= 0x8c00 && f <= 0x8c03) return 'pvrtc';
    if (f >= 0x8e8c && f <= 0x8e8f) return 'bptc';
    if (f >= 0x8dbb && f <= 0x8dbe) return 'rgtc';
    if (f === 0x8c92 || f === 0x8c93 || f === 0x87ee) return 'atc';
    return undefined;
  };
  const extFamily = (name) => {
    const n = name.toLowerCase();
    if (/compressed_texture_etc1$/.test(n)) return 'etc1';
    if (/compressed_texture_etc$/.test(n)) return 'etc2';
    if (/compressed_texture_astc/.test(n)) return 'astc';
    if (/compressed_texture_s3tc/.test(n)) return 's3tc';
    if (/compressed_texture_pvrtc/.test(n)) return 'pvrtc';
    if (/texture_compression_bptc/.test(n)) return 'bptc';
    if (/texture_compression_rgtc/.test(n)) return 'rgtc';
    if (/compressed_texture_atc/.test(n)) return 'atc';
    return undefined;
  };
  const allowedExt = (v, name) => {
    const n = String(name).toLowerCase();
    if (!ext[v][n]) return false;
    const fam = extFamily(n);
    return !fam || !!comp[fam];
  };

  const sizeFor = (target, level) => {
    const cube = target >= 0x8515 && target <= 0x851a;
    const m = lim(cube ? 0x851c : 0x0d33);
    return typeof m === 'number' ? Math.max(1, m >> (level || 0)) : undefined;
  };
  const srcDims = (s) => (s && typeof s === 'object' ? [s.videoWidth || s.naturalWidth || s.displayWidth || s.width || 0, s.videoHeight || s.naturalHeight || s.displayHeight || s.height || 0] : [0, 0]);
  const tooBig = (gl, call, target, level, w, h) => {
    const m = sizeFor(target, level);
    if (m === undefined || (w <= m && h <= m)) return false;
    fail('fail', call, w + 'x' + h + (level ? ' at mip level ' + level : '') + ' is over MAX_' + (target >= 0x8515 && target <= 0x851a ? 'CUBE_MAP_' : '') + 'TEXTURE_SIZE ' + m + ' on ' + gpu + ': INVALID_VALUE, no texture');
    raise(gl, INVALID_VALUE);
    return true;
  };

  const checked = {};
  const shaderType = new WeakMap();
  const shaderSrc = new WeakMap();
  const shaderBad = new WeakMap();
  const progShaders = new WeakMap();
  const progBad = new WeakMap();

  const wrapGl = (proto) => {
    if (!proto) return;
    const w = (name, make) => { const o = proto[name]; if (typeof o === 'function') proto[name] = make(o); };
    w('getSupportedExtensions', (o) => function () {
      const r = o.apply(this, arguments);
      if (!r) return r;
      const v = isGl2(this) ? 2 : 1;
      if (!checked[v]) {
        checked[v] = true;
        const have = {};
        r.forEach((e) => { have[e.toLowerCase()] = true; });
        C.extensions[v === 2 ? 'webgl2' : 'webgl1'].forEach((e) => { if (!have[e.toLowerCase()] && allowedExt(v, e) && G.hostMissing.indexOf(e) < 0) G.hostMissing.push(e); });
      }
      return r.filter((e) => allowedExt(v, e));
    });
    w('getExtension', (o) => function (name) {
      if (!allowedExt(isGl2(this) ? 2 : 1, name)) {
        const fam = extFamily(String(name));
        /* Legacy vendor-prefixed aliases (MOZ_, WEBKIT_) are probes libraries make after the real name: not worth a line. */
        if (!/^(MOZ|WEBKIT)_/i.test(String(name))) fail('warn', 'getExtension("' + name + '")', 'returned null: ' + gpu + (fam ? ' has no ' + fam.toUpperCase() + ' texture compression' : ' does not expose it'));
        return null;
      }
      const r = o.apply(this, arguments);
      if (!r && G.hostMissing.indexOf(String(name)) < 0) G.hostMissing.push(String(name));
      return r;
    });
    w('getParameter', (o) => function (p) {
      if (p === 0x9246) return C.renderer;
      if (p === 0x9245) return C.vendor;
      const r = o.apply(this, arguments);
      if (p === 0x86a3 && r && r.length !== undefined) return new Uint32Array(Array.prototype.filter.call(r, (f) => { const fam = COMPRESSED_FAMILY(f); return !fam || !!comp[fam]; }));
      const m = lim(p);
      if (m === undefined || r === null || r === undefined) return r;
      if (typeof m === 'number' && typeof r === 'number') return Math.min(r, m);
      if (Array.isArray(m) && r.length === 2) return new Int32Array([Math.min(r[0], m[0]), Math.min(r[1], m[1])]);
      return r;
    });
    w('getShaderPrecisionFormat', (o) => function (st, pt) {
      const r = o.apply(this, arguments);
      const f = C.precision[st + ':' + pt];
      if (!f || !r) return r;
      return Object.freeze({ rangeMin: f.rangeMin, rangeMax: f.rangeMax, precision: f.precision });
    });
    /* Draw calls on a WebGL1 context: a refused WebGL2 had a fallback that works. */
    ['drawArrays', 'drawElements'].forEach((n) => w(n, (o) => function () {
      if (!G.contexts.drew1 && !isGl2(this)) G.contexts.drew1 = true;
      return o.apply(this, arguments);
    }));
    w('getError', (o) => function () {
      const q = errs.get(this);
      if (q && q.length) return q.shift();
      return o.apply(this, arguments);
    });
    w('texImage2D', (o) => function (target, level) {
      const a = arguments;
      const d = a.length >= 8 ? [a[3], a[4]] : srcDims(a[a.length - 1]);
      if (tooBig(this, 'texImage2D', target, level, d[0], d[1])) return;
      return o.apply(this, a);
    });
    w('texStorage2D', (o) => function (target, levels, fmt, wd, ht) {
      if (tooBig(this, 'texStorage2D', target, 0, wd, ht)) return;
      return o.apply(this, arguments);
    });
    w('texImage3D', (o) => function (target, level, fmt, wd, ht, dp) {
      const m3 = lim(target === 0x806f ? 0x8073 : 0x0d33);
      const layers = lim(0x88ff);
      if (typeof m3 === 'number' && (wd > m3 >> (level || 0) || ht > m3 >> (level || 0) || (target === 0x806f && dp > m3 >> (level || 0)))) { fail('fail', 'texImage3D', wd + 'x' + ht + 'x' + dp + ' is over the ' + gpu + ' limit ' + m3 + ': INVALID_VALUE'); raise(this, INVALID_VALUE); return; }
      if (target === 0x8c1a && typeof layers === 'number' && dp > layers) { fail('fail', 'texImage3D', dp + ' layers is over MAX_ARRAY_TEXTURE_LAYERS ' + layers + ' on ' + gpu + ': INVALID_VALUE'); raise(this, INVALID_VALUE); return; }
      return o.apply(this, arguments);
    });
    w('compressedTexImage2D', (o) => function (target, level, fmt, wd, ht) {
      const fam = COMPRESSED_FAMILY(fmt);
      if (fam && !comp[fam]) { fail('fail', 'compressedTexImage2D', fam.toUpperCase() + ' texture (format 0x' + Number(fmt).toString(16) + '): ' + gpu + ' has no ' + fam.toUpperCase() + ': INVALID_ENUM, no texture'); raise(this, INVALID_ENUM); return; }
      if (tooBig(this, 'compressedTexImage2D', target, level, wd, ht)) return;
      return o.apply(this, arguments);
    });
    w('compressedTexImage3D', (o) => function (target, level, fmt) {
      const fam = COMPRESSED_FAMILY(fmt);
      if (fam && !comp[fam]) { fail('fail', 'compressedTexImage3D', fam.toUpperCase() + ' texture: ' + gpu + ' has no ' + fam.toUpperCase() + ': INVALID_ENUM'); raise(this, INVALID_ENUM); return; }
      return o.apply(this, arguments);
    });
    w('compressedTexSubImage2D', (o) => function (target, level, x, y, wd, ht, fmt) {
      const fam = COMPRESSED_FAMILY(fmt);
      if (fam && !comp[fam]) { fail('fail', 'compressedTexSubImage2D', fam.toUpperCase() + ' texture: ' + gpu + ' has no ' + fam.toUpperCase() + ': INVALID_ENUM'); raise(this, INVALID_ENUM); return; }
      return o.apply(this, arguments);
    });
    const rbCheck = (gl, call, wd, ht) => {
      const m = lim(0x84e8);
      if (typeof m !== 'number' || (wd <= m && ht <= m)) return false;
      fail('fail', call, wd + 'x' + ht + ' is over MAX_RENDERBUFFER_SIZE ' + m + ' on ' + gpu + ': INVALID_VALUE, no renderbuffer');
      raise(gl, INVALID_VALUE);
      return true;
    };
    w('renderbufferStorage', (o) => function (target, fmt, wd, ht) {
      if (rbCheck(this, 'renderbufferStorage', wd, ht)) return;
      return o.apply(this, arguments);
    });
    w('renderbufferStorageMultisample', (o) => function (target, samples, fmt, wd, ht) {
      const ms = lim(0x8d57);
      if (typeof ms === 'number' && samples > ms) { fail('fail', 'renderbufferStorageMultisample', samples + 'x MSAA is over MAX_SAMPLES ' + ms + ' on ' + gpu + ': INVALID_OPERATION'); raise(this, INVALID_OPERATION); return; }
      if (rbCheck(this, 'renderbufferStorageMultisample', wd, ht)) return;
      return o.apply(this, arguments);
    });
    /* Shaders the GPU can't compile: highp in fragment shaders (no highp hardware), vertex texture fetch (no vertex texture units). */
    w('createShader', (o) => function (type) { const s = o.apply(this, arguments); if (s) shaderType.set(s, type); return s; });
    w('shaderSource', (o) => function (s, src) { if (s) shaderSrc.set(s, String(src)); return o.apply(this, arguments); });
    w('compileShader', (o) => function (s) {
      const r = o.apply(this, arguments);
      const src = (s && shaderSrc.get(s)) || '';
      const type = s && shaderType.get(s);
      const code = src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/\\/\\/.*$/gm, '');
      let why;
      if (type === 0x8b30 && !C.fragmentHighp && /\\bhighp\\b/.test(code) && !/GL_FRAGMENT_PRECISION_HIGH/.test(code)) why = "'highp' : precision not supported in fragment shaders on " + gpu;
      const vtu = lim(0x8b4c);
      if (!why && type === 0x8b31 && vtu === 0 && /\\buniform\\s+(lowp\\s+|mediump\\s+|highp\\s+)?sampler(2D|Cube)\\b/.test(code)) why = 'texture lookups in vertex shaders: MAX_VERTEX_TEXTURE_IMAGE_UNITS is 0 on ' + gpu;
      if (why) { shaderBad.set(s, why); fail('fail', 'compileShader', why); }
      return r;
    });
    w('getShaderParameter', (o) => function (s, p) {
      if (p === 0x8b81 && s && shaderBad.has(s)) return false;
      return o.apply(this, arguments);
    });
    w('getShaderInfoLog', (o) => function (s) {
      if (s && shaderBad.has(s)) return 'ERROR: 0:1: ' + shaderBad.get(s) + ' (emulated by FireLab)\\n';
      return o.apply(this, arguments);
    });
    w('attachShader', (o) => function (p, s) { if (p && s) { const l = progShaders.get(p) || []; l.push(s); progShaders.set(p, l); } return o.apply(this, arguments); });
    w('linkProgram', (o) => function (p) {
      const r = o.apply(this, arguments);
      const bad = (p && progShaders.get(p) || []).find((s) => shaderBad.has(s));
      if (bad) progBad.set(p, shaderBad.get(bad));
      return r;
    });
    w('getProgramParameter', (o) => function (p, n) {
      if (n === 0x8b82 && p && progBad.has(p)) return false;
      return o.apply(this, arguments);
    });
    w('getProgramInfoLog', (o) => function (p) {
      if (p && progBad.has(p)) return 'ERROR: a shader did not compile: ' + progBad.get(p) + ' (emulated by FireLab)\\n';
      return o.apply(this, arguments);
    });
    w('useProgram', (o) => function (p) {
      if (p && progBad.has(p)) { fail('fail', 'useProgram', 'on a program that did not link: ' + progBad.get(p)); raise(this, INVALID_OPERATION); return; }
      return o.apply(this, arguments);
    });
  };
  wrapGl(W1);
  wrapGl(W2);
})()`;

/** The shim as a script for Page.addScriptToEvaluateOnNewDocument (or a page's first <script>). */
export function gpuShimScript(emu: GpuEmulation): string {
  const caps = { model: emu.model, name: emu.name, renderer: emu.renderer, vendor: emu.vendor, webgl1: emu.webgl1, webgl2: emu.webgl2, limits: emu.limits, extensions: emu.extensions, compressed: emu.compressed, precision: emu.precision, fragmentHighp: emu.fragmentHighp, webgpu: emu.webgpu };
  // JSON in a <script> or a javascript: URL must not close the tag; < is escaped.
  return SHIM_BODY.replace('__CAPS__', () => JSON.stringify(caps).replace(/</g, '\\u003c'));
}

/** A userscript (Tampermonkey / Violentmonkey, `@run-at document-start`) or a file for the page's first <script src>. */
export function gpuShimFile(emu: GpuEmulation): string {
  return [
    '// ==UserScript==',
    `// @name        FireLab GPU emulation: ${emu.name} (${emu.model})`,
    '// @description WebGL reports only what this Fire TV GPU supports (features and limits, not speed). Generated by `firelab fit --emulate-gpu`.',
    '// @match       *://*/*',
    '// @run-at      document-start',
    '// @grant       none',
    '// ==/UserScript==',
    `// GPU: ${emu.renderer}. WebGL2: ${emu.webgl2 ? 'yes' : 'no'}. Failed calls: window.${GPU_GLOBAL}.report() in the console.`,
    '// Load it before the game: as the first <script> in index.html, or as a userscript. A bookmarklet is too late for',
    '// games that create their WebGL context on load.',
    `${gpuShimScript(emu)};`,
    '',
  ].join('\n');
}

/** A javascript: bookmarklet. It installs the shim in the page as it is, so it only catches contexts created after the click. */
export function gpuShimBookmarklet(emu: GpuEmulation): string {
  return `javascript:${encodeURIComponent(`${gpuShimScript(emu)};void 0`)}`;
}

/** Reads `window.__firelabGpu` (plain JSON). */
export const GPU_READ_SCRIPT = `(() => {
  const G = window.${GPU_GLOBAL};
  if (!G) return { installed: false, url: location.href };
  return { installed: true, model: G.model, url: location.href, total: G.total, contexts: G.contexts, hostMissing: G.hostMissing, failures: G.fails.map((f) => ({ key: f.key, sev: f.sev, call: f.call, detail: f.detail, n: f.n, t: f.t })) };
})()`;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseGpuFailures(v: unknown): GpuFailure[] {
  if (!Array.isArray(v)) return [];
  const out: GpuFailure[] = [];
  for (const f of v) {
    if (!isObj(f) || typeof f.call !== 'string' || typeof f.detail !== 'string') continue;
    out.push({ key: typeof f.key === 'string' ? f.key : `${f.call} ${f.detail}`, sev: f.sev === 'warn' ? 'warn' : 'fail', call: f.call, detail: f.detail, n: typeof f.n === 'number' ? f.n : 1, ...(typeof f.t === 'number' ? { t: f.t } : {}) });
  }
  return out;
}

export function parseGpuReport(v: unknown): GpuShimReport {
  if (!isObj(v) || v.installed !== true) return { installed: false, ...(isObj(v) && typeof v.url === 'string' ? { url: v.url } : {}), failures: [], total: 0, contexts: { webgl: 0, webgl2: 0, refused: 0, drew1: false }, hostMissing: [] };
  const c = isObj(v.contexts) ? v.contexts : {};
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    installed: true,
    ...(typeof v.model === 'string' ? { model: v.model } : {}),
    ...(typeof v.url === 'string' ? { url: v.url } : {}),
    failures: parseGpuFailures(v.failures),
    total: n(v.total),
    contexts: { webgl: n(c.webgl), webgl2: n(c.webgl2), refused: n(c.refused), drew1: c.drew1 === true },
    hostMissing: Array.isArray(v.hostMissing) ? v.hostMissing.filter((x): x is string => typeof x === 'string') : [],
  };
}
