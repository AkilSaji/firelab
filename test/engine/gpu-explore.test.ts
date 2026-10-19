import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explore, buildConfig, failMatcher, readTrace } from '../../src/engine/index.js';
import { createGpuOracle, gpuSignature } from '../../src/engine/oracles/gpu.js';
import { createOracles } from '../../src/engine/oracles/index.js';
import { parseProbe } from '../../src/engine/probe.js';
import { Observer } from '../../src/engine/observe.js';
import { FakeDriver } from '../../src/driver/fake.js';
import { gpuEmulationFor } from '../../src/fit/gpu-emulate.js';
import { GPU_GLOBAL, type GpuFailure } from '../../src/fit/gpu-shim.js';
import type { FindingDraft, Observation, OracleContext, State } from '../../src/engine/types.js';
import { SimGame, PKG, VirtualClock } from './sim-app.js';

const emu = gpuEmulationFor('AFTT');
const state: State = { id: 's1', level: 2, key: { pkg: PKG }, firstSeenStep: 0 };
const obs = (o: Partial<Observation>): Observation => ({ ts: 0, step: 0, foreground: PKG, logs: [], console: [], settleMs: 0, ...o });
const NO_WEBGL2: GpuFailure = { key: 'getContext("webgl2") returned null: no WebGL2 on Mali-450 MP4', sev: 'fail', call: 'getContext("webgl2")', detail: 'returned null: no WebGL2 on Mali-450 MP4', n: 1 };
const BIG_TEX: GpuFailure = { key: 'texImage2D 8192x8192', sev: 'fail', call: 'texImage2D', detail: '8192x8192 is over MAX_TEXTURE_SIZE 4096 on Mali-450 MP4: INVALID_VALUE, no texture', n: 1 };
const NO_S3TC: GpuFailure = { key: 'getExtension s3tc', sev: 'warn', call: 'getExtension("WEBGL_compressed_texture_s3tc")', detail: 'returned null', n: 1 };

function ctxFor(drafts: FindingDraft[]): OracleContext {
  const cfg = buildConfig({ app: { package: PKG }, emulateGpu: emu }, 'r1');
  return { driver: {} as never, config: cfg, graph: { cells: new Map(), transitions: new Map() }, history: [], emit: (f) => void drafts.push(f), note: () => {}, isExitEdge: () => false };
}

describe('gpu oracle', () => {
  test('only with --emulate-gpu; buildConfig turns it on', () => {
    const plain = buildConfig({ app: { package: PKG } }, 'r');
    expect(createGpuOracle(plain)).toBeUndefined();
    expect(createOracles(['gpu'], plain, new FakeDriver().caps).notes).toEqual(['gpu oracle off: it needs --emulate-gpu <model>']);
    const cfg = buildConfig({ app: { package: PKG }, emulateGpu: emu }, 'r');
    expect(cfg.oracles).toEqual(['health', 'screen', 'focus', 'gpu']);
    expect(failMatcher(['gpu'])({ kind: 'gpu-unsupported', severity: 'minor' })).toBe(true);
  });

  test('a failed call is a major finding once per page load; warnings and fallbacks are softer', async () => {
    const drafts: FindingDraft[] = [];
    const ctx = ctxFor(drafts);
    const o = createGpuOracle(ctx.config)!;
    const gpu = { model: 'AFTT', webgl: 0, webgl2: 0, refused: 1 };
    const a = obs({ probe: { raf: 1, errors: 0, url: '/', gpu, gpuFails: [BIG_TEX, NO_S3TC] } });
    await o.check(ctx, a, undefined, state);
    const b = obs({ step: 1, probe: { raf: 2, errors: 0, url: '/', gpu, gpuFails: [BIG_TEX, NO_S3TC] } });
    await o.check(ctx, b, a, state);
    expect(drafts.map((d) => [d.kind, d.severity, d.signature])).toEqual([['gpu-unsupported', 'major', gpuSignature(BIG_TEX)]]);
    expect(drafts[0]?.title).toMatch(/^texImage2D fails on AFTT: 8192x8192 is over MAX_TEXTURE_SIZE 4096/);
    // After a relaunch the page is new: the same failure counts again (the explorer adds it to the count).
    await o.check(ctx, obs({ step: 2, relaunched: true, probe: { raf: 1, errors: 0, url: '/', gpu: { ...gpu, webgl: 1, drew1: true }, gpuFails: [NO_WEBGL2] } }), b, state);
    expect(drafts[1]).toMatchObject({ severity: 'minor', signature: gpuSignature(NO_WEBGL2) }); // it went on drawing with WebGL1
    // A WebGL1 context that never drew (a chip-detection probe) is no fallback.
    await o.check(ctx, obs({ step: 3, relaunched: true, probe: { raf: 1, errors: 0, url: '/', gpu: { ...gpu, webgl: 1 }, gpuFails: [NO_WEBGL2] } }), b, state);
    expect(drafts[2]).toMatchObject({ severity: 'major', signature: gpuSignature(NO_WEBGL2) });
    expect(o.matches(gpuSignature(BIG_TEX), b)).toBe(true);
    expect(o.matches(gpuSignature(NO_S3TC), b)).toBe(false);
    const notes = o.notes!();
    expect(notes[0]).toMatch(/^WebGL under the Fire TV Stick \(2nd gen\) \/ Basic Edition \(AFTT, Mali-450 MP4\) profile \(features and limits, not speed\): 2 calls failed .*; 1 capability check came back empty \(getExtension\("WEBGL_compressed_texture_s3tc"\)\)/);
  });

  test('says so when the shim never reached the page', async () => {
    const drafts: FindingDraft[] = [];
    const ctx = ctxFor(drafts);
    const o = createGpuOracle(ctx.config)!;
    await o.check(ctx, obs({ probe: { raf: 1, errors: 0 } }), undefined, state);
    expect(o.notes!()[0]).toMatch(/never showed up in the page/);
  });

  test('the probe carries the shim state', () => {
    const p = parseProbe({ raf: 1, errors: 0, gpu: { model: 'AFTT', webgl: 1, webgl2: 0, refused: 1 }, gpuFails: [NO_WEBGL2, { nonsense: true }] });
    expect(p?.gpu).toEqual({ model: 'AFTT', webgl: 1, webgl2: 0, refused: 1, drew1: false });
    expect(p?.gpuFails).toEqual([NO_WEBGL2]);
  });
});

