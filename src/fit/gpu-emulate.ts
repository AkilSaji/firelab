/**
 * GPU capability profiles for web games: which WebGL features and limits a
 * Fire TV model's GPU has, so the shim in gpu-shim.ts can make any browser
 * (the emulator lab's WebView, desktop Chrome) report only those. Features
 * and limits are exact per GPU; speed is not copied at all.
 *
 * Values come from the model's device profile when it measured them, else
 * from the GPU family (src/fit/gpus.ts) plus the per-class tables below,
 * which are estimates from the OpenGL ES version, the vendor's extension set
 * and what Chromium exposes on top of it. Every value says where it came from.
 */
import { lookupModel } from '../adb/models.js';
import type { DeviceProfile } from '../profile/types.js';
import { gpuFamily } from './gpus.js';
import { buildTargets } from './targets.js';
import { GL, GPU_READ_SCRIPT, gpuShimScript, parseGpuReport, type GpuEmulation, type GpuFact, type GpuFactSource, type GpuFailure, type GpuShimReport, type PrecisionFormat } from './gpu-shim.js';
import type { FitPage } from './run.js';
import type { FitTarget } from './types.js';

/** Extensions WebGL2 made core: only a WebGL1 context offers them. */
export const WEBGL1_ONLY: readonly string[] = [
  'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float', 'EXT_frag_depth', 'EXT_shader_texture_lod', 'EXT_sRGB',
  'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_half_float',
  'OES_texture_half_float_linear', 'OES_vertex_array_object', 'WEBGL_color_buffer_float', 'WEBGL_depth_texture', 'WEBGL_draw_buffers',
];
/** Extensions only a WebGL2 context offers. */
export const WEBGL2_ONLY: readonly string[] = ['EXT_color_buffer_float', 'OES_draw_buffers_indexed', 'OVR_multiview2', 'EXT_texture_norm16', 'EXT_render_snorm', 'WEBGL_render_shared_exponent', 'EXT_conservative_depth', 'WEBGL_clip_cull_distance', 'WEBGL_stencil_texturing'];
// EXT_color_buffer_half_float exists in both: WebGL2 offers it too.
const BOTH = new Set(['EXT_color_buffer_half_float']);

const COMPRESSED_EXT: Record<string, string[]> = {
  etc1: ['WEBGL_compressed_texture_etc1'],
  etc2: ['WEBGL_compressed_texture_etc'],
  astc: ['WEBGL_compressed_texture_astc'],
  pvrtc: ['WEBGL_compressed_texture_pvrtc', 'WEBKIT_WEBGL_compressed_texture_pvrtc'],
  s3tc: ['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb'],
  bptc: ['EXT_texture_compression_bptc'],
  rgtc: ['EXT_texture_compression_rgtc'],
};
const FLOAT_RENDER_EXT = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'WEBGL_color_buffer_float', 'EXT_float_blend'];

/** Chromium's extensions on an OpenGL ES 3.x Android GPU, before vendor differences (compressed formats are added from the family). */
const ES3_WEBGL1 = [
  'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float', 'EXT_frag_depth', 'EXT_shader_texture_lod', 'EXT_sRGB', 'EXT_texture_filter_anisotropic',
  'KHR_parallel_shader_compile', 'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_half_float',
  'OES_texture_half_float_linear', 'OES_vertex_array_object', 'WEBGL_color_buffer_float', 'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_depth_texture',
  'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_multi_draw',
];
const ES3_WEBGL2 = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_texture_filter_anisotropic', 'KHR_parallel_shader_compile', 'OES_draw_buffers_indexed', 'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_lose_context', 'WEBGL_multi_draw'];
/** OpenGL ES 2 GPUs (Mali Utgard, VideoCore IV): no instancing, no 32-bit indices, no float textures, no MRT. */
const ES2_WEBGL1 = ['EXT_blend_minmax', 'KHR_parallel_shader_compile', 'OES_standard_derivatives', 'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object', 'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_lose_context', 'WEBGL_multi_draw'];

type GpuClass = {
  id: string;
  label: string;
  vendor: string;
  webgl1: string[];
  webgl2: string[];
  /** Float color buffers (EXT_color_buffer_float on WebGL2). */
  floatRender: boolean;
  limits: Partial<Record<keyof typeof GL, number>>;
  /** Fragment shader mediump is FP16. */
  mediumpFp16: boolean;
  fragmentHighp: boolean;
  defaultMaxTexture: number;
  why: string;
};

