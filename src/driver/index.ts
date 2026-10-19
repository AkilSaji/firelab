/**
 * DeviceDriver: one interface for everything that drives a TV (docs/DRIVERS.md).
 *
 *   import { createDriver } from 'firelab';
 *   const tv = await createDriver({ serial: '192.168.1.50' });
 *   await tv.launch({ package: 'com.example.game' });
 *   await tv.press([{ key: 'right', mode: 'hold', holdMs: 1500 }]);
 *   const thumb = await tv.screenshot({ format: 'rgba', width: 64 });
 *   await tv.close();
 */
import { FireLab, type FireLabOptions } from '../core/firelab.js';
import { FireLabError } from '../lib/errors.js';
import { AdbDriver, type AdbDriverOptions } from './adb.js';
import { FakeDriver, type FakeDriverOptions } from './fake.js';
import type { AppRef, DeviceDriver, DriverKind } from './types.js';

export * from './types.js';
export { AdbDriver, keySpecString, type AdbDriverOptions } from './adb.js';
export { BrowserDriver, findChrome, type BrowserDriverOptions } from './browser.js';
export { FakeDriver, type FakeDriverOptions, type FakeReply, type FakeCall, type FakeMethod, type FakeReturns, type FakeState, type FakeMeasure } from './fake.js';

export type CreateDriverOptions = {
  /** Device serial or IP. Omitted: the only connected device. */
  serial?: string;
  /** Which driver (default 'adb'). 'vda' is Vega OS (src/vega; not yet tested on a real Vega device, see docs/VEGA.md). */
  kind?: DriverKind;
  /** Share an existing FireLab (adb driver). Default: the driver makes, and on close() closes, its own. */
  lab?: FireLab;
  labOptions?: FireLabOptions;
  /** Probe caps before returning (default true): device-level caps, plus app-level ones when `app` is given. */
  probe?: boolean;
  app?: AppRef;
  /** Extra options for the adb driver. */
  adb?: Omit<AdbDriverOptions, 'serial' | 'lab' | 'ownsLab' | 'labOptions'>;
  /** Options for the 'mock' driver (a FakeDriver). */
  fake?: FakeDriverOptions;
  /** Anything a third-party driver needs. */
  extra?: Record<string, unknown>;
};

/** Makes a driver of one kind. Factories validate the device and probe caps when asked. */
export type DriverFactory = (opts: CreateDriverOptions) => Promise<DeviceDriver>;

const factories = new Map<DriverKind, DriverFactory>();

/**
 * Extension point: makes `createDriver({ kind })` build drivers of `kind`.
 * The Vega OS driver (src/vega, over `vda`) registers itself here:
 *
 *   registerDriver('vda', async (o) => new VdaDriver({ serial: o.serial, ... }));
 */
export function registerDriver(kind: DriverKind, factory: DriverFactory): void {
  factories.set(kind, factory);
}

/** Kinds that createDriver can build right now. */
export function driverKinds(): DriverKind[] {
  return [...factories.keys()];
}

registerDriver('adb', async (o) => {
  const lab = o.lab ?? new FireLab(o.labOptions);
  let driver: AdbDriver | undefined;
  try {
    const serial = await lab.resolveDevice(o.serial);
    driver = new AdbDriver({ ...o.adb, serial, lab, ownsLab: !o.lab });
    if (o.probe !== false) await driver.probe(o.app);
    return driver;
  } catch (e) {
    if (driver) await driver.close().catch(() => undefined);
    else if (!o.lab) await lab.close().catch(() => undefined);
    throw e;
  }
});

registerDriver('mock', async (o) => {
  const d = new FakeDriver({ ...o.fake, ...(o.serial ? { serial: o.serial } : {}) });
  if (o.probe !== false) await d.probe(o.app);
  return d;
});

registerDriver('browser', async (o) => {
  const { BrowserDriver } = await import('./browser.js');
  return new BrowserDriver({ ...(o.extra as import('./browser.js').BrowserDriverOptions | undefined), ...(o.serial ? { serial: o.serial } : {}) });
});

/**
 * Opens a driver for a device: an AdbDriver for Fire OS / Android TV today.
 * The caller closes it when done.
 */
export async function createDriver(opts: CreateDriverOptions = {}): Promise<DeviceDriver> {
  const kind = opts.kind ?? 'adb';
  // The Vega OS driver registers itself when src/vega is first imported.
  if (kind === 'vda' && !factories.has('vda')) await import('../vega/index.js');
  const factory = factories.get(kind);
  if (!factory) {
    throw new FireLabError('bad-request', `Unknown driver kind "${String(kind)}"`, { hint: `Available: ${driverKinds().join(', ')}` });
  }
  return factory(opts);
}
