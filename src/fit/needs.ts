/**
 * What a web app needs from the WebView: parsed from `--needs`, read from
 * `window.firelab.needs`, inferred (three.js r163+ is WebGL2-only) or
 * detected from what the page actually did.
 */
import { compressedFamilyForFormat } from '../profile/webcaps.js';
import type { NeedSource, WebNeeds } from './types.js';

const COMPRESSED = new Set(['etc1', 'etc2', 'astc', 's3tc', 'pvrtc', 'bptc', 'rgtc', 'atc']);
const FEATURES = new Set(['wasm', 'wasm-simd', 'wasm-threads', 'offscreen-canvas', 'webgpu', 'shared-array-buffer', 'web-audio', 'gamepad', 'media-source', 'workers']);

type NeedKey = Exclude<keyof WebNeeds, 'sources' | 'notes'>;

/**
 * `--needs webgl2,astc,etc2,max-texture=4096,max-renderbuffer=4096,float-render,webview>=110,ext:EXT_color_buffer_float,wasm-simd`
 */
export function parseNeedsFlag(spec: string): WebNeeds {
  const n: WebNeeds = { sources: {} };
  const src = n.sources as Partial<Record<NeedKey, NeedSource>>;
  const set = <K extends NeedKey>(k: K, v: WebNeeds[K]) => {
    n[k] = v;
    src[k] = 'flag';
  };
  for (const raw of spec.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) {
    const t = raw.toLowerCase();
    let m: RegExpExecArray | null;
    if (t === 'webgl2' || t === 'webgl1' || t === 'webgl') set('webgl', t === 'webgl2' ? 2 : 1);
    else if (COMPRESSED.has(t)) set('compressed', [...new Set([...(n.compressed ?? []), t])]);
    else if ((m = /^max-?texture(?:-size)?[=:](\d+)$/.exec(t))) set('maxTextureSize', Number(m[1]));
    else if ((m = /^max-?renderbuffer(?:-size)?[=:](\d+)$/.exec(t))) set('maxRenderbufferSize', Number(m[1]));
    else if (t === 'float-render' || t === 'float' || t === 'color-buffer-float') set('floatRender', true);
    else if ((m = /^(?:webview|chrome)(?:>=|=|:)(\d+)$/.exec(t))) set('minWebView', Number(m[1]));
    else if ((m = /^ext:(\w+)$/i.exec(raw))) set('extensions', [...new Set([...(n.extensions ?? []), (m[1] as string)])]);
    else if (FEATURES.has(t)) set('features', [...new Set([...(n.features ?? []), t])]);
    else if (/^[A-Z]+_\w+$/.test(raw)) set('extensions', [...new Set([...(n.extensions ?? []), raw])]);
    else throw new Error(`Unknown need "${raw}". Use: webgl2, webgl1, etc1, etc2, astc, s3tc, pvrtc, max-texture=4096, max-renderbuffer=4096, float-render, webview>=110, ext:<WebGL extension>, ${[...FEATURES].join(', ')}`);
  }
  return n;
}

/** Validates the page's own declaration (window.firelab.needs). */
export function needsFromDeclaration(raw: unknown): WebNeeds | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const n: WebNeeds = { sources: {} };
  const src = n.sources as Partial<Record<NeedKey, NeedSource>>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  if (r.webgl === 1 || r.webgl === 2) ((n.webgl = r.webgl), (src.webgl = 'page'));
  else if (r.webgl === 'webgl2' || r.webgl2 === true) ((n.webgl = 2), (src.webgl = 'page'));
  const ext = strs(r.extensions);
  if (ext?.length) ((n.extensions = ext), (src.extensions = 'page'));
  const comp = strs(r.compressed)?.map((c) => c.toLowerCase()).filter((c) => COMPRESSED.has(c));
  if (comp?.length) ((n.compressed = comp), (src.compressed = 'page'));
  for (const k of ['maxTextureSize', 'maxRenderbufferSize', 'minWebView'] as const) {
    const v = r[k];
    if (typeof v === 'number' && v > 0) ((n[k] = v), (src[k] = 'page'));
  }
  if (r.floatRender === true) ((n.floatRender = true), (src.floatRender = 'page'));
  const feats = strs(r.features)?.map((f) => f.toLowerCase());
  if (feats?.length) ((n.features = feats), (src.features = 'page'));
  return Object.keys(src).length ? n : undefined;
}

