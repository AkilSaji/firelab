// Watch pane: start/stop watching a person play on the selected device, live
// counters while recording, and the list of sessions with their thumbnails.

import { api, post, dev } from './api.js';
import { state, on, emit, liveDevice, deviceLabel } from './store.js';
import { $, h, icon, mount, storage } from './dom.js';
import { dateTime, duration, stopwatch } from './format.js';
import * as toast from './toast.js';

let sessions = [];
let loadError = null;
let active = null; // { sessionId, device, startedAt }
let live = { keys: 0, errors: 0, memMax: 0, fps: null };
let clockTimer = 0;
let refreshTimer = 0;
let busy = false;

function deviceName(id) {
  const d = state.devices.find((x) => x.id === id);
  if (d) return deviceLabel(d);
  const k = storage('firelab.known', {})[id];
  return k?.name || id;
}

function thumbSrc(t) {
  if (typeof t !== 'string' || !t) return '';
  if (/^(data:|blob:|https?:|\/)/.test(t)) return t;
  return `data:image/jpeg;base64,${t}`;
}

export async function loadSessions() {
  try {
    const list = await api('/sessions');
    sessions = (Array.isArray(list) ? list : []).sort((a, b) => b.startedAt - a.startedAt);
    loadError = null;
  } catch (err) {
    loadError = err.message;
  }
  // Pick up a session that is already running on this device (e.g. after a reload).
  const running = sessions.find((s) => !s.endedAt && s.device === state.selectedId);
  if (running && !active) {
    active = { sessionId: running.sessionId, device: running.device, startedAt: running.startedAt };
    live = { keys: running.keys || 0, errors: running.errors || 0, memMax: running.memMB?.max || 0, fps: null };
    startClock();
  }
  if (active && !sessions.some((s) => s.sessionId === active.sessionId) && Date.now() - active.startedAt > 5000) {
    active = null;
    stopClock();
  }
  render();
}

function startClock() {
  stopClock();
  state.watching = active;
  $('#dot-watch').hidden = false;
  clockTimer = setInterval(renderControls, 1000);
  refreshTimer = setInterval(loadSessions, 5000);
  emit('watching', active);
}

function stopClock() {
  clearInterval(clockTimer);
  clearInterval(refreshTimer);
  state.watching = null;
  $('#dot-watch').hidden = true;
  emit('watching', null);
}

async function toggle() {
  if (busy) return;
  const d = liveDevice();
  busy = true;
  renderControls();
  try {
    if (active) {
      const summary = await post(`${dev(active.device)}/watch/stop`);
      const i = sessions.findIndex((s) => s.sessionId === summary.sessionId);
      if (i >= 0) sessions[i] = summary;
      else sessions.unshift(summary);
      toast.ok('Watch session saved', `${summary.keys} key presses over ${duration((summary.endedAt || Date.now()) - summary.startedAt)}`);
      active = null;
      stopClock();
    } else {
      if (!d) {
        toast.info('Connect a device first');
        return;
      }
      const pkg = $('#watch-pkg').value;
      const intervalMs = Number($('#watch-interval').value) || 5000;
      const res = await post(`${dev(d.id)}/watch/start`, { ...(pkg ? { package: pkg } : {}), intervalMs });
      active = { sessionId: res.sessionId, device: d.id, startedAt: Date.now() };
      live = { keys: 0, errors: 0, memMax: 0, fps: null };
      startClock();
      toast.info('Watching', 'Hand the remote to your player. FireLab records their presses, fps, memory and errors.');
      setTimeout(loadSessions, 1200);
    }
  } catch (err) {
    toast.fail(active ? 'Couldn’t stop watching' : 'Couldn’t start watching', err.message);
    if (/not watching/i.test(err.message)) {
      active = null;
      stopClock();
    }
  } finally {
    busy = false;
    render();
  }
}

/* ---------------------------------------------------------------- render */

function renderControls() {
  const btn = $('#rec-btn');
  const d = liveDevice();
  const rec = !!active;
  btn.setAttribute('aria-pressed', String(rec));
  btn.disabled = busy || (!rec && !d);
  btn.querySelector('.rec-label').textContent = rec ? 'Stop watching' : 'Start watching';
  btn.title = rec ? 'Stop and save the session' : 'Start watching';
  const time = $('#rec-time');
  time.classList.toggle('is-idle', !rec);
  time.textContent = rec ? stopwatch(Date.now() - active.startedAt) : 'Start watching';
  $('#rec-sub').textContent = rec
    ? `Recording ${deviceName(active.device)}. Press stop to save the session.`
    : d
      ? 'Records remote presses, fps, memory, errors and a thumbnail strip while someone plays.'
      : 'Connect a device to watch someone play it.';
  $('#rec-stats').classList.toggle('is-idle', !rec);
  $('#rec-keys').textContent = rec ? String(live.keys) : '0';
  $('#rec-fps').textContent = rec && live.fps != null ? live.fps.toFixed(0) : '—';
  $('#rec-mem').textContent = rec && live.memMax ? `${Math.round(live.memMax)}` : '—';
  $('#rec-errors').textContent = rec ? String(live.errors) : '0';
  $('#watch-pkg').disabled = rec || !d;
  $('#watch-interval').disabled = rec || !d;
}

