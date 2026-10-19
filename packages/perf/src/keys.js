// A remote-friendly toggle: tap a key twice quickly.
//
// Fire TV remotes repeat keydown while a button is held, so taps are counted
// on keyup, and only short presses count. Events are only observed, never
// cancelled: the app still sees every key.

/** Keys that toggle the meter by default: the remote's rewind button, or ` on a keyboard. */
export const DEFAULT_TOGGLE_KEYS = Object.freeze(['MediaRewind', 'Backquote']);

/** keyCodes some TV browsers send instead of a `key` name (Fire TV 227, HbbTV / LG / Samsung 412). */
const KEYCODE_NAMES = /** @type {Record<number, string>} */ ({ 227: 'MediaRewind', 412: 'MediaRewind', 228: 'MediaFastForward', 417: 'MediaFastForward', 179: 'MediaPlayPause' });

/**
 * The name a key event matches against: `key`, `code`, or a known keyCode.
 * @param {{ key?: string, code?: string, keyCode?: number }} e
 * @returns {string[]}
 */
export function keyNames(e) {
  const names = [];
  if (e.key) names.push(e.key);
  if (e.code && e.code !== e.key) names.push(e.code);
  const byCode = e.keyCode ? KEYCODE_NAMES[e.keyCode] : undefined;
  if (byCode && !names.includes(byCode)) names.push(byCode);
  return names;
}

/**
 * @typedef {object} TapDetector
 * @property {(e: { type: string, key?: string, code?: string, keyCode?: number, repeat?: boolean, target?: any }, now: number) => boolean} handle
 *   feed a keydown/keyup; returns true when this event completed the combo
 */

/**
 * Pure tap counter, so it can be tested without a DOM.
 * @param {{ keys?: readonly string[], taps?: number, withinMs?: number, maxPressMs?: number }} [opts]
 * @returns {TapDetector}
 */
export function createTapDetector(opts = {}) {
  const keys = new Set(opts.keys ?? DEFAULT_TOGGLE_KEYS);
  const taps = Math.max(1, opts.taps ?? 2);
  const withinMs = opts.withinMs ?? 600;
  const maxPressMs = opts.maxPressMs ?? 450;
  let down = false;
  let downAt = 0;
  let downKey = '';
  let count = 0;
  let lastTapAt = 0;
  return {
    handle(e, now) {
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable)) return false;
      const name = keyNames(e).find((k) => keys.has(k));
      if (!name) {
        if (e.type === 'keydown') count = 0; // any other key breaks the combo
        return false;
      }
      if (e.type === 'keydown') {
        if (!down) {
          down = true;
          downAt = now;
          downKey = name;
        }
        return false;
      }
      if (e.type !== 'keyup' || !down || name !== downKey) return false;
      const short = now - downAt <= maxPressMs;
      down = false;
      if (!short) {
        count = 0;
        return false;
      }
      count = now - lastTapAt <= withinMs ? count + 1 : 1;
      lastTapAt = now;
      if (count >= taps) {
        count = 0;
        return true;
      }
      return false;
    },
  };
}

/**
 * Listens on `target` (default window) and calls onToggle when the combo is
 * pressed. Returns a function that removes the listeners.
 * @param {{ target?: EventTarget, keys?: readonly string[], taps?: number, withinMs?: number, now?: () => number, onToggle: () => void }} opts
 * @returns {() => void}
 */
export function listenForToggle(opts) {
  const target = opts.target ?? (typeof window !== 'undefined' ? window : null);
  if (!target) return () => {};
  const detector = createTapDetector(opts);
  const now = opts.now ?? (() => performance.now());
  /** @param {Event} e */
  const onKey = (e) => {
    if (detector.handle(/** @type {KeyboardEvent} */ (e), now())) opts.onToggle();
  };
  target.addEventListener('keydown', onKey, true);
  target.addEventListener('keyup', onKey, true);
  return () => {
    target.removeEventListener('keydown', onKey, true);
    target.removeEventListener('keyup', onKey, true);
  };
}
