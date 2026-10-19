import { describe, expect, test } from 'vitest';
import { Archive, cellWeight, DEPTH_HORIZON } from '../../src/engine/archive.js';
import { coveredBlocks, JsCoverage } from '../../src/engine/coverage.js';
import { FakeDriver } from '../../src/driver/fake.js';
import { BROWSER_KEYS, keyScript } from '../../src/driver/browser.js';
import { benchHeadline, benchStats } from '../../src/bench/report.js';
import { SUBJECTS, customSubject } from '../../src/bench/subjects.js';
import type { BenchResult, BenchRun } from '../../src/bench/run.js';
import type { Action, State } from '../../src/engine/types.js';

const st = (id: string, depthPath: number): [State, Action[]] => [{ id, level: 2, key: { pkg: 'p', scene: id }, firstSeenStep: 0 }, Array.from({ length: depthPath }, () => ({ kind: 'key', key: 'ok' }) as Action)];

describe('deep exploration', () => {
  test('cellWeight: depth keeps counting past 20 (log scale to 100) and untried keys pull', () => {
    const base = { chosen: 0, discovered: 0, suspicion: 0, failedReturns: 0 };
    const w = (depth: number, frontier = 0, deep = true) => cellWeight({ ...base, depth }, 0, frontier, deep);
    expect(w(60)).toBeGreaterThan(w(20));
    expect(w(DEPTH_HORIZON)).toBeCloseTo(w(500));
    expect(w(60, 0, false)).toBeCloseTo(w(20, 0, false)); // the MVP term stops at 20
    expect(w(5, 1)).toBeGreaterThan(w(5, 0));
  });

  test('Archive.depthStats: deepest cell, mean and histogram', () => {
    const a = new Archive();
    for (const [s, p] of [st('a', 0), st('b', 4), st('c', 30), st('d', 120)]) a.observe(s, p);
    expect(a.depthStats()).toEqual({ max: 120, maxCell: 'd', mean: 38.5, histogram: { '0-5': 2, '26-50': 1, '100+': 1 } });
  });

  test('coveredBlocks counts covered ranges of matching scripts only', () => {
    const r = coveredBlocks(
      [
        { scriptId: '1', url: 'http://x/game.js', functions: [{ functionName: 'f', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 10, endOffset: 20, count: 0 }, { startOffset: 30, endOffset: 40, count: 2 }] }, { functionName: 'g', isBlockCoverage: true, ranges: [{ startOffset: 200, endOffset: 300, count: 0 }] }] },
        { scriptId: '2', url: 'https://cdn/three.js', functions: [{ functionName: 'h', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 9, count: 5 }] }] },
        { scriptId: '3', url: '', functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 9, count: 5 }] }] },
      ],
      (u) => u.includes('game.js'),
    );
    expect([...r.blocks].sort()).toEqual(['http://x/game.js#0-100', 'http://x/game.js#30-40']);
    expect([...r.functions]).toEqual(['http://x/game.js#0']);
  });

  test('JsCoverage adds up across samples and turns itself off when DevTools refuses', async () => {
    const d = new FakeDriver();
    let n = 0;
    d.on('cdp', async (method: string) => {
      if (method !== 'Profiler.takePreciseCoverage') return {};
      n++;
      return { result: [{ scriptId: '1', url: 'http://x/a.js', functions: [{ functionName: 'f', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10 * n, count: 1 }] }] }] };
    });
    const c = new JsCoverage(d);
    await c.start();
    expect(await c.sample()).toBe(1);
    expect(await c.sample()).toBe(1);
    expect(c.summary()).toMatchObject({ blocks: 2, functions: 1, scripts: [{ url: 'http://x/a.js', blocks: 2 }] });
    const bad = new FakeDriver();
    bad.on('cdp', async () => {
      throw new Error('Profiler not found');
    });
    const off = new JsCoverage(bad);
    await off.start();
    expect(off.off).toMatch(/Profiler not found/);
    expect(await off.sample()).toBe(0);
  });
});

describe('browser driver keys', () => {
  test('keys match the TV wrapper (Back = Escape, OK = Enter) and report preventDefault', () => {
    expect(BROWSER_KEYS.back).toEqual(['Escape', 'Escape', 27]);
    expect(BROWSER_KEYS.ok).toEqual(['Enter', 'Enter', 13]);
    const js = keyScript('keydown', BROWSER_KEYS.left!);
    expect(js).toContain("new KeyboardEvent('keydown',{key:'ArrowLeft'");
    expect(js).toContain('return !t.dispatchEvent(e)');
  });
});

