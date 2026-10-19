// Virtual remote: buttons with press-and-hold (sent as holdMs), keyboard
// control while the TV screen has focus, the text box and Wake.

import { on, emit, liveDevice } from './store.js';
import { post, dev } from './api.js';
import { $, $$, h } from './dom.js';
import * as toast from './toast.js';

const HOLD_MS = 380;
const MAX_HOLD = 5000;

/** Keyboard map, also used to build the shortcuts dialog. */
export const SHORTCUTS = [
  { key: 'up', label: 'Up', kbd: ['↑'] },
  { key: 'down', label: 'Down', kbd: ['↓'] },
  { key: 'left', label: 'Left', kbd: ['←'] },
  { key: 'right', label: 'Right', kbd: ['→'] },
  { key: 'ok', label: 'OK / select', kbd: ['Enter'] },
  { key: 'back', label: 'Back', kbd: ['Esc', '⌫'] },
  { key: 'home', label: 'Home', kbd: ['H'] },
  { key: 'menu', label: 'Menu', kbd: ['M'] },
  { key: 'playpause', label: 'Play / pause', kbd: ['Space'] },
  { key: 'rewind', label: 'Rewind', kbd: [','] },
  { key: 'fastforward', label: 'Fast forward', kbd: ['.'] },
  { key: 'volup', label: 'Volume up', kbd: ['+'] },
  { key: 'voldown', label: 'Volume down', kbd: ['−'] },
  { key: 'mute', label: 'Mute', kbd: ['0'] },
  { key: 'search', label: 'Search', kbd: ['/', 'S'] },
  { key: 'wake', label: 'Wake', kbd: ['W'] },
];

function mapKey(e) {
  switch (e.key) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'Enter': return 'ok';
    case 'Escape':
    case 'Backspace':
    case 'BrowserBack': return 'back';
    case ' ':
    case 'MediaPlayPause': return 'playpause';
    case ',':
    case '<': return 'rewind';
    case '.':
    case '>': return 'fastforward';
    case '=':
    case '+': return 'volup';
    case '-':
    case '_': return 'voldown';
    case '0': return 'mute';
    case '/': return 'search';
    default:
  }
  switch (e.key.toLowerCase()) {
    case 'h': return 'home';
    case 'm': return 'menu';
    case 's': return 'search';
    case 'w': return 'wake';
    default: return null;
  }
}

/* --------------------------------------------------------------- sending */

let blinkTimer = 0;
function blink(error = false) {
  const led = $('#remote-led');
  led.classList.remove('is-on', 'is-error');
  void led.offsetWidth;
  led.classList.add(error ? 'is-error' : 'is-on');
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => led.classList.remove('is-on', 'is-error'), error ? 600 : 140);
}

export async function sendKeys(keys, opts = {}) {
  const d = liveDevice();
  if (!d) {
    toast.info('No device to send keys to', 'Connect a Fire TV in the panel on the left.');
    return false;
  }
  const body = { keys };
  if (opts.holdMs) body.holdMs = Math.round(opts.holdMs);
  if (opts.gapMs) body.gapMs = Math.round(opts.gapMs);
  emit('keysent', { keys, holdMs: body.holdMs || 0, gapMs: body.gapMs || 0, ts: Date.now() });
  blink();
  try {
    await post(`${dev(d.id)}/keys`, body);
    return true;
  } catch (err) {
    blink(true);
    toast.fail(`Couldn't press ${keys.join(', ')}`, err.message);
    return false;
  }
}

export async function wake() {
  const d = liveDevice();
  if (!d) return;
  emit('keysent', { keys: ['wake'], holdMs: 0, ts: Date.now() });
  blink();
  try {
    await post(`${dev(d.id)}/wake`);
  } catch (err) {
    blink(true);
    toast.fail('Couldn’t wake the TV', err.message);
  }
}

async function sendText(text) {
  const d = liveDevice();
  if (!d || !text) return false;
  blink();
  try {
    await post(`${dev(d.id)}/text`, { text });
    emit('textsent', { text, ts: Date.now() });
    return true;
  } catch (err) {
    blink(true);
    toast.fail('Couldn’t type on the TV', err.message);
    return false;
  }
}

/* ------------------------------------------------------- hold feedback */

let holdTicker = 0;
function holdFeedback(btn, start) {
  const label = $('#remote-hold');
  const remote = $('#remote');
  clearInterval(holdTicker);
  if (!btn) {
    label.classList.remove('is-active');
    remote.classList.remove('is-holding-any');
    label.textContent = 'hold = long press';
    return;
  }
  const tickFn = () => {
    const s = Math.min(MAX_HOLD, performance.now() - start) / 1000;
    label.textContent = `long press · ${s.toFixed(1)} s`;
  };
  label.classList.add('is-active');
  remote.classList.add('is-holding-any');
  tickFn();
  holdTicker = setInterval(tickFn, 100);
}

