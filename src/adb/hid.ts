import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Adb } from './client.js';
import { InputKeyInjector, type KeyInjector, type KeyPress } from './keys.js';
import { parseGeteventDevices } from './getevent.js';
import { KernelKeyInjector } from './sendevent.js';
import { sleep } from '../lib/util.js';
import { log } from '../lib/log.js';

/**
 * A virtual remote control made with Android's built-in `hid` command, which
 * creates a HID device through /dev/uhid (the shell user may do this; no root,
 * nothing to install). When it works, keys arrive like a real Bluetooth
 * remote's: real key-down and key-up with any hold time in between, and ~10 ms
 * per key instead of the ~1 s JVM start of every `input keyevent`.
 *
 * It does not work everywhere, and it can fail silently: on Fire OS 8 (Fire TV
 * Stick 4K Plus) `hid` accepts the device and the reports without an error,
 * yet no key event ever reaches the kernel or the app. So FireLab never trusts
 * it without proof: see `HidRemote`.
 *
 * The default device is a Consumer Control collection whose usages Linux maps
 * to remote keys (hid-input.c): Menu Pick -> KEY_SELECT -> DPAD_CENTER, Menu
 * Up -> KEY_UP -> DPAD_UP, AC Back -> KEY_BACK, AC Home -> KEY_HOMEPAGE, and so
 * on through Android's Generic.kl.
 */
export const CONSUMER_USAGES: Record<string, number> = {
  ok: 0x41,
  up: 0x42,
  down: 0x43,
  left: 0x44,
  right: 0x45,
  menu: 0x40,
  back: 0x224,
  home: 0x223,
  playpause: 0xcd,
  rewind: 0xb4,
  fastforward: 0xb3,
  volup: 0xe9,
  voldown: 0xea,
  mute: 0xe2,
  search: 0x221,
};

/** HID report descriptor: Consumer Control, report id 1, one 16-bit usage. */
export const REMOTE_DESCRIPTOR = [
  0x05, 0x0c, // Usage Page (Consumer)
  0x09, 0x01, // Usage (Consumer Control)
  0xa1, 0x01, // Collection (Application)
  0x85, 0x01, //   Report ID (1)
  0x15, 0x00, //   Logical Minimum (0)
  0x26, 0xff, 0x03, //   Logical Maximum (0x3ff)
  0x19, 0x00, //   Usage Minimum (0)
  0x2a, 0xff, 0x03, //   Usage Maximum (0x3ff)
  0x75, 0x10, //   Report Size (16)
  0x95, 0x01, //   Report Count (1)
  0x81, 0x00, //   Input (Data, Array, Absolute)
  0xc0, // End Collection
];

/**
 * Experimental: a plain keyboard (usage page 7), whose arrow and Enter usages
 * every kernel maps (KEY_RIGHT, KEY_ENTER...). Enter is ENTER rather than
 * DPAD_CENTER and Escape is ESCAPE rather than BACK, so it only covers the keys
 * games read. `scripts/hold-check.mjs` tries it next to the consumer remote.
 */
export const KEYBOARD_USAGES: Record<string, number> = {
  right: 0x4f,
  left: 0x50,
  down: 0x51,
  up: 0x52,
  ok: 0x28,
  back: 0x29,
  menu: 0x65,
};

/** HID report descriptor: Keyboard, report id 1, one 8-bit key usage. */
export const KEYBOARD_DESCRIPTOR = [
  0x05, 0x01, // Usage Page (Generic Desktop)
  0x09, 0x06, // Usage (Keyboard)
  0xa1, 0x01, // Collection (Application)
  0x85, 0x01, //   Report ID (1)
  0x05, 0x07, //   Usage Page (Keyboard/Keypad)
  0x19, 0x00, //   Usage Minimum (0)
  0x29, 0xff, //   Usage Maximum (0xff)
  0x15, 0x00, //   Logical Minimum (0)
  0x26, 0xff, 0x00, //   Logical Maximum (0xff)
  0x75, 0x08, //   Report Size (8)
  0x95, 0x01, //   Report Count (1)
  0x81, 0x00, //   Input (Data, Array, Absolute)
  0xc0, // End Collection
];

