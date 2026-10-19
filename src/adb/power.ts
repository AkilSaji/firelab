import type { Adb } from './client.js';
import { sleep } from '../lib/util.js';

export type PowerState = {
  /** Awake, Asleep, Dreaming (screensaver) or Dozing. */
  wakefulness?: string;
  /** The display is on (true while the screensaver shows, too). */
  displayOn?: boolean;
  /** Showing the screensaver / ambient mode. */
  dreaming: boolean;
  /** Awake with the display on and no screensaver: what an app needs. */
  awake: boolean;
};

export function parsePower(text: string): PowerState {
  const wakefulness = /mWakefulness=(\w+)/.exec(text)?.[1];
  const disp = /Display Power: state=(\w+)/.exec(text)?.[1];
  const displayOn = disp ? disp === 'ON' : /mScreenOn=true|mInteractive=true/.test(text) ? true : undefined;
  const dreaming = wakefulness === 'Dreaming' || /mIsDreaming=true|isDreaming=true/.test(text);
  return { wakefulness, displayOn, dreaming, awake: wakefulness === 'Awake' && displayOn !== false && !dreaming };
}

export async function powerState(adb: Adb, serial: string): Promise<PowerState> {
  const out = await adb.shell(serial, "dumpsys power | grep -E 'mWakefulness=|Display Power|mScreenOn|mInteractive|Dreaming'", { timeoutMs: 8000 });
  return parsePower(out);
}

/**
 * Wakes the device from sleep or the screensaver with KEYCODE_WAKEUP (which,
 * unlike a D-pad key, doesn't also act in the foreground app), then checks
 * `dumpsys power` until it reports Awake.
 */
export async function wakeDevice(adb: Adb, serial: string, timeoutMs = 4000): Promise<PowerState & { woke: boolean }> {
  const before = await powerState(adb, serial);
  if (before.awake) return { ...before, woke: false };
  await adb.shell(serial, 'input keyevent KEYCODE_WAKEUP', { timeoutMs: 10000 });
  const until = Date.now() + timeoutMs;
  let st = before;
  while (Date.now() < until) {
    await sleep(400);
    st = await powerState(adb, serial);
    if (st.awake) return { ...st, woke: true };
  }
  return { ...st, woke: false };
}
