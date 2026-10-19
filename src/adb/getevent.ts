import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Adb } from './client.js';

/** Linux input key names (getevent -l) -> FireLab remote key names. */
const LINUX_KEYS: Record<string, string> = {
  KEY_UP: 'up',
  KEY_DOWN: 'down',
  KEY_LEFT: 'left',
  KEY_RIGHT: 'right',
  KEY_SELECT: 'ok',
  KEY_ENTER: 'ok',
  KEY_KPENTER: 'ok',
  KEY_OK: 'ok',
  BTN_SELECT: 'ok',
  KEY_BACK: 'back',
  KEY_ESC: 'back',
  KEY_HOME: 'home',
  KEY_HOMEPAGE: 'home',
  KEY_MENU: 'menu',
  KEY_COMPOSE: 'menu',
  KEY_PLAYPAUSE: 'playpause',
  KEY_PLAY: 'playpause',
  KEY_PAUSE: 'playpause',
  KEY_PLAYCD: 'playpause',
  KEY_PAUSECD: 'playpause',
  KEY_REWIND: 'rewind',
  KEY_FASTFORWARD: 'fastforward',
  KEY_VOLUMEUP: 'volup',
  KEY_VOLUMEDOWN: 'voldown',
  KEY_MUTE: 'mute',
  KEY_SEARCH: 'search',
  KEY_VOICECOMMAND: 'search',
  KEY_ASSISTANT: 'search',
  KEY_WAKEUP: 'wake',
  KEY_POWER: 'power',
};

/** Linux key codes for when getevent can't label them (hex in the output). */
const LINUX_CODES: Record<number, string> = {
  103: 'KEY_UP', 108: 'KEY_DOWN', 105: 'KEY_LEFT', 106: 'KEY_RIGHT', 353: 'KEY_SELECT', 28: 'KEY_ENTER', 96: 'KEY_KPENTER',
  352: 'KEY_OK', 158: 'KEY_BACK', 1: 'KEY_ESC', 102: 'KEY_HOME', 172: 'KEY_HOMEPAGE', 139: 'KEY_MENU', 127: 'KEY_COMPOSE',
  164: 'KEY_PLAYPAUSE', 207: 'KEY_PLAY', 119: 'KEY_PAUSE', 168: 'KEY_REWIND', 208: 'KEY_FASTFORWARD', 115: 'KEY_VOLUMEUP',
  114: 'KEY_VOLUMEDOWN', 113: 'KEY_MUTE', 217: 'KEY_SEARCH', 582: 'KEY_VOICECOMMAND', 583: 'KEY_ASSISTANT', 143: 'KEY_WAKEUP', 116: 'KEY_POWER',
};

export type RawKey = { kernelTs?: number; device: string; linux: string; key: string; action: 'down' | 'up' | 'repeat' };

/**
 * Parses one line of `getevent -lt` (or `getevent -t` without labels), e.g.
 * "[   5992.123456] /dev/input/event5: EV_KEY       KEY_UP               DOWN".
 * Returns null for non-key lines (EV_SYN, EV_MSC, device add/remove...).
 */
