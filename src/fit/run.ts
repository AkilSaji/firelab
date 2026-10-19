/**
 * `firelab fit` on a device: measures the app on the one Fire TV you own and
 * writes a portable measurement. Everything device-side goes through
 * FitDeps, so tests drive it with fakes (src/fit/lab.ts wires the real
 * adb/CDP layers).
 */
import type { FpsSample } from '../cdp/fps.js';
import type { NativeSample } from '../perf/native.js';
import { tierUrl } from '../perf/sweep.js';
import { lookupModel } from '../adb/models.js';
import { summarize, percentile } from '../lib/stats.js';
import { round1 } from '../lib/util.js';
import type { DeviceProfile } from '../profile/types.js';
import { WEB_CAPS_SCRIPT, parseWebCaps, type WebCaps } from '../profile/webcaps.js';
import { PAGE_MEDIA_SCRIPT, probeMedia } from '../media/probe.js';
import type { FetchLike } from '../media/readers.js';
import { NEEDS_HOOK_SCRIPT, NEEDS_READ_SCRIPT, mergeNeeds, needsFromDeclaration, needsFromUsage, type DetectedUsage } from './needs.js';
import { buildTarget } from './targets.js';
import { gpuFamily, CPU_FACTORS } from './gpus.js';
import { emptyMeasurement } from './measurement.js';
import type { ApkFacts, FitDeviceInfo, FitMeasurement, FitRun, FrameStats, PressureResult, WebNeeds } from './types.js';

/** A page in the app's WebView (the real one wraps a WebViewSession and an FpsSampler). */
export interface FitPage {
  readonly closed: boolean;
  eval<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
  /** A raw DevTools command, for Emulation.setCPUThrottlingRate. */
  send?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  navigate?(url: string): Promise<{ loaded: boolean }>;
  addInitScript?(source: string): Promise<string | undefined>;
  removeInitScript?(id: string): Promise<void>;
  reload?(): Promise<{ loaded: boolean }>;
  currentUrl(): Promise<string>;
  installProbe(): Promise<void>;
  resetFps(): Promise<void>;
  readFps(): Promise<FpsSample[]>;
  /** window.firelab as the fps sampler last saw it. */
  lastHook?(): Record<string, unknown> | null | undefined;
  close(): void;
}

export interface FitDeps {
  device(): Promise<FitDeviceInfo>;
  openPage?(): Promise<FitPage>;
  /** Memory (PSS) and MemAvailable of the app (NativeSampler). */
  native?(memory: boolean): Promise<NativeSample>;
  /** Frame rate for apps without a WebView (SurfaceFlinger). */
  frames?: { reset(): Promise<void>; read(): Promise<FpsSample[]> };
  shell?(command: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): number;
  fetch?: FetchLike;
}

export type SimulateOptions = { cpu?: boolean; gpu?: boolean; trim?: boolean };

export type FitRunOptions = {
  apk?: ApkFacts;
  url?: string;
  package?: string;
  name?: string;
  /** Measure at each of these tiers (?q=<tier>), like the sweep. Default: the page as it is. */
  tiers?: string[];
  param?: string;
  seconds?: number;
  warmupS?: number;
  targetFps?: number;
  /** From --needs. */
  needs?: WebNeeds;
  /** Reload the page with a hook that records what WebGL it really uses. */
  detectNeeds?: boolean;
  simulate?: SimulateOptions;
  /** Models to imitate in simulations (default: AFTSSS). */
  simulateFor?: string[];
  /** URL parameter that pins the render scale (default "scale", as in @firelab/perf). */
  scaleParam?: string;
  /** The render scale to imitate the target at (default 1 = the tier's full resolution). */
  simScale?: number;
  media?: string[];
  /** Also probe the media the page loaded (default true). */
  pageMedia?: boolean;
  profiles?: Map<string, DeviceProfile>;
  /** Put the page back on its URL afterwards (default true). */
  restore?: boolean;
};

export type FitProgress = { progress: number; message: string };

const HOOK_EXPR = 'window.firelab ? JSON.parse(JSON.stringify(window.firelab)) : null';
const CANVAS_EXPR = `(() => { let b = null; document.querySelectorAll('canvas').forEach((c) => { if (!b || c.width * c.height > b.width * b.height) b = { width: c.width, height: c.height }; }); return b; })()`;