describe('observer init scripts', () => {
  test('added over CDP after each launch, then the page reloads; retried when the WebView is not up yet', async () => {
    const d = new FakeDriver();
    const clock = new VirtualClock();
    let fail = 1;
    d.on('cdp', async (method: string) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && fail-- > 0) throw new Error('no webview yet');
      return {};
    });
    d.on('evaluate', async () => ({ raf: 1, errors: 0 }));
    const o = new Observer({ driver: d, app: { package: PKG }, clock, probe: {}, initScripts: ['window.x = 1'] });
    await o.afterLaunch();
    expect(o.initInstalls).toBe(0);
    await o.probe();
    expect(o.initInstalls).toBe(1);
    await o.probe();
    await o.afterLaunch();
    expect(o.initInstalls).toBe(2);
    const methods = d.callsTo('cdp').map((c) => c.args[0]);
    expect(methods.filter((m) => m === 'Page.reload')).toHaveLength(2);
    expect(d.callsTo('cdp').find((c) => c.args[0] === 'Page.addScriptToEvaluateOnNewDocument')?.args[1]).toEqual({ source: 'window.x = 1' });
  });
});

describe('explore --emulate-gpu on the simulated game', () => {
  test('the game asks for WebGL2 when play starts: a confirmed gpu-unsupported finding with a short repro', async () => {
    const sim = new SimGame([]);
    let shimAt = -1;
    sim.driver.on('cdp', async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') expect(String(params?.source)).toContain(GPU_GLOBAL);
      if (method === 'Page.reload') shimAt = sim.launches;
      return {};
    });
    const probe = sim.probe.bind(sim);
    sim.probe = () => {
      const p = probe();
      if (shimAt !== sim.launches) return p;
      // A game that only creates its (WebGL2) renderer once play starts.
      const playing = sim.mode !== 'title';
      return { ...p, gpu: { model: 'AFTT', webgl: 0, webgl2: 0, refused: playing ? 1 : 0 }, ...(playing ? { gpuFails: [NO_WEBGL2] } : {}) };
    };
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-gpu-explore-'));
    try {
      const r = await explore({ driver: sim.driver as never, clock: sim.clock, package: PKG, minutes: 3, out, minimizeMinutes: 2, emulateGpu: 'AFTT' });
      const f = r.findings.find((x) => x.kind === 'gpu-unsupported');
      expect(f).toMatchObject({ severity: 'major', status: 'confirmed' });
      expect(f?.title).toMatch(/getContext\("webgl2"\) fails on AFTT/);
      expect(f?.traceLength).toBeLessThanOrEqual(2);
      expect(readTrace(f!.trace).probe?.emulateGpu?.model).toBe('AFTT');
      expect(r.notes.join('\n')).toMatch(/WebGL under the .*AFTT, Mali-450 MP4\) profile .*1 call failed/);
      expect(r.exitCode).toBe(1);
      await expect(explore({ driver: sim.driver as never, clock: sim.clock, package: PKG, steps: 5, out, emulateGpu: 'NOPE' })).rejects.toThrow(/Unknown Fire TV model/);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