const without = (l: string[], ...drop: string[]) => l.filter((x) => !drop.includes(x));

const CLASSES: Record<string, GpuClass> = {
  'rogue-es32': {
    id: 'rogue-es32',
    label: 'PowerVR Rogue, OpenGL ES 3.2',
    vendor: 'Imagination Technologies',
    // PowerVR Rogue filters FP32 textures only with NEAREST: no OES_texture_float_linear.
    webgl1: ES3_WEBGL1,
    webgl2: ES3_WEBGL2,
    floatRender: true,
    limits: { MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_SAMPLES: 4, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 16 },
    mediumpFp16: true,
    fragmentHighp: true,
    defaultMaxTexture: 8192,
    why: 'PowerVR Rogue 8XE/9XE, OpenGL ES 3.2: no OES_texture_float_linear, 4x MSAA',
  },
  'rogue-6xt': {
    id: 'rogue-6xt',
    label: 'PowerVR Series6XT, OpenGL ES 3.1',
    vendor: 'Imagination Technologies',
    webgl1: ES3_WEBGL1,
    webgl2: without(ES3_WEBGL2, 'EXT_color_buffer_float', 'OES_draw_buffers_indexed'),
    floatRender: false,
    limits: { MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_SAMPLES: 4 },
    mediumpFp16: true,
    fragmentHighp: true,
    defaultMaxTexture: 8192,
    why: 'PowerVR Series6XT, OpenGL ES 3.1: no ASTC, no float color buffers, no ES 3.2 extensions',
  },
  'mali-es32': {
    id: 'mali-es32',
    label: 'Mali, OpenGL ES 3.2',
    vendor: 'ARM',
    webgl1: [...ES3_WEBGL1, 'OES_texture_float_linear'],
    webgl2: [...ES3_WEBGL2, 'OES_texture_float_linear'],
    floatRender: true,
    limits: { MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_SAMPLES: 4, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 16 },
    mediumpFp16: true,
    fragmentHighp: true,
    defaultMaxTexture: 8192,
    why: 'Mali Midgard/Bifrost/Valhall, OpenGL ES 3.2: no PVRTC, 4x MSAA',
  },
  'adreno-es30': {
    id: 'adreno-es30',
    label: 'Adreno 3xx, OpenGL ES 3.0',
    vendor: 'Qualcomm',
    webgl1: ES3_WEBGL1,
    webgl2: without(ES3_WEBGL2, 'EXT_color_buffer_float', 'OES_draw_buffers_indexed'),
    floatRender: false,
    limits: { MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_SAMPLES: 4 },
    mediumpFp16: true,
    fragmentHighp: true,
    defaultMaxTexture: 4096,
    why: 'Adreno 3xx, OpenGL ES 3.0: no ASTC, no float color buffers',
  },
  'mali-utgard': {
    id: 'mali-utgard',
    label: 'Mali Utgard, OpenGL ES 2',
    vendor: 'ARM',
    webgl1: ES2_WEBGL1,
    webgl2: [],
    floatRender: false,
    // Utgard has no vertex texture units and no highp in fragment shaders.
    limits: { MAX_TEXTURE_IMAGE_UNITS: 8, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 8 },
    mediumpFp16: true,
    fragmentHighp: false,
    defaultMaxTexture: 4096,
    why: 'Mali-400/450/470 (Utgard), OpenGL ES 2: no WebGL2, no highp in fragment shaders, no vertex texture fetch, no instancing, no 32-bit indices',
  },
  'videocore-iv': {
    id: 'videocore-iv',
    label: 'VideoCore IV, OpenGL ES 2',
    vendor: 'Broadcom',
    webgl1: ES2_WEBGL1,
    webgl2: [],
    floatRender: false,
    limits: { MAX_TEXTURE_IMAGE_UNITS: 8 },
    mediumpFp16: false,
    fragmentHighp: true,
    defaultMaxTexture: 2048,
    why: 'VideoCore IV, OpenGL ES 2: no WebGL2, no instancing, no 32-bit indices',
  },
};

const CLASS_OF: Record<string, string> = {
  ge8300: 'rogue-es32', ge9215: 'rogue-es32', ge9xxx: 'rogue-es32', ge83xx: 'rogue-es32', ge8100: 'rogue-es32',
  gx6250: 'rogue-6xt',
  'mali-g52-big': 'mali-es32', 'mali-g52-mp2': 'mali-es32', 'mali-g52-1': 'mali-es32', 'mali-g57': 'mali-es32', 'mali-g310': 'mali-es32', 'mali-g31': 'mali-es32', 'mali-t820': 'mali-es32',
  'mali-470': 'mali-utgard', 'mali-450-mp4': 'mali-utgard', 'mali-450': 'mali-utgard',
  'adreno-320': 'adreno-es30',
  'videocore-iv': 'videocore-iv',
};

