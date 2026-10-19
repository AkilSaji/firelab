/**
 * Runs fit's measured checks on any DeviceDriver (the engine's driver
 * contract, docs/ENGINE.md section 3), not just on FireLab's adb layer.
 *
 * The type below is the subset of DeviceDriver (src/driver/types.ts) that
 * fit uses, declared structurally so fit doesn't import the driver layer:
 * DeviceDriver, AdbDriver and FakeDriver all satisfy it as they are (checked
 * with tsc), and so does the engine's copy of the contract.
 */
import { PROBE_SOURCE, bucketsToSamples, type FpsSample } from '../cdp/fps.js';
import type { NativeSample } from '../perf/native.js';
import { sleep } from '../lib/util.js';
import type { FitDeps, FitPage } from './run.js';
import type { FitDeviceInfo } from './types.js';

type AppRef = { package: string; url?: string };

export interface FitDriverLike {
  readonly serial: string;
  readonly caps: { eval: boolean; cdp: boolean; memory: boolean };
  info(): Promise<{ model?: string; name?: string; os?: string; ramMB?: number; gpu?: string; resolution?: { width: number; height: number } }>;
  pid(app: AppRef): Promise<number | undefined>;
  evaluate?<T = unknown>(expression: string, opts?: { app?: AppRef; timeoutMs?: number }): Promise<T>;
  cdp?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  memory?(app: AppRef): Promise<{ ts: number; pssMB?: number; jsHeapMB?: number; graphicsMB?: number; availMB?: number }>;
}

const READ_EXPR = `(() => {
  const f = window.firelab; const p = window.__firelabProbe;
  return { hook: f ? JSON.parse(JSON.stringify(f)) : null, probe: p ? p.take() : null, hidden: document.hidden };
})()`;

type Read = { hook: Record<string, unknown> | null; probe: Parameters<typeof bucketsToSamples>[0] | null; hidden: boolean };

/**
 * FitDeps from a driver. Needs caps.eval for web checks and frames,
 * caps.cdp for CPU throttling and page navigation, caps.memory for memory.
 * A driver has no shell, so the trim-memory simulation reports "unknown";
 * and its memory sample is one PSS number (app + renderer, no split).
 */
export function fitDepsFromDriver(driver: FitDriverLike, app: AppRef, opts: { loadWaitMs?: number } = {}): FitDeps {
  const evaluate = driver.caps.eval && driver.evaluate ? driver.evaluate.bind(driver) : undefined;
  const cdp = driver.caps.cdp && driver.cdp ? driver.cdp.bind(driver) : undefined;
  const memory = driver.caps.memory && driver.memory ? driver.memory.bind(driver) : undefined;
  const deps: FitDeps = {
    device: async (): Promise<FitDeviceInfo> => {
      const i = await driver.info();
      return { id: driver.serial, ...(i.model ? { model: i.model } : {}), ...(i.name ? { name: i.name } : {}), ...(i.os ? { os: i.os } : {}), ...(i.ramMB ? { ramMB: i.ramMB } : {}), ...(i.gpu ? { gpu: i.gpu } : {}), ...(i.resolution ? { resolution: i.resolution } : {}) };
    },
    sleep: (ms) => sleep(ms),
    now: () => Date.now(),
  };
  if (evaluate) {
    deps.openPage = async (): Promise<FitPage> => {
      let hook: Record<string, unknown> | null = null;
      let closed = false;
      const ev = <T>(expr: string, timeoutMs?: number) => evaluate<T>(expr, { app, timeoutMs: timeoutMs ?? 15000 });
      const page: FitPage = {
        get closed() {
          return closed;
        },
        eval: ev,
        currentUrl: () => ev<string>('location.href', 5000),
        installProbe: async () => void (await ev(PROBE_SOURCE, 8000)),
        resetFps: async () => void (await ev('window.__firelabProbe ? (window.__firelabProbe.take(), 1) : 0', 5000).catch(() => 0)),
        readFps: async (): Promise<FpsSample[]> => {
          const r = await ev<Read | null>(READ_EXPR, 5000);
          if (!r || r.hidden) return [];
          hook = r.hook;
          if (r.hook && typeof r.hook.fps === 'number') return r.hook.paused === true ? [] : [{ ts: Date.now(), fps: r.hook.fps, source: 'page', ...(typeof r.hook.scale === 'number' ? { scale: r.hook.scale } : {}) }];
          return r.probe ? bucketsToSamples(r.probe) : [];
        },
        lastHook: () => hook,
        close: () => {
          closed = true;
        },
      };
      if (cdp) {
        page.send = (method, params) => cdp(method, params);
        page.navigate = async (url) => {
          await cdp('Page.navigate', { url });
          await sleep(opts.loadWaitMs ?? 4000);
          return { loaded: false };
        };
        page.addInitScript = async (source) => ((await cdp('Page.addScriptToEvaluateOnNewDocument', { source })) as { identifier?: string } | undefined)?.identifier;
        page.removeInitScript = async (id) => void (await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }));
      }
      return page;
    };
  }
  if (memory) {
    deps.native = async (): Promise<NativeSample> => {
      const s = await memory(app);
      const pid = await driver.pid(app).catch(() => undefined);
      // A driver's pssMB is app + WebView renderer together (AdbDriver: NativeSampler.memMB).
      return { ts: s.ts, ...(pid ? { appPid: pid } : {}), ...(s.pssMB !== undefined ? { memMB: s.pssMB } : {}), ...(s.graphicsMB !== undefined ? { graphicsMB: s.graphicsMB } : {}), ...(s.availMB !== undefined ? { memAvailableMB: s.availMB } : {}) };
    };
  }
  return deps;
}
