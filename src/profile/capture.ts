/**
 * `firelab profile`: records what a real device has, so `fit` can use
 * measurements instead of estimates for that model.
 *
 * Read-only on the device: getprop, /proc/meminfo, wm size, cpufreq,
 * `dumpsys webviewupdate`, plus (when a debuggable WebView page is open)
 * WebGL limits, the WebView version and MediaCapabilities answers.
 */
import { parseGetprop, parseWmDensity, parseWmSize, splitSections } from '../adb/getprop.js';
import { lookupModel, friendlyName } from '../adb/models.js';
import { parseProcMeminfo } from '../perf/parse.js';
import { round1 } from '../lib/util.js';
import { gpuFamily } from '../fit/gpus.js';
import { memoryBudget, estimateBudget } from '../fit/memory.js';
import { DECODE_PROBES, DECODE_SIZES, WEB_CAPS_SCRIPT, parseWebCaps, type WebCaps } from './webcaps.js';
import { fact, unknown, type DecoderLimit, type DeviceProfile, type Fact, type VideoCodec } from './types.js';

export const PROFILE_SCRIPT = [
  'getprop',
  'echo @@meminfo; cat /proc/meminfo',
  'echo @@wm; wm size 2>/dev/null; wm density 2>/dev/null',
  'echo @@cpufreq; cat /sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq 2>/dev/null',
  'echo @@nproc; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo',
  'echo @@webview; dumpsys webviewupdate 2>/dev/null | head -30',
].join('; ');

export interface CapturePage {
  eval<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
  url?(): Promise<string>;
}

export interface CaptureDeps {
  shell(command: string): Promise<string>;
  /** Opens a page in a debuggable WebView. Called after the idle memory reading. */
  openPage?(): Promise<CapturePage>;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
}

export type CaptureOptions = { firelabVersion: string; settleMs?: number };

/** "Current WebView package (name, version): (com.amazon.webview.chromium, 138.0.7204.amazon-webview-v138-7204-tv)" */
export function parseWebViewUpdate(text: string): { package?: string; version?: string; major?: number } {
  const m = /Current WebView package \(name, version\):\s*\(([^,]+),\s*([^)]+)\)/.exec(text);
  if (!m) return {};
  const version = (m[2] as string).trim();
  const major = Number(/^(\d+)/.exec(version)?.[1]);
  return { package: (m[1] as string).trim(), version, ...(Number.isFinite(major) ? { major } : {}) };
}