export type HidProfileName = 'consumer' | 'keyboard';
export type HidProfile = { id: HidProfileName; name: string; pid: number; descriptor: number[]; usages: Record<string, number>; bytes: 1 | 2 };

/** pid.codes test VID/PIDs: no vendor key layout exists for them, so Android uses Generic.kl. */
const VID = 0x1209;

export const HID_PROFILES: Record<HidProfileName, HidProfile> = {
  consumer: { id: 'consumer', name: 'FireLab Remote', pid: 0x0001, descriptor: REMOTE_DESCRIPTOR, usages: CONSUMER_USAGES, bytes: 2 },
  keyboard: { id: 'keyboard', name: 'FireLab Keyboard', pid: 0x0002, descriptor: KEYBOARD_DESCRIPTOR, usages: KEYBOARD_USAGES, bytes: 1 },
};

export function registerCommand(id = 1, profile: HidProfile = HID_PROFILES.consumer, name = profile.name): string {
  return JSON.stringify({ id, command: 'register', name, vid: VID, pid: profile.pid, bus: 'usb', descriptor: profile.descriptor });
}

export function reportCommand(usage: number, id = 1, bytes: 1 | 2 = 2): string {
  const report = bytes === 2 ? [0x01, usage & 0xff, (usage >> 8) & 0xff] : [0x01, usage & 0xff];
  return JSON.stringify({ id, command: 'report', report });
}

export function delayCommand(ms: number, id = 1): string {
  return JSON.stringify({ id, command: 'delay', duration: Math.max(0, Math.round(ms)) });
}

/** The JSON lines `hid` gets for a sequence, and how long it takes to play. */
export function hidScript(
  keys: KeyPress[],
  opts: { gapMs?: number; tapMs?: number; longMs?: number; profile?: HidProfile } = {},
): { lines: string[]; durationMs: number; unsupported: KeyPress[] } {
  const profile = opts.profile ?? HID_PROFILES.consumer;
  const tap = opts.tapMs ?? 60;
  const long = opts.longMs ?? 800;
  const gap = opts.gapMs ?? 80;
  const lines: string[] = [];
  const unsupported: KeyPress[] = [];
  let durationMs = 0;
  keys.forEach((k, i) => {
    const usage = profile.usages[k.key];
    if (usage === undefined) {
      unsupported.push(k);
      return;
    }
    const hold = k.mode === 'hold' ? (k.holdMs ?? tap) : k.mode === 'long' ? long : tap;
    lines.push(reportCommand(usage, 1, profile.bytes), delayCommand(hold), reportCommand(0, 1, profile.bytes));
    durationMs += hold;
    if (i < keys.length - 1 && gap > 0) {
      lines.push(delayCommand(gap));
      durationMs += gap;
    }
  });
  return { lines, durationMs, unsupported };
}

/** What FireLab found out about the virtual remote on a device. */
export type HidVerdict = { ok: boolean; reason: string; at: number; device?: string };

/** Verdicts per device and profile, for the life of the process. */
const verdicts = new Map<string, HidVerdict>();
const fireOsCache = new Map<string, boolean>();
const verdictKey = (serial: string, profile: HidProfileName) => `${serial}|${profile}`;

/** The cached verdict for a device: ok (verified by getevent), not ok (and why), or undefined (not tried yet). */
export function hidVerdict(serial: string, profile: HidProfileName = 'consumer'): HidVerdict | undefined {
  return verdicts.get(verdictKey(serial, profile));
}

