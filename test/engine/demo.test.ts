import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDemo, explore, DemoGame, DEMO_PACKAGE } from '../../src/engine/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-demo-'));

describe('firelab demo (Lantern Lake)', () => {
  test('finds every seeded bug, shrinks them, and writes a report with a baseline', async () => {
    const out = tmp();
    const r = await runDemo({ out, minutes: 15 });
    const kinds = new Set(r.summary.findings.map((f) => f.kind));
    for (const k of ['crash', 'js-exception', 'black-screen', 'render-loop-stopped', 'focus-trap', 'unreachable-control']) expect(kinds, k).toContain(k);
    for (const k of ['crash', 'js-exception', 'black-screen', 'render-loop-stopped', 'focus-trap', 'unreachable-control']) expect(r.summary.findings.some((f) => f.kind === k && f.status === 'confirmed'), k).toBe(true);
    // A second symptom of a bug (a frozen menu after the render loop stopped) may not replay: it is reported as
    // not-reproduced and fails no gate; everything else must be confirmed.
    for (const f of r.summary.findings.filter((x) => x.severity !== 'info' && x.status !== 'not-reproduced')) {
      expect(f.status, f.kind).toBe('confirmed');
      // The freeze needs 4 Right presses spread over one play session: with a 4 minute shrink budget (about 7 replays
      // of a long trace) ddmin may not get it down to a few keys; it is still confirmed.
      if (f.kind !== 'render-loop-stopped') expect(f.keys.length, f.kind).toBeLessThanOrEqual(6);
    }
    expect(fs.existsSync(path.join(out, 'random', 'run.json'))).toBe(true);
    const html = fs.readFileSync(r.summary.report.html, 'utf8');
    expect(html).toContain('random baseline');
    expect(html).toContain('Focus trap');
    expect(r.summary.exitCode).toBe(1); // crash, black, frozen and focus-trap fail the demo run, as they would in CI
  }, 60_000);

  test('draws real screens (title, menu, lake), not noise', () => {
    const g = new DemoGame();
    const lumaOf = (f: { data: Uint8Array }) => {
      let s = 0;
      for (let i = 0; i < f.data.length; i += 4) s += f.data[i]! + f.data[i + 1]! + f.data[i + 2]!;
      return s / (f.data.length / 4) / 3;
    };
    const title = g.frame();
    g.key('menu');
    const menu = g.frame();
    expect(title.width).toBe(320);
    expect(lumaOf(title)).toBeGreaterThan(30);
    expect(Buffer.compare(Buffer.from(title.data), Buffer.from(menu.data))).not.toBe(0);
  });

  test('--driver demo needs no package and no device', async () => {
    const r = await explore({ driverKind: 'demo', minutes: 2, minimize: false, out: tmp() });
    expect(r.app.package).toBe(DEMO_PACKAGE);
    expect(r.steps).toBeGreaterThan(20);
  });
});
