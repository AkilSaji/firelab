// Devices rail + top-bar device summary + server health.

import { api, post, dev, ApiError } from './api.js';
import { state, on, emit, select, selected, deviceLabel } from './store.js';
import { $, h, icon, mount, storage, save, copyText } from './dom.js';
import { ago, shortGpu, TIER_INFO } from './format.js';
import * as toast from './toast.js';

const POLL_MS = 3000;
const HEALTH_MS = 10000;
let scan = { status: 'idle', found: [], error: null, subnet: null };
let busy = new Set(); // device ids with a connect/disconnect in flight
let devTimer = 0;
let search = '';
let healthTimer = 0;

/* ------------------------------------------------------------- polling */

export async function refreshDevices() {
  clearTimeout(devTimer);
  try {
    const list = await api('/devices', { timeout: 15000 });
    state.devices = Array.isArray(list) ? list : [];
    state.devicesError = null;
    setServer('up');
    rememberKnown(state.devices);
  } catch (err) {
    state.devicesError = err.message;
    if (err instanceof ApiError && err.network) setServer('down');
    else state.devices = [];
  }
  ensureSelection();
  emit('devices', state.devices);
  render();
  devTimer = setTimeout(refreshDevices, document.hidden ? POLL_MS * 4 : POLL_MS);
}

export async function refreshHealth() {
  clearTimeout(healthTimer);
  try {
    state.health = await api('/health', { timeout: 8000 });
    setServer('up');
  } catch (err) {
    if (err instanceof ApiError && err.network) setServer('down');
  }
  emit('health', state.health);
  renderHealth();
  render();
  healthTimer = setTimeout(refreshHealth, state.server === 'down' ? 3000 : HEALTH_MS);
}

function setServer(s) {
  if (state.server === s) return;
  const was = state.server;
  state.server = s;
  $('#server-banner').hidden = s !== 'down';
  emit('health', state.health);
  if (s === 'up' && was === 'down') {
    toast.ok('Back in touch with the FireLab server');
    refreshHealth();
  }
}

function ensureSelection() {
  const list = state.devices;
  const cur = list.find((d) => d.id === state.selectedId);
  if (cur) return;
  const next = list.find((d) => d.state === 'device') || list[0] || null;
  if (next || state.server === 'up') select(next ? next.id : null);
}

/* ---------------------------------------------------------- known list */

function rememberKnown(list) {
  const known = storage('firelab.known', {});
  let changed = false;
  for (const d of list) {
    if (d.state !== 'device' || !d.name) continue;
    known[d.id] = { name: d.name, model: d.model, seen: Date.now() };
    changed = true;
  }
  if (changed) save('firelab.known', known);
}

function knownNotConnected() {
  const known = storage('firelab.known', {});
  const ids = new Set(state.devices.map((d) => d.id));
  return Object.entries(known)
    .filter(([id]) => !ids.has(id))
    .sort((a, b) => b[1].seen - a[1].seen)
    .slice(0, 5);
}

/* ------------------------------------------------------------- actions */

export function normalizeId(raw) {
  const v = String(raw).trim();
  if (!v) return '';
  return /:\d+$/.test(v) ? v : `${v}:5555`;
}

export async function connect(raw) {
  const id = normalizeId(raw);
  if (!id) return;
  busy.add(id);
  render();
  try {
    const d = await post(`${dev(id)}/connect`);
    if (d?.state === 'unauthorized') toast.info(`${id} needs permission`, 'Pick “Allow” on the TV’s “Allow USB debugging?” prompt.');
    else toast.ok(`Connected ${deviceLabel(d) || id}`);
    select(id);
  } catch (err) {
    toast.fail(`Couldn't connect to ${id}`, err.message);
  } finally {
    busy.delete(id);
    await refreshDevices();
  }
}

export async function disconnect(id) {
  busy.add(id);
  render();
  try {
    await post(`${dev(id)}/disconnect`);
    toast.info(`Disconnected ${id}`);
  } catch (err) {
    toast.fail(`Couldn't disconnect ${id}`, err.message);
  } finally {
    busy.delete(id);
    await refreshDevices();
  }
}