/** Forgets what FireLab learned about a device's remote (one device, or all), e.g. after a firmware update. */
export function forgetHidVerdicts(serial?: string): void {
  for (const k of [...verdicts.keys()]) if (!serial || k.startsWith(`${serial}|`)) verdicts.delete(k);
  if (serial) fireOsCache.delete(serial);
  else fireOsCache.clear();
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type HidRemoteOptions = {
  /** Close the virtual remote after this long without presses (default 60 s). */
  idleMs?: number;
  /** How long Android gets to add the device after registering (default 900 ms). */
  registerWaitMs?: number;
  /** Which descriptor to register (default 'consumer'). */
  profile?: HidProfileName;
  /** How long to wait for getevent to start watching before the proof press (default 2500 ms). */
  verifyWaitMs?: number;
};

/**
 * Presses keys through a virtual HID remote, and proves it works first:
 *
 * 1. After registering, the device must show up in `getevent -lp` (the input
 *    devices Android reads).
 * 2. The first press is sent while `getevent` watches; at least one EV_KEY
 *    from the virtual device must arrive.
 *
 * If either fails, the keys that were sent go again through `input keyevent`
 * (the app never saw them) and the device is marked broken for the rest of
 * the process, so later presses go straight to `input`. Keys the remote can't
 * express (wake, raw key codes) always use `input`.
 */
export class HidRemote implements KeyInjector {
  private proc?: ChildProcessWithoutNullStreams;
  private starting?: Promise<boolean>;
  private idleTimer?: NodeJS.Timeout;
  private broken = false;
  private devicePath?: string;
  private readonly fallback: InputKeyInjector;
  private queue: Promise<void> = Promise.resolve();
  readonly profile: HidProfile;
  /** The device name registered with Android: unique per instance, so getevent tells it apart from other FireLab remotes. */
  readonly deviceName: string;

  constructor(
    private readonly adb: Adb,
    private readonly serial: string,
    private readonly opts: HidRemoteOptions = {},
  ) {
    this.fallback = new InputKeyInjector(adb, serial);
    this.profile = HID_PROFILES[opts.profile ?? 'consumer'];
    this.deviceName = `${this.profile.name} ${Math.random().toString(16).slice(2, 6)}`;
    if (hidVerdict(serial, this.profile.id)?.ok === false) this.broken = true;
  }

  /** False once the remote is known not to work on this device. */
  get available(): boolean {
    return !this.broken;
  }

  /** True once getevent saw this device's (or an earlier instance's) keys on this device. */
  get verified(): boolean {
    return !this.broken && hidVerdict(this.serial, this.profile.id)?.ok === true;
  }

  get verdict(): HidVerdict | undefined {
    return hidVerdict(this.serial, this.profile.id);
  }

  /** true once verified, false if it can't work, undefined before the proof press. */
  holds(): boolean | undefined {
    if (this.broken) return false;
    return this.verified ? true : undefined;
  }

  /**
   * Registers the virtual remote (it closes again after the idle time) and
   * checks Android lists it. Only a key press proves it delivers keys, so
   * `holds` stays false here until one has.
   */
  async probe(): Promise<{ holds: boolean }> {
    if (this.broken) return { holds: false };
    const ok = await this.start();
    if (ok) this.touch();
    return { holds: ok && this.verified };
  }

  private fail(reason: string): void {
    this.broken = true;
    verdicts.set(verdictKey(this.serial, this.profile.id), { ok: false, reason, at: Date.now() });
    log.warn(`virtual remote unavailable on ${this.serial} (${reason}); using input keyevent`);
    void this.close();
  }

  private start(): Promise<boolean> {
    if (this.broken) return Promise.resolve(false);
    if (this.proc && !this.proc.killed) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const p = this.adb.spawn(['-s', this.serial, 'shell', 'hid', '-']);
      let output = '';
      let exited = false;
      p.stdout.on('data', (d: Buffer) => (output += d.toString()));
      p.stderr.on('data', (d: Buffer) => (output += d.toString()));
      p.on('exit', () => {
        exited = true;
        if (this.proc === p) this.proc = undefined;
      });
      p.on('error', () => (exited = true));
      p.stdin.on('error', () => {});
      p.stdin.write(`${registerCommand(1, this.profile, this.deviceName)}\n`);
      // Android needs a moment to add the input device before it accepts reports.
      await sleep(this.opts.registerWaitMs ?? 900);
      if (exited || /Exception|Error|not found|denied/i.test(output)) {
        p.kill();
        this.fail(output.trim().split('\n')[0] || 'hid exited');
        return false;
      }
      this.proc = p;
      const path = await this.findDevice();
      if (!path) {
        this.fail('the virtual remote never showed up in getevent -lp');
        return false;
      }
      this.devicePath = path;
      return true;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** The /dev/input node of this instance's device, from `getevent -lp`. */
  private async findDevice(): Promise<string | undefined> {
    for (let i = 0; i < 3; i++) {
      const out = await this.adb.shell(this.serial, 'getevent -lp 2>/dev/null', { timeoutMs: 8000 }).catch(() => '');
      const dev = parseGeteventDevices(out).find((d) => d.name === this.deviceName);
      if (dev) return dev.path;
      await sleep(300);
    }
    return undefined;
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), this.opts.idleMs ?? 60000);
    this.idleTimer.unref();
  }

  press(keys: KeyPress[], opts: { gapMs?: number } = {}): Promise<void> {
    const run = this.queue.then(() => this.pressNow(keys, opts));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Sends `run` while getevent watches the virtual device; true when its key events arrived. */
  private async sendVerified(run: KeyPress[], gapMs?: number): Promise<boolean> {
    const path = this.devicePath;
    const proc = this.proc;
    if (!path || !proc) return false;
    const watcher = this.adb.spawn(['-s', this.serial, 'shell', 'getevent -l']);
    let out = '';
    let ready = false;
    let seen = false;
    const readyRe = new RegExp(`add device \\d+:\\s*${reEscape(path)}(\\s|$)`, 'm');
    const keyRe = new RegExp(`${reEscape(path)}:\\s+EV_KEY\\s+\\S+\\s+DOWN`);
    watcher.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (!ready) ready = readyRe.test(out);
      if (!seen) seen = keyRe.test(out);
      if (out.length > 1 << 16) out = out.slice(-4096);
    });
    watcher.on('error', () => {});
    watcher.stdin?.on('error', () => {});
    try {
      const until = Date.now() + (this.opts.verifyWaitMs ?? 2500);
      while (!ready && Date.now() < until) await sleep(40);
      if (!ready) {
        this.fail("getevent couldn't watch the virtual remote, so it can't be verified");
        return false;
      }
      const { lines, durationMs } = hidScript(run, { gapMs, profile: this.profile });
      proc.stdin.write(`${lines.join('\n')}\n`);
      await sleep(durationMs + 40);
      const slack = Date.now() + 500;
      while (!seen && Date.now() < slack) await sleep(25);
      if (!seen) {
        this.fail('it registered, but getevent saw no key events from it');
        return false;
      }
      verdicts.set(verdictKey(this.serial, this.profile.id), { ok: true, reason: 'getevent saw its key events', at: Date.now(), device: path });
      return true;
    } finally {
      watcher.kill();
    }
  }

  private async pressNow(keys: KeyPress[], opts: { gapMs?: number }): Promise<void> {
    if (this.broken || !(await this.start()) || !this.proc) return this.fallback.press(keys, opts);
    this.touch();
    // Keep the order: runs of HID-able keys go to hid, the rest to input.
    let run: KeyPress[] = [];
    /** False when the proof failed (the run was re-sent through input). */
    const flush = async (): Promise<boolean> => {
      if (!run.length) return true;
      const batch = run;
      run = [];
      if (!this.verified) {
        if (await this.sendVerified(batch, opts.gapMs)) return true;
        await this.fallback.press(batch, opts);
        return false;
      }
      const { lines, durationMs } = hidScript(batch, { gapMs: opts.gapMs, profile: this.profile });
      this.proc?.stdin.write(`${lines.join('\n')}\n`);
      await sleep(durationMs + 40);
      return true;
    };
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] as KeyPress;
      if (this.profile.usages[k.key] !== undefined) {
        run.push(k);
        continue;
      }
      if (!(await flush())) return this.fallback.press(keys.slice(i), opts);
      await this.fallback.press([k], opts);
    }
    await flush();
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const p = this.proc;
    this.proc = undefined;
    if (p) {
      try {
        p.stdin.end();
      } catch {}
      p.kill();
    }
  }
}

