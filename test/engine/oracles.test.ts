import { describe, expect, test } from 'vitest';
import { healthSignals, parseCrash, RENDERER_GONE_PATTERNS } from '../../src/engine/oracles/health.js';
import { createScreenOracle, isBlack } from '../../src/engine/oracles/screen.js';
import { spatialProblems, stronglyConnected, focusPath, inHalfPlane, navDistance, type FocusGraph } from '../../src/engine/oracles/focus.js';
import { StuckDetector } from '../../src/engine/oracles/stuck.js';
import { normalizeText } from '../../src/engine/oracles/common.js';
import { Graph } from '../../src/engine/graph.js';
import { buildConfig } from '../../src/engine/config.js';
import type { Cell, FindingDraft, Observation, OracleContext, State } from '../../src/engine/types.js';
import type { LogLine } from '../../src/engine/driver.js';

const PKG = 'dev.test.app';
const obs = (o: Partial<Observation>): Observation => ({ ts: 0, step: 0, foreground: PKG, logs: [], console: [], settleMs: 0, ...o });
const state: State = { id: 's1', level: 2, key: { pkg: PKG }, firstSeenStep: 0 };
const log = (text: string, pid = 42): LogLine => ({ ts: 1, level: 'error', pid, text });

describe('health oracle', () => {
  test('a FATAL EXCEPTION of our pid is a crash signed by class and top frame', () => {
    const lines = [log('FATAL EXCEPTION: main'), log(`Process: ${PKG}, PID: 42`), log('java.lang.NullPointerException: boom'), log('\tat com.x.Game.tick(Game.java:10)'), log('FATAL EXCEPTION: other', 7)];
    expect(parseCrash(lines, 0)).toMatchObject({ cls: 'java.lang.NullPointerException', frame: 'com.x.Game.tick' });
    const f = healthSignals(obs({ logs: lines, pid: 42 }), undefined, { pkg: PKG });
    expect(f.map((x) => x.signature)).toEqual(['crash:java.lang.NullPointerException@com.x.Game.tick']);
  });
  test("another app's crash is ignored", () => {
    expect(healthSignals(obs({ logs: [log('FATAL EXCEPTION: main', 7), log('Process: com.other, PID: 7', 7)], pid: 42 }), undefined, { pkg: PKG })).toEqual([]);
  });
  test('ANR and renderer death', () => {
    const f = healthSignals(obs({ logs: [log(`ANR in ${PKG}`), log('onRenderProcessGone: renderer crashed')], pid: 42 }), undefined, { pkg: PKG });
    expect(f.map((x) => x.kind).sort()).toEqual(['anr', 'webview-renderer-gone']);
    expect(RENDERER_GONE_PATTERNS.some((r) => r.test('Render process crashed'))).toBe(true);
  });
  test('JS errors from the probe counter get a number-free signature', () => {
    const prev = obs({ probe: { raf: 1, errors: 0 } });
    const a = healthSignals(obs({ probe: { raf: 2, errors: 1, lastError: "Cannot read properties of undefined (reading 'x')@game.js:301" } }), prev, { pkg: PKG });
    expect(a[0]).toMatchObject({ kind: 'js-exception', severity: 'major', signature: "js-error:Cannot read properties of undefined (reading '…')@game.js:301" });
    expect(normalizeText('Uncaught Error 42 at 0xdeadbeef')).toBe('Error # at <hex>');
  });
  test('leaving the app: home is expected, back depends on depth, others are major', () => {
    const prev = obs({ stateId: 'deep' });
    const left = (key: string, verdict?: 'expected' | 'minor' | 'major') => healthSignals(obs({ foreground: 'com.launcher', action: { kind: 'key', key: key as never } }), prev, { pkg: PKG, expectedExit: () => verdict ?? 'major' });
    expect(left('home')).toEqual([]);
    expect(left('back', 'expected')).toEqual([]);
    expect(left('ok')[0]).toMatchObject({ kind: 'unexpected-exit', severity: 'major' });
  });
  test('a pid change without a relaunch is a restart', () => {
    expect(healthSignals(obs({ pid: 2 }), obs({ pid: 1 }), { pkg: PKG })[0]?.kind).toBe('process-restarted');
    expect(healthSignals(obs({ pid: 2, relaunched: true }), obs({ pid: 1 }), { pkg: PKG })).toEqual([]);
  });
});

function ctxFor(emitted: FindingDraft[]): OracleContext {
  const cfg = buildConfig({ app: { package: PKG }, steps: 1, outDir: '/tmp/x' }, 'r');
  return { driver: {} as never, config: cfg, graph: { cells: new Map(), transitions: new Map() }, history: [], emit: (f) => void emitted.push(f), note: () => {}, isExitEdge: () => false };
}
const solid = (v: number, n = 64 * 36) => {
  const a = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) a.set([v, v, v, 255], i * 4);
  return a;
};
const frame = (v: number, std = 0) => ({ hash: '0000000000000000', luma: { mean: v, std }, thumb64: solid(v) });

