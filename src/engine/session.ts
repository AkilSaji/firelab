/**
 * Launching the app the way every exploration step, return and replay needs it:
 * stop (or clear data), launch, re-install the probe, wait until the page
 * answers, run the setup expression. Shared by the explorer and replay so a
 * trace starts from the same place it was recorded from.
 */
import { FireLabError } from '../lib/errors.js';
import type { AppRef, DeviceDriver, KeySpec } from './driver.js';
import type { Clock } from './clock.js';
import type { Action, ExploreConfig } from './types.js';
import type { Observer } from './observe.js';
import { MACRO_GAP_MS, keySpecs } from './actions.js';

/** Packages the engine refuses to drive without --allow-package (CONTRACT safety rules). */
export const PROTECTED_PACKAGES: readonly string[] = ['com.sunsetvilla.tv'];

export function assertAllowed(pkg: string, allow: readonly string[] = []): void {
  if (PROTECTED_PACKAGES.includes(pkg) && !allow.includes(pkg))
    throw new FireLabError('confirm-required', `${pkg} holds someone's real progress: the engine won't drive it`, { hint: `Test a build with its own package id, or pass --allow-package ${pkg}` });
}

export type LaunchOptions = {
  reset?: ExploreConfig['reset'];
  setupEval?: string;
  /** How long to wait for the page (probe) to answer after a launch (default 20 s). */
  readyMs?: number;
  signal?: AbortSignal;
};

/** Stop (or clear data) and launch; returns the pid and how long it took. */
export async function relaunchApp(driver: DeviceDriver, app: AppRef, observer: Observer, clock: Clock, o: LaunchOptions = {}): Promise<{ pid?: number; ms: number }> {
  const t0 = clock.now();
  if (o.reset === 'clear-data' && driver.caps.reset && driver.reset) await driver.reset(app, { confirm: true });
  else await driver.stop(app).catch(() => undefined);
  const r = await driver.launch(app);
  await observer.afterLaunch();
  await waitReady(driver, app, observer, clock, o.readyMs ?? 20_000, o.signal);
  if (o.setupEval && driver.caps.eval && driver.evaluate) {
    await driver.evaluate(o.setupEval, { app, timeoutMs: 5000 }).catch(() => undefined);
    await clock.sleep(300, o.signal).catch(() => undefined);
  }
  const pid = r.pid ?? (await driver.pid(app).catch(() => undefined));
  return { pid, ms: clock.now() - t0 };
}

/** Until the app is in front and (when the driver can evaluate) the probe answers. */
async function waitReady(driver: DeviceDriver, app: AppRef, observer: Observer, clock: Clock, maxMs: number, signal?: AbortSignal): Promise<void> {
  const t0 = clock.now();
  while (clock.now() - t0 < maxMs && !signal?.aborted) {
    const fg = await driver.foreground().catch(() => null);
    if (fg?.package === app.package) {
      if (!observer.canProbe) return;
      const p = await observer.probe();
      // Ready once the page answers and the app's own state expression works (scripts may still be loading).
      const appErr = p?.app && typeof p.app === 'object' && '__error' in (p.app as object);
      if (p && !appErr) return;
    }
    await clock.sleep(400, signal).catch(() => undefined);
  }
}

/** Sends one action to the device (relaunch is the caller's job). */
export async function perform(driver: DeviceDriver, a: Action, clock: Clock, signal?: AbortSignal): Promise<void> {
  switch (a.kind) {
    case 'key': {
      const specs: KeySpec[] = keySpecs(a);
      // A macro goes out as one batch: the presses land milliseconds apart, like a fast double press
      // (separate calls cost a JVM start each on Fire OS, about 1 s). Drivers with real timing use MACRO_GAP_MS.
      await driver.press(specs, specs.length > 1 && driver.caps.holds ? { gapMs: MACRO_GAP_MS } : {});
      return;
    }
    case 'text':
      if (driver.typeText) await driver.typeText(a.text);
      return;
    case 'wait':
      await clock.sleep(a.ms, signal).catch(() => undefined);
      return;
    case 'relaunch':
      return;
  }
}