/** Highest cpuinfo_max_freq (kHz) -> GHz. */
export function parseCpuMaxGHz(text: string): number | undefined {
  const khz = text.split(/\s+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  return khz.length ? Math.round(Math.max(...khz) / 10000) / 100 : undefined;
}

const LEVEL_ORDER = (l: string) => Number(l);

/** MediaCapabilities answers -> one DecoderLimit per codec (what the WebView will decode). */
export function decodersFromCaps(caps: WebCaps): DecoderLimit[] | undefined {
  const d = caps.decoding;
  if (!d || !Object.keys(d).length) return undefined;
  const out: DecoderLimit[] = [];
  for (const codec of ['avc', 'hevc', 'vp9', 'av1'] as VideoCodec[]) {
    const probes = DECODE_PROBES.filter((p) => p.codec === codec);
    let best: { w: number; h: number; fps: number } | undefined;
    const profiles = new Set<string>();
    let level: string | undefined;
    for (const p of probes) {
      const key = p.contentType.replace(/^video\/\w+; codecs="|"$/g, '');
      for (const s of DECODE_SIZES) {
        const r = d[`${key}@${s.w}x${s.h}p${s.fps}`];
        if (!r?.supported) continue;
        profiles.add(p.profile);
        if (!level || LEVEL_ORDER(p.level) > LEVEL_ORDER(level)) level = p.level;
        if (!best || s.w * s.h * s.fps > best.w * best.h * best.fps) best = { w: s.w, h: s.h, fps: s.fps };
      }
    }
    if (!best) out.push({ codec, supported: false });
    else out.push({ codec, supported: true, maxWidth: best.w, maxHeight: best.h, maxFps: best.fps, profiles: [...profiles].sort(), ...(level ? { maxLevel: level } : {}) });
  }
  return out;
}

/** Captures a device profile. The person should start on the Home screen (for the idle memory reading). */
export async function captureProfile(deps: CaptureDeps, opts: CaptureOptions): Promise<{ profile: DeviceProfile; warnings: string[] }> {
  const warnings: string[] = [];
  const now = deps.now?.() ?? new Date();
  const s = splitSections(await deps.shell(PROFILE_SCRIPT));
  const p = parseGetprop(s._ ?? '');
  const mi = parseProcMeminfo(s.meminfo ?? '');
  const model = p['ro.product.model'];
  if (!model) throw new Error('getprop returned no ro.product.model: is this an Android device?');
  const known = lookupModel(model);
  const sdk = Number(p['ro.build.version.sdk']) || undefined;
  const fireOs = /^Fire OS ([\d.]+)/.exec(p['ro.build.mktg.fireos'] ?? '')?.[1] ?? /^Fire OS ([\d.]+)/.exec(p['ro.build.version.name'] ?? '')?.[1];
  const build = /\(([^)]+)\)/.exec(p['ro.build.version.name'] ?? '')?.[1] ?? p['ro.build.display.id'];
  const abis = (p['ro.product.cpu.abilist'] || [p['ro.product.cpu.abi'], p['ro.product.cpu.abi2']].filter(Boolean).join(',')).split(',').map((x) => x.trim()).filter(Boolean);
  const size = parseWmSize(s.wm ?? '');
  const density = parseWmDensity(s.wm ?? '');
  const maxGHz = parseCpuMaxGHz(s.cpufreq ?? '');
  const cores = Number((s.nproc ?? '').trim()) || undefined;
  const wv = parseWebViewUpdate(s.webview ?? '');
  const totalMB = mi.MemTotal ? round1(mi.MemTotal / 1024) : undefined;
  const idleMB = mi.MemAvailable ? round1(mi.MemAvailable / 1024) : undefined;
  const lowRam = p['ro.config.low_ram'];

  let caps: WebCaps | undefined;
  let availWebViewMB: number | undefined;
  let pageUrl: string | undefined;
  if (deps.openPage) {
    try {
      const page = await deps.openPage();
      pageUrl = await page.url?.().catch(() => undefined);
      await deps.sleep?.(opts.settleMs ?? 3000);
      const mem = parseProcMeminfo(await deps.shell('grep -E "^(MemTotal|MemAvailable):" /proc/meminfo'));
      if (mem.MemAvailable) availWebViewMB = round1(mem.MemAvailable / 1024);
      caps = parseWebCaps(await page.eval(WEB_CAPS_SCRIPT, 60000));
      if (!caps) warnings.push('The WebView page did not answer the capability probe.');
    } catch (e) {
      warnings.push(`WebView facts skipped: ${(e as Error).message}`);
    }
  } else warnings.push('No WebView page: WebGL, WebView and media facts stay unknown. Pass --package <a debuggable WebView app> to fill them in.');

  const gl2 = caps?.webgl2 ?? null;
  const gl1 = caps?.webgl1 ?? null;
  const gl = gl2 ?? gl1;
  const renderer = gl?.renderer;
  const fam = gpuFamily(renderer ?? known?.gpu);
  const viaWebGL = 'WebGL in the WebView';
  const decoders = caps ? decodersFromCaps(caps) : undefined;

  const budget = memoryBudget({
    ramMB: known?.ramMB,
    totalMB: fact(totalMB, 'measured'),
    availWebViewMB: fact(availWebViewMB, 'measured'),
  });
  if (availWebViewMB === undefined && totalMB !== undefined) {
    const e = estimateBudget(known?.ramMB ?? (totalMB > 1100 ? 2048 : 1024), totalMB);
    budget.budgetMB = fact(e.budget, 'estimated', `${Math.round(totalMB)} MB MemTotal (measured) x the calibration ratio`);
    budget.limitMB = fact(e.limit, 'estimated', `${Math.round(totalMB)} MB MemTotal (measured) x the calibration ratio`);
  }

  const profile: DeviceProfile = {
    schemaVersion: 1,
    model,
    name: friendlyName(model, p['ro.product.manufacturer']),
    source: 'measured',
    capturedAt: now.toISOString(),
    firelabVersion: opts.firelabVersion,
    os: {
      fireOs: fact(fireOs, 'measured', 'getprop'),
      android: fact(p['ro.build.version.release'] || undefined, 'measured', 'getprop'),
      sdk: fact(sdk, 'measured', 'getprop'),
      build: fact(build, 'measured', 'getprop'),
    },
    cpu: {
      abis: fact(abis.length ? abis : undefined, 'measured', 'ro.product.cpu.abilist'),
      soc: fact(p['ro.board.platform'] || p['ro.hardware'] || undefined, 'measured', 'ro.board.platform'),
      cores: fact(cores, 'measured', 'nproc'),
      maxGHz: fact(maxGHz, 'measured', 'cpuinfo_max_freq'),
    },
    memory: {
      totalMB: fact(totalMB, 'measured', 'MemTotal'),
      availIdleMB: fact(idleMB, 'measured', 'MemAvailable when the capture started (start it from the Home screen)'),
      availWebViewMB: fact(availWebViewMB, 'measured', pageUrl ? `MemAvailable with ${pageUrl} open` : undefined),
      appBudgetMB: budget.budgetMB,
      appLimitMB: budget.limitMB,
      ...(lowRam !== undefined ? { lowRam: fact(lowRam === 'true', 'measured', 'ro.config.low_ram') } : {}),
    },
    gpu: {
      renderer: fact(renderer, 'measured', viaWebGL),
      vendor: fact(gl?.vendor, 'measured', viaWebGL),
      speedFactor: fam ? fact(fam.factor, fam.source, `${fam.family}: ${fam.why}`) : unknown('GPU not in the speed table yet'),
    },
    webgl: {
      webgl1: fact(caps ? !!gl1 : undefined, 'measured', viaWebGL),
      webgl2: fact(caps ? !!gl2 : undefined, 'measured', viaWebGL),
      maxTextureSize: fact(gl?.maxTextureSize, 'measured', gl2 ? 'WebGL2 context' : 'WebGL1 context'),
      maxRenderbufferSize: fact(gl?.maxRenderbufferSize, 'measured', gl2 ? 'WebGL2 context' : 'WebGL1 context'),
      extensions: fact(gl ? [...new Set([...(gl2?.extensions ?? []), ...(gl1?.extensions ?? [])])].sort() : undefined, 'measured', 'getSupportedExtensions (WebGL2 and WebGL1)'),
      compressed: fact(caps ? caps.compressed : undefined, 'measured', 'from the extension list'),
      floatRender: fact(caps ? caps.floatRender : undefined, 'measured', 'EXT_color_buffer_float / _half_float'),
      mediumpFp16: fact(gl?.mediumpPrecision !== undefined ? gl.mediumpPrecision <= 10 : undefined, 'measured', 'getShaderPrecisionFormat(FRAGMENT_SHADER, MEDIUM_FLOAT)'),
    },
    webview: {
      version: fact(wv.version ?? caps?.chromeVersion, 'measured', wv.version ? 'dumpsys webviewupdate' : 'user agent'),
      major: fact(wv.major ?? caps?.chromeMajor, 'measured', wv.major ? 'dumpsys webviewupdate' : 'user agent'),
      package: fact(wv.package, 'measured', 'dumpsys webviewupdate'),
    },
    media: {
      decoders: fact(decoders, 'measured', 'MediaCapabilities.decodingInfo in the WebView (media-source)'),
      ...(caps?.canPlay ? { canPlay: fact(caps.canPlay, 'measured', 'HTMLMediaElement.canPlayType') } : {}),
    },
    display: {
      width: fact(size?.width, 'measured', 'wm size'),
      height: fact(size?.height, 'measured', 'wm size'),
      density: fact(density, 'measured', 'wm density'),
    },
    notes: [],
  };
  if (!fam && renderer) warnings.push(`"${renderer}" is not in the GPU speed table (src/fit/gpus.ts); fit will assume GE8300 speed until it is added.`);
  return { profile, warnings };
}

/** Facts in a profile, grouped by source (for "what did we measure" summaries). */
export function factSummary(profile: DeviceProfile): Record<'measured' | 'spec' | 'estimated' | 'unknown', string[]> {
  const out = { measured: [] as string[], spec: [] as string[], estimated: [] as string[], unknown: [] as string[] };
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const o = node as Record<string, unknown>;
    if ('source' in o && 'value' in o) {
      out[(o as Fact<unknown>).source].push(path);
      return;
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'references' && k !== 'notes') walk(v, path ? `${path}.${k}` : k);
  };
  walk(profile, '');
  return out;
}
