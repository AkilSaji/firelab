import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runFit, frameStats, trimMemoryCheck, type FitDeps, type FitPage } from '../src/fit/run.js';
import { fitDepsFromDriver, type FitDriverLike } from '../src/fit/driver.js';
import { scoreFit } from '../src/fit/score.js';
import { parseNeedsFlag, NEEDS_HOOK_SCRIPT, NEEDS_READ_SCRIPT } from '../src/fit/needs.js';
import { WEB_CAPS_SCRIPT } from '../src/profile/webcaps.js';
import { PAGE_MEDIA_SCRIPT } from '../src/media/probe.js';
import { PROBE_SOURCE } from '../src/cdp/fps.js';
import { loadProfiles } from '../src/profile/load.js';
import { h264_1080p, mp4 } from './media-fixtures.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-fitrun-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const profiles = loadProfiles().profiles;
const BASE = 'http://192.168.1.20:4173/';

const CAPS = {
  userAgent: 'Mozilla/5.0 (Linux; Android 11; AFTMA08C15; wv) Chrome/138.0.7204.180',
  chromeMajor: 138,
  webgl2: { renderer: 'PowerVR Rogue GE9215', maxTextureSize: 8192, maxRenderbufferSize: 8192, extensions: ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc'] },
  webgl1: { renderer: 'PowerVR Rogue GE9215', maxTextureSize: 8192, extensions: [] },
  features: { wasm: true },
};

type Scenario = { trim?: 'survive' | 'crash' | 'reload' | 'error' };

/** A scripted app: fps and memory depend on the tier (?q=), render scale (?scale=) and CPU throttling. */
function fakeApp(sc: Scenario = {}) {
  let clock = 1_000_000;
  let url = `${BASE}?q=tv-hd`;
  let throttle = 1;
  let marker: unknown;
  let pid = 4242;
  let rendererPid = 4300;
  let closed = false;
  const log = { navigations: [] as string[], sends: [] as { method: string; params?: Record<string, unknown> }[], evals: [] as string[], shell: [] as string[], init: [] as string[], removed: [] as string[] };
  const tierOf = () => new URL(url).searchParams.get('q') ?? 'tv-hd';
  const scaleOf = () => Number(new URL(url).searchParams.get('scale') ?? 1);
  const fps = () => {
    if (throttle > 1 || scaleOf() > 1) return 25;
    return tierOf() === 'tv' ? 30 : 27;
  };
  const hook = () => {
    const f = fps();
    const canvas = tierOf() === 'tv' ? { width: Math.round(1280 * scaleOf()), height: Math.round(720 * scaleOf()) } : { width: 1920, height: 1080 };
    return { version: '1', tier: tierOf(), fps: f, fpsMedian: f, frameMs: { p50: Math.round((1000 / f) * 10) / 10, p95: Math.round((1300 / f) * 10) / 10 }, scale: scaleOf(), canvas, targetFps: 30 };
  };
  const page: FitPage = {
    get closed() {
      return closed;
    },
    eval: async <T>(expr: string): Promise<T> => {
      log.evals.push(expr);
      if (expr === WEB_CAPS_SCRIPT) return CAPS as T;
      if (expr === NEEDS_READ_SCRIPT) return { declared: { compressed: ['astc'] }, threeRevision: '170', canvasContexts: ['webgl2'] } as T;
      if (expr === PAGE_MEDIA_SCRIPT) return [] as T;
      if (expr === PROBE_SOURCE) return 'installed' as T;
      if (expr.startsWith('(window.__firelabTrim =')) {
        marker = JSON.parse(/= ("[^"]+")/.exec(expr)?.[1] ?? 'null');
        return true as T;
      }
      if (expr === 'window.__firelabTrim') return marker as T;
      if (expr.includes('window.firelab')) return hook() as T;
      return null as T;
    },
    send: async (method, params) => {
      log.sends.push({ method, ...(params ? { params } : {}) });
      if (method === 'Emulation.setCPUThrottlingRate') throttle = Number(params?.rate ?? 1);
      return {};
    },
    navigate: async (u) => {
      log.navigations.push(u);
      url = u;
      return { loaded: true };
    },
    reload: async () => ({ loaded: true }),
    addInitScript: async (src) => {
      log.init.push(src);
      return 'init-1';
    },
    removeInitScript: async (id) => void log.removed.push(id),
    currentUrl: async () => url,
    installProbe: async () => {},
    resetFps: async () => {},
    readFps: async () => [{ ts: clock, fps: fps(), source: 'page' as const }],
    lastHook: () => hook(),
    close: () => {
      closed = true;
    },
  };
  let avail = 400;
  const deps: FitDeps = {
    device: async () => ({ id: '192.168.1.194:5555', model: 'AFTMA08C15', name: 'Fire TV Stick 4K Plus', gpu: 'PowerVR GE9215', sdk: 30, abis: ['armeabi-v7a', 'armeabi'], ramMB: 1670 }),
    openPage: async () => page,
    native: async (memory) => {
      avail -= 2;
      const big = tierOf() === 'tv-hd' || scaleOf() > 1;
      return { ts: clock, appPid: pid, rendererPid, memAvailableMB: avail, ...(memory ? { appPssMB: big ? 290 : 245, rendererPssMB: big ? 255 : 190, memMB: big ? 545 : 435 } : {}) };
    },
    shell: async (cmd) => {
      log.shell.push(cmd);
      if (cmd.startsWith('pidof')) return `${pid}\n`;
      if (cmd.startsWith('am send-trim-memory')) {
        if (sc.trim === 'error') return 'Error: Unknown process: com.example.webgame';
        if (sc.trim === 'crash') pid = 5151;
        if (sc.trim === 'reload') {
          marker = undefined;
          rendererPid = 4400;
        }
        return '';
      }
      return '';
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, page, log, url: () => url };
}

describe('runFit with a fake device', () => {
  it('measures the page as it is: caps, needs, frames from window.firelab, memory, no navigation', async () => {
    const app = fakeApp();
    const progress: string[] = [];
    const m = await runFit(app.deps, { package: 'com.example.webgame', needs: parseNeedsFlag('max-texture=4096'), seconds: 6 }, (p) => progress.push(p.message));
    expect(m.kind).toBe('firelab-measurement');
    expect(m.device).toMatchObject({ model: 'AFTMA08C15', gpu: 'PowerVR Rogue GE9215', webviewMajor: 138 });
    expect(m.webCaps?.compressed).toEqual(['astc', 'etc2']);
    expect(m.needs).toMatchObject({ webgl: 2, compressed: ['astc'], maxTextureSize: 4096, sources: { webgl: 'inferred', compressed: 'page', maxTextureSize: 'flag' } });
    expect(m.runs).toHaveLength(1);
    expect(m.runs[0]).toMatchObject({ label: 'current', tier: 'tv-hd', seconds: 6, canvas: { width: 1920, height: 1080 }, scale: 1, frames: { fpsMedian: 27, frameMsP50: 37, frameMsP95: 48.1, frameMsFrom: 'page', capped: false, samples: 6 }, memory: { appPssMB: 290, rendererPssMB: 255, totalMB: 545 } });
    expect(m.runs[0]?.memory?.memAvailableMinMB).toBeLessThan(400);
    expect(app.log.navigations).toEqual([]);
    expect(progress.at(-1)).toBe('Done');
  });

  it('tier runs plus CPU + GPU simulation of the 3rd gen stick, then restores the page', async () => {
    const app = fakeApp();
    const m = await runFit(app.deps, { url: BASE, package: 'com.example.webgame', tiers: ['tv', 'tv-hd'], simulate: { cpu: true, gpu: true }, profiles, seconds: 5, warmupS: 2 });
    expect(m.runs.map((r) => r.label)).toEqual(['tv', 'tv-hd', 'sim:AFTSSS']);
    expect(m.runs[0]).toMatchObject({ tier: 'tv', frames: { fpsMedian: 30, capped: true }, memory: { totalMB: 435 } });
    expect(m.runs[1]).toMatchObject({ tier: 'tv-hd', frames: { fpsMedian: 27, capped: false } });
    const sim = m.runs[2];
    expect(sim?.simulated).toMatchObject({ forModel: 'AFTSSS', forGpu: 'PowerVR Rogue GE8300', kinds: ['cpu', 'gpu'], cpuRate: 1.6, pixelFactor: 2.2, scale: 1.48 });
    expect(sim?.tier).toBe('tv');
    expect(sim?.frames?.fpsMedian).toBe(25);
    expect(app.log.navigations).toEqual([`${BASE}?q=tv`, `${BASE}?q=tv-hd`, `${BASE}?q=tv&scale=1.48`, `${BASE}?q=tv-hd`]);
    expect(app.log.sends).toEqual([
      { method: 'Emulation.setCPUThrottlingRate', params: { rate: 1.6 } },
      { method: 'Emulation.setCPUThrottlingRate', params: { rate: 1 } },
    ]);
    // Scored: the 1 GB stick's frame rate comes from the simulation, memory from the tv run.
    const r = scoreFit(m, profiles);
    const sss = r.models.find((x) => x.model === 'AFTSSS');
    expect(sss?.checks.find((c) => c.id === 'frames')).toMatchObject({ simulated: true, status: 'pass' });
    expect(sss?.checks.find((c) => c.id === 'memory')).toMatchObject({ summary: '435 / 415 MB', status: 'warn' });
  });

  it('skips simulations that make no sense and says why', async () => {
    const app = fakeApp();
    const m = await runFit(app.deps, { package: 'com.example.webgame', simulate: { cpu: true, gpu: true }, simulateFor: ['AFTKRT', 'NOPE'], profiles, seconds: 2 });
    expect(m.runs.map((r) => r.label)).toEqual(['current']);
    expect(m.notes.join(' ')).toMatch(/GPU simulation needs --url|GPU simulation for AFTKRT skipped/);
    expect(m.notes.join(' ')).toMatch(/CPU simulation for AFTKRT skipped/);
    expect(m.notes.join(' ')).toMatch(/unknown model NOPE/);
  });

  it('--detect-needs installs the usage hook before reloading, and removes it after', async () => {
    const app = fakeApp();
    await runFit(app.deps, { url: BASE, detectNeeds: true, seconds: 2, warmupS: 1 });
    expect(app.log.init).toEqual([NEEDS_HOOK_SCRIPT]);
    expect(app.log.removed).toEqual(['init-1']);
    expect(app.log.navigations[0]).toBe(BASE);
    expect(app.log.navigations.at(-1)).toBe(`${BASE}?q=tv-hd`); // restored
  });

  it('probes media given on the command line', async () => {
    const file = path.join(tmp, 'intro.mp4');
    fs.writeFileSync(file, mp4({ video: h264_1080p(), fastStart: false }));
    const m = await runFit(fakeApp().deps, { media: [file], seconds: 1 });
    expect(m.media).toHaveLength(1);
    expect(m.media[0]).toMatchObject({ source: file, fastStart: false, video: { codec: 'avc' } });
  });

  it('without a WebView it measures memory, and frames through SurfaceFlinger', async () => {
    const app = fakeApp();
    const deps: FitDeps = {
      ...app.deps,
      openPage: async () => {
        throw new Error('com.example.native is running but has no debuggable WebView');
      },
      frames: { reset: async () => {}, read: async () => [{ ts: 1, fps: 58, source: 'surface' }] },
    };
    const m = await runFit(deps, { package: 'com.example.native', seconds: 3 });
    expect(m.runs[0]?.frames).toMatchObject({ fpsMedian: 58, source: 'surface', frameMsFrom: 'fps', capped: true });
    expect(m.notes[0]).toMatch(/No WebView page: .*SurfaceFlinger/);
    expect(m.webCaps).toBeUndefined();
  });
});

describe('trim-memory check', () => {
  it('survived: same process, same renderer, page state intact', async () => {
    const app = fakeApp({ trim: 'survive' });
    const r = await trimMemoryCheck(app.deps, app.page, 'com.example.webgame');
    expect(r).toMatchObject({ level: 'RUNNING_CRITICAL', outcome: 'survived' });
    expect(app.log.shell).toContain('am send-trim-memory com.example.webgame RUNNING_CRITICAL');
  });
  it('crashed: the app pid changed', async () => {
    const app = fakeApp({ trim: 'crash' });
    expect(await trimMemoryCheck(app.deps, app.page, 'com.example.webgame')).toMatchObject({ outcome: 'crashed', detail: 'The app restarted (pid 4242 -> 5151).' });
  });
  it('reloaded: the WebView renderer was replaced', async () => {
    const app = fakeApp({ trim: 'reload' });
    expect(await trimMemoryCheck(app.deps, app.page, 'com.example.webgame')).toMatchObject({ outcome: 'reloaded' });
  });
  it('unknown: the command failed', async () => {
    const app = fakeApp({ trim: 'error' });
    expect(await trimMemoryCheck(app.deps, app.page, 'com.example.webgame')).toMatchObject({ outcome: 'unknown' });
  });
  it('runs from runFit with --simulate trim', async () => {
    const m = await runFit(fakeApp({ trim: 'survive' }).deps, { package: 'com.example.webgame', simulate: { trim: true }, seconds: 1 });
    expect(m.pressure?.outcome).toBe('survived');
  });
});

describe('frameStats', () => {
  it('derives frame times from per-second fps when the page has no window.firelab', () => {
    const s = frameStats([20, 22, 24, 25, 25, 26, 26, 27].map((fps) => ({ ts: 0, fps, source: 'raf' as const })), null, 30);
    expect(s).toMatchObject({ fpsMedian: 25, frameMsFrom: 'fps', capped: false, samples: 8 });
    expect(s?.frameMsP50).toBe(40);
    expect(s?.frameMsP95).toBeGreaterThan(45);
    expect(frameStats([], null, 30)).toBeUndefined();
    expect(frameStats([{ ts: 0, fps: 60, source: 'raf' }], null, 30)?.capped).toBe(true);
  });
});

describe('fit on a DeviceDriver (the engine contract)', () => {
  it('maps evaluate, cdp and memory onto fit, and measures', async () => {
    let clockUrl = `${BASE}?q=tv`;
    const evals: string[] = [];
    const cdps: string[] = [];
    const driver: FitDriverLike = {
      serial: 'mock-1',
      caps: { eval: true, cdp: true, memory: true },
      info: async () => ({ model: 'AFTSSS', name: 'Fire TV Stick (3rd gen)', ramMB: 900, gpu: 'PowerVR Rogue GE8300' }),
      pid: async () => 77,
      evaluate: async <T>(expr: string): Promise<T> => {
        evals.push(expr);
        if (expr === 'location.href') return clockUrl as T;
        if (expr.includes('__firelabProbe') && expr.includes('take()') && expr.includes('hook')) return { hook: { fps: 24, tier: 'tv', canvas: { width: 768, height: 432 }, targetFps: 30 }, probe: null, hidden: false } as T;
        if (expr.includes('window.firelab')) return { tier: 'tv', fps: 24, canvas: { width: 768, height: 432 } } as T;
        return null as T;
      },
      cdp: async (method, params) => {
        cdps.push(method);
        if (method === 'Page.navigate') clockUrl = String(params?.url);
        return {};
      },
      memory: async () => ({ ts: 1, pssMB: 415, availMB: 88 }),
    };
    const deps = fitDepsFromDriver(driver, { package: 'com.sunsetvilla.tv' }, { loadWaitMs: 0 });
    let clock = 0;
    deps.sleep = async (ms) => void (clock += ms);
    deps.now = () => clock;
    const m = await runFit(deps, { seconds: 3 });
    expect(m.device).toMatchObject({ id: 'mock-1', model: 'AFTSSS', gpu: 'PowerVR Rogue GE8300' });
    expect(m.runs[0]).toMatchObject({ tier: 'tv', canvas: { width: 768, height: 432 }, frames: { fpsMedian: 24, source: 'page' }, memory: { totalMB: 415, memAvailableMinMB: 88 } });
    expect(m.runs[0]?.memory?.appPssMB).toBeUndefined();
    expect(evals).toContain(PROBE_SOURCE);
    const page = await deps.openPage?.();
    await page?.navigate?.(`${BASE}?q=low`);
    expect(cdps).toContain('Page.navigate');
    expect(await page?.currentUrl()).toBe(`${BASE}?q=low`);
    // No shell on a driver: trim-memory says so instead of guessing.
    expect((await trimMemoryCheck(deps, page, 'com.sunsetvilla.tv')).outcome).toBe('unknown');
  });
});
