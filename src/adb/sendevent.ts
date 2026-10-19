import type { Adb } from './client.js';
import { InputKeyInjector, type KeyInjector, type KeyPress } from './keys.js';
import { LINUX_KEY_CODES, parseGeteventDevices, type InputDevice } from './getevent.js';
import { log } from '../lib/log.js';

/**
 * Experimental true holds without root: write EV_KEY events with `sendevent`
 * straight into an input node the device already has (the remote's, or an IR
 * receiver's). Android reads those nodes, so a key written there is a real
 * key-down that stays down until the key-up, and the system's own auto-repeat
 * runs in between, exactly as with the physical remote.
 *
 * It needs write access to /dev/input/event* for the shell user (the `input`
 * group and the SELinux policy decide), and a node that declares the key.
 * Opt in with FIRELAB_REMOTE=sendevent; `scripts/hold-check.mjs` reports
 * whether it works on a device.
 */

/** Remote key -> Linux key names to look for in a node's capabilities, best first. */
export const KERNEL_KEYS: Record<string, string[]> = {
  up: ['KEY_UP'],
  down: ['KEY_DOWN'],
  left: ['KEY_LEFT'],
  right: ['KEY_RIGHT'],
  ok: ['KEY_SELECT', 'KEY_OK', 'KEY_ENTER', 'KEY_KPENTER', 'BTN_SELECT'],
  back: ['KEY_BACK', 'KEY_ESC'],
  home: ['KEY_HOMEPAGE', 'KEY_HOME'],
  menu: ['KEY_MENU', 'KEY_COMPOSE'],
  playpause: ['KEY_PLAYPAUSE', 'KEY_PLAY'],
  rewind: ['KEY_REWIND'],
  fastforward: ['KEY_FASTFORWARD'],
  volup: ['KEY_VOLUMEUP'],
  voldown: ['KEY_VOLUMEDOWN'],
  mute: ['KEY_MUTE'],
  search: ['KEY_SEARCH', 'KEY_VOICECOMMAND'],
  wake: ['KEY_WAKEUP'],
};

export type KernelKey = { path: string; device: string; linux: string; code: number };

/**
 * Picks, for each remote key, a node and Linux key to write. Remote-like nodes
 * that cover the most D-pad keys win, so a sequence usually stays on one node.
 * FireLab's own virtual remotes are skipped.
 */
export function kernelKeyMap(devices: InputDevice[]): Map<string, KernelKey> {
  const dpad = ['KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT'];
  const score = (d: InputDevice) => (/remote|^AR\b|amazon|fire ?tv|\bir\b|-ir\b/i.test(d.name) ? 10 : 0) + dpad.filter((k) => d.keys.includes(k)).length;
  const ranked = devices.filter((d) => !/^FireLab /.test(d.name) && d.keys.length).sort((a, b) => score(b) - score(a));
  const out = new Map<string, KernelKey>();
  for (const [key, names] of Object.entries(KERNEL_KEYS)) {
    found: for (const d of ranked) {
      for (const linux of names) {
        const code = LINUX_KEY_CODES[linux];
        if (code !== undefined && d.keys.includes(linux)) {
          out.set(key, { path: d.path, device: d.name, linux, code });
          break found;
        }
      }
    }
  }
  return out;
}

const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

/** One shell script for a sequence: down, SYN, hold, up, SYN (and the gap) per key. */
export function sendeventScript(steps: { key: KernelKey; holdMs: number }[], gapMs = 80): string {
  const parts: string[] = [];
  steps.forEach((s, i) => {
    const { path, code } = s.key;
    parts.push(`sendevent ${path} 1 ${code} 1`, `sendevent ${path} 0 0 0`, `sleep ${secs(s.holdMs)}`, `sendevent ${path} 1 ${code} 0`, `sendevent ${path} 0 0 0`);
    if (gapMs > 0 && i < steps.length - 1) parts.push(`sleep ${secs(gapMs)}`);
  });
  return `{ ${parts.join('; ')}; } 2>&1`;
}

const verdicts = new Map<string, { ok: boolean; reason: string }>();

/** Forgets cached sendevent verdicts (tests, or after a firmware update). */
export function forgetSendeventVerdicts(serial?: string): void {
  for (const k of [...verdicts.keys()]) if (!serial || k === serial) verdicts.delete(k);
}

const FAILED = /denied|could not|not found|No such|error|invalid/i;

export class KernelKeyInjector implements KeyInjector {
  private keys?: Promise<Map<string, KernelKey>>;
  private readonly fallback: InputKeyInjector;

  constructor(
    private readonly adb: Adb,
    private readonly serial: string,
    private readonly opts: { tapMs?: number; longMs?: number } = {},
  ) {
    this.fallback = new InputKeyInjector(adb, serial);
  }

  private keyMap(): Promise<Map<string, KernelKey>> {
    this.keys ??= this.adb
      .shell(this.serial, 'getevent -lp 2>/dev/null', { timeoutMs: 8000 })
      .then((out) => kernelKeyMap(parseGeteventDevices(out)))
      .catch(() => new Map<string, KernelKey>());
    return this.keys;
  }

  holds(): boolean | undefined {
    return verdicts.get(this.serial)?.ok;
  }

  private fail(reason: string): { holds: false } {
    verdicts.set(this.serial, { ok: false, reason });
    log.warn(`sendevent unavailable on ${this.serial} (${reason}); using input keyevent`);
    return { holds: false };
  }

  /** Checks a node accepts writes with an empty report (EV_SYN alone: no key moves). */
  async probe(): Promise<{ holds: boolean }> {
    const v = verdicts.get(this.serial);
    if (v) return { holds: v.ok };
    const map = await this.keyMap();
    const first = map.get('right') ?? map.values().next().value;
    if (!first) return this.fail('no input node declares remote keys');
    const out = await this.adb.shell(this.serial, `sendevent ${first.path} 0 0 0 2>&1; echo @@rc=$?`, { timeoutMs: 8000 }).catch((e: Error) => e.message);
    if (!/@@rc=0/.test(out) || FAILED.test(out.replace(/@@rc=\d+/, ''))) return this.fail(`can't write ${first.path}: ${out.replace(/@@rc=\d+/, '').trim() || 'failed'}`);
    verdicts.set(this.serial, { ok: true, reason: `writes to ${first.path} (${first.device})` });
    return { holds: true };
  }

  async press(keys: KeyPress[], opts: { gapMs?: number } = {}): Promise<void> {
    if (!(await this.probe()).holds) return this.fallback.press(keys, opts);
    const map = await this.keyMap();
    const tap = this.opts.tapMs ?? 60;
    const long = this.opts.longMs ?? 800;
    let run: { key: KernelKey; holdMs: number }[] = [];
    const flush = async () => {
      if (!run.length) return;
      const steps = run;
      run = [];
      const total = steps.reduce((t, s) => t + s.holdMs, 0) + (opts.gapMs ?? 80) * steps.length;
      const out = await this.adb.shell(this.serial, sendeventScript(steps, opts.gapMs ?? 80), { timeoutMs: total + 15000 });
      if (FAILED.test(out)) throw new Error(`sendevent failed: ${out.trim().split('\n')[0]}`);
    };
    for (const k of keys) {
      const kk = map.get(k.key);
      if (kk) {
        run.push({ key: kk, holdMs: k.mode === 'hold' ? (k.holdMs ?? tap) : k.mode === 'long' ? long : tap });
        continue;
      }
      await flush();
      await this.fallback.press([k], opts);
    }
    await flush();
  }

  close(): void {}
}
