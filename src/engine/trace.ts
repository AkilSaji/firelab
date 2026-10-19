/**
 * Traces and replay (docs/ENGINE.md 8, 10.4). A trace is the key sequence from
 * a fresh launch to a finding, with the gaps between presses (timing is part of
 * the input [47]) and what a replay must see again (`expect`). A replay
 * relaunches, presses the keys with the recorded gaps, observes after each, and
 * asks the finding's oracle whether it shows up again, both through
 * `matches()` and through a fresh copy of the oracles' own checks.
 */
import { FireLabError } from '../lib/errors.js';
import fs from 'node:fs';
import type { DeviceDriver } from './driver.js';
import { realClock, type Clock } from './clock.js';
import type { Action, ExploreConfig, InvestigateTools, Observation, Oracle, OracleContext, Trace, TraceStep } from './types.js';
import { Observer, type SettleOptions } from './observe.js';
import { gpuShimScript } from '../fit/gpu-shim.js';
import { Abstraction, screenIdOf } from './abstraction.js';
import { Archive } from './archive.js';
import { EXIT, Graph } from './graph.js';
import { actionKey, parseActionKey } from './actions.js';
import { createOracle } from './oracles/index.js';
import { MVP_ORACLES } from './oracles/index.js';
import { assertAllowed, perform, relaunchApp } from './session.js';
import { DEFAULT_KEYS } from './config.js';

export function readTrace(file: string): Trace {
  let t: unknown;
  try {
    t = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateTrace(t);
  } catch (e) {
    throw new FireLabError('bad-request', `Can't use ${file} as a trace: ${(e as Error).message}`);
  }
  return t;
}

/** Throws on anything that isn't a version-1 trace (traces are user files: check before driving a TV with one). */
export function validateTrace(t: unknown): asserts t is Trace {
  const x = t as Trace;
  if (!x || typeof x !== 'object' || x.version !== 1) throw new Error('not a FireLab trace (version 1)');
  if (!x.app || typeof x.app.package !== 'string') throw new Error('trace has no app.package');
  if (!Array.isArray(x.steps)) throw new Error('trace has no steps');
  for (const s of x.steps) {
    if (!s || typeof s !== 'object' || !s.action || typeof s.action !== 'object') throw new Error('bad trace step');
    if (!parseActionKey(actionKey(s.action as Action))) throw new Error(`bad action in trace: ${JSON.stringify(s.action)}`);
    if (typeof s.gapMs !== 'number' || !(s.gapMs >= 0) || s.gapMs > 120_000) throw new Error('bad gapMs in trace');
  }
}

/** The key list of a trace in the CONTRACT key-spec syntax ('down*3 ok right:1500'). */
export const traceKeys = (steps: readonly TraceStep[]): string[] => steps.map((s) => actionKey(s.action));

export type ReplayOptions = {
  clock?: Clock;
  signal?: AbortSignal;
  settle?: SettleOptions;
  readyMs?: number;
  /** Stop as soon as the expected finding shows (default true; replay --check keeps going with false). */
  stopOnHit?: boolean;
  /** Observations after the last step, 1 s apart, so lasting symptoms (black, frozen) can show (default 3). */
  tail?: number;
  allowPackages?: string[];
  onStep?: (i: number, total: number) => void;
};

export type ReplayRun = { hit: boolean; steps: number; ms: number; signatures: string[] };

function configFor(trace: Trace): ExploreConfig {
  return {
    app: trace.app,
    seed: trace.seed,
    keys: DEFAULT_KEYS.slice(),
    oracles: [...MVP_ORACLES],
    stateExpr: trace.probe?.stateExpr,
    focusSelector: trace.probe?.focusSelector,
    setupEval: trace.probe?.setupEval,
    visualState: trace.probe?.visualState,
    ...(trace.probe?.emulateGpu ? { emulateGpu: trace.probe.emulateGpu } : {}),
    reset: 'relaunch',
    strategy: 'explore',
    minimize: false,
    outDir: '',
  };
}

