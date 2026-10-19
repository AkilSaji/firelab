// Live screen mirror. Polls /api/devices/:id/screen.jpg at an adaptive 2–5 fps
// (slower when frames take longer), pauses when the tab is hidden, and shows
// a "no signal" picture with setup help whenever there is nothing to mirror.

import { state, on, selected, liveDevice, deviceLabel } from './store.js';
import { dev } from './api.js';
import { $, h, icon, mount, storage, save } from './dom.js';
import { clock, pad, KEY_GLYPH } from './format.js';
import { runScan, connect } from './devices.js';
import * as toast from './toast.js';

const MIN_INTERVAL = 200; // 5 fps
const MAX_INTERVAL = 500; // 2 fps

let img;
let screen;
let running = false;
let loopId = 0;
let timer = 0;
let ctrl = null;
let inflight = false;
let prevUrl = null;
let errors = 0;
let lastError = '';
let gotFrame = false;
let lastFrameAt = 0;
let rtt = 0;
let frameTimes = [];
let paused = storage('firelab.mirrorPaused', false);
let quality = storage('firelab.mirrorQuality', 960);
let overlayKey = '';

const shouldRun = () => !!liveDevice() && !paused && !document.hidden && state.server !== 'down';

function update() {
  const want = shouldRun();
  if (want && !running) start();
  // Hidden page: let the frame in flight land (slow sticks take seconds per frame) and just stop asking for more.
  else if (!want && running) stop({ abort: !document.hidden });
  render();
}

function start() {
  running = true;
  // A frame still on its way (after a hidden-page pause) keeps its loop going.
  if (inflight) return;
  loopId += 1;
  tick(loopId);
}

function stop({ abort = true } = {}) {
  running = false;
  clearTimeout(timer);
  if (abort) {
    loopId += 1; // the cancelled frame's loop ends; the next start() begins a fresh one
    inflight = false;
    ctrl?.abort();
    ctrl = null;
  }
}

function resetPicture() {
  stop();
  gotFrame = false;
  errors = 0;
  lastError = '';
  frameTimes = [];
  rtt = 0;
  img.hidden = true;
  img.removeAttribute('src');
  if (prevUrl) URL.revokeObjectURL(prevUrl);
  prevUrl = null;
}

async function tick(id) {
  if (!running || id !== loopId) return;
  const d = liveDevice();
  if (!d) return;
  const t0 = performance.now();
  inflight = true;
  ctrl = new AbortController();
  const killer = setTimeout(() => ctrl?.abort(new DOMException('timeout', 'TimeoutError')), 8000);
  let ok = false;
  try {
    const res = await fetch(`/api${dev(d.id)}/screen.jpg?w=${quality}&t=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) {
      let msg = `The server answered ${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {
        /* not JSON */
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const probe = new Image();
    probe.src = url;
    await probe.decode();
    if (id !== loopId || d.id !== state.selectedId) {
      URL.revokeObjectURL(url);
      return;
    }
    img.src = url;
    img.hidden = false;
    if (prevUrl) URL.revokeObjectURL(prevUrl);
    prevUrl = url;
    ok = true;
    errors = 0;
    lastError = '';
    gotFrame = true;
    lastFrameAt = Date.now();
    const dt = performance.now() - t0;
    rtt = rtt ? rtt * 0.7 + dt * 0.3 : dt;
    const now = performance.now();
    frameTimes.push(now);
    while (frameTimes.length && frameTimes[0] < now - 3000) frameTimes.shift();
  } catch (err) {
    if (err?.name === 'AbortError' && id !== loopId) return;
    if (!running) return;
    errors += 1;
    lastError = err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'The screenshot took too long' : err?.message || 'Screenshot failed';
  } finally {
    clearTimeout(killer);
    inflight = false;
  }
  render();
  if (!running || id !== loopId) return;
  const elapsed = performance.now() - t0;
  const wait = ok
    ? Math.max(15, Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, elapsed * 1.3)) - elapsed)
    : Math.min(5000, 600 * 2 ** Math.min(errors, 3));
  timer = setTimeout(() => tick(id), wait);
}

function mirrorFps() {
  if (frameTimes.length < 2) return 0;
  const span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
  return span > 0 ? (frameTimes.length - 1) / span : 0;
}

/* -------------------------------------------------------------- overlays */

function setupCard() {
  return h(
    'div',
    { class: 'ov-card' },
    h('h3', null, icon('tv'), 'Connect a Fire TV'),
    h(
      'ol',
      { class: 'steps steps-compact' },
      h('li', null, 'On the TV open ', h('b', { text: 'Settings → My Fire TV → About' }), ' and select the device name ', h('b', { text: '7 times' }), ' until it says you are a developer.'),
      h('li', null, h('b', { text: 'Settings → My Fire TV → Developer options → ADB debugging' }), ': On.'),
      h('li', null, 'With the TV on the same Wi-Fi as this computer, scan for it. Then pick ', h('b', { text: 'Allow' }), ' on the TV’s “Allow USB debugging?” prompt.'),
    ),
    h(
      'div',
      { class: 'ov-actions' },
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => runScan() }, icon('radar'), 'Scan Wi-Fi'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => $('#connect-ip').focus() }, icon('plug'), 'I know its IP'),
    ),
  );
}

