/**
 * FireLab remote keys -> Vega `inputd-cli` key names.
 *
 * inputd-cli takes Linux input event codes (linux-event-codes.h). Amazon's
 * page confirms KEY_UP/DOWN/LEFT/RIGHT, KEY_ENTER, KEY_BACK and KEY_MENU; the
 * rest are the standard Linux names for those buttons and are NOT YET
 * VERIFIED on a Vega device (override them with VdaDriverOptions.keyMap).
 */
import type { KeySpec, RemoteKey } from '../driver/types.js';
import { FireLabError } from '../lib/errors.js';

export const VEGA_KEYS: Readonly<Record<RemoteKey, string>> = {
  up: 'KEY_UP', // documented
  down: 'KEY_DOWN', // documented
  left: 'KEY_LEFT', // documented
  right: 'KEY_RIGHT', // documented
  ok: 'KEY_ENTER', // documented
  back: 'KEY_BACK', // documented
  menu: 'KEY_MENU', // documented
  home: 'KEY_HOMEPAGE', // Linux "AC Home"; unverified
  playpause: 'KEY_PLAYPAUSE', // unverified
  rewind: 'KEY_REWIND', // unverified
  fastforward: 'KEY_FASTFORWARD', // unverified
  volup: 'KEY_VOLUMEUP', // unverified
  voldown: 'KEY_VOLUMEDOWN', // unverified
  mute: 'KEY_MUTE', // unverified
  search: 'KEY_SEARCH', // unverified
  wake: 'KEY_WAKEUP', // unverified
};

/** Keys whose Vega name comes from Amazon's inputd-cli page (the rest are standard Linux names). */
export const DOCUMENTED_VEGA_KEYS: readonly RemoteKey[] = ['up', 'down', 'left', 'right', 'ok', 'back', 'menu'];

/**
 * The inputd-cli arguments for one press:
 *   press -> button_press KEY_X
 *   long  -> button_press KEY_X long                 (documented form)
 *   hold  -> button_press KEY_X --holdDuration <ms>  (documented flag; the unit is not stated, milliseconds assumed)
 */
export function inputdArgs(k: KeySpec, keyMap: Readonly<Record<string, string>> = VEGA_KEYS): string[] {
  const name = k && typeof k.key === 'string' ? keyMap[k.key] : undefined;
  if (!name) throw new FireLabError('bad-request', `Unknown remote key "${String(k?.key)}"`, { hint: `Use one of: ${Object.keys(keyMap).join(', ')}` });
  const mode = k.mode ?? 'press';
  if (mode === 'press') return ['button_press', name];
  if (mode === 'long') return ['button_press', name, 'long'];
  if (mode !== 'hold') throw new FireLabError('bad-request', `Unknown key mode "${String(mode)}"`, { hint: 'press, long or hold' });
  const ms = Math.round(k.holdMs ?? 500);
  if (!(ms >= 1 && ms <= 30000)) throw new FireLabError('bad-request', `Hold time for "${k.key}" must be 1-30000 ms`);
  return ['button_press', name, '--holdDuration', String(ms)];
}

/**
 * Escapes text for `inputd-cli send_text`. Amazon's example escapes spaces and
 * punctuation with backslashes ('hello\ world\!'), so every character outside
 * [A-Za-z0-9._-] gets one. Only printable ASCII is accepted.
 */
export function escapeSendText(text: string): string {
  if (typeof text !== 'string' || !text.length) throw new FireLabError('bad-request', 'No text given');
  if (/[^\x20-\x7e]/.test(text)) throw new FireLabError('bad-request', 'Vega text input takes printable ASCII only');
  return text.replace(/[^A-Za-z0-9._-]/g, (c) => `\\${c}`);
}
