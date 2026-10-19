/** Actions: their stable names (graph edges, traces) and how they become driver presses. */
import type { DriverCaps, KeySpec, RemoteKey } from './driver.js';
import { REMOTE_KEYS } from './driver.js';
import type { Action } from './types.js';

/** Gap between the presses of one macro ('ok*3'): short, because timing is part of the input [47]. */
export const MACRO_GAP_MS = 120;
/** Default hold for a long press. */
export const LONG_PRESS_MS = 800;
/**
 * When the driver cannot do real holds (caps.holds false; Fire OS 8 over adb),
 * a hold arrives as repeated key-downs: about one every 50 ms after a 500 ms
 * initial delay, like Android's key repeat. Used to budget a hold's cost.
 */
export const KEY_REPEAT_MS = 50;
export const KEY_REPEAT_DELAY_MS = 500;

/** Edge name as the CONTRACT's key-spec syntax: 'ok', 'down*3', 'ok:long', 'right:1500', 'text:"abc"', 'wait:500', 'relaunch'. */
export function actionKey(a: Action): string {
  switch (a.kind) {
    case 'key': {
      let s: string = a.key;
      if (a.mode === 'long') s += ':long';
      else if (a.mode === 'hold') s += `:${a.holdMs ?? LONG_PRESS_MS}`;
      if (a.repeat && a.repeat > 1) s += `*${a.repeat}`;
      return s;
    }
    case 'text':
      return `text:${JSON.stringify(a.text)}`;
    case 'wait':
      return `wait:${a.ms}`;
    case 'relaunch':
      return 'relaunch';
  }
}

/** Parses the names actionKey() writes (and plain CONTRACT key specs like 'down*3'). */
export function parseActionKey(s: string): Action | undefined {
  if (s === 'relaunch') return { kind: 'relaunch' };
  let m = /^wait:(\d+)$/.exec(s);
  if (m) return { kind: 'wait', ms: Number(m[1]) };
  if (s.startsWith('text:')) {
    try {
      const t: unknown = JSON.parse(s.slice(5));
      return typeof t === 'string' ? { kind: 'text', text: t } : undefined;
    } catch {
      return undefined;
    }
  }
  m = /^([a-z]+)(?::(long|\d+))?(?:\*(\d+))?$/.exec(s);
  if (!m || !REMOTE_KEYS.includes(m[1] as RemoteKey)) return undefined;
  const a: Action = { kind: 'key', key: m[1] as RemoteKey };
  if (m[2] === 'long') a.mode = 'long';
  else if (m[2]) (a.mode = 'hold'), (a.holdMs = Number(m[2]));
  if (m[3] && Number(m[3]) > 1) a.repeat = Number(m[3]);
  return a;
}

/** Driver presses for a key action (a macro expands to its repeats). */
export function keySpecs(a: Extract<Action, { kind: 'key' }>): KeySpec[] {
  const spec: KeySpec = { key: a.key };
  if (a.mode && a.mode !== 'press') spec.mode = a.mode;
  if (a.mode === 'hold') spec.holdMs = a.holdMs ?? LONG_PRESS_MS;
  return Array.from({ length: Math.max(1, a.repeat ?? 1) }, () => ({ ...spec }));
}

/** Rough device time an action costs beyond one plain press (ms), for budgeting macros. */
export function extraCostMs(a: Action, caps: Pick<DriverCaps, 'holds'>): number {
  if (a.kind === 'wait') return a.ms;
  if (a.kind !== 'key') return 0;
  const n = Math.max(1, a.repeat ?? 1);
  let hold = 0;
  if (a.mode === 'long' || a.mode === 'hold') {
    const ms = a.mode === 'hold' ? (a.holdMs ?? LONG_PRESS_MS) : LONG_PRESS_MS;
    // A real hold costs its duration. Repeated key-downs cost the same time and
    // also deliver extra presses the app must process.
    hold = caps.holds ? ms : ms + Math.max(0, Math.floor((ms - KEY_REPEAT_DELAY_MS) / KEY_REPEAT_MS)) * 10;
  }
  return (n - 1) * MACRO_GAP_MS + n * hold;
}

/** The base key of an action (for per-state key statistics), if it is a key. */
export const baseKey = (a: Action): RemoteKey | undefined => (a.kind === 'key' ? a.key : undefined);

export const isPlainKey = (a: Action): boolean => a.kind === 'key' && !a.mode && !(a.repeat && a.repeat > 1);
