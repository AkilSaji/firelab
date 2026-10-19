/**
 * What a WebView can do, read from inside a page: WebGL 1/2 limits and
 * extensions, the Chromium version, media decoding support and a few web
 * platform features. `firelab profile` stores it; `firelab fit` compares a
 * page's needs against it.
 */

export type WebGLCaps = {
  renderer?: string;
  vendor?: string;
  version?: string;
  maxTextureSize?: number;
  maxRenderbufferSize?: number;
  maxViewportDims?: number[];
  maxSamples?: number;
  extensions: string[];
  /** Fragment shader mediump float precision bits (10 = FP16). */
  mediumpPrecision?: number;
};

export type DecodingResult = { supported: boolean; smooth: boolean; powerEfficient: boolean };

export type WebCaps = {
  userAgent?: string;
  chromeVersion?: string;
  chromeMajor?: number;
  screen?: { width: number; height: number; dpr: number };
  deviceMemoryGB?: number;
  cores?: number;
  webgl1: WebGLCaps | null;
  webgl2: WebGLCaps | null;
  /** Compressed texture families from the extension lists. */
  compressed: string[];
  floatRender: boolean;
  canPlay?: Record<string, string>;
  /** MediaCapabilities.decodingInfo answers, keyed "<codec string>@<w>x<h>p<fps>". */
  decoding?: Record<string, DecodingResult>;
  features?: Record<string, boolean>;
};

const COMPRESSED_EXT: [RegExp, string][] = [
  [/compressed_texture_etc1$/i, 'etc1'],
  [/compressed_texture_etc$/i, 'etc2'],
  [/compressed_texture_astc/i, 'astc'],
  [/compressed_texture_s3tc/i, 's3tc'],
  [/compressed_texture_pvrtc/i, 'pvrtc'],
  [/texture_compression_bptc/i, 'bptc'],
  [/texture_compression_rgtc/i, 'rgtc'],
  [/compressed_texture_atc/i, 'atc'],
];

/** WebGL extension names -> compressed texture families (etc1, etc2, astc, s3tc, pvrtc, bptc, rgtc, atc). */
export function compressedFamilies(extensions: readonly string[]): string[] {
  const out = new Set<string>();
  for (const e of extensions) for (const [re, fam] of COMPRESSED_EXT) if (re.test(e)) out.add(fam);
  return [...out].sort();
}

/** Compressed texture families by GL internal-format enum (as passed to compressedTexImage2D). */
export function compressedFamilyForFormat(format: number): string | undefined {
  if (format === 0x8d64) return 'etc1';
  if (format >= 0x9270 && format <= 0x9279) return 'etc2';
  if ((format >= 0x93b0 && format <= 0x93bd) || (format >= 0x93d0 && format <= 0x93dd)) return 'astc';
  if ((format >= 0x83f0 && format <= 0x83f3) || (format >= 0x8c4c && format <= 0x8c4f)) return 's3tc';
  if (format >= 0x8c00 && format <= 0x8c03) return 'pvrtc';
  if (format >= 0x8e8c && format <= 0x8e8f) return 'bptc';
  if (format >= 0x8dbb && format <= 0x8dbe) return 'rgtc';
  if (format === 0x8c92 || format === 0x8c93 || format === 0x87ee) return 'atc';
  return undefined;
}