const sortU = (l: Iterable<string>) => [...new Set(l)].sort();

/** Splits a measured extension list (a profile stores WebGL1 and WebGL2 together) by context type. */
export function splitExtensions(all: readonly string[]): { webgl1: string[]; webgl2: string[] } {
  return {
    webgl1: sortU(all.filter((e) => !WEBGL2_ONLY.includes(e))),
    webgl2: sortU(all.filter((e) => BOTH.has(e) || !WEBGL1_ONLY.includes(e))),
  };
}

const FP16: PrecisionFormat = { rangeMin: 15, rangeMax: 15, precision: 10 };
const NONE: PrecisionFormat = { rangeMin: 0, rangeMax: 0, precision: 0 };

/**
 * The GPU capability profile for one model, or throws for a model FireLab
 * doesn't know (or one whose GPU family isn't in src/fit/gpus.ts).
 */
export function gpuEmulationFor(model: string, profiles: Map<string, DeviceProfile> = new Map()): GpuEmulation {
  const want = model.trim().toUpperCase();
  const target = buildTargets(profiles, [want])[0];
  if (!target) {
    const hint = lookupModel(want) ? '' : ' (see firelab fit --all for the model list)';
    throw new Error(`Unknown Fire TV model "${model}"${hint}`);
  }
  return gpuEmulationForTarget(target, profiles.get(want));
}