/** Whether a device runs Fire OS (manufacturer Amazon); cached per device. */
export async function isFireOs(adb: Adb, serial: string): Promise<boolean> {
  const c = fireOsCache.get(serial);
  if (c !== undefined) return c;
  const out = await adb.shell(serial, 'getprop ro.product.manufacturer', { timeoutMs: 8000 }).catch(() => undefined);
  if (out === undefined) return false;
  const v = /amazon/i.test(out);
  fireOsCache.set(serial, v);
  return v;
}

export type RemoteMode = 'auto' | 'hid' | 'input' | 'sendevent';

/**
 * The default remote. Plain presses use `input keyevent` (works everywhere,
 * batched into one call). Holds and long presses:
 *
 * - use the virtual HID remote once it is verified on the device;
 * - on Fire OS, use `input` until then (HID fails silently on Fire OS 8), so a
 *   hold is emulated with repeated presses (see `inputHoldScript`);
 * - elsewhere, try HID, which proves itself on the first press and falls
 *   back to `input` if it doesn't deliver.
 *
 * FIRELAB_REMOTE=hid sends everything through HID (still verified, with the
 * same fallback), FIRELAB_REMOTE=input never uses it, and
 * FIRELAB_REMOTE=sendevent (experimental) writes key events to the device's
 * own remote input node for true holds.
 */