/** One replay from a fresh launch. */
export async function replayOnce(driver: DeviceDriver, trace: Trace, o: ReplayOptions = {}): Promise<ReplayRun> {
  const clock = o.clock ?? realClock;
  const cfg = configFor(trace);
  assertAllowed(cfg.app.package, o.allowPackages);
  const t0 = clock.now();
  const observer = new Observer({ driver, app: cfg.app, clock, probe: { stateExpr: cfg.stateExpr, focusSelector: cfg.focusSelector }, settle: o.settle, ...(cfg.emulateGpu ? { initScripts: [gpuShimScript(cfg.emulateGpu)] } : {}) });
  const abstraction = new Abstraction({ visualState: cfg.visualState });
  const archive = new Archive();
  const graph = new Graph();
  const history: Observation[] = [];
  const signatures = new Set<string>();
  const expect = trace.expect;
  const ctx: OracleContext = {
    driver,
    config: cfg,
    graph: { cells: archive.cells, transitions: graph.transitions },
    history,
    emit: (f) => void signatures.add(f.signature),
    note: () => {},
    isExitEdge: (s, a) => graph.isExit(s, a),
  };
  const oracles: Oracle[] = [];
  for (const id of new Set([...MVP_ORACLES, 'stuck', ...(expect ? [expect.oracle] : [])])) {
    const or = createOracle(id, cfg);
    if (or && or.needs.every((n) => driver.caps[n])) oracles.push(or);
  }
  const target = expect ? oracles.find((x) => x.id === expect.oracle) : undefined;
  let prev: Observation | undefined;
  let hit = false;
  let curPath: Action[] = [];
  const ingest = async (obs: Observation) => {
    const inApp = obs.foreground === cfg.app.package;
    const st = abstraction.abstract(obs);
    obs.stateId = inApp ? st.id : EXIT;
    if (inApp) {
      if (obs.action) curPath = [...curPath, obs.action];
      archive.observe(st, curPath);
    }
    history.push(obs);
    if (history.length > 200) history.shift();
    for (const or of oracles) await Promise.resolve(or.check(ctx, obs, prev, st)).catch(() => undefined);
    if (expect && !expect.investigate && (signatures.has(expect.signature) || target?.matches(expect.signature, obs, prev))) hit = true;
    prev = obs;
    return st;
  };

  try {
    const { pid } = await relaunchApp(driver, cfg.app, observer, clock, { setupEval: cfg.setupEval, readyMs: o.readyMs, signal: o.signal });
    let step = 0;
    await ingest(await observer.observe(step++, { relaunched: true, ...(pid !== undefined ? { pid } : {}) }));
    let lastPress = clock.now();
    for (const [i, s] of trace.steps.entries()) {
      if (o.signal?.aborted || (hit && o.stopOnHit !== false)) break;
      o.onStep?.(i, trace.steps.length);
      const wait = s.gapMs - (clock.now() - lastPress);
      if (wait > 0) await clock.sleep(wait, o.signal).catch(() => undefined);
      lastPress = clock.now();
      await perform(driver, s.action, clock, o.signal);
      const p = await driver.pid(cfg.app).catch(() => undefined);
      await ingest(await observer.observe(step++, { action: s.action, ...(p !== undefined ? { pid: p } : {}) }));
    }
    for (let k = 0; k < (o.tail ?? 3) && !hit && !o.signal?.aborted && !expect?.investigate; k++) {
      const a: Action = { kind: 'wait', ms: 1000 };
      await perform(driver, a, clock, o.signal);
      await ingest(await observer.observe(step++, { action: a }));
    }
    if (expect?.investigate && target?.investigate && prev && prev.foreground === cfg.app.package && !o.signal?.aborted) {
      const tools: InvestigateTools = {
        act: async (a) => {
          await perform(driver, a, clock, o.signal);
          const p = await driver.pid(cfg.app).catch(() => undefined);
          const obs = await observer.observe(step++, { action: a, ...(p !== undefined ? { pid: p } : {}) });
          await ingest(obs);
          return obs;
        },
        focusables: () => observer.focusables(),
        screenOf: (x) => screenIdOf(x),
        returnTo: async () => false,
        current: () => prev,
        traceSoFar: () => trace.steps.map((x) => ({ ...x })),
      };
      ctx.tools = tools;
      await target.investigate({ ...ctx, tools }, abstraction.abstract(prev)).catch(() => undefined);
      if (signatures.has(expect.signature)) hit = true;
    }
  } finally {
    observer.close();
  }
  return { hit, steps: trace.steps.length, ms: clock.now() - t0, signatures: [...signatures] };
}

export type ReplayResult = { hits: number; runs: number; detail: ReplayRun[]; expect?: Trace['expect'] };

/** `firelab replay --times n`: reproduced k/n for trace.expect. */
export async function replayTrace(driver: DeviceDriver, trace: Trace, times = 1, o: ReplayOptions = {}): Promise<ReplayResult> {
  const detail: ReplayRun[] = [];
  for (let i = 0; i < times && !o.signal?.aborted; i++) detail.push(await replayOnce(driver, trace, o));
  return { hits: detail.filter((d) => d.hit).length, runs: detail.length, detail, ...(trace.expect ? { expect: trace.expect } : {}) };
}