export async function runScan(subnet) {
  if (scan.status === 'scanning') return;
  scan = { status: 'scanning', found: [], error: null, subnet: subnet || null };
  render();
  const btn = $('#scan-btn');
  btn.classList.add('is-busy');
  btn.disabled = true;
  try {
    const res = await post('/scan', subnet ? { subnet } : {}, { timeout: 120000 });
    scan = { status: 'done', found: res?.found || [], error: null, subnet: res?.subnet || subnet || null };
  } catch (err) {
    scan = { status: 'error', found: [], error: err.message, subnet };
  } finally {
    btn.classList.remove('is-busy');
    btn.disabled = false;
    render();
  }
}

/* -------------------------------------------------------------- render */

const STATE_DOT = { device: 'ok', offline: '', unauthorized: 'warn', connecting: 'busy' };

function deviceItem(d) {
  const isSel = d.id === state.selectedId;
  const sub = [d.model, d.os?.replace(/\s*\(.*\)/, '')].filter(Boolean).join(' · ');
  const li = h('li', { class: `device${isSel ? ' is-selected' : ''}${d.state !== 'device' ? ' has-hint' : ''}` });
  const main = h(
    'button',
    {
      class: 'device-main',
      type: 'button',
      'aria-pressed': String(isSel),
      title: d.tier ? `Tier ${d.tier}: ${TIER_INFO[d.tier]}` : d.id,
      onclick: () => select(d.id),
    },
    h('span', { class: 'device-icon' }, icon('tv'), h('span', { class: `dot dot--${STATE_DOT[d.state] || ''}` })),
    h('span', { class: 'device-name', text: d.name || (d.state === 'unauthorized' ? 'Unknown device' : d.model || d.id) }),
    h('span', { class: 'device-sub', text: sub || (d.state === 'unauthorized' ? 'waiting for permission' : '—') }),
    h(
      'span',
      { class: 'device-meta' },
      h('span', { class: 'device-id', title: d.id, text: d.id.endsWith(':5555') ? d.id.slice(0, -5) : d.id }),
      d.state === 'device' && d.tier ? h('span', { class: `tier tier--${d.tier}`, text: d.tier }) : null,
      d.state !== 'device' ? h('span', { class: `device-state device-state--${d.state}`, text: d.state }) : null,
    ),
  );
  const isBusy = busy.has(d.id);
  const actions = h(
    'div',
    { class: 'device-actions' },
    d.state === 'device'
      ? h('button', { class: 'icon-btn icon-btn-sm', type: 'button', title: `Disconnect ${d.id}`, 'aria-label': `Disconnect ${d.id}`, disabled: isBusy, onclick: () => disconnect(d.id) }, icon('unplug'))
      : h('button', { class: 'icon-btn icon-btn-sm', type: 'button', title: `Reconnect ${d.id}`, 'aria-label': `Reconnect ${d.id}`, disabled: isBusy, onclick: () => connect(d.id) }, icon('refresh')),
  );
  li.append(main, actions);
  const hint = deviceHint(d, isBusy);
  if (hint) li.append(hint);
  return li;
}

function deviceHint(d, isBusy) {
  if (d.state === 'device') return null;
  let title;
  let body;
  let kind = 'warn';
  if (d.state === 'unauthorized') {
    title = 'Allow debugging on the TV';
    body = 'A prompt “Allow USB debugging?” is waiting on the TV. Pick Allow (tick “Always allow from this computer”), then retry. No prompt? Toggle ADB debugging off and on.';
  } else if (d.state === 'offline') {
    kind = 'bad';
    title = 'Offline';
    body = 'adb can see this TV but it isn’t answering. Wake it with the TV remote, check it’s on the same Wi-Fi, then reconnect.';
  } else {
    kind = '';
    title = 'Connecting…';
    body = 'Waiting for adb to finish the handshake.';
  }
  return h(
    'div',
    { class: 'device-hint' },
    h(
      'div',
      { class: `callout callout--${kind}` },
      h('div', { class: 'callout-body' }, h('b', { text: title }), h('span', { text: body }),
        d.state !== 'connecting'
          ? h('button', { class: 'btn btn-sm', type: 'button', disabled: isBusy, onclick: () => connect(d.id) }, icon(isBusy ? 'refresh' : 'plug'), isBusy ? 'Connecting…' : d.state === 'unauthorized' ? 'Retry' : 'Reconnect')
          : null),
    ),
  );
}

