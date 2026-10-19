import { describe, expect, test } from 'vitest';
import { createScreenOracle } from '../../src/engine/oracles/screen.js';
import { buildConfig } from '../../src/engine/config.js';
import type { FindingDraft, Observation, OracleContext, State } from '../../src/engine/types.js';

const PKG = 'dev.test.app';
const cfg = buildConfig({ app: { package: PKG }, steps: 1, outDir: '/tmp/x' }, 'r');
const state: State = { id: 'S', level: 4, key: { pkg: PKG }, firstSeenStep: 0 };
const frame = (v: number) => {
  const a = new Uint8Array(64 * 36 * 4);
  for (let i = 0; i < a.length; i += 4) a.set([v, v, v, 255], i);
  return { hash: '0000000000000000', luma: { mean: v, std: 30 }, thumb64: a };
};
function run(seq: { key: string; v: number }[]): FindingDraft[] {
  const out: FindingDraft[] = [];
  const ctx = { history: [], emit: (f: FindingDraft) => void out.push(f) } as unknown as OracleContext;
  const o = createScreenOracle(cfg);
  let prev: Observation | undefined;
  seq.forEach((s, i) => {
    // No probe: the app can't be inspected, as with release builds and WebViews without debugging.
    const obs: Observation = { ts: i * 2500, step: i, foreground: PKG, logs: [], console: [], settleMs: 0, frame: frame(s.v), action: { kind: 'key', key: s.key as never }, stateId: 'S' };
    o.check(ctx, obs, prev, state);
    prev = obs;
  });
  return out;
}

describe('screen oracle without a probe (picture only)', () => {
  test('an animation that stops (a dialog pausing the background) is not a freeze', () => {
    const seq = [...[10, 20, 30, 40, 50].map((v) => ({ key: 'playpause', v })), ...Array(6).fill({ key: 'playpause', v: 50 })];
    expect(run(seq)).toEqual([]);
  });
  test('navigation keys that reliably moved the picture and then stop are a freeze', () => {
    const moving = [10, 30, 50, 70, 90, 110, 130, 150].map((v, i) => ({ key: i % 2 ? 'left' : 'right', v }));
    const stuck = Array(5).fill(0).map((_, i) => ({ key: i % 2 ? 'left' : 'right', v: 150 }));
    expect(run([...moving, ...stuck]).map((f) => f.kind)).toContain('frozen-screen');
  });
});