/** Codec strings asked of MediaCapabilities, with the decoder family they belong to. */
export const DECODE_PROBES: { codec: 'avc' | 'hevc' | 'vp9' | 'av1'; contentType: string; profile: string; level: string }[] = [
  { codec: 'avc', contentType: 'video/mp4; codecs="avc1.4D401F"', profile: 'main', level: '3.1' },
  { codec: 'avc', contentType: 'video/mp4; codecs="avc1.640028"', profile: 'high', level: '4.0' },
  { codec: 'avc', contentType: 'video/mp4; codecs="avc1.64002A"', profile: 'high', level: '4.2' },
  { codec: 'avc', contentType: 'video/mp4; codecs="avc1.640033"', profile: 'high', level: '5.1' },
  { codec: 'hevc', contentType: 'video/mp4; codecs="hvc1.1.6.L120.90"', profile: 'main', level: '4.0' },
  { codec: 'hevc', contentType: 'video/mp4; codecs="hvc1.1.6.L153.90"', profile: 'main', level: '5.1' },
  { codec: 'hevc', contentType: 'video/mp4; codecs="hvc1.2.4.L153.90"', profile: 'main10', level: '5.1' },
  { codec: 'vp9', contentType: 'video/mp4; codecs="vp09.00.41.08"', profile: 'profile0', level: '4.1' },
  { codec: 'vp9', contentType: 'video/mp4; codecs="vp09.00.51.08"', profile: 'profile0', level: '5.1' },
  { codec: 'vp9', contentType: 'video/mp4; codecs="vp09.02.51.10"', profile: 'profile2', level: '5.1' },
  { codec: 'av1', contentType: 'video/mp4; codecs="av01.0.08M.08"', profile: 'main', level: '4.0' },
  { codec: 'av1', contentType: 'video/mp4; codecs="av01.0.13M.10"', profile: 'main', level: '5.1' },
];
export const DECODE_SIZES: { w: number; h: number; fps: number; bitrate: number }[] = [
  { w: 1920, h: 1080, fps: 30, bitrate: 8_000_000 },
  { w: 1920, h: 1080, fps: 60, bitrate: 12_000_000 },
  { w: 3840, h: 2160, fps: 30, bitrate: 20_000_000 },
  { w: 3840, h: 2160, fps: 60, bitrate: 30_000_000 },
];
export const CAN_PLAY_TYPES = [
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="avc1.640028"',
  'video/mp4; codecs="hvc1.1.6.L120.90"',
  'video/mp4; codecs="hev1.1.6.L120.90"',
  'video/webm; codecs="vp9"',
  'video/mp4; codecs="vp09.00.41.08"',
  'video/mp4; codecs="av01.0.08M.08"',
  'video/webm; codecs="vp8"',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="ac-3"',
  'audio/mp4; codecs="ec-3"',
  'audio/webm; codecs="opus"',
  'application/vnd.apple.mpegurl',
];

/**
 * Evaluated in the page (Runtime.evaluate with awaitPromise). Creates two
 * 1x1 throwaway WebGL contexts and releases them straight away.
 */
export const WEB_CAPS_SCRIPT = `(async () => {
  const out = { userAgent: navigator.userAgent, webgl1: null, webgl2: null, features: {} };
  const m = /Chrome\\/(\\d+)([\\d.]*)/.exec(navigator.userAgent);
  if (m) { out.chromeMajor = Number(m[1]); out.chromeVersion = m[1] + m[2]; }
  out.screen = { width: Math.round(screen.width * devicePixelRatio), height: Math.round(screen.height * devicePixelRatio), dpr: devicePixelRatio };
  if (navigator.deviceMemory) out.deviceMemoryGB = navigator.deviceMemory;
  if (navigator.hardwareConcurrency) out.cores = navigator.hardwareConcurrency;
  const probe = (type) => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const gl = c.getContext(type, { failIfMajorPerformanceCaveat: false });
      if (!gl) return null;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const p = (k) => { try { return gl.getParameter(k); } catch (e) { return undefined; } };
      const r = {
        renderer: String(dbg ? p(dbg.UNMASKED_RENDERER_WEBGL) : p(gl.RENDERER)),
        vendor: String(dbg ? p(dbg.UNMASKED_VENDOR_WEBGL) : p(gl.VENDOR)),
        version: String(p(gl.VERSION)),
        maxTextureSize: p(gl.MAX_TEXTURE_SIZE),
        maxRenderbufferSize: p(gl.MAX_RENDERBUFFER_SIZE),
        maxViewportDims: Array.from(p(gl.MAX_VIEWPORT_DIMS) || []),
        extensions: gl.getSupportedExtensions() || [],
      };
      if (type === 'webgl2') r.maxSamples = p(gl.MAX_SAMPLES);
      try { const f = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT); if (f) r.mediumpPrecision = f.precision; } catch (e) {}
      const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      return r;
    } catch (e) { return null; }
  };
  out.webgl2 = probe('webgl2');
  out.webgl1 = probe('webgl') || probe('experimental-webgl');
  try {
    const v = document.createElement('video'); out.canPlay = {};
    for (const t of ${JSON.stringify(CAN_PLAY_TYPES)}) out.canPlay[t] = v.canPlayType(t);
  } catch (e) {}
  if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
    out.decoding = {};
    for (const pr of ${JSON.stringify(DECODE_PROBES.map((p) => p.contentType))}) for (const s of ${JSON.stringify(DECODE_SIZES)}) {
      try {
        const r = await navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: pr, width: s.w, height: s.h, bitrate: s.bitrate, framerate: s.fps } });
        out.decoding[pr.replace(/^video\\/\\w+; codecs="|"$/g, '') + '@' + s.w + 'x' + s.h + 'p' + s.fps] = { supported: !!r.supported, smooth: !!r.smooth, powerEfficient: !!r.powerEfficient };
      } catch (e) {}
    }
  }
  const f = out.features;
  f.wasm = typeof WebAssembly === 'object';
  try { f['wasm-simd'] = f.wasm && WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])); } catch (e) { f['wasm-simd'] = false; }
  f['wasm-threads'] = typeof SharedArrayBuffer !== 'undefined' && f.wasm;
  f['shared-array-buffer'] = typeof SharedArrayBuffer !== 'undefined';
  f['offscreen-canvas'] = typeof OffscreenCanvas !== 'undefined';
  f.webgpu = !!navigator.gpu;
  f['web-audio'] = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
  f.gamepad = typeof navigator.getGamepads === 'function';
  f['media-source'] = typeof MediaSource !== 'undefined';
  f.workers = typeof Worker !== 'undefined';
  return out;
})()`;