function notice() {
  if (state.server === 'down') {
    return h(
      'div',
      { class: 'rail-empty rail-empty--bad' },
      h('h3', null, icon('alert'), 'Server not reachable'),
      h('p', { text: 'The dashboard lost the FireLab server. Start it again in a terminal:' }),
      cmdLine('npx firelab ui'),
    );
  }
  if (state.health && !state.health.adb) {
    return h(
      'div',
      { class: 'rail-empty rail-empty--bad' },
      h('h3', null, icon('alert'), 'adb not found'),
      h('p', { text: 'FireLab talks to TVs through Android’s adb. Install platform-tools, then check your setup:' }),
      h(
        'div',
        { class: 'os-list' },
        h('div', null, h('span', { text: 'macOS' }), cmdLine('brew install android-platform-tools')),
        h('div', null, h('span', { text: 'Windows' }), cmdLine('winget install Google.PlatformTools')),
        h('div', null, h('span', { text: 'Linux' }), cmdLine('sudo apt install adb')),
        h('div', null, h('span', { text: 'Then' }), cmdLine('npx firelab doctor')),
      ),
      h('a', { href: 'https://developer.android.com/tools/releases/platform-tools', target: '_blank', rel: 'noopener' }, 'Platform-tools downloads ↗'),
    );
  }
  if (state.server === 'up' && !state.devices.length && scan.status !== 'scanning') {
    return h(
      'div',
      { class: 'rail-empty' },
      h('h3', null, icon('tv'), 'No devices yet'),
      h('p', { text: 'Turn on ADB debugging on your Fire TV (steps under the TV screen), then scan this Wi-Fi network or type the TV’s IP below.' }),
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => runScan() }, icon('radar'), 'Scan Wi-Fi'),
    );
  }
  if (state.devicesError && state.server === 'up') {
    return h('div', { class: 'callout callout--bad' }, icon('alert'), h('div', { class: 'callout-body' }, h('b', { text: 'Couldn’t list devices' }), h('span', { text: state.devicesError })));
  }
  return null;
}

function cmdLine(text) {
  return h(
    'div',
    { class: 'cmd' },
    h('code', { text }),
    h('button', {
      class: 'icon-btn icon-btn-sm', type: 'button', 'aria-label': `Copy ${text}`, title: 'Copy',
      onclick: async () => (await copyText(text)) && toast.ok('Copied', text),
    }, icon('copy')),
  );
}

function scanBlock() {
  const wrap = $('#scan-results');
  if (scan.status === 'idle') {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const close = h('button', { class: 'icon-btn icon-btn-sm', type: 'button', 'aria-label': 'Hide scan results', onclick: () => { scan = { status: 'idle', found: [] }; render(); } }, icon('x'));
  if (scan.status === 'scanning') {
    mount(wrap,
      h('div', { class: 'scan-head' }, h('span', { class: 'label label-sm', text: `Scanning ${scan.subnet || 'this network'}` })),
      h('div', { class: 'scan-bar' }),
      h('p', { class: 'hint', text: 'Looking for adb on port 5555. Takes a few seconds.' }));
    return;
  }
  if (scan.status === 'error') {
    mount(wrap,
      h('div', { class: 'scan-head' }, h('span', { class: 'label label-sm', text: 'Scan failed' }), close),
      h('p', { class: 'hint', text: scan.error }));
    return;
  }
  const ids = new Map(state.devices.map((d) => [d.id, d]));
  const items = scan.found.map(({ ip, port }) => {
    const id = `${ip}:${port || 5555}`;
    const d = ids.get(id);
    return h('li', { class: 'found', title: id }, icon('wifi'), h('span', { class: 'found-id', text: port && port !== 5555 ? id : ip }),
      d && d.state === 'device'
        ? h('span', { class: 'found-tag', text: 'connected' })
        : h('button', { class: 'btn btn-sm', type: 'button', disabled: busy.has(id), onclick: () => connect(id) }, busy.has(id) ? 'Connecting…' : 'Connect'));
  });
  mount(wrap,
    h('div', { class: 'scan-head' }, h('span', { class: 'label label-sm', text: `${scan.found.length} found${scan.subnet ? ` on ${scan.subnet}` : ''}` }), close),
    items.length ? h('ul', { class: 'found-list' }, items) : h('p', { class: 'hint', text: 'Nothing answered on port 5555. Is ADB debugging on, and is the TV on this Wi-Fi?' }));
}

function renderKnown() {
  const sec = $('#known-devices');
  const list = knownNotConnected();
  sec.hidden = !list.length || state.server !== 'up';
  mount($('#known-list'), list.map(([id, k]) =>
    h('li', { class: 'known-item', title: `Last used ${ago(k.seen)}` }, icon('tv'),
      h('span', { class: 'known-name', text: k.name || id }),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: busy.has(id), onclick: () => connect(id), 'aria-label': `Connect ${k.name || id}` }, 'Connect'))));
}