export class SmartRemote implements KeyInjector {
  private readonly input: InputKeyInjector;
  readonly hid: HidRemote;
  private kernel?: KernelKeyInjector;
  private readonly fireOsOverride?: boolean;
  constructor(
    private readonly adb: Adb,
    private readonly serial: string,
    readonly mode: RemoteMode = (process.env.FIRELAB_REMOTE as RemoteMode | undefined) ?? 'auto',
    opts: HidRemoteOptions & { fireOs?: boolean } = {},
  ) {
    this.input = new InputKeyInjector(adb, serial);
    this.hid = new HidRemote(adb, serial, opts);
    this.fireOsOverride = opts.fireOs;
    if (mode === 'sendevent') this.kernel = new KernelKeyInjector(adb, serial);
  }

  private async fireOs(): Promise<boolean> {
    return this.fireOsOverride ?? isFireOs(this.adb, this.serial);
  }

  /** The path holds and long presses take now. */
  async holdPath(): Promise<'hid' | 'input' | 'sendevent'> {
    if (this.mode === 'input') return 'input';
    if (this.mode === 'sendevent') return 'sendevent';
    if (this.mode === 'hid') return this.hid.available ? 'hid' : 'input';
    if (this.hid.verified) return 'hid';
    if (!this.hid.available) return 'input';
    return (await this.fireOs()) ? 'input' : 'hid';
  }

  async press(keys: KeyPress[], opts: { gapMs?: number } = {}): Promise<void> {
    if (this.mode === 'input') return this.input.press(keys, opts);
    if (this.mode === 'hid') return this.hid.press(keys, opts);
    if (this.mode === 'sendevent' && this.kernel) return this.kernel.press(keys, opts);
    if (!keys.some((k) => k.mode !== 'press')) return this.input.press(keys, opts);
    return (await this.holdPath()) === 'hid' ? this.hid.press(keys, opts) : this.input.press(keys, opts);
  }

  holds(): boolean | undefined {
    if (this.mode === 'input') return false;
    if (this.mode === 'sendevent') return this.kernel?.holds();
    return this.hid.holds();
  }

  async probe(): Promise<{ holds: boolean }> {
    if (this.mode === 'input') return { holds: false };
    if (this.mode === 'sendevent' && this.kernel) return this.kernel.probe();
    if (this.hid.verified) return { holds: true };
    // Don't put an unproven virtual remote on a Fire OS device just to ask.
    if (this.mode === 'auto' && (await this.fireOs())) return { holds: false };
    return this.hid.probe();
  }

  async close(): Promise<void> {
    await this.hid.close();
    await this.kernel?.close();
  }
}
