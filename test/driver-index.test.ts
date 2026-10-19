import { describe, expect, it, vi } from 'vitest';
import { createDriver, registerDriver, driverKinds, AdbDriver, FakeDriver, CAP_NAMES, minimalCaps } from '../src/driver/index.js';
import * as pkg from '../src/index.js';
import { fakeLab } from './helpers/fake-lab.js';
import { fakeAdb, SERIAL } from './helpers/fake-adb.js';

describe('createDriver', () => {
  it('opens an AdbDriver for the only connected device and probes it', async () => {
    const w = fakeLab();
    w.runner.on(/getprop ro.product.manufacturer/, 'Amazon\n').on(/command -v getevent/, '@@yes\n');
    const d = await createDriver({ lab: w.lab });
    expect(d).toBeInstanceOf(AdbDriver);
    expect(d.kind).toBe('adb');
    expect(d.serial).toBe(SERIAL);
    expect(d.caps.recordKeys).toBe(true);
    await d.close();
  });

  it('accepts a bare IP and can skip the probe', async () => {
    const w = fakeLab();
    const d = await createDriver({ serial: '192.168.1.194', lab: w.lab, probe: false });
    expect(d.serial).toBe(SERIAL);
    expect(w.runner.shellCommands().some((c) => c.includes('getevent'))).toBe(false);
    await d.close();
  });

  it('closes the FireLab it made when the device is not there', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/^devices -l$/, 'List of devices attached\n\n');
    const close = vi.spyOn((await import('../src/core/firelab.js')).FireLab.prototype, 'close');
    await expect(createDriver({ labOptions: { adb, autoReconnect: false } })).rejects.toMatchObject({ code: 'no-device' });
    expect(close).toHaveBeenCalled();
    close.mockRestore();
  });

  it('loads the Vega (vda) driver on demand, and takes a registered driver', async () => {
    // src/vega registers itself on first use; with no Vega device connected it says so.
    const runner = { run: async () => ({ code: 0, stdout: Buffer.from('List of devices attached\n\n'), stderr: '' }) };
    await expect(createDriver({ kind: 'vda', serial: 'x', extra: { runner } })).rejects.toMatchObject({ code: 'device-not-found' });
    expect(driverKinds()).toEqual(expect.arrayContaining(['adb', 'mock', 'vda']));
    registerDriver('vda', async (o) => new FakeDriver({ kind: 'vda', serial: o.serial ?? 'vega', caps: { cdp: false } }));
    const v = await createDriver({ kind: 'vda', serial: 'vega-stick' });
    expect([v.kind, v.serial, v.caps.cdp]).toEqual(['vda', 'vega-stick', false]);
    await expect(createDriver({ kind: 'roku' as never })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it("'mock' gives a FakeDriver", async () => {
    const d = await createDriver({ kind: 'mock', fake: { caps: { holds: false } } });
    expect(d).toBeInstanceOf(FakeDriver);
    expect(d.caps.holds).toBe(false);
  });

  it('is exported from the package root, with the caps helpers', () => {
    expect(pkg.createDriver).toBe(createDriver);
    expect(pkg.AdbDriver).toBe(AdbDriver);
    expect(pkg.FakeDriver).toBe(FakeDriver);
    expect(CAP_NAMES).toHaveLength(15);
    const m = minimalCaps();
    expect(CAP_NAMES.filter((c) => m[c])).toEqual(['keys', 'screenshot', 'launch', 'logs']);
  });
});