/** Turns the script's raw result into WebCaps (tolerant of missing fields). */
export function parseWebCaps(raw: unknown): WebCaps | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const gl = (x: unknown): WebGLCaps | null => {
    if (!x || typeof x !== 'object') return null;
    const g = x as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const caps: WebGLCaps = { extensions: Array.isArray(g.extensions) ? (g.extensions as unknown[]).map(String) : [] };
    if (typeof g.renderer === 'string') caps.renderer = g.renderer;
    if (typeof g.vendor === 'string') caps.vendor = g.vendor;
    if (typeof g.version === 'string') caps.version = g.version;
    if (n(g.maxTextureSize)) caps.maxTextureSize = n(g.maxTextureSize);
    if (n(g.maxRenderbufferSize)) caps.maxRenderbufferSize = n(g.maxRenderbufferSize);
    if (Array.isArray(g.maxViewportDims)) caps.maxViewportDims = (g.maxViewportDims as unknown[]).map(Number);
    if (n(g.maxSamples) !== undefined) caps.maxSamples = n(g.maxSamples);
    if (n(g.mediumpPrecision) !== undefined) caps.mediumpPrecision = n(g.mediumpPrecision);
    return caps;
  };
  const webgl2 = gl(r.webgl2);
  const webgl1 = gl(r.webgl1);
  const exts = [...(webgl2?.extensions ?? []), ...(webgl1?.extensions ?? [])];
  const caps: WebCaps = {
    webgl1,
    webgl2,
    compressed: compressedFamilies(exts),
    floatRender: exts.some((e) => /^EXT_color_buffer_(half_)?float$/.test(e)),
  };
  if (typeof r.userAgent === 'string') caps.userAgent = r.userAgent;
  if (typeof r.chromeVersion === 'string') caps.chromeVersion = r.chromeVersion;
  if (typeof r.chromeMajor === 'number') caps.chromeMajor = r.chromeMajor;
  if (r.screen && typeof r.screen === 'object') caps.screen = r.screen as WebCaps['screen'];
  if (typeof r.deviceMemoryGB === 'number') caps.deviceMemoryGB = r.deviceMemoryGB;
  if (typeof r.cores === 'number') caps.cores = r.cores;
  if (r.canPlay && typeof r.canPlay === 'object') caps.canPlay = r.canPlay as Record<string, string>;
  if (r.decoding && typeof r.decoding === 'object') caps.decoding = r.decoding as Record<string, DecodingResult>;
  if (r.features && typeof r.features === 'object') caps.features = r.features as Record<string, boolean>;
  return caps;
}