function fire(btn, dur) {
  if (btn.dataset.action === 'wake') {
    wake();
    return;
  }
  const key = btn.dataset.key;
  if (!key) return;
  sendKeys([key], dur >= HOLD_MS ? { holdMs: Math.min(dur, MAX_HOLD) } : {});
}

function buttonFor(key) {
  return key === 'wake' ? $('#remote [data-action="wake"]') : $(`#remote [data-key="${key}"]`);
}

/* ------------------------------------------------------------------ init */

export function initRemote() {
  const remote = $('#remote');
  let press = null;
  let holdTimer = 0;

  const release = () => {
    if (!press) return;
    press.btn.classList.remove('is-pressed', 'is-holding');
    clearTimeout(holdTimer);
    holdFeedback(null);
    press = null;
  };

  remote.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-key], [data-action]');
    if (!btn || btn.disabled || e.button !== 0) return;
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    press = { btn, start: performance.now(), id: e.pointerId };
    btn.classList.add('is-pressed');
    if (btn.dataset.key) {
      holdTimer = setTimeout(() => {
        if (!press) return;
        btn.classList.add('is-holding');
        holdFeedback(btn, press.start);
      }, HOLD_MS);
    }
  });
  remote.addEventListener('pointerup', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const { btn, start } = press;
    const dur = performance.now() - start;
    release();
    fire(btn, dur);
  });
  remote.addEventListener('pointercancel', release);
  remote.addEventListener('click', (e) => {
    // Keyboard activation (Enter/Space on a focused button) arrives as a click with detail 0.
    if (e.detail !== 0) return;
    const btn = e.target.closest('[data-key], [data-action]');
    if (btn && !btn.disabled) fire(btn, 0);
  });

  // D-pad tooltips live outside the round, clipped ring.
  const dpad = remote.querySelector('.dpad');
  const tip = h('div', { class: 'dpad-tip', hidden: true });
  remote.append(tip);
  dpad.addEventListener('pointerover', (e) => {
    const b = e.target.closest('[data-tip]');
    if (!b) return;
    tip.textContent = b.dataset.tip;
    tip.style.top = `${dpad.offsetTop + dpad.offsetHeight / 2}px`;
    tip.hidden = false;
  });
  dpad.addEventListener('pointerleave', () => {
    tip.hidden = true;
  });

  // Keyboard control while the TV screen has focus.
  const screen = $('#screen');
  const down = new Map();
  screen.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = mapKey(e);
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || down.has(e.code)) return;
    if (!liveDevice()) {
      toast.info('No device to send keys to', 'Connect a Fire TV in the panel on the left.');
      return;
    }
    const start = performance.now();
    const btn = buttonFor(key);
    btn?.classList.add('is-pressed');
    const entry = { key, start, btn, timer: 0 };
    if (key !== 'wake') {
      entry.timer = setTimeout(() => {
        btn?.classList.add('is-holding');
        holdFeedback(btn || screen, start);
      }, HOLD_MS);
    }
    down.set(e.code, entry);
  });
  screen.addEventListener('keyup', (e) => {
    const entry = down.get(e.code);
    if (!entry) return;
    down.delete(e.code);
    e.preventDefault();
    clearTimeout(entry.timer);
    entry.btn?.classList.remove('is-pressed', 'is-holding');
    holdFeedback(null);
    const dur = performance.now() - entry.start;
    if (entry.key === 'wake') wake();
    else sendKeys([entry.key], dur >= HOLD_MS ? { holdMs: Math.min(dur, MAX_HOLD) } : {});
  });
  screen.addEventListener('blur', () => {
    for (const entry of down.values()) {
      clearTimeout(entry.timer);
      entry.btn?.classList.remove('is-pressed', 'is-holding');
    }
    down.clear();
    holdFeedback(null);
  });

  // Text box
  $('#type-box').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#type-input');
    const text = input.value;
    if (!text) {
      input.focus();
      return;
    }
    if (await sendText(text)) input.value = '';
  });

  // Shortcuts dialog
  const grid = $('#kbd-grid');
  grid.replaceChildren(...SHORTCUTS.map((s) => h('div', { class: 'kbd-row' }, h('span', { text: s.label }), h('span', null, s.kbd.map((k) => h('kbd', { text: k }))))));

  const sync = () => {
    const live = !!liveDevice();
    remote.classList.toggle('is-disabled', !live);
    for (const b of $$('button', remote)) b.disabled = !live;
    $('#type-input').disabled = !live;
    $('#type-box button').disabled = !live;
  };
  on('devices', sync);
  on('select', sync);
  on('health', sync);
  sync();
}