/** Per-second fps samples (+ window.firelab) -> frame stats. */
export function frameStats(samples: FpsSample[], hook: Record<string, unknown> | null | undefined, targetFps: number): FrameStats | undefined {
  const xs = samples.map((s) => s.fps).filter((x) => Number.isFinite(x) && x > 0);
  if (!xs.length) return undefined;
  const s = summarize(xs);
  const fm = hook?.frameMs as { p50?: unknown; p95?: unknown } | undefined;
  const fromPage = typeof fm?.p50 === 'number' && typeof fm?.p95 === 'number' && fm.p50 > 0;
  const p5 = percentile(xs, 5);
  const cap = typeof hook?.targetFps === 'number' && hook.targetFps > 0 ? hook.targetFps : targetFps;
  return {
    fpsMedian: round1(s.median),
    fpsP10: round1(s.p10),
    frameMsP50: round1(fromPage ? (fm?.p50 as number) : 1000 / s.median),
    frameMsP95: round1(fromPage ? Math.max(fm?.p95 as number, fm?.p50 as number) : 1000 / Math.max(p5, 0.1)),
    samples: xs.length,
    source: samples[0]?.source ?? 'raf',
    frameMsFrom: fromPage ? 'page' : 'fps',
    capped: s.median >= cap * 0.95 || s.median >= 57,
  };
}

async function measureRun(deps: FitDeps, page: FitPage | undefined, o: { label: string; seconds: number; targetFps: number; tier?: string; url?: string }): Promise<FitRun> {
  const fps: FpsSample[] = [];
  const avail: number[] = [];
  const noteAvail = (n?: NativeSample) => n?.memAvailableMB !== undefined && avail.push(n.memAvailableMB);
  if (page) {
    await page.installProbe().catch(() => {});
    await page.resetFps().catch(() => {});
  } else await deps.frames?.reset().catch(() => {});
  noteAvail(deps.native ? await deps.native(false).catch(() => undefined) : undefined);
  const until = deps.now() + o.seconds * 1000;
  let tick = 0;
  while (deps.now() < until) {
    await deps.sleep(1000);
    if (page && !page.closed) fps.push(...(await page.readFps().catch(() => [] as FpsSample[])));
    else if (!page && deps.frames) fps.push(...(await deps.frames.read().catch(() => [] as FpsSample[])));
    if (deps.native && ++tick % 3 === 0) noteAvail(await deps.native(false).catch(() => undefined));
  }
  const nat = deps.native ? await deps.native(true).catch(() => undefined) : undefined;
  noteAvail(nat);
  let hook: Record<string, unknown> | null | undefined = page?.lastHook?.();
  if (page && !page.closed && hook === undefined) hook = await page.eval<Record<string, unknown> | null>(HOOK_EXPR, 5000).catch(() => null);
  const run: FitRun = { label: o.label, seconds: o.seconds };
  const tier = o.tier ?? (typeof hook?.tier === 'string' ? hook.tier : undefined);
  if (tier) run.tier = tier;
  if (o.url) run.url = o.url;
  const hc = hook?.canvas as { width?: number; height?: number } | undefined;
  if (hc?.width && hc?.height) run.canvas = { width: hc.width, height: hc.height };
  else if (page && !page.closed) {
    const c = await page.eval<{ width: number; height: number } | null>(CANVAS_EXPR, 5000).catch(() => null);
    if (c?.width && c.height) run.canvas = c;
  }
  if (typeof hook?.scale === 'number') run.scale = hook.scale;
  const frames = frameStats(fps, hook, o.targetFps);
  if (frames) run.frames = frames;
  if (nat?.appPssMB !== undefined || nat?.memMB !== undefined || avail.length) {
    run.memory = { samples: avail.length };
    if (nat?.appPssMB !== undefined) run.memory.appPssMB = nat.appPssMB;
    if (nat?.rendererPssMB !== undefined) run.memory.rendererPssMB = nat.rendererPssMB;
    if (nat?.memMB !== undefined) run.memory.totalMB = nat.memMB;
    if (avail.length) run.memory.memAvailableMinMB = Math.min(...avail);
  }
  if (nat?.cpuPct !== undefined) run.cpuPct = nat.cpuPct;
  if (page?.closed) run.notes = ['The WebView page closed during the run (crash or reload).'];
  return run;
}