function card(ic, title, body, actions = []) {
  return h('div', { class: 'ov-card' }, h('h3', null, icon(ic), title), ...[].concat(body).map((t) => (typeof t === 'string' ? h('p', { text: t }) : t)), actions.length ? h('div', { class: 'ov-actions' }, actions) : null);
}

function signal(title, sub, spin = false) {
  return h('div', { class: 'ov-signal' }, spin ? h('div', { class: 'ov-spinner' }) : null, h('strong', { text: title }), sub ? h('span', { text: sub }) : null);
}

function overlayFor() {
  const d = selected();
  if (state.server === 'down') {
    return ['down', card('alert', 'Can’t reach the FireLab server', ['The dashboard reconnects on its own once the server is back. To start it again run:', h('p', null, h('code', { text: 'npx firelab ui' }))])];
  }
  if (state.health && !state.health.adb) {
    return ['noadb', card('alert', 'adb is not installed', ['FireLab drives TVs with Android’s adb. The panel on the left has the install command for your OS. Then run ', h('p', null, h('code', { text: 'npx firelab doctor' }))])];
  }
  if (state.server !== 'up') return ['boot', signal('STARTING', 'Talking to the FireLab server…', true)];
  if (!state.devices.length) return ['setup', setupCard()];
  if (!d) return ['pick', signal('NO DEVICE', 'Pick a device on the left')];
  if (d.state === 'unauthorized') {
    return [`unauth:${d.id}`, card('alert', 'Allow debugging on the TV', ['The TV is showing “Allow USB debugging?”. Pick Allow and tick “Always allow from this computer”. If there is no prompt, turn ADB debugging off and on again.'], [h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => connect(d.id) }, icon('refresh'), 'Retry')])];
  }
  if (d.state === 'offline') {
    return [`offline:${d.id}`, card('alert', `${deviceLabel(d)} is offline`, ['adb can see it but it isn’t answering. Wake it with its own remote, check it is on the same Wi-Fi, then reconnect.'], [h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => connect(d.id) }, icon('plug'), 'Reconnect')])];
  }
  if (d.state === 'connecting') return ['connecting', signal('CONNECTING', d.id, true)];
  if (paused && gotFrame) return ['paused', signal('PAUSED', 'Mirror paused. Press play in the bar below.')];
  if (paused) return ['paused0', signal('PAUSED', 'Mirror paused. Press play in the bar below.')];
  if (!gotFrame) return errors >= 2 ? [`nosig:${lastError}`, signal('NO SIGNAL', lastError)] : ['tuning', signal('TUNING IN', `First frame from ${d.ip || d.id}…`, true)];
  if (errors >= 2) return [`lost:${lastError}`, signal('SIGNAL LOST', `${lastError}. Retrying…`)];
  if (state.live && state.live.screenOn === false) {
    return ['off', card('power', 'The TV screen is off', ['It is probably asleep. Wake it to keep testing.'], [h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => import('./remote.js').then((m) => m.wake()) }, icon('power'), 'Wake')])];
  }
  return ['', null];
}

