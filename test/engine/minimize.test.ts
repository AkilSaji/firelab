import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ddmin, loopCuts, shrinkTrace, split, replayOnce, replayTrace, readTrace, explore, validateTrace } from '../../src/engine/index.js';
import type { Action, Trace, TraceStep } from '../../src/engine/types.js';
import { VirtualClock, SimGame, PKG } from './sim-app.js';

const k = (key: string): Action => ({ kind: 'key', key: key as never });
const trace = (keys: string[], states?: string[]): Trace => ({
  version: 1,
  app: { package: PKG },
  device: { serial: 't' },
  createdAt: 0,
  seed: 1,
  setup: [{ kind: 'relaunch' }],
  steps: keys.map((x, i) => ({ i, action: k(x), gapMs: 500, ...(states ? { stateId: states[i] } : {}) })),
  expect: { oracle: 'health', signature: 'x' },
  startStateId: 'S0',
});

describe('ddmin', () => {
  test('finds the failure-inducing pair (Zeller & Hildebrandt)', async () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    let tests = 0;
    const out = await ddmin(input, async (c) => (tests++, c.includes(3) && c.includes(7)));
    expect(out.sort()).toEqual([3, 7]);
    expect(tests).toBeLessThan(40);
  });
  test('single cause, and an input that cannot shrink', async () => {
    expect(await ddmin([...'abcdefghij'], async (c) => c.includes('f'))).toEqual(['f']);
    expect(await ddmin([1, 2], async (c) => c.length === 2)).toEqual([1, 2]);
  });
  test('stops early and keeps the best so far', async () => {
    let n = 0;
    const out = await ddmin([...Array(64).keys()], async (c) => c.includes(40), () => ++n > 3);
    expect(out.length).toBeLessThan(64);
    expect(out).toContain(40);
  });
  test('split', () => {
    expect(split([1, 2, 3, 4, 5], 2)).toEqual([[1, 2, 3], [4, 5]]);
    expect(split([1, 2], 4)).toEqual([[1], [2]]);
  });
});

describe('loopCuts', () => {
  test('detours that come back to a state, longest first', () => {
    // S0 -a-> A -b-> B -c-> A -d-> S0 -e-> C
    const cuts = loopCuts('S0', [{ stateId: 'A' }, { stateId: 'B' }, { stateId: 'A' }, { stateId: 'S0' }, { stateId: 'C' }]);
    expect(cuts[0]).toEqual([-1, 3]); // drop steps 0..3
    expect(cuts).toContainEqual([0, 2]); // drop steps 1..2
  });
});

describe('shrinkTrace', () => {
  // The "app" fails when 'menu' is followed (later) by 'left'.
  const fails = (t: Trace) => {
    const ks = t.steps.map((s) => (s.action as { key: string }).key);
    const m = ks.indexOf('menu');
    return m >= 0 && ks.indexOf('left', m) > m;
  };
  test('loop cut + ddmin + gap shrink to a 1-minimal, confirmed trace', async () => {
    const clock = new VirtualClock();
    let calls = 0;
    const t = trace(['up', 'down', 'up', 'down', 'menu', 'ok', 'back', 'down', 'down', 'left', 'right'], ['A', 'S0', 'A', 'S0', 'M', 'P', 'M', 'M1', 'M2', 'M2', 'M2']);
    const r = await shrinkTrace(t, { replay: async (x) => (calls++, (clock.t += 5000), fails(x)), clock });
    expect(r.status).toBe('confirmed');
    expect(r.trace.steps.map((s) => (s.action as { key: string }).key)).toEqual(['menu', 'left']);
    expect(r.trace.steps.every((s) => s.gapMs === 0)).toBe(true);
    expect(r.repro).toEqual({ hits: 5, runs: 5 });
    expect(r.before).toBe(11);
    expect(r.after).toBe(2);
    expect(r.tests).toBe(calls);
  });
  test('tries the explorer shortcut first', async () => {
    const t = { ...trace(['up', 'down', 'up', 'down', 'up', 'down', 'menu', 'left']), shortcuts: [[{ i: 0, action: k('menu'), gapMs: 0 }, { i: 1, action: k('left'), gapMs: 0 }]] as TraceStep[][] };
    const seen: number[] = [];
    const r = await shrinkTrace(t, { replay: async (x) => (seen.push(x.steps.length), fails(x)) });
    expect(seen[0]).toBe(2);
    expect(r.after).toBe(2);
    expect('shortcuts' in r.trace).toBe(false);
  });
  test('not reproduced is labelled, not hidden', async () => {
    const r = await shrinkTrace(trace(['up', 'menu']), { replay: async () => false });
    expect(r.status).toBe('not-reproduced');
    expect(r.after).toBe(2);
  });
  test('flaky findings use more replays per test and are labelled flaky', async () => {
    let i = 0;
    const r = await shrinkTrace(trace(['menu', 'down', 'left']), { replay: async (x) => fails(x) && i++ % 2 === 0 });
    expect(['flaky', 'confirmed']).toContain(r.status);
    expect(r.repro.runs).toBe(5);
  });
  test('respects the budget', async () => {
    const clock = new VirtualClock();
    const r = await shrinkTrace(trace([...Array(40)].map((_, j) => (j === 10 ? 'menu' : j === 30 ? 'left' : 'up'))), { replay: async (x) => ((clock.t += 60_000), fails(x)), clock, budgetMs: 5 * 60_000 });
    expect(r.tests).toBeLessThan(12);
    expect(r.after).toBeLessThanOrEqual(40);
  });
});

describe('replay on the simulated game', () => {
  test('a recorded finding reproduces from its trace file', async () => {
    const sim = new SimGame(['throw']);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-replay-'));
    const s = await explore({ driver: sim.driver as never, clock: sim.clock, package: PKG, minutes: 3, out, minimize: false });
    const f = s.findings.find((x) => x.kind === 'js-exception')!;
    const t = readTrace(f.trace);
    const r = await replayTrace(sim.driver as never, t, 3, { clock: sim.clock });
    expect(r).toMatchObject({ hits: 3, runs: 3 });
    // Without the bug the same keys don't reproduce it.
    const clean = new SimGame([]);
    expect((await replayOnce(clean.driver as never, t, { clock: clean.clock })).hit).toBe(false);
  });
  test('validateTrace rejects junk', () => {
    expect(() => validateTrace({ version: 2 })).toThrow();
    expect(() => validateTrace({ ...trace(['up']), steps: [{ i: 0, action: { kind: 'key', key: 'nope' }, gapMs: 0 }] })).toThrow(/bad action/);
    expect(() => validateTrace({ ...trace(['up']), steps: [{ i: 0, action: k('up'), gapMs: -1 }] })).toThrow(/gapMs/);
  });
});