export function parseGeteventLine(line: string): RawKey | null {
  const m = /^\s*(?:\[\s*(\d+\.\d+)\])?\s*(\/dev\/input\/event\d+):\s+(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
  if (!m) return null;
  const [, ts, device, type, codeRaw, valueRaw] = m as unknown as [string, string | undefined, string, string, string, string];
  if (type !== 'EV_KEY' && type !== '0001') return null;
  let linux = codeRaw;
  if (/^[0-9a-f]{4}$/i.test(codeRaw)) linux = LINUX_CODES[parseInt(codeRaw, 16)] ?? `KEY_0x${codeRaw.toLowerCase()}`;
  if (!linux.startsWith('KEY_') && !linux.startsWith('BTN_')) return null;
  if (linux.startsWith('BTN_') && linux !== 'BTN_SELECT') return null; // mouse/touch buttons
  const v = valueRaw.toUpperCase();
  const action = v === 'DOWN' || v === '00000001' ? 'down' : v === 'UP' || v === '00000000' ? 'up' : v === 'REPEAT' || v === '00000002' ? 'repeat' : null;
  if (!action) return null;
  const key = LINUX_KEYS[linux] ?? linux.toLowerCase().replace(/^key_/, '');
  const raw: RawKey = { device, linux, key, action };
  if (ts) raw.kernelTs = Number(ts);
  return raw;
}

export type RecordedKey = { ts: number; key: string; action: 'down' | 'up'; holdMs?: number; device?: string };

/**
 * Records the remote presses a person makes, via `getevent -lt`. Keys that
 * FireLab injects with `input keyevent` don't show up here (they never pass
 * through a kernel input device), so this captures only the human.
 */
export class KeyRecorder extends EventEmitter<{ key: [RecordedKey]; error: [Error]; exit: [] }> {
  private proc?: ChildProcessWithoutNullStreams;
  private buf = '';
  private downAt = new Map<string, number>();
  readonly keys: RecordedKey[] = [];

  constructor(
    private readonly adb: Adb,
    private readonly serial: string,
  ) {
    super();
  }

  start(): void {
    if (this.proc) return;
    const p = this.adb.spawn(['-s', this.serial, 'shell', 'getevent -lt']);
    this.proc = p;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk: string) => this.feed(chunk));
    p.on('error', (e) => this.emit('error', e));
    p.on('exit', () => {
      this.proc = undefined;
      this.emit('exit');
    });
  }

  /** Feeds raw getevent output (exposed for tests). */
  feed(chunk: string, now = Date.now()): void {
    this.buf += chunk;
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop() ?? '';
    for (const line of parts) {
      const r = parseGeteventLine(line);
      if (!r || r.action === 'repeat') continue;
      const ev: RecordedKey = { ts: now, key: r.key, action: r.action, device: r.device };
      const k = `${r.device}:${r.linux}`;
      if (r.action === 'down') this.downAt.set(k, r.kernelTs ?? now / 1000);
      else {
        const t0 = this.downAt.get(k);
        if (t0 !== undefined) ev.holdMs = Math.max(0, Math.round(((r.kernelTs ?? now / 1000) - t0) * 1000));
        this.downAt.delete(k);
      }
      this.keys.push(ev);
      this.emit('key', ev);
    }
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
  }
}

/** Linux key name -> code (the inverse of the table above), for `sendevent`. */
export const LINUX_KEY_CODES: Record<string, number> = Object.fromEntries(Object.entries(LINUX_CODES).map(([code, name]) => [name, Number(code)]));
LINUX_KEY_CODES.BTN_SELECT = 0x13a;

export type InputDevice = {
  /** e.g. /dev/input/event5 */
  path: string;
  name: string;
  /** Key and button names the device can send (KEY_UP, BTN_SELECT...). */
  keys: string[];
};

/**
 * Parses `getevent -lp` (or `getevent -p`): every input device with its name
 * and the keys it declares. A device that isn't listed doesn't exist as far as
 * Android's input reader is concerned.
 */
export function parseGeteventDevices(text: string): InputDevice[] {
  const out: InputDevice[] = [];
  let cur: InputDevice | undefined;
  let inKeys = false;
  for (const line of text.split(/\r?\n/)) {
    const add = /^add device \d+:\s*(\S+)/.exec(line);
    if (add) {
      cur = { path: add[1] as string, name: '', keys: [] };
      out.push(cur);
      inKeys = false;
      continue;
    }
    if (!cur) continue;
    const name = /^\s+name:\s+"(.*)"\s*$/.exec(line);
    if (name) {
      cur.name = name[1] as string;
      continue;
    }
    // "    KEY (0001): KEY_UP ..." with -l, "    0001: 0067 ..." without.
    const cat = /^\s{2,}(?:[A-Z]{2,4}\s*\(([0-9a-f]{4})\)|([0-9a-f]{4})):\s*(.*)$/i.exec(line);
    let rest: string | undefined;
    if (cat) {
      inKeys = (cat[1] ?? cat[2]) === '0001';
      rest = cat[3];
    } else if (inKeys && /^\s{6,}\S/.test(line) && !/:\s*$/.test(line)) rest = line;
    else if (/^\s+\S.*:/.test(line)) inKeys = false;
    if (!inKeys || rest === undefined) continue;
    for (const tok of rest.trim().split(/\s+/)) {
      if (/^(KEY|BTN)_[A-Z0-9_]+$/.test(tok)) cur.keys.push(tok);
      else if (/^[0-9a-f]{4}$/i.test(tok)) {
        const n = LINUX_CODES[parseInt(tok, 16)];
        if (n) cur.keys.push(n);
        else if (parseInt(tok, 16) === 0x13a) cur.keys.push('BTN_SELECT');
      }
    }
  }
  return out;
}