function render() {
  if (!screen) return;
  const d = selected();
  const live = !!liveDevice();
  const [key, content] = overlayFor();
  if (key !== overlayKey) {
    overlayKey = key;
    mount($('#screen-overlay'), content);
  }
  const picture = live && gotFrame;
  screen.classList.toggle('has-picture', picture);
  screen.classList.toggle('is-stale', picture && errors >= 2);
  screen.classList.toggle('is-paused', picture && paused);
  img.alt = d ? `Live screen of ${deviceLabel(d)}` : '';

  // HUD
  const streaming = live && running && gotFrame && errors < 2;
  $('#hud-tally').classList.toggle('is-live', streaming);
  $('#hud-name').textContent = d ? `${streaming ? 'live' : live ? 'standby' : d.state} · ${d.model || d.id}` : 'no device';
  $('#hud-time').textContent = lastFrameAt && live ? clock(lastFrameAt) : '--:--:--';
  $('#tv-led').classList.toggle('is-on', live && state.live?.screenOn !== false);

  // bar
  const liveEl = $('#mirror-live');
  liveEl.classList.toggle('is-live', streaming);
  liveEl.querySelector('.tally').classList.toggle('is-live', streaming);
  $('#mirror-status').textContent = !d ? 'No device' : !live ? d.state : paused ? 'Paused' : errors >= 2 ? 'No signal' : gotFrame ? 'Live' : 'Tuning';
  const fps = mirrorFps();
  $('#mirror-rate').textContent = streaming && fps ? `${fps.toFixed(1)} fps · ${Math.round(rtt)} ms` : '';
  const fg = live ? state.live?.foreground || '' : '';
  const fgEl = $('#mirror-fg');
  if (fgEl.dataset.fg !== fg) {
    fgEl.dataset.fg = fg;
    mount(fgEl, fg ? [icon('apps'), h('span', { text: fg })] : null);
  }
  const pauseBtn = $('#mirror-pause');
  pauseBtn.setAttribute('aria-pressed', String(paused));
  pauseBtn.title = paused ? 'Resume the mirror' : 'Pause the mirror';
  pauseBtn.setAttribute('aria-label', pauseBtn.title);
  pauseBtn.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
  for (const id of ['#mirror-pause', '#mirror-shot', '#mirror-full']) $(id).disabled = !live;
  $('#mirror-quality').disabled = !live;
}

/* ------------------------------------------------------------ key flash */

function flash(label, sub) {
  const host = $('#screen-keyflash');
  const el = h('span', { class: 'keyflash' }, label, sub ? h('small', { text: sub }) : null);
  host.append(el);
  while (host.children.length > 5) host.firstChild.remove();
  setTimeout(() => el.remove(), 1150);
}

/* ------------------------------------------------------------- actions */

async function screenshot() {
  const d = liveDevice();
  if (!d) return;
  const btn = $('#mirror-shot');
  btn.disabled = true;
  try {
    const res = await fetch(`/api${dev(d.id)}/screen.jpg?w=1920&t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const ext = blob.type.includes('png') ? 'png' : blob.type.includes('svg') ? 'svg' : 'jpg';
    const t = new Date();
    const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
    const name = `firelab-${(d.model || 'tv').toLowerCase()}-${stamp}.${ext}`;
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast.ok('Screenshot saved', name);
  } catch (err) {
    toast.fail('Couldn’t take a screenshot', err.message);
  } finally {
    btn.disabled = !liveDevice();
  }
}

export function initScreen() {
  img = $('#screen-img');
  screen = $('#screen');
  $('#mirror-quality').value = String(quality);
  screen.addEventListener('pointerdown', () => screen.focus());
  const hint = $('#focus-hint span');
  screen.addEventListener('focus', () => {
    hint.textContent = 'Keyboard → TV · Tab to leave';
  });
  screen.addEventListener('blur', () => {
    hint.textContent = 'Click the screen to drive the TV with your keyboard';
  });
  $('#mirror-pause').addEventListener('click', () => {
    paused = !paused;
    save('firelab.mirrorPaused', paused);
    update();
  });
  $('#mirror-quality').addEventListener('change', (e) => {
    quality = Number(e.target.value) || 960;
    save('firelab.mirrorQuality', quality);
  });
  $('#mirror-shot').addEventListener('click', screenshot);
  $('#mirror-full').addEventListener('click', () => {
    const tv = $('#tv');
    if (document.fullscreenElement) document.exitFullscreen();
    else tv.requestFullscreen?.().then(() => screen.focus()).catch(() => {});
  });
  document.addEventListener('visibilitychange', update);
  on('select', () => {
    resetPicture();
    update();
  });
  on('devices', update);
  on('health', update);
  on('state', render);
  on('keysent', ({ keys, holdMs }) => {
    for (const k of keys) flash(KEY_GLYPH[k] || k.toUpperCase(), holdMs ? `hold ${(holdMs / 1000).toFixed(1)}s` : null);
  });
  on('textsent', ({ text }) => flash(`“${text.length > 24 ? `${text.slice(0, 24)}…` : text}”`, 'text'));
  render();
}