describe('screen oracle', () => {
  test('black needs two settled steps and 1.5 s, and is reported once', () => {
    const out: FindingDraft[] = [];
    const o = createScreenOracle(buildConfig({ app: { package: PKG }, steps: 1, outDir: '/tmp/x' }, 'r'));
    const ctx = ctxFor(out);
    const seq = [0, 800, 1600, 2400, 3200].map((ts, i) => obs({ ts, step: i, frame: frame(2), action: { kind: 'key', key: 'ok' }, probe: { raf: i, errors: 0, scene: 'game' } }));
    let prev: Observation | undefined;
    for (const x of seq) {
      o.check(ctx, x, prev, state);
      prev = x;
    }
    expect(out.map((f) => f.signature)).toEqual(['black-screen@game']);
    expect(out[0]?.step).toBe(2);
    expect(isBlack(obs({ frame: frame(40, 20) }))).toBe(false);
  });
  test('render loop stopped while the app says it renders', () => {
    const out: FindingDraft[] = [];
    const o = createScreenOracle(buildConfig({ app: { package: PKG }, steps: 1, outDir: '/tmp/x' }, 'r'));
    const ctx = ctxFor(out);
    let prev: Observation | undefined;
    for (const [i, ts] of [0, 1000, 2000, 3000].entries()) {
      const x = obs({ ts, step: i, frame: frame(100, 30), action: { kind: 'key', key: 'right' }, probe: { raf: i === 0 ? 10 : 50, errors: 0, paused: false, targetFps: 30, scene: 'playing' } });
      o.check(ctx, x, prev, state);
      prev = x;
    }
    expect(out.map((f) => f.kind)).toEqual(['render-loop-stopped']);
    // ...but not when the app says it is paused (a menu).
    expect(o.matches('render-loop-stopped@playing', obs({ ts: 5000, frame: frame(100, 30), probe: { raf: 50, errors: 0, paused: true, targetFps: 30, scene: 'playing' } }), prev)).toBe(false);
  });
});

describe('focus geometry', () => {
  // A 2-column grid: a b / c d.
  const R = { a: [0, 0, 100, 50], b: [200, 0, 100, 50], c: [0, 100, 100, 50], d: [200, 100, 100, 50] } as Record<string, [number, number, number, number]>;
  const F = Object.entries(R).map(([id, rect]) => ({ id, rect }));
  const rects = new Map(Object.entries(R));
  test('half-planes and distances', () => {
    expect(inHalfPlane(R.a!, R.c!, 'down')).toBe(true);
    expect(inHalfPlane(R.a!, R.b!, 'down')).toBe(false);
    expect(navDistance(R.a!, R.c!, 'down')).toBe(50);
    expect(navDistance(R.a!, R.d!, 'down')).toBeGreaterThan(navDistance(R.a!, R.c!, 'down'));
  });
  test('list-order navigation on a grid is non-spatial (Sunset Villa grid bug)', () => {
    const G: FocusGraph = new Map([
      ['a', new Map([['down', 'b'], ['right', 'b']])],
      ['b', new Map([['down', 'c'], ['left', 'a']])],
    ]) as FocusGraph;
    const p = spatialProblems(G, rects, F);
    expect(p).toContainEqual(expect.objectContaining({ from: 'a', dir: 'down', got: 'b', expected: 'c', why: 'wrong-direction' }));
    expect(p.find((x) => x.from === 'a' && x.dir === 'right')).toBeUndefined();
  });
  test('wrap-around at the end of a column is allowed', () => {
    const G: FocusGraph = new Map([['c', new Map([['down', 'a']])]]) as FocusGraph;
    expect(spatialProblems(G, rects, F)).toEqual([]);
  });
  test('strongly connected components and paths', () => {
    const G: FocusGraph = new Map([
      ['a', new Map([['right', 'b']])],
      ['b', new Map([['down', 'd']])],
      ['d', new Map([['left', 'c']])],
      ['c', new Map([['up', 'd']])],
    ]) as FocusGraph;
    const sccs = stronglyConnected(G).map((c) => c.join(''));
    expect(sccs).toContain('cd');
    expect(focusPath(G, 'a', 'c')).toEqual(['right', 'down', 'left']);
    expect(focusPath(G, 'c', 'a')).toBeUndefined();
  });
});

describe('stuck detector', () => {
  test('dead end when every key self-loops, after two tries each', () => {
    const keys = ['up', 'down', 'back'] as const;
    const st = new StuckDetector([...keys], 5);
    const g = new Graph();
    const cell = { id: 'X' } as Cell;
    for (const k of keys) g.record('X', k, 'X');
    expect(st.isDeadEnd(cell, g)).toBe(false);
    for (const k of keys) g.record('X', k, 'X');
    expect(st.isDeadEnd(cell, g)).toBe(true);
    g.record('X', 'back', 'Y');
    expect(st.isDeadEnd(cell, g)).toBe(false);
  });
  test('plateau fires once, then gives the next region its own window', () => {
    const st = new StuckDetector(['up'], 5);
    const o = obs({});
    expect(st.plateau(3, o, { id: 'X' } as Cell).stuck).toBe(false);
    const a = st.plateau(6, o, { id: 'X' } as Cell);
    expect(a.stuck && a.finding?.kind).toBe('plateau');
    expect(st.plateau(8, o, { id: 'X' } as Cell).stuck).toBe(false);
    expect(st.plateau(12, o, { id: 'X' } as Cell).finding).toBeUndefined();
  });
});

describe('health oracle: hand-offs', () => {
  test('OK that opens another app is a note, not an exit; OK back to the home screen is still an exit', () => {
    const prev = obs({ stateId: 'hub', probe: { raf: 1, errors: 0 } });
    const press = (fg: string) => healthSignals(obs({ foreground: fg, action: { kind: 'key', key: 'ok' } }), prev, { pkg: PKG, expectedExit: () => 'major' });
    expect(press('com.example.game').map((f) => [f.kind, f.severity])).toEqual([['opened-app', 'info']]);
    expect(press('com.amazon.tv.launcher').map((f) => f.kind)).toEqual(['unexpected-exit']);
  });
});