export function gpuEmulationForTarget(t: FitTarget, profile?: DeviceProfile): GpuEmulation {
  const fam = gpuFamily(t.gpu);
  const cls = fam ? CLASSES[CLASS_OF[fam.id] ?? ''] : undefined;
  if (!fam || !cls) throw new Error(`${t.name} (${t.model}): GPU "${t.gpu ?? 'unknown'}" isn't in FireLab's GPU table, so there is nothing to emulate`);
  const facts: GpuFact[] = [];
  const notes: string[] = [];
  const src = (s: string): GpuFactSource => (s === 'measured' || s === 'spec' ? s : 'estimated');
  const classNote = `typical for ${cls.label}`;

  // The PowerVR driver names its Rogue GPUs "PowerVR Rogue GE8300"; the model table says "PowerVR GE8300".
  const renderer = !t.fromProfile.has('gpu') && /^PowerVR (?!Rogue)/.test(t.gpu ?? '') ? (t.gpu as string).replace(/^PowerVR /, 'PowerVR Rogue ') : (t.gpu as string);
  facts.push({ name: 'UNMASKED_RENDERER_WEBGL', value: renderer, source: t.fromProfile.has('gpu') ? 'measured' : 'estimated', note: t.fromProfile.has('gpu') ? 'from the device profile' : 'the GPU in the model table (src/adb/models.ts), as the driver names it' });

  let webgl2: boolean;
  if (t.webgl.webgl2.value === null) {
    webgl2 = false;
    notes.push(`WebGL2 on ${fam.family} depends on the WebView's GPU blocklist: emulating the worst case (no WebGL2). Send a profile (firelab profile) to settle it.`);
    facts.push({ name: 'WebGL2', value: 'no (worst case)', source: 'estimated', note: t.webgl.webgl2.note ?? 'unknown' });
  } else {
    webgl2 = t.webgl.webgl2.value;
    facts.push({ name: 'WebGL2', value: webgl2 ? 'yes' : 'no', source: src(t.webgl.webgl2.source), ...(t.webgl.webgl2.note ? { note: t.webgl.webgl2.note } : {}) });
  }
  const webgl1 = true;

  const maxTex = t.webgl.maxTextureSize.value ?? cls.defaultMaxTexture;
  const maxTexSrc: GpuFactSource = t.webgl.maxTextureSize.value !== null ? src(t.webgl.maxTextureSize.source) : 'estimated';
  facts.push({ name: 'MAX_TEXTURE_SIZE', value: String(maxTex), source: maxTexSrc, note: t.webgl.maxTextureSize.value !== null ? t.webgl.maxTextureSize.note ?? '' : `typical for ${fam.family}` });
  const maxRb = t.webgl.maxRenderbufferSize.value ?? maxTex;
  facts.push({ name: 'MAX_RENDERBUFFER_SIZE', value: String(maxRb), source: t.webgl.maxRenderbufferSize.value !== null ? src(t.webgl.maxRenderbufferSize.source) : 'estimated', note: t.webgl.maxRenderbufferSize.value !== null ? t.webgl.maxRenderbufferSize.note ?? '' : 'same as MAX_TEXTURE_SIZE' });

  const limits: GpuEmulation['limits'] = {
    [GL.MAX_TEXTURE_SIZE]: maxTex,
    [GL.MAX_CUBE_MAP_TEXTURE_SIZE]: maxTex,
    [GL.MAX_RENDERBUFFER_SIZE]: maxRb,
    [GL.MAX_VIEWPORT_DIMS]: [maxRb, maxRb],
  };
  for (const [k, v] of Object.entries(cls.limits)) {
    if (k === 'MAX_SAMPLES' && !webgl2) continue;
    limits[GL[k as keyof typeof GL]] = v;
    facts.push({ name: k, value: String(v), source: 'estimated', note: classNote });
  }

  const compressed = t.webgl.compressed.value ?? fam.compressed;
  facts.push({ name: 'compressed textures', value: compressed.join(', ') || 'none', source: src(t.webgl.compressed.source), ...(t.webgl.compressed.note ? { note: t.webgl.compressed.note } : {}) });
  const floatRender = t.webgl.floatRender.value ?? cls.floatRender;

  let extensions: { webgl1: string[]; webgl2: string[] };
  if (t.webgl.extensions.value) {
    extensions = splitExtensions(t.webgl.extensions.value);
    facts.push({ name: 'extensions', value: `${t.webgl.extensions.value.length} names`, source: src(t.webgl.extensions.source), note: t.webgl.extensions.note ?? 'from the device profile' });
  } else {
    const comp = compressed.flatMap((c) => COMPRESSED_EXT[c] ?? []);
    const drop = floatRender ? [] : FLOAT_RENDER_EXT;
    extensions = {
      webgl1: sortU(without([...cls.webgl1, ...comp], ...drop)),
      webgl2: webgl2 ? sortU(without([...cls.webgl2, ...comp], ...drop)) : [],
    };
    facts.push({ name: 'extensions', value: `${extensions.webgl1.length} (WebGL1) / ${extensions.webgl2.length} (WebGL2)`, source: 'estimated', note: `${classNote}: Chromium's set on that OpenGL ES version` });
  }
  facts.push({ name: 'float color buffers', value: floatRender ? 'yes' : 'no', source: t.webgl.floatRender.value !== null ? src(t.webgl.floatRender.source) : 'estimated', note: t.webgl.floatRender.value !== null ? t.webgl.floatRender.note ?? '' : classNote });

  const precision: GpuEmulation['precision'] = {};
  const fp16Fact = profile?.webgl.mediumpFp16;
  const fp16 = fp16Fact && fp16Fact.value !== null ? fp16Fact.value : cls.mediumpFp16;
  if (fp16) precision[`${GL.FRAGMENT_SHADER}:${GL.MEDIUM_FLOAT}`] = FP16;
  if (!cls.fragmentHighp) precision[`${GL.FRAGMENT_SHADER}:${GL.HIGH_FLOAT}`] = NONE;
  facts.push({ name: 'fragment mediump', value: fp16 ? 'FP16 (10-bit mantissa)' : 'host value', source: fp16Fact && fp16Fact.value !== null ? src(fp16Fact.source) : 'estimated', note: fp16Fact?.note ?? classNote });
  facts.push({ name: 'fragment highp', value: cls.fragmentHighp ? 'yes' : 'no', source: 'estimated', note: classNote });
  facts.push({ name: 'WebGPU', value: 'no', source: 'estimated', note: 'Chromium enables WebGPU on Android 12+; Fire OS 8 is Android 11' });

  notes.push(`GPU class: ${cls.why}.`);
  notes.push('Features and limits only: the frame rate under this shim is your machine\'s, not the stick\'s.');
  notes.push('mediump is reported as FP16 but shaders still run at your GPU\'s precision: precision artifacts don\'t show here.');
  if (t.vega) notes.push(`${t.name} runs Vega OS: fit doesn't cover it; the GPU values are estimates.`);
  if (!t.webgl.extensions.value) notes.push('The extension list is estimated from the GPU family: run firelab profile on a real device to measure it.');

  return { model: t.model, name: t.name, renderer, vendor: cls.vendor, webgl1, webgl2, limits, extensions, compressed: [...compressed], precision, fragmentHighp: cls.fragmentHighp, webgpu: false, facts, notes };
}