let lastSig = '';

export function render() {
  // The device list polls every few seconds; only touch the DOM when something changed,
  // so focus and hover survive.
  const sig = JSON.stringify([search, state.devices, state.selectedId, scan, [...busy], state.server, !!state.health, state.health?.adb, state.devicesError, knownNotConnected().map((k) => k[0])]);
  if (sig === lastSig) return;
  lastSig = sig;
  mount($('#rail-notice'), notice());
  const list = $('#device-list');
  const q = search.toLowerCase();
  const shown = q ? state.devices.filter((d) => [d.name, d.model, d.id, d.os, d.gpu].join(' ').toLowerCase().includes(q)) : state.devices;
  mount(list, shown.length || !q ? shown.map(deviceItem) : h('li', { class: 'hint', text: `No device matches “${search}”.` }));
  $('#device-search-wrap').hidden = state.devices.length < 2 && !q;
  $('#dev-count').textContent = String(state.devices.length);
  scanBlock();
  renderKnown();
  renderTopbar();
}

function renderTopbar() {
  const el = $('#topbar-device');
  const d = selected();
  if (!d) {
    mount(el, h('span', { class: 'td-empty', text: state.server === 'down' ? 'Disconnected from server' : 'No device selected' }));
    return;
  }
  const specs = [
    d.model && h('span', null, icon('tv'), d.model),
    d.os && h('span', { text: d.os }),
    d.gpu && h('span', null, icon('chip'), shortGpu(d.gpu)),
    d.resolution && h('span', { text: `${d.resolution.width}×${d.resolution.height}` }),
    d.ramMB && h('span', { text: d.ramMB >= 1024 ? `${Math.round(d.ramMB / 1024)} GB RAM` : `${d.ramMB} MB RAM` }),
    d.abi && h('span', { text: d.abi }),
  ].filter(Boolean);
  mount(el,
    h('span', { class: 'td-name', text: deviceLabel(d) }),
    d.state === 'device' && d.tier ? h('span', { class: `tier tier--${d.tier}`, title: TIER_INFO[d.tier], text: d.tier }) : h('span', { class: `device-state device-state--${d.state}`, text: d.state }),
    h('span', { class: 'td-specs' }, specs));
}

function renderHealth() {
  const pill = $('#adb-pill');
  const val = pill.querySelector('.status-pill-val');
  const dot = pill.querySelector('.dot');
  const hl = state.health;
  if (state.server === 'down') {
    val.textContent = 'server down';
    dot.className = 'dot dot--bad';
  } else if (!hl) {
    val.textContent = '…';
    dot.className = 'dot';
  } else if (!hl.adb) {
    val.textContent = 'missing';
    dot.className = 'dot dot--bad';
  } else {
    val.textContent = hl.adb.version || 'ok';
    dot.className = 'dot dot--ok';
    pill.title = `adb ${hl.adb.version || ''} at ${hl.adb.path || '?'}`;
  }
  if (hl?.version) $('#app-version').textContent = `v${hl.version}`;
  $('#mock-flag').hidden = !hl?.mock;
  $('#mock-flag').previousElementSibling.hidden = !hl?.mock;
}

/* ---------------------------------------------------------------- init */

export function initDevices() {
  $('#scan-btn').addEventListener('click', () => runScan());
  $('#device-search').addEventListener('input', (e) => {
    search = e.target.value.trim();
    render();
  });
  $('#connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#connect-ip');
    const v = input.value.trim();
    if (!v) {
      input.focus();
      return;
    }
    if (!/^[\w.-]+(:\d{1,5})?$/.test(v)) {
      toast.fail('That doesn’t look like an IP address', 'Use something like 192.168.1.50 or 192.168.1.50:5555.');
      return;
    }
    connect(v);
    input.value = '';
  });
  $('#server-retry').addEventListener('click', () => {
    refreshHealth();
    refreshDevices();
  });
  on('select', render);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshDevices();
  });
  refreshHealth();
  refreshDevices();
}
