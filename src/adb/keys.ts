import type { Adb } from './client.js';
import { FireLabError } from '../lib/errors.js';
import { sleep } from '../lib/util.js';

/** Remote key names shared by the API, CLI and MCP tools (docs/CONTRACT.md). */
export const REMOTE_KEYS = {
  up: { code: 19, keycode: 'KEYCODE_DPAD_UP' },
  down: { code: 20, keycode: 'KEYCODE_DPAD_DOWN' },
  left: { code: 21, keycode: 'KEYCODE_DPAD_LEFT' },
  right: { code: 22, keycode: 'KEYCODE_DPAD_RIGHT' },
  ok: { code: 23, keycode: 'KEYCODE_DPAD_CENTER' },
  back: { code: 4, keycode: 'KEYCODE_BACK' },
  home: { code: 3, keycode: 'KEYCODE_HOME' },
  menu: { code: 82, keycode: 'KEYCODE_MENU' },
  playpause: { code: 85, keycode: 'KEYCODE_MEDIA_PLAY_PAUSE' },
  rewind: { code: 89, keycode: 'KEYCODE_MEDIA_REWIND' },
  fastforward: { code: 90, keycode: 'KEYCODE_MEDIA_FAST_FORWARD' },
  volup: { code: 24, keycode: 'KEYCODE_VOLUME_UP' },
  voldown: { code: 25, keycode: 'KEYCODE_VOLUME_DOWN' },
  mute: { code: 164, keycode: 'KEYCODE_VOLUME_MUTE' },
  search: { code: 84, keycode: 'KEYCODE_SEARCH' },
  wake: { code: 224, keycode: 'KEYCODE_WAKEUP' },
} as const;

export type RemoteKey = keyof typeof REMOTE_KEYS;
export const REMOTE_KEY_NAMES = Object.keys(REMOTE_KEYS) as RemoteKey[];

const ALIASES: Record<string, RemoteKey> = {
  center: 'ok',
  select: 'ok',
  enter: 'ok',
  dpad_center: 'ok',
  play: 'playpause',
  pause: 'playpause',
  play_pause: 'playpause',
  rew: 'rewind',
  ff: 'fastforward',
  fwd: 'fastforward',
  forward: 'fastforward',
  volumeup: 'volup',
  volumedown: 'voldown',
  vol_up: 'volup',
  vol_down: 'voldown',
  wakeup: 'wake',
};

/** One press in a sequence. `code` is an Android KeyEvent code. */
export type KeyPress = {
  key: string;
  code: number;
  /** 'press' = tap, 'long' = Android long press, 'hold' = keep it down for holdMs. */
  mode: 'press' | 'long' | 'hold';
  holdMs?: number;
};

export function keyCode(name: string): number {
  const n = name.trim().toLowerCase();
  const canonical = (REMOTE_KEYS as Record<string, { code: number }>)[n] ? n : ALIASES[n];
  if (canonical) return REMOTE_KEYS[canonical as RemoteKey].code;
  if (/^\d+$/.test(n)) return Number(n);
  // Power users: any Android keycode name, e.g. KEYCODE_CHANNEL_UP.
  if (/^keycode_[a-z0-9_]+$/.test(n)) return -1;
  throw new FireLabError('bad-request', `Unknown key "${name}"`, {
    hint: `Use one of: ${REMOTE_KEY_NAMES.join(', ')} (or a number / KEYCODE_* name)`,
  });
}

/**
 * Parses CLI-style key specs: "up", "down*3" (three taps), "ok:long" (long
 * press), "right:1500" (hold 1.5 s), "KEYCODE_CHANNEL_UP", "66".
 */
export function parseKeys(specs: readonly string[], defaults: { holdMs?: number } = {}): KeyPress[] {
  const out: KeyPress[] = [];
  for (const raw of specs.flatMap((s) => s.split(/[\s,]+/)).filter(Boolean)) {
    const m = /^([A-Za-z0-9_]+)(?:\*(\d+))?(?::(long|\d+)(?:ms)?)?(?:\*(\d+))?$/.exec(raw.trim());
    if (!m) throw new FireLabError('bad-request', `Can't read key "${raw}"`, { hint: 'Examples: up, down*3, ok:long, right:1500' });
    const name = m[1] as string;
    const times = Number(m[2] ?? m[4] ?? 1);
    if (times < 1 || times > 50) throw new FireLabError('bad-request', `Repeat count for "${raw}" must be 1-50`);
    const code = keyCode(name);
    const lower = name.toLowerCase();
    const key = (REMOTE_KEYS as Record<string, unknown>)[lower] ? lower : (ALIASES[lower] ?? (code === -1 ? name.toUpperCase() : name));
    let mode: KeyPress['mode'] = 'press';
    let holdMs: number | undefined;
    if (m[3] === 'long') mode = 'long';
    else if (m[3]) {
      mode = 'hold';
      holdMs = Number(m[3]);
    } else if (defaults.holdMs && defaults.holdMs > 0) {
      mode = 'hold';
      holdMs = defaults.holdMs;
    }
    if (holdMs !== undefined && (holdMs < 1 || holdMs > 30000)) throw new FireLabError('bad-request', `Hold time for "${raw}" must be 1-30000 ms`);
    for (let i = 0; i < times; i++) out.push(holdMs !== undefined ? { key, code, mode, holdMs } : { key, code, mode });
  }
  return out;
}