// ---------- running it on a page ----------

export type GpuRunResult = GpuShimReport & {
  model: string;
  name: string;
  renderer: string;
  seconds: number;
  notes: string[];
};

export type GpuRunOptions = {
  url?: string;
  seconds?: number;
  sleep(ms: number): Promise<void>;
  /** Go back to the page that was open before (default true). */
  restore?: boolean;
  onProgress?: (message: string) => void;
};

/**
 * Loads the page with the shim installed before its scripts (DevTools
 * Page.addScriptToEvaluateOnNewDocument), lets it run for `seconds` (play
 * the game meanwhile, or let `firelab explore` do it), then reads the WebGL
 * calls that failed.
 */
export async function runGpuEmulation(page: FitPage, emu: GpuEmulation, o: GpuRunOptions): Promise<GpuRunResult> {
  if (!page.addInitScript) throw new Error('GPU emulation needs DevTools on the page (a debuggable WebView: an app made by firelab wrap, or the emulator lab)');
  const seconds = o.seconds ?? 15;
  const notes = [...emu.notes];
  const original = await page.currentUrl().catch(() => undefined);
  const id = await page.addInitScript(gpuShimScript(emu));
  let report: GpuShimReport;
  try {
    o.onProgress?.(`${emu.model}: loading ${o.url ?? original ?? 'the page'} with the ${emu.renderer} profile`);
    if (o.url && page.navigate) await page.navigate(o.url);
    else if (page.reload) await page.reload();
    else await page.eval('location.reload(), 1', 5000).catch(() => undefined);
    o.onProgress?.(`${emu.model}: running ${seconds} s (play the game now to reach more WebGL code)`);
    await o.sleep(seconds * 1000);
    report = parseGpuReport(await page.eval(GPU_READ_SCRIPT, 8000).catch(() => undefined));
  } finally {
    if (id) await page.removeInitScript?.(id).catch(() => {});
  }
  if (!report.installed) notes.push('The shim did not load in the page (the page may have navigated away, or DevTools refused the init script): nothing was checked.');
  else if (!report.contexts.webgl && !report.contexts.webgl2 && !report.contexts.refused) notes.push('The page created no WebGL context while it ran: start the game (or a level) within the run time.');
  if (report.hostMissing.length) notes.push(`This browser lacks ${report.hostMissing.join(', ')}, which ${emu.name} has: calls that need them fail here but not on the stick.`);
  if (o.restore !== false && original && !/^about:|^chrome-error:/.test(original) && page.navigate) await page.navigate(original).catch(() => {});
  return { ...report, model: emu.model, name: emu.name, renderer: emu.renderer, seconds, notes };
}

// ---------- text ----------

const MARK: Record<GpuFailure['sev'], string> = { fail: '❌', warn: '⚠️' };

export function gpuEmulationText(emu: GpuEmulation): string {
  const lines = [`GPU profile: ${emu.name} (${emu.model}), ${emu.renderer}. Copies WebGL features and limits, not speed.`];
  const w = Math.max(...emu.facts.map((f) => f.name.length));
  for (const f of emu.facts) lines.push(`  ${f.name.padEnd(w)}  ${f.value}  [${f.source}${f.note ? `: ${f.note}` : ''}]`);
  for (const n of emu.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

export function gpuRunText(r: GpuRunResult): string {
  const lines = [`${r.name} (${r.model}), ${r.renderer}: ${r.failures.length ? `${r.failures.length} kind${r.failures.length === 1 ? '' : 's'} of WebGL call failed (${r.total} calls)` : r.installed ? 'no WebGL call failed' : 'not checked'}`];
  lines.push(`  contexts: ${r.contexts.webgl} WebGL1, ${r.contexts.webgl2} WebGL2, ${r.contexts.refused} refused  (${r.seconds} s${r.url ? ` on ${r.url}` : ''})`);
  const sorted = [...r.failures].sort((a, b) => (a.sev === b.sev ? (a.t ?? 0) - (b.t ?? 0) : a.sev === 'fail' ? -1 : 1));
  for (const f of sorted) lines.push(`  ${MARK[f.sev]} ${f.call} ${f.detail}${f.n > 1 ? ` (x${f.n})` : ''}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}