function stat(label, value, unit, bad = false) {
  return h('div', { class: bad ? 'is-bad' : '' }, h('span', { text: label }), h('b', null, value, unit ? h('small', { text: unit }) : null));
}

function sessionItem(s) {
  const isLive = !s.endedAt;
  const dur = (s.endedAt || Date.now()) - s.startedAt;
  const thumbs = (s.thumbnails || []).map(thumbSrc).filter(Boolean);
  return h('li', { class: `session${isLive ? ' is-live' : ''}` },
    h('div', { class: 'session-head' },
      h('span', { class: 'session-title', text: deviceName(s.device) }),
      isLive ? h('span', { class: 'live-chip' }, h('span', { class: 'tally is-live' }), 'recording') : null,
      h('span', { class: 'session-when', text: `${dateTime(s.startedAt)} · ${duration(dur)}` }),
      h('span', { class: 'session-id', text: s.sessionId })),
    h('div', { class: 'session-stats' },
      stat('keys', String(s.keys ?? 0)),
      stat('fps median', s.fps ? s.fps.median.toFixed(1) : '—'),
      stat('fps p10', s.fps ? s.fps.p10.toFixed(1) : '—'),
      stat('max memory', s.memMB ? String(Math.round(s.memMB.max)) : '—', s.memMB ? 'MB' : ''),
      stat('errors', String(s.errors ?? 0), '', (s.errors || 0) > 0)),
    thumbs.length
      ? h('div', { class: 'thumbs' }, thumbs.map((src, i) => h('button', {
        class: 'thumb', type: 'button', 'aria-label': `Open frame ${i + 1} of ${thumbs.length}`,
        onclick: () => openLightbox(s, thumbs, i),
      }, h('img', { src, alt: '', loading: 'lazy', decoding: 'async' }), h('span', { text: `#${i + 1}` }))))
      : h('div', { class: 'thumbs-empty', text: isLive ? 'Thumbnails appear as they are captured…' : 'No thumbnails in this session.' }));
}

function render() {
  renderControls();
  $('#sessions-count').textContent = String(sessions.length);
  const list = $('#session-list');
  if (loadError && !sessions.length) mount(list, h('li', { class: 'pane-empty' }, icon('alert'), h('b', { text: 'Couldn’t load sessions' }), h('span', { text: loadError })));
  else if (!sessions.length) mount(list, h('li', { class: 'pane-empty' }, icon('eye'), h('b', { text: 'No sessions yet' }), h('span', { text: 'Start watching, hand the remote to a player, and stop when they are done. Each session keeps its key presses, performance and thumbnails.' })));
  else mount(list, sessions.map(sessionItem));
}

/* -------------------------------------------------------------- lightbox */

let lb = null;
function openLightbox(s, thumbs, i) {
  lb = { s, thumbs, i };
  showFrame();
  const dlg = $('#lightbox');
  if (!dlg.open) dlg.showModal();
}

function showFrame() {
  const { s, thumbs, i } = lb;
  $('#lightbox-img').src = thumbs[i];
  $('#lightbox-img').alt = `Frame ${i + 1} of session ${s.sessionId}`;
  $('#lightbox-cap').textContent = `${deviceName(s.device)} · ${s.sessionId} · frame ${i + 1} of ${thumbs.length} · ← → to step`;
}

/* ------------------------------------------------------------------ init */

export function initWatch() {
  $('#rec-btn').addEventListener('click', toggle);
  $('#sessions-refresh').addEventListener('click', loadSessions);
  $('#lightbox').addEventListener('keydown', (e) => {
    if (!lb) return;
    if (e.key === 'ArrowRight') lb.i = (lb.i + 1) % lb.thumbs.length;
    else if (e.key === 'ArrowLeft') lb.i = (lb.i - 1 + lb.thumbs.length) % lb.thumbs.length;
    else return;
    e.preventDefault();
    showFrame();
  });
  on('key', (e) => {
    if (active && e.action === 'down') {
      live.keys += 1;
      renderControls();
    }
  });
  on('log', (e) => {
    if (active && e.level === 'error') live.errors += 1;
  });
  on('perf', (e) => {
    if (!active) return;
    if (e.fps != null) live.fps = e.fps;
    if (e.memMB) live.memMax = Math.max(live.memMax, e.memMB);
  });
  on('apps', (apps) => {
    const sel = $('#watch-pkg');
    const cur = sel.value;
    mount(sel, h('option', { value: '', text: 'foreground app' }), apps.map((a) => h('option', { value: a.package, text: a.label || a.package })));
    sel.value = apps.some((a) => a.package === cur) ? cur : '';
  });
  on('select', () => {
    // A recording keeps running on its own device even if you look at another one.
    renderControls();
    loadSessions();
  });
  on('devices', renderControls);
  loadSessions();
}
