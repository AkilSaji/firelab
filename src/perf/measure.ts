import type { FpsSample } from '../cdp/fps.js';
import type { NativeSample } from './native.js';
import type { Gfxinfo } from './parse.js';
import { summarize } from '../lib/stats.js';
import { round1 } from '../lib/util.js';

export type Measurement = {
  seconds: number;
  fps?: { median: number; p10: number; min: number; max: number; samples: number; source: FpsSample['source']; counter?: FpsSample['counter'] };
  memMB?: number;
  appPssMB?: number;
  rendererPssMB?: number;
  graphicsMB?: number;
  cpuPct?: number;
  deviceCpuPct?: number;
  memAvailableMB?: number;
  /** HWUI frame stats for apps drawn with Android views (`dumpsys gfxinfo`). */
  jank?: Gfxinfo;
  /** What window.firelab reported, if the page publishes it. */
  page?: Record<string, unknown>;
  notes: string[];
};

export interface MeasureDeps {
  readFps?: () => Promise<FpsSample[]>;
  resetFps?: () => Promise<void>;
  native?: (memory: boolean) => Promise<NativeSample>;
  pageHook?: () => Record<string, unknown> | null | undefined;
  sleep: (ms: number) => Promise<void>;
}

/** Measures for `seconds`: fps from the page (if any) plus memory and CPU from the device. */
export async function measure(deps: MeasureDeps, seconds: number): Promise<Measurement> {
  const notes: string[] = [];
  const n0 = deps.native ? await deps.native(false).catch((e: Error) => (notes.push(`native: ${e.message}`), undefined)) : undefined;
  if (deps.resetFps) await deps.resetFps().catch(() => {});
  const fps: FpsSample[] = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await deps.sleep(Math.min(1000, Math.max(50, end - Date.now())));
    if (deps.readFps) fps.push(...(await deps.readFps().catch(() => [] as FpsSample[])));
  }
  const n1 = deps.native ? await deps.native(true).catch((e: Error) => (notes.push(`native: ${e.message}`), undefined)) : undefined;
  const m: Measurement = { seconds, notes };
  if (fps.length) {
    const s = summarize(fps.map((f) => f.fps));
    m.fps = { median: round1(s.median), p10: round1(s.p10), min: round1(s.min), max: round1(s.max), samples: s.n, source: (fps[0] as FpsSample).source };
    if (fps[0]?.counter) m.fps.counter = fps[0].counter;
  } else if (deps.readFps) notes.push('No frames measured: the page may be hidden or idle.');
  else notes.push('No WebView to read frame rate from; memory and CPU only.');
  if (n1) {
    for (const k of ['memMB', 'appPssMB', 'rendererPssMB', 'graphicsMB', 'cpuPct', 'deviceCpuPct', 'memAvailableMB'] as const) {
      if (n1[k] !== undefined) m[k] = n1[k];
    }
    if (!n1.appPid) notes.push('The app is not running.');
  }
  if (n0 === undefined && n1 === undefined && deps.native) notes.push('Native sampling failed.');
  const hook = deps.pageHook?.();
  if (hook) m.page = hook;
  return m;
}
