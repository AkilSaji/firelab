import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explore } from '../../src/engine/index.js';
import { learnFromRuns, mergePacks, patternKeys, patternWeight, scaledPriors, usablePatterns, validatePack, PRIOR_CAP, type RunInput } from '../../src/engine/knowledge.js';
import { describePack, exportKnowledge, writePack } from '../../src/engine/learn.js';
import { runLearnCli } from '../../src/engine/learn-cli.js';
import { readRunDir } from '../../src/engine/explorer.js';
import { SimGame, PKG } from './sim-app.js';

const steps = (...keys: string[]) => ({ steps: keys.map((k, i) => ({ i, gapMs: 0, action: k.includes('*') ? { kind: 'key' as const, key: k.split('*')[0] as never, repeat: Number(k.split('*')[1]) } : { kind: 'key' as const, key: k as never } })) });
const run = (pkg: string, over: Partial<RunInput> = {}): RunInput => ({
  package: pkg,
  steps: 100,
  findings: [
    { id: 'f-1', kind: 'black-screen', status: 'confirmed', severity: 'critical' },
    { id: 'f-2', kind: 'js-exception', status: 'flaky', severity: 'major' },
    { id: 'f-3', kind: 'plateau', status: 'confirmed', severity: 'info' },
  ],
  traces: new Map([['f-1', steps('menu', 'down', 'down', 'down', 'down', 'up', 'ok', 'ok*3')], ['f-2', steps('left')], ['f-3', steps('up')]]),
  presses: [{ key: 'ok', changed: true }, { key: 'ok', changed: false }, { key: 'rewind', changed: false }, { key: 'ok*3', changed: true }],
  ...over,
});

describe('knowledge packs', () => {
  test('learn: confirmed findings become patterns (last 6 keys), presses become key priors; no package names', () => {
    const p = learnFromRuns([run('com.example.game')]);
    expect(p.patterns).toHaveLength(1);
    expect(p.patterns[0]).toMatchObject({ kind: 'black-screen', keys: ['down', 'down', 'down', 'up', 'ok', 'ok*3'], confirmed: 1, games: 1, rejected: 0 });
    expect(p.keyPriors).toEqual({ ok: { n: 2, changed: 1 }, rewind: { n: 1, changed: 0 } });
    expect(p.source).toEqual({ runs: 1, games: 1, steps: 100 });
    expect(JSON.stringify(p)).not.toContain('example');
    expect(patternKeys(steps('a', 'b'))).toEqual(['a', 'b']);
  });

  test('merge adds up across developers; games count once; rejections lower the weight', () => {
    const a = learnFromRuns([run('game-a')]);
    const b = learnFromRuns([run('game-b')]);
    const again = learnFromRuns([run('game-a')]);
    const m = mergePacks([a, b, again]);
    expect(m.source.games).toBe(2);
    expect(m.patterns[0]).toMatchObject({ confirmed: 3, games: 3 });
    expect(m.keyPriors.ok).toEqual({ n: 6, changed: 3 });
    const rej = learnFromRuns([run('game-c')], new Set(['f-1']));
    expect(rej.patterns[0]).toMatchObject({ confirmed: 0, rejected: 1 });
    expect(patternWeight(mergePacks([a, rej]).patterns[0]!)).toBeLessThan(patternWeight(a.patterns[0]!));
    expect(patternWeight({ confirmed: 0, games: 0, rejected: 3 })).toBe(0);
  });

  test('validate refuses junk and keeps only known keys; priors scale to a few presses', () => {
    expect(() => validatePack({ kind: 'nope' })).toThrow(/not a FireLab knowledge pack/);
    const v = validatePack({ kind: 'firelab-knowledge', version: 1, keyPriors: { ok: { n: 100, changed: 80 }, evil: { n: 1, changed: 1 }, back: { n: 1, changed: 5 } }, patterns: [{ kind: 'black-screen', keys: ['ok*3'], confirmed: 2, games: 1, rejected: 0 }, { kind: 'x', keys: ['rm -rf'] }, { kind: 'focus-trap', keys: Array(9).fill('ok') }], gameHashes: ['abcdef012345', '../../etc'] });
    expect(Object.keys(v.keyPriors)).toEqual(['ok']);
    expect(v.patterns.map((p) => p.keys)).toEqual([['ok*3']]);
    expect(v.gameHashes).toEqual(['abcdef012345']);
    expect(scaledPriors(v).get('ok')).toEqual({ n: PRIOR_CAP, changed: 3.2 });
    expect(usablePatterns(v, ['up', 'down'])).toEqual([]);
    expect(usablePatterns(v, ['ok']).map((x) => x.pattern.keys)).toEqual([['ok*3']]);
  });
});

describe('the engine learns from other runs', () => {
  test('export from a real run, then a new run tries the patterns first on new screens and credits what they find', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-learn-'));
    try {
      // 1. A developer explores a game with bugs, and exports what was learned.
      const a = new SimGame(['throw', 'black', 'trap']);
      const r1 = await explore({ driver: a.driver as never, clock: a.clock, package: PKG, minutes: 10, minimizeMinutes: 3, out: path.join(tmp, 'r1'), knowledge: false });
      const pack = exportKnowledge([r1.dir]);
      expect(pack.source.runs).toBe(1);
      expect(pack.patterns.length).toBeGreaterThan(0);
      expect(describePack(pack)).toMatch(/Not shared: URLs/);
      const file = writePack(pack, path.join(tmp, 'k', 'pack.json'));
      // 2. Another run, on a fresh copy of the game, loads the pack.
      const b = new SimGame(['throw', 'black', 'trap']);
      await explore({ driver: b.driver as never, clock: b.clock, package: PKG, minutes: 4, minimize: false, out: path.join(tmp, 'r2'), knowledge: [file] });
      const r2 = readRunDir(path.join(tmp, 'r2'));
      expect(r2.config.knowledge?.patterns.length).toBe(pack.patterns.filter((p) => patternWeight(p) > 0).length);
      expect(r2.knowledge?.tried).toBeGreaterThan(0);
      expect(r2.knowledge?.hits.length).toBeGreaterThan(0);
      expect(r2.notes.join('\n')).toMatch(/shared knowledge: \d+ bug patterns from 1 pack/);
      // 3. Strategies other than explore, and --no-knowledge, never load it.
      const c = new SimGame([]);
      await explore({ driver: c.driver as never, clock: c.clock, package: PKG, steps: 20, minimize: false, strategy: 'random', out: path.join(tmp, 'r3'), knowledge: [file] });
      expect(readRunDir(path.join(tmp, 'r3')).config.knowledge).toBeUndefined();
      // 4. The CLI: export and show.
      const out: string[] = [];
      const io = { out: (s: string) => out.push(s), err: () => {} };
      expect(await runLearnCli(['export', r1.dir, '--out', path.join(tmp, 'cli.json')], io)).toBe(0);
      expect(fs.existsSync(path.join(tmp, 'cli.json'))).toBe(true);
      expect(await runLearnCli(['show', '--knowledge', path.join(tmp, 'k')], io)).toBe(0);
      expect(out.join('\n')).toMatch(/pattern [0-9a-f]{12}: .* -> /);
      expect(await runLearnCli(['nope'], io)).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