describe('benchmark statistics', () => {
  const run = (strategy: BenchRun['strategy'], rep: number, blocks: number, triggered: Record<string, number>, detected: Record<string, number> = {}): BenchRun => ({
    subject: 'deep-quest', strategy, rep, seed: rep + 1, minutes: 10, steps: 100, states: 10, maxDepth: blocks / 10, jsBlocks: blocks, progress: blocks / 20, triggered, detected, findings: [], curve: [[0, 0, 1], [300, blocks, 10]], dir: '/tmp/x',
  });
  const b: BenchResult = {
    kind: 'firelab-bench', id: 'b1', title: 't', createdAt: '2026-10-18T00:00:00Z', firelabVersion: '0', machine: { platform: 'x', node: 'v' },
    subjects: ['deep-quest'],
    subjectInfo: { 'deep-quest': { id: 'deep-quest', name: 'Deep Quest', bugs: SUBJECTS['deep-quest']!.bugs.map(({ id, what, depth }) => ({ id, what, depth })) } },
    strategies: ['firelab', 'random'], runsPer: 5, minutes: 10,
    runs: [
      ...[0, 1, 2, 3, 4].map((r) => run('firelab', r, 100 + r, { options: 10, chest: 200 }, { options: 12 })),
      ...[0, 1, 2, 3, 4].map((r) => run('random', r, 40 + r, r < 2 ? { options: 50 } : {})),
    ],
  };

  test('medians, A12 and Fisher per bug', () => {
    const [s] = benchStats(b);
    const cov = s!.comparisons.find((c) => c.metric === 'jsBlocks')!;
    expect(cov).toMatchObject({ a: 'firelab', b: 'random', medA: 102, medB: 42, a12: 1, magnitude: 'large' });
    expect(cov.p).toBeLessThan(0.05);
    const chest = s!.bugs.find((x) => x.id === 'chest')!;
    expect(chest.byStrategy.firelab).toMatchObject({ triggered: 5, runs: 5, medianS: 200 });
    expect(chest.byStrategy.random).toMatchObject({ triggered: 0, runs: 5 });
    expect(chest.fisher.random).toBeLessThan(0.01);
    expect(s!.bugs.find((x) => x.id === 'options')!.byStrategy.firelab!.detected).toBe(5);
    expect(benchHeadline(b)).toBe('Distinct seeded bugs triggered (of 6) in 5 × 10 min runs: FireLab 2, Random 1');
  });

  test('subject bug matchers and custom subjects', () => {
    const dq = SUBJECTS['deep-quest']!;
    const boss = dq.bugs.find((x) => x.id === 'boss')!;
    expect(boss.matches({ kind: 'js-exception', title: "Uncaught: TypeError: Cannot read properties of undefined (reading 'shield')", detail: '' })).toBe(true);
    expect(boss.matches({ kind: 'focus-trap', title: 'x', detail: '' })).toBe(false);
    expect(customSubject('mygame=https://game.example/')).toMatchObject({ id: 'mygame', url: 'https://game.example/', bugs: [] });
    expect(() => customSubject('nope')).toThrow(/name=http/);
  });
});

describe('leaving the app with Back', () => {
  test('Back from the root screen (even with other app state) or n Backs from n deep is expected; deeper is minor', async () => {
    const { createHealthOracle } = await import('../../src/engine/oracles/health.js');
    const { buildConfig } = await import('../../src/engine/config.js');
    const cfg = buildConfig({ app: { package: 'p' } }, 'r');
    const o = createHealthOracle(cfg);
    const cell = (id: string, scene: string, depth: number, app?: string) => [id, { id, level: 3, key: { pkg: 'p', scene, ...(app ? { app } : {}) }, firstSeenStep: 0, visits: 1, chosen: 0, discovered: 0, failedReturns: 0, depth, path: [], suspicion: 0, actionStats: {} }] as const;
    const cells = new Map([cell('t0', 'title', 0), cell('t9', 'title', 9, '{"bag":"key"}'), cell('m3', 'menu', 3), cell('d8', 'dialog', 8)]);
    const drafts: { kind: string; severity: string }[] = [];
    const ctx = { driver: {} as never, config: cfg, graph: { cells, transitions: new Map() }, history: [], emit: (f: { kind: string; severity: string }) => void drafts.push(f), note: () => {}, isExitEdge: () => false } as never;
    const base = { ts: 0, step: 1, logs: [], console: [], settleMs: 0 };
    const leave = async (from: string, key: string, repeat?: number) => {
      drafts.length = 0;
      const prev = { ...base, foreground: 'p', stateId: from, probe: { raf: 1, errors: 0 } };
      const obs = { ...base, step: 2, foreground: 'launcher', action: { kind: 'key', key, ...(repeat ? { repeat } : {}) } };
      await o.check(ctx, obs as never, prev as never, { id: 'EXIT' } as never);
      return drafts.find((d) => d.kind === 'unexpected-exit')?.severity ?? 'none';
    };
    expect(await leave('t9', 'back')).toBe('none');
    expect(await leave('m3', 'back', 3)).toBe('none');
    expect(await leave('d8', 'back', 3)).toBe('minor');
    expect(await leave('m3', 'ok')).toBe('major');
  });
});