/** What the detection hook (and the page) reported: see NEEDS_READ_SCRIPT. */
export type DetectedUsage = {
  contexts?: { webgl?: boolean; webgl2?: boolean };
  /** Existing canvases' context types, probed without reloading. */
  canvasContexts?: string[];
  extensions?: string[];
  compressedFormats?: number[];
  maxTexture?: number;
  maxRenderbuffer?: number;
  floatRender?: boolean;
  threeRevision?: string | number;
  declared?: unknown;
  hooked?: boolean;
};

/** Turns detected usage into needs: three.js r163+ = WebGL2 for sure; other usage is soft. */
export function needsFromUsage(u: DetectedUsage | undefined): WebNeeds | undefined {
  if (!u) return undefined;
  const n: WebNeeds = { sources: {}, notes: [] };
  const src = n.sources as Partial<Record<NeedKey, NeedSource>>;
  const notes = n.notes as string[];
  const three = Number(String(u.threeRevision ?? '').replace(/\D.*$/, ''));
  const usesGl2 = !!u.contexts?.webgl2 || (u.canvasContexts ?? []).includes('webgl2');
  const usesGl1 = !!u.contexts?.webgl || (u.canvasContexts ?? []).includes('webgl');
  if (Number.isFinite(three) && three >= 163) {
    n.webgl = 2;
    src.webgl = 'inferred';
    notes.push(`three.js r${three} draws with WebGL2 only (WebGL1 support was removed in r163).`);
  } else if (usesGl2) {
    n.webgl = 2;
    src.webgl = 'detected';
    notes.push('The page drew with WebGL2; it may or may not fall back to WebGL1 (declare window.firelab.needs to be sure).');
  } else if (usesGl1) {
    n.webgl = 1;
    src.webgl = 'detected';
  }
  const fams = [...new Set((u.compressedFormats ?? []).map(compressedFamilyForFormat).filter((x): x is string => !!x))];
  if (fams.length) {
    n.compressed = fams.sort();
    src.compressed = 'detected';
  }
  if (u.maxTexture && u.maxTexture > 2048) {
    n.maxTextureSize = u.maxTexture;
    src.maxTextureSize = 'detected';
  }
  if (u.maxRenderbuffer && u.maxRenderbuffer > 2048) {
    n.maxRenderbufferSize = u.maxRenderbuffer;
    src.maxRenderbufferSize = 'detected';
  }
  if (u.floatRender) {
    n.floatRender = true;
    src.floatRender = 'detected';
  }
  if (!Object.keys(src).length && !notes.length) return undefined;
  if (!notes.length) delete n.notes;
  return n;
}

const RANK: Record<NeedSource, number> = { flag: 3, page: 2, inferred: 1, detected: 0 };

/** Merges needs; for each field the strongest source wins (flag > page > inferred > detected). */
export function mergeNeeds(...all: (WebNeeds | undefined)[]): WebNeeds | undefined {
  const out: WebNeeds = { sources: {} };
  const src = out.sources as Partial<Record<NeedKey, NeedSource>>;
  const notes: string[] = [];
  for (const n of all) {
    if (!n) continue;
    if (n.notes) notes.push(...n.notes);
    for (const k of Object.keys(n.sources ?? {}) as NeedKey[]) {
      const s = n.sources?.[k] as NeedSource;
      const cur = src[k];
      if (cur === undefined || RANK[s] > RANK[cur]) {
        (out as Record<string, unknown>)[k] = n[k];
        src[k] = s;
      }
    }
  }
  if (notes.length) out.notes = [...new Set(notes)];
  return Object.keys(src).length ? out : undefined;
}

/** Hard needs make a model fail; soft (detected) ones make it risky. */
export const isHard = (n: WebNeeds, k: NeedKey): boolean => (n.sources?.[k] ?? 'detected') !== 'detected';

/**
 * Installed before the page's own scripts (Page.addScriptToEvaluateOnNewDocument)
 * when `--detect-needs` reloads the page: records which WebGL contexts,
 * extensions, compressed formats and texture sizes the page really uses.
 */