const keyArg = (p: KeyPress): string => (p.code === -1 ? p.key : String(p.code));

/**
 * Something that can press keys on a device. The default uses `input
 * keyevent`; `HidRemote` (hid.ts) adds true holds and much lower latency.
 */
export interface KeyInjector {
  press(keys: KeyPress[], opts?: { gapMs?: number }): Promise<void>;
  close?(): Promise<void> | void;
  /**
   * Whether holds are real key-down / key-up with any hold time in between:
   * true, false, or undefined while nobody has tried yet.
   */
  holds?(): boolean | undefined;
  /** Finds out whether holds work (may start the virtual remote). */
  probe?(): Promise<{ holds: boolean }>;
}

/**
 * A hold emulated with `input`, which cannot keep a key down: one press, a
 * pause like a remote's auto-repeat delay (~400 ms), then presses every ~30 ms
 * until `holdMs` has passed. It runs as one shell script that times itself
 * with /proc/uptime, so adb round trips don't stretch it.
 *
 * What the app sees is a series of separate presses (key-down + key-up each),
 * not one continuous press, and fewer of them than a real remote sends: every
 * `input keyevent` starts a JVM (~0.3-1 s on Fire OS 8), which sets the real
 * repeat rate. `--longpress` is no better: it sends down, an immediate
 * long-press repeat and up, with no time held at all.
 */
export function inputHoldScript(key: string, holdMs: number, opts: { firstDelayMs?: number; intervalMs?: number } = {}): string {
  if (!/^[A-Za-z0-9_]+$/.test(key)) throw new FireLabError('bad-request', `Bad key "${key}"`);
  const hold = Math.max(1, Math.round(holdMs));
  const first = Math.min(opts.firstDelayMs ?? 400, hold);
  const interval = Math.max(1, opts.intervalMs ?? 30);
  const secs = (ms: number) => (ms / 1000).toFixed(3);
  return [
    't(){ read u r </proc/uptime; echo $(( ${u%.*}${u#*.} )); }',
    `e=$(( $(t) + ${Math.ceil(hold / 10)} ))`,
    `input keyevent ${key}`,
    `sleep ${secs(first)}`,
    `while [ $(t) -lt $e ]; do input keyevent ${key}; sleep ${secs(interval)}; done`,
  ].join('; ');
}

/**
 * `input keyevent`. Each call starts a JVM on the device (about 1 s on a Fire
 * TV Stick), so runs of plain presses with no gap go in a single call; the
 * events are still delivered one after the other. Holds are emulated with
 * repeated presses (`inputHoldScript`).
 */
export class InputKeyInjector implements KeyInjector {
  constructor(
    private readonly adb: Adb,
    private readonly serial: string,
  ) {}

  /** `input` only approximates holds with long-press repeats. */
  holds(): boolean {
    return false;
  }

  async probe(): Promise<{ holds: boolean }> {
    return { holds: false };
  }

  async press(keys: KeyPress[], opts: { gapMs?: number } = {}): Promise<void> {
    const gap = opts.gapMs ?? 0;
    let batch: KeyPress[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await this.adb.shell(this.serial, `input keyevent ${batch.map(keyArg).join(' ')}`, { timeoutMs: 10000 + batch.length * 500 });
      batch = [];
    };
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] as KeyPress;
      if (k.mode === 'press' && gap === 0) {
        batch.push(k);
        continue;
      }
      await flush();
      if (k.mode === 'press') await this.adb.shell(this.serial, `input keyevent ${keyArg(k)}`, { timeoutMs: 10000 });
      else if (k.mode === 'long') await this.adb.shell(this.serial, `input keyevent --longpress ${keyArg(k)}`, { timeoutMs: 15000 });
      else {
        const holdMs = k.holdMs ?? 500;
        await this.adb.shell(this.serial, inputHoldScript(keyArg(k), holdMs), { timeoutMs: holdMs + 20000 });
      }
      if (gap > 0 && i < keys.length - 1) await sleep(gap);
    }
    await flush();
  }
}

/**
 * Quotes text for `input text`, which runs through the device's shell:
 * single-quote it for sh, and spell spaces as %s (input's own escape).
 */
export function escapeInputText(text: string): string {
  if (/[^\x20-\x7e]/.test(text)) {
    throw new FireLabError('unsupported', '`input text` can only type plain ASCII', {
      hint: 'For other characters in a WebView, use webview_eval to set the field value, or type with the on-screen keyboard',
    });
  }
  return `'${text.replace(/'/g, `'\\''`).replace(/ /g, '%s')}'`;
}

export async function typeText(adb: Adb, serial: string, text: string): Promise<void> {
  if (!text) return;
  // Long strings in one `input text` call get dropped by some IMEs: chunk them.
  for (let i = 0; i < text.length; i += 80) {
    await adb.shell(serial, `input text ${escapeInputText(text.slice(i, i + 80))}`, { timeoutMs: 15000 });
  }
}