/** Speed and CPU factors of the measured device. */
function deviceFactors(d: FitDeviceInfo, profiles?: Map<string, DeviceProfile>): { gpu?: number; cpu?: number } {
  const m = d.model ? lookupModel(d.model) : undefined;
  if (m) {
    const t = buildTarget(m, profiles?.get(m.model.toUpperCase()));
    return { gpu: t.speed.value ?? undefined, cpu: t.cpuSpeed.value ?? undefined };
  }
  return { gpu: gpuFamily(d.gpu)?.factor, cpu: d.model ? CPU_FACTORS[d.model]?.factor : undefined };
}

async function simulateModel(
  deps: FitDeps,
  page: FitPage,
  o: FitRunOptions & { targetFps: number; seconds: number; warmupS: number },
  device: FitDeviceInfo,
  model: string,
  baseUrl: string | undefined,
  notes: string[],
): Promise<FitRun | undefined> {
  const m = lookupModel(model);
  if (!m) {
    notes.push(`Simulation: unknown model ${model}.`);
    return undefined;
  }
  const t = buildTarget(m, o.profiles?.get(m.model.toUpperCase()));
  const dev = deviceFactors(device, o.profiles);
  const cpuRate = dev.cpu && t.cpuSpeed.value ? round1(dev.cpu / t.cpuSpeed.value) : undefined;
  const pixelFactor = dev.gpu && t.speed.value ? round1(dev.gpu / t.speed.value) : undefined;
  const kinds: ('cpu' | 'gpu')[] = [];
  if (o.simulate?.cpu) {
    if (!page.send) notes.push('CPU simulation needs a DevTools session that can send Emulation commands.');
    else if (!cpuRate || cpuRate <= 1.05) notes.push(`CPU simulation for ${model} skipped: its CPU is not slower than this device's.`);
    else kinds.push('cpu');
  }
  let simUrl: string | undefined;
  const scale = o.simScale ?? 1;
  if (o.simulate?.gpu) {
    if (!baseUrl || !page.navigate) notes.push('GPU simulation needs --url (it reloads the page at a higher render scale).');
    else if (!pixelFactor || pixelFactor <= 1.05) notes.push(`GPU simulation for ${model} skipped: its GPU is not slower than this device's.`);
    else {
      kinds.push('gpu');
      let u = baseUrl;
      if (t.tier && (o.tiers?.length || /[?&]q=/.test(u))) u = tierUrl(u, o.param ?? 'q', t.tier);
      simUrl = tierUrl(u, o.scaleParam ?? 'scale', String(Math.round(scale * Math.sqrt(pixelFactor) * 100) / 100));
    }
  }
  if (!kinds.length) return undefined;
  try {
    if (simUrl && page.navigate) {
      await page.navigate(simUrl);
      await deps.sleep(o.warmupS * 1000);
    }
    if (kinds.includes('cpu')) await page.send?.('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    if (!simUrl) await deps.sleep(Math.min(3, o.warmupS) * 1000);
    const run = await measureRun(deps, page, { label: `sim:${model}`, seconds: o.seconds, targetFps: o.targetFps, ...(t.tier && simUrl ? { tier: t.tier } : {}), ...(simUrl ? { url: simUrl } : {}) });
    run.simulated = {
      forModel: t.model,
      ...(t.gpu ? { forGpu: t.gpu } : {}),
      kinds,
      ...(kinds.includes('cpu') ? { cpuRate } : {}),
      ...(kinds.includes('gpu') ? { pixelFactor, scale: Math.round(scale * Math.sqrt(pixelFactor as number) * 100) / 100 } : {}),
      note: `Imitates ${t.name}${kinds.includes('gpu') ? ` at render scale ${scale} (the tier's full resolution${scale === 1 ? '; adaptive resolution on the real stick would lower it if needed' : ''})` : ''}. Estimated (simulated).`,
    };
    return run;
  } finally {
    if (kinds.includes('cpu')) await page.send?.('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
  }
}

/** Fires RUNNING_CRITICAL trim-memory at the app and checks whether it crashed, reloaded or survived. */
export async function trimMemoryCheck(deps: FitDeps, page: FitPage | undefined, pkg: string): Promise<PressureResult> {
  const level = 'RUNNING_CRITICAL';
  if (!deps.shell) return { level, outcome: 'unknown', detail: 'No adb shell to send the trim event.' };
  const pidOf = async () => Number((await deps.shell?.(`pidof ${pkg}`).catch(() => ''))?.trim().split(/\s+/)[0]) || undefined;
  const pid0 = await pidOf();
  if (!pid0) return { level, outcome: 'unknown', detail: `${pkg} is not running.` };
  const r0 = deps.native ? await deps.native(false).catch(() => undefined) : undefined;
  const token = `t${Date.now().toString(36)}`;
  const marked = page && !page.closed ? await page.eval(`(window.__firelabTrim = ${JSON.stringify(token)}, true)`, 5000).catch(() => false) : false;
  const out = await deps.shell(`am send-trim-memory ${pkg} ${level}`).catch((e: Error) => `Error: ${e.message}`);
  if (/error|unknown|exception|not found/i.test(out)) return { level, outcome: 'unknown', detail: `am send-trim-memory failed: ${out.trim().split('\n')[0]}` };
  await deps.sleep(5000);
  const pid1 = await pidOf();
  const r1 = deps.native ? await deps.native(false).catch(() => undefined) : undefined;
  const after = r1?.memAvailableMB !== undefined ? { memAvailableAfterMB: r1.memAvailableMB } : {};
  if (!pid1 || pid1 !== pid0) return { level, outcome: 'crashed', detail: pid1 ? `The app restarted (pid ${pid0} -> ${pid1}).` : 'The app process is gone.', ...after };
  if (r0?.rendererPid && r1?.rendererPid && r0.rendererPid !== r1.rendererPid) return { level, outcome: 'reloaded', detail: `The WebView renderer was replaced (pid ${r0.rendererPid} -> ${r1.rendererPid}).`, ...after };
  if (marked && page) {
    if (page.closed) return { level, outcome: 'reloaded', detail: 'The DevTools connection to the page dropped (the renderer restarted).', ...after };
    const still = await page.eval<unknown>('window.__firelabTrim', 5000).catch(() => undefined);
    if (still !== token) return { level, outcome: 'reloaded', detail: 'The page lost its state (it reloaded).', ...after };
  }
  return { level, outcome: 'survived', detail: `Same app process${r1?.rendererPid ? ' and renderer' : ''}${marked ? ', page state intact' : ''}.`, ...after };
}

/** Measures on the device and returns a portable measurement. Restores the page URL it changed. */
export async function runFit(deps: FitDeps, opts: FitRunOptions = {}, onProgress: (p: FitProgress) => void = () => {}): Promise<FitMeasurement> {
  const targetFps = opts.targetFps ?? 30;
  const seconds = opts.seconds ?? 15;
  const warmupS = opts.warmupS ?? 5;
  const o = { ...opts, targetFps, seconds, warmupS };
  const notes: string[] = [];
  onProgress({ progress: 0, message: 'Reading the device' });
  const device = await deps.device();
  const m = emptyMeasurement({ targetFps });
  m.app = { ...(opts.package ? { package: opts.package } : {}), ...(opts.url ? { url: opts.url } : {}), ...(opts.name ? { name: opts.name } : {}), ...(opts.apk ? { apk: opts.apk } : {}) };
  let page: FitPage | undefined;
  if (deps.openPage) {
    try {
      page = await deps.openPage();
    } catch (e) {
      notes.push(`No WebView page: ${(e as Error).message}. Memory${deps.frames ? ' and frame rate (SurfaceFlinger)' : ''} only.`);
    }
  }
  let caps: WebCaps | undefined;
  let original: string | undefined;
  let initId: string | undefined;
  const tierCount = opts.tiers?.length ?? 0;
  const simCount = (opts.simulateFor?.length || 1) * (opts.simulate?.cpu || opts.simulate?.gpu ? 1 : 0);
  const steps = 2 + Math.max(1, tierCount) + simCount + (opts.simulate?.trim ? 1 : 0) + 1;
  let step = 1;
  const next = (message: string) => onProgress({ progress: Math.min(0.99, step++ / steps), message });
  try {
    if (page) {
      original = await page.currentUrl().catch(() => undefined);
      next('Reading WebGL and WebView capabilities');
      caps = parseWebCaps(await page.eval(WEB_CAPS_SCRIPT, 60000).catch(() => undefined));
      if (caps) {
        m.webCaps = caps;
        const r = caps.webgl2?.renderer ?? caps.webgl1?.renderer;
        if (r) device.gpu = r;
        if (caps.chromeMajor) device.webviewMajor = caps.chromeMajor;
      }
      if (opts.detectNeeds && page.addInitScript) {
        next('Reloading with the WebGL usage hook');
        initId = await page.addInitScript(NEEDS_HOOK_SCRIPT);
        if (opts.url && page.navigate) await page.navigate(opts.url);
        else await page.reload?.();
        await deps.sleep(warmupS * 1000);
      } else if (opts.url && page.navigate && !tierCount && original && original.split('#')[0] !== opts.url.split('#')[0]) {
        next(`Loading ${opts.url}`);
        await page.navigate(opts.url);
        await deps.sleep(warmupS * 1000);
      }
    }
    m.device = device;
    if (tierCount && page?.navigate && opts.url) {
      for (const tier of opts.tiers as string[]) {
        const url = tierUrl(opts.url, opts.param ?? 'q', tier);
        next(`${tier}: loading and warming up`);
        await page.navigate(url);
        await deps.sleep(warmupS * 1000);
        next(`${tier}: measuring ${seconds} s`);
        m.runs.push(await measureRun(deps, page, { label: tier, tier, url, seconds, targetFps }));
      }
    } else {
      if (tierCount) notes.push('--tiers needs --url and a WebView page; measured the app as it is.');
      next(`Measuring ${seconds} s`);
      m.runs.push(await measureRun(deps, page, { label: 'current', seconds, targetFps, ...(opts.url ? { url: opts.url } : {}) }));
    }
    if (page && (opts.simulate?.cpu || opts.simulate?.gpu)) {
      for (const model of opts.simulateFor?.length ? opts.simulateFor : ['AFTSSS']) {
        next(`Simulating ${model}`);
        const run = await simulateModel(deps, page, o, device, model, opts.url ?? original, notes).catch((e: Error) => {
          notes.push(`Simulation for ${model} failed: ${e.message}`);
          return undefined;
        });
        if (run) m.runs.push(run);
      }
    }
    if (page && !page.closed) {
      const usage = await page.eval<DetectedUsage>(NEEDS_READ_SCRIPT, 8000).catch(() => undefined);
      m.needs = mergeNeeds(opts.needs, needsFromDeclaration(usage?.declared), needsFromUsage(usage));
    } else if (opts.needs) m.needs = opts.needs;
    if (opts.simulate?.trim) {
      next('Sending RUNNING_CRITICAL trim-memory');
      if (opts.package) m.pressure = await trimMemoryCheck(deps, page, opts.package);
      else notes.push('--simulate trim needs --package.');
    }
    const mediaInputs = [...(opts.media ?? [])];
    if (page && !page.closed && opts.pageMedia !== false) mediaInputs.push(...((await page.eval<string[]>(PAGE_MEDIA_SCRIPT, 8000).catch(() => [])) ?? []));
    if (mediaInputs.length) {
      next(`Probing ${mediaInputs.length} media file${mediaInputs.length === 1 ? '' : 's'}`);
      m.media = await probeMedia(mediaInputs, { ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    }
  } finally {
    if (page) {
      if (initId) await page.removeInitScript?.(initId).catch(() => {});
      const changed = tierCount > 0 || opts.simulate?.gpu || opts.detectNeeds || (opts.url && original && original.split('#')[0] !== opts.url.split('#')[0]);
      if (opts.restore !== false && changed && original && !/^about:|^chrome-error:/.test(original) && page.navigate) {
        onProgress({ progress: 0.99, message: `Restoring ${original}` });
        await page.navigate(original).catch(() => {});
      }
      page.close();
    }
  }
  if (!m.app.apk && !m.needs && !m.runs.some((r) => r.frames || r.memory)) notes.push('Nothing was measured: is the app running in the foreground?');
  m.notes = notes;
  onProgress({ progress: 1, message: 'Done' });
  return m;
}
