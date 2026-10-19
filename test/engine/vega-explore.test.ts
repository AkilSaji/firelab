import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerDriver, type CreateDriverOptions } from '../../src/driver/index.js';
import { minimalCaps } from '../../src/driver/types.js';
import { explore, readRunDir } from '../../src/engine/index.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { main } from '../../src/cli.js';
import { fakeLab } from '../helpers/fake-lab.js';
import { SimGame, PKG } from './sim-app.js';

/** The caps VdaDriver (src/vega/driver.ts) reports: no eval, console, cdp or reset. */
const VEGA_CAPS = { ...minimalCaps(), holds: true, text: true, rgbaThumb: true, install: true, memory: true };

/** SimGame on a FakeDriver that behaves like the Vega driver: foreground() is the last launched app while it runs. */
function vegaSim() {
  const sim = new SimGame([], { driver: { kind: 'vda', caps: VEGA_CAPS } });
  const d = sim.driver;
  // A crash any screen-only explorer reaches: OK while playing ends the process (no Android FATAL EXCEPTION in the log).
  const key = sim.key.bind(sim);
  sim.key = (k: string) => {
    if (sim.mode !== 'playing' || k !== 'ok') return key(k);
    const pid = d.state.running.get(PKG);
    d.state.logs.push({ ts: sim.clock.now() + 1, level: 'error', tag: PKG, pid, text: 'Unhandled JS Exception: TypeError: undefined is not an object' });
    d.state.running.delete(PKG);
    d.state.foreground = { package: 'com.fake.launcher' };
  };
  d.on('foreground', () => {
    const last = (d.callsTo('launch').at(-1)?.args[0] as { package: string } | undefined)?.package;
    return last && d.state.running.has(last) ? { package: last } : null;
  });
  // After an exit the TV shows the launcher, while foreground() still names the app.
  const launcher = { width: 64, height: 36, data: new Uint8Array(64 * 36 * 4).map((_, i) => (i % 4 === 3 ? 255 : ((i >> 2) % 64 < 32 ? 230 : 10) ^ (Math.floor(i / 1024) * 37))) };
  d.setFrame(() => (d.state.foreground?.package === PKG ? sim.frame() : launcher));
  return sim;
}

describe('explore on a Vega-like driver', () => {
  test('runs on screen-only states, sees a crash as the process ending, and says what it cannot see', async () => {
    const sim = vegaSim();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-vega-'));
    const r = await explore({ driver: sim.driver as never, clock: sim.clock, package: PKG, minutes: 6, out, minimize: false, reset: 'clear-data' });

    expect(r.stopped).toBe('budget');
    expect(r.device.kind).toBe('vda');
    expect(r.states).toBeGreaterThan(1);
    // The engine never calls what Vega lacks (the fake throws 'unsupported' if it did).
    for (const m of ['evaluate', 'onConsole', 'cdp', 'reset'] as const) expect(sim.driver.callsTo(m), m).toHaveLength(0);

    const notes = r.notes.join('\n');
    expect(notes).toMatch(/Vega OS: .*Leaving the app while it keeps running .* isn't detected/);
    expect(notes).toMatch(/not run on a real device/);
    expect(notes).toMatch(/screen only/);
    expect(notes).toMatch(/can't clear app data/);
    expect(notes).toMatch(/focus oracle off/);

    // The process ended, so foreground() goes null: seen as an exit, with a note that it is likely a crash.
    const exit = readRunDir(out).findings.find((f) => f.kind === 'unexpected-exit');
    expect(exit?.title).toMatch(/"ok" left the app/);
    expect(exit?.detail).toMatch(/likely a crash/);
    // Leaving with back at the title keeps the process alive: never seen as an exit.
    expect(r.findings.some((f) => f.kind === 'unexpected-exit' && /"back"/.test(f.title))).toBe(false);
    // A dead end may be the launcher after an unseen exit: reported as minor, and the explorer relaunches.
    for (const f of r.findings.filter((x) => x.kind === 'dead-end')) expect(f.severity).toBe('minor');
    for (const f of r.findings.filter((x) => x.kind === 'dead-end' || x.kind === 'frozen-screen')) expect(readRunDir(out).findings.find((y) => y.id === f.id)?.detail).toMatch(/cannot tell when the app was left/);
    expect(sim.launches).toBeGreaterThan(1);
    expect(fs.readFileSync(path.join(out, 'report.md'), 'utf8')).toMatch(/Vega OS: the driver can't ask which app is in front/);
  });

  test('driverKind "vda" opens the driver through createDriver({ kind: "vda" }), without the adb FireLab', async () => {
    const seen: CreateDriverOptions[] = [];
    const sim = vegaSim();
    registerDriver('vda', async (o) => (seen.push(o), sim.driver));
    const world = fakeLab();
    const r = await explore({ driverKind: 'vda', device: 'vega-stick', lab: world.lab, clock: sim.clock, package: PKG, steps: 12, minimize: false, out: fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-vega-')) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'vda', serial: 'vega-stick' });
    expect(seen[0]?.lab).toBeUndefined();
    expect(r.device.kind).toBe('vda');
    expect(sim.driver.closed).toBe(true); // explore() opened it, so it closes it
    await world.lab.close();
  });

  test('MCP explore_start passes driver "vda" through', async () => {
    const seen: CreateDriverOptions[] = [];
    registerDriver('vda', async (o) => (seen.push(o), vegaSim().driver));
    const world = fakeLab();
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(world.lab).connect(a), client.connect(b)]);
    // The protected package fails the run right after the driver opens: nothing is played.
    const r = await client.callTool({ name: 'explore_start', arguments: { package: 'com.sunsetvilla.tv', minutes: 1, driver: 'vda', device: 'vega-stick' } });
    expect(r.isError).toBe(true);
    expect(seen[0]).toMatchObject({ kind: 'vda', serial: 'vega-stick' });
    const bad = await client.callTool({ name: 'explore_start', arguments: { package: PKG, driver: 'roku' } });
    expect(bad.isError).toBe(true);
    await client.close();
    await world.lab.close();
  });

  test('the CLI checks --driver', async () => {
    await expect(main(['explore', '--package', PKG, '--driver', 'roku'])).rejects.toMatchObject({ code: 'bad-request', message: '--driver must be adb, vda, browser or demo' });
  });
});