export const NEEDS_HOOK_SCRIPT = `(() => {
  if (window.__firelabNeeds) return;
  const N = { contexts: {}, extensions: [], compressedFormats: [], maxTexture: 0, maxRenderbuffer: 0, floatRender: false, hooked: true };
  Object.defineProperty(window, '__firelabNeeds', { value: N, enumerable: false, configurable: true });
  const addOnce = (arr, v) => { if (arr.indexOf(v) < 0 && arr.length < 200) arr.push(v); };
  const wrapCtx = (proto) => {
    if (!proto || !proto.getContext) return;
    const orig = proto.getContext;
    proto.getContext = function (type) {
      const ctx = orig.apply(this, arguments);
      if (ctx && /^(webgl2|webgl|experimental-webgl)$/.test(type)) N.contexts[type === 'webgl2' ? 'webgl2' : 'webgl'] = true;
      return ctx;
    };
  };
  wrapCtx(window.HTMLCanvasElement && HTMLCanvasElement.prototype);
  wrapCtx(window.OffscreenCanvas && OffscreenCanvas.prototype);
  const dims = (args, wi, hi) => {
    if (typeof args[wi] === 'number' && typeof args[hi] === 'number') return Math.max(args[wi], args[hi]);
    const src = args[args.length - 1];
    if (src && typeof src === 'object') return Math.max(src.videoWidth || src.naturalWidth || src.width || 0, src.videoHeight || src.naturalHeight || src.height || 0);
    return 0;
  };
  const wrapGl = (proto) => {
    if (!proto) return;
    const w = (name, fn) => { const o = proto[name]; if (typeof o !== 'function') return; proto[name] = function () { try { fn.call(this, arguments); } catch (e) {} return o.apply(this, arguments); }; };
    w('getExtension', (a) => { if (typeof a[0] === 'string') addOnce(N.extensions, a[0]); if (/^EXT_color_buffer_(half_)?float$/.test(a[0])) N.floatRender = true; });
    w('texImage2D', (a) => { N.maxTexture = Math.max(N.maxTexture, a.length >= 8 ? dims(a, 3, 4) : dims(a, -1, -1)); });
    w('texStorage2D', (a) => { N.maxTexture = Math.max(N.maxTexture, dims(a, 3, 4)); });
    w('compressedTexImage2D', (a) => { addOnce(N.compressedFormats, a[2]); N.maxTexture = Math.max(N.maxTexture, dims(a, 3, 4)); });
    w('compressedTexImage3D', (a) => { addOnce(N.compressedFormats, a[2]); });
    w('renderbufferStorage', (a) => { N.maxRenderbuffer = Math.max(N.maxRenderbuffer, a[2] || 0, a[3] || 0); });
    w('renderbufferStorageMultisample', (a) => { N.maxRenderbuffer = Math.max(N.maxRenderbuffer, a[3] || 0, a[4] || 0); });
  };
  wrapGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  wrapGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})()`;

/**
 * Reads usage without reloading: the hook's record (if installed), the
 * page's declaration, three.js's revision, and the context type of each
 * visible canvas (asking a canvas that already has a context for one never
 * creates a new context).
 */
export const NEEDS_READ_SCRIPT = `(() => {
  const N = window.__firelabNeeds;
  const out = N ? JSON.parse(JSON.stringify(N)) : {};
  out.declared = window.firelab && window.firelab.needs ? JSON.parse(JSON.stringify(window.firelab.needs)) : undefined;
  if (window.__THREE__) out.threeRevision = String(window.__THREE__);
  out.canvasContexts = [];
  try {
    document.querySelectorAll('canvas').forEach((c) => {
      // Only large, visible canvases: a page draws on those, so they already have a context.
      const r = c.getBoundingClientRect();
      if (c.width < 64 || c.height < 64 || !c.isConnected || r.width < 1 || r.height < 1) return;
      for (const t of ['webgl2', 'webgl', '2d']) { let ctx = null; try { ctx = c.getContext(t); } catch (e) {} if (ctx) { out.canvasContexts.push(t); break; } }
    });
  } catch (e) {}
  return out;
})()`;
