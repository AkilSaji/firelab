import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explore, Explorer, buildConfig, failMatcher, readRunDir, report, type ExploreEvent } from '../../src/engine/index.js';
import { SimGame, PKG, type SimBug } from './sim-app.js';

const ALL: SimBug[] = ['throw', 'trap', 'black', 'freeze', 'hidden', 'crash'];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-engine-'));

async function run(bugs: SimBug[], o: Partial<Parameters<typeof explore>[0]> = {}, simOpts: ConstructorParameters<typeof SimGame>[1] = {}) {
  const sim = new SimGame(bugs, simOpts);
  const out = tmp();
  const r = await explore({ driver: sim.driver as never, clock: sim.clock, package: PKG, minutes: 10, out, minimizeMinutes: 3, ...o });
  return { sim, out, r };
}

describe('explorer on the simulated game', () => {
  test('finds every seeded bug in 15 device minutes and shrinks them', async () => {
    const { r, out } = await run(ALL, { minutes: 15 });
    const kinds = new Set(r.findings.map((f) => f.kind));
    for (const k of ['js-exception', 'focus-trap', 'unreachable-control', 'crash', 'black-screen', 'render-loop-stopped']) expect(kinds, k).toContain(k);
    const byKind = (k: string) => r.findings.find((f) => f.kind === k)!;
    for (const k of ['js-exception', 'focus-trap', 'unreachable-control', 'crash', 'black-screen']) {
      const f = byKind(k);
      expect(f.status, k).toBe('confirmed');
      expect(f.traceLength, k).toBeLessThanOrEqual(6);
      expect(fs.existsSync(f.trace)).toBe(true);
    }
    expect(byKind('crash').keys.at(-1)).toBe('ok');
    expect(byKind('js-exception').keys.at(-1)).toBe('left');
    expect(byKind('black-screen').keys.some((k) => /^ok\*\d/.test(k))).toBe(true); // only a fast double OK reaches it
    expect(r.exitCode).toBe(1);
    expect(fs.existsSync(path.join(out, 'report.html'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'report.md'))).toBe(true);
    expect(fs.readFileSync(path.join(out, 'timeline.jsonl'), 'utf8').trim().split('\n').length).toBeGreaterThan(100);
  }, 60_000);

  test('the random baseline misses what needs a focus walk or a fast macro', async () => {
    const { r } = await run(ALL, { strategy: 'random', minimize: false });
    const kinds = new Set(r.findings.map((f) => f.kind));
    expect(kinds.has('focus-trap')).toBe(false);
    expect(kinds.has('unreachable-control')).toBe(false);
    expect(kinds.has('black-screen')).toBe(false);
    expect(r.strategy).toBe('random');
  });

  test('a clean game passes, and leaving it from the title is not a bug', async () => {
    const { r, sim } = await run([], { minutes: 4 });
    expect(r.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.states).toBeGreaterThanOrEqual(8); // title, 3 lanes, 5 menu items
    expect(sim.launches).toBeGreaterThan(1); // back at the title exits; the explorer relaunched
  });

  test('is deterministic for a seed', async () => {
    const a = await run([], { steps: 150, minimize: false, seed: 7 });
    const b = await run([], { steps: 150, minimize: false, seed: 7 });
    const keys = (dir: string) => fs.readFileSync(path.join(dir, 'timeline.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).action);
    expect(keys(a.out)).toEqual(keys(b.out));
    expect(a.r.steps).toBe(150);
  });

  test('stops on abort and reports it', async () => {
    const ac = new AbortController();
    let steps = 0;
    const { r } = await run([], { minutes: 60, signal: ac.signal, onEvent: (e: ExploreEvent) => e.type === 'step' && ++steps === 40 && ac.abort() });
    expect(r.stopped).toBe('aborted');
    expect(r.steps).toBeLessThan(50);
  });

  test('refuses the protected Sunset Villa package', async () => {
    const sim = new SimGame();
    await expect(explore({ driver: sim.driver as never, clock: sim.clock, package: 'com.sunsetvilla.tv', steps: 5, out: tmp() })).rejects.toThrow(/real progress/);
    expect(sim.driver.callsTo('press')).toHaveLength(0);
  });

  test('without JS evaluation it falls back to visual states and says so', async () => {
    const { r } = await run(['crash'], { minutes: 3, minimize: false }, { evalCap: false });
    expect(r.notes.join('\n')).toMatch(/screen only/);
    expect(r.states).toBeGreaterThan(1);
  });

  test('chooseAction tries every key once before repeating', async () => {
    const sim = new SimGame();
    const cfg = buildConfig({ app: { package: PKG }, steps: 1, outDir: tmp() }, 'x');
    const x = new Explorer({ driver: sim.driver as never, config: cfg, clock: sim.clock });
    const cell = { id: 's', level: 2 as const, key: { pkg: PKG }, firstSeenStep: 0, visits: 1, chosen: 0, discovered: 0, failedReturns: 0, depth: 0, path: [], suspicion: 0, actionStats: {} as Record<string, { n: number; reward: number }> };
    const seen = new Set<string>();
    for (let i = 0; i < cfg.keys.length; i++) {
      const a = x.chooseAction(cell);
      if (a.kind !== 'key') throw new Error('not a key');
      expect(seen.has(a.key)).toBe(false);
      seen.add(a.key);
      cell.actionStats[a.key] = { n: 1, reward: 0 };
    }
    expect(seen.size).toBe(cfg.keys.length);
  });

  test('report regenerates from the run directory', async () => {
    const { out } = await run(['throw'], { minutes: 3 });
    const run0 = readRunDir(out);
    expect(run0.findings.some((f) => f.kind === 'js-exception')).toBe(true);
    const { html, md } = report(out);
    const h = fs.readFileSync(html, 'utf8');
    expect(h).toContain('Uncaught: Cannot read properties');
    expect(h).toContain('firelab replay');
    expect(h).not.toMatch(/<(img|script)[^>]+src="https?:/); // self-contained
    expect(fs.readFileSync(md, 'utf8')).toMatch(/\| major \| Uncaught/);
  });
});

describe('fail-on', () => {
  const m = (w: string[]) => failMatcher(w);
  test('categories, severities and kinds', () => {
    expect(m(['crash'])({ kind: 'anr', severity: 'critical' })).toBe(true);
    expect(m(['crash', 'black'])({ kind: 'js-exception', severity: 'major' })).toBe(false);
    expect(m(['frozen'])({ kind: 'render-loop-stopped', severity: 'critical' })).toBe(true);
    expect(m(['focus-trap'])({ kind: 'focus-trap', severity: 'critical' })).toBe(true);
    expect(m(['major'])({ kind: 'whatever', severity: 'major' })).toBe(true);
    expect(m(['non-spatial-move'])({ kind: 'non-spatial-move', severity: 'major' })).toBe(true);
    expect(m(['none'])({ kind: 'crash', severity: 'critical' })).toBe(false);
  });
  test('only failing findings set the exit code', async () => {
    const { r } = await run(['throw'], { minutes: 3, minimize: false, failOn: ['crash', 'black', 'frozen', 'focus-trap'] });
    expect(r.findings.some((f) => f.kind === 'js-exception')).toBe(true);
    expect(r.exitCode).toBe(0);
  });
});
