// Apps pane: list, launch (optionally with a URL), stop, reset (with an
// in-page confirmation), install by APK path, and a WebView eval box.

import { api, post, dev } from './api.js';
import { state, on, emit, liveDevice } from './store.js';
import { $, h, icon, mount, storage, save } from './dom.js';
import * as toast from './toast.js';

let apps = [];
let loading = false;
let loadError = null;
let confirmPkg = null;
const busy = new Set();
let history = storage('firelab.evalHistory', []);
let histPos = -1;

const SNIPPETS = [
  'window.firelab',
  'firelab.fps',
  'location.href',
  'document.title',
  'navigator.userAgent',
  'performance.memory',
  'Object.keys(localStorage)',
];

export function getApps() {
  return apps;
}

function hue(pkg) {
  let x = 0;
  for (const ch of pkg) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x % 360;
}

export async function loadApps() {
  const d = liveDevice();
  confirmPkg = null;
  if (!d) {
    apps = [];
    loadError = null;
    render();
    emit('apps', apps);
    return;
  }
  loading = true;
  render();
  try {
    const res = await api(`${dev(d.id)}/apps`);
    apps = (res?.apps || []).slice().sort((a, b) => (a.label || a.package).localeCompare(b.label || b.package));
    loadError = null;
  } catch (err) {
    apps = [];
    loadError = err.message;
  } finally {
    loading = false;
  }
  render();
  emit('apps', apps);
}

async function act(pkg, what, fn) {
  busy.add(pkg);
  render();
  try {
    await fn();
  } catch (err) {
    toast.fail(`Couldn’t ${what} ${pkg}`, err.message);
  } finally {
    busy.delete(pkg);
    render();
  }
}

function launch(pkg) {
  const d = liveDevice();
  const url = $('#launch-url').value.trim();
  if (url && !/^https?:\/\//i.test(url)) {
    toast.fail('The URL needs http:// or https://', url);
    return;
  }
  return act(pkg, 'launch', async () => {
    const res = await post(`${dev(d.id)}/apps/launch`, url ? { package: pkg, url } : { package: pkg });
    toast.ok(`Launched ${labelOf(pkg)}`, url ? `with ${url}` : res?.pid ? `pid ${res.pid}` : undefined);
  });
}

function stop(pkg) {
  const d = liveDevice();
  return act(pkg, 'stop', async () => {
    await post(`${dev(d.id)}/apps/stop`, { package: pkg });
    toast.info(`Stopped ${labelOf(pkg)}`);
  });
}

function reset(pkg) {
  const d = liveDevice();
  confirmPkg = null;
  return act(pkg, 'reset', async () => {
    await post(`${dev(d.id)}/apps/reset`, { package: pkg, confirm: true });
    toast.ok(`Reset ${labelOf(pkg)}`, 'All app data cleared. The next launch is a first launch.');
  });
}

const labelOf = (pkg) => apps.find((a) => a.package === pkg)?.label || pkg;

function appRow(a) {
  const running = state.live?.foreground === a.package;
  const isBusy = busy.has(a.package);
  const name = a.label || a.package;
  const li = h('li', { class: `app-row${running ? ' is-running' : ''}` },
    h('span', { class: 'app-mono', style: { '--h': String(hue(a.package)) }, 'aria-hidden': 'true', text: name.trim()[0]?.toUpperCase() || '?' }),
    h('span', { class: 'app-text' },
      h('span', { class: 'app-name' }, h('span', { text: name }), running ? h('span', { class: 'run-chip' }, 'in front') : null),
      h('span', { class: 'app-pkg', text: `${a.package}${a.version ? ` · ${a.version}` : ''}` })),
    h('span', { class: 'app-actions' },
      h('button', { class: 'icon-btn icon-btn-sm', type: 'button', disabled: isBusy, title: `Launch ${name}`, 'aria-label': `Launch ${name}`, onclick: () => launch(a.package) }, icon('play')),
      h('button', { class: 'icon-btn icon-btn-sm', type: 'button', disabled: isBusy, title: `Force-stop ${name}`, 'aria-label': `Stop ${name}`, onclick: () => stop(a.package) }, icon('stop')),
      h('button', {
        class: 'icon-btn icon-btn-sm danger', type: 'button', disabled: isBusy, title: `Reset ${name} (clear its data)`, 'aria-label': `Reset ${name}`,
        'aria-expanded': String(confirmPkg === a.package),
        onclick: () => {
          confirmPkg = confirmPkg === a.package ? null : a.package;
          render();
          if (confirmPkg) requestAnimationFrame(() => $('#confirm-cancel')?.focus());
        },
      }, icon('reset'))));
  if (confirmPkg === a.package) {
    li.append(h('div', { class: 'app-confirm', role: 'alertdialog', 'aria-label': `Reset ${name}?` },
      h('div', { class: 'callout callout--bad' }, icon('alert'),
        h('div', { class: 'callout-body' },
          h('b', { text: `Reset ${name}?` }),
          h('span', { text: 'This clears all of the app’s data on the TV: saved progress, settings, logins and caches. The next launch is a true first launch. It can’t be undone.' }),
          h('div', { class: 'ov-actions' },
            h('button', { class: 'btn btn-sm', id: 'confirm-cancel', type: 'button', onclick: () => { confirmPkg = null; render(); } }, 'Cancel'),
            h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: () => reset(a.package) }, icon('trash'), 'Clear data and reset'))))));
  }
  return li;
}

function render() {
  $('#apps-count').textContent = String(apps.length);
  const list = $('#app-list');
  const d = liveDevice();
  if (!d) mount(list, h('li', { class: 'pane-empty' }, icon('apps'), h('b', { text: 'No live device' }), h('span', { text: 'Connect a device to see its apps.' })));
  else if (loading && !apps.length) mount(list, h('li', { class: 'pane-empty' }, h('span', { text: 'Loading apps…' })));
  else if (loadError) mount(list, h('li', { class: 'pane-empty' }, icon('alert'), h('b', { text: 'Couldn’t list apps' }), h('span', { text: loadError })));
  else if (!apps.length) mount(list, h('li', { class: 'pane-empty' }, icon('package'), h('b', { text: 'No third-party apps installed' }), h('span', { text: 'Install an APK below, or wrap a web URL with npx firelab wrap.' })));
  else mount(list, apps.map(appRow));
  for (const el of [$('#apps-refresh'), $('#install-form button'), $('#apk-path'), $('#launch-url')]) el.disabled = !d;

  // eval target select
  const sel = $('#eval-pkg');
  const cur = sel.value;
  mount(sel, h('option', { value: '', text: 'foreground app' }), apps.map((a) => h('option', { value: a.package, text: a.label || a.package })));
  sel.value = apps.some((a) => a.package === cur) ? cur : '';
  $('#eval-run').disabled = !d;
}

/* -------------------------------------------------------------- eval */

function jsonNodes(value) {
  if (value === undefined) return [h('span', { class: 'j-lit', text: 'undefined' })];
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) return [document.createTextNode(String(value))];
  const out = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let i = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > i) out.push(document.createTextNode(text.slice(i, m.index)));
    if (m[1]) {
      out.push(h('span', { class: m[2] ? 'j-key' : 'j-str', text: m[1] }));
      if (m[2]) out.push(document.createTextNode(m[2]));
    } else if (m[3]) out.push(h('span', { class: 'j-lit', text: m[3] }));
    else out.push(h('span', { class: 'j-num', text: m[4] }));
    i = re.lastIndex;
  }
  if (i < text.length) out.push(document.createTextNode(text.slice(i)));
  return out;
}

function renderHistory() {
  mount($('#eval-history'), history.map((x) => h('li', null, h('button', { type: 'button', title: x, onclick: () => { setExpr(x); runEval(); } }, x))));
}

function setExpr(x) {
  const ta = $('#eval-expr');
  ta.value = x;
  ta.focus();
  ta.setSelectionRange(x.length, x.length);
}

async function runEval() {
  const d = liveDevice();
  const ta = $('#eval-expr');
  const expression = ta.value.trim();
  const out = $('#eval-out');
  if (!expression) {
    ta.focus();
    return;
  }
  if (!d) {
    mount(out, h('span', { class: 'err', text: 'No live device.' }));
    return;
  }
  history = [expression, ...history.filter((x) => x !== expression)].slice(0, 30);
  save('firelab.evalHistory', history);
  histPos = -1;
  renderHistory();
  const pkg = $('#eval-pkg').value;
  const btn = $('#eval-run');
  btn.disabled = true;
  const t0 = performance.now();
  try {
    const res = await post(`${dev(d.id)}/webview/eval`, pkg ? { package: pkg, expression } : { expression });
    const ms = Math.round(performance.now() - t0);
    if (res && (res.exception || res.error)) {
      mount(out, h('span', { class: 'eval-meta', text: `${ms} ms · threw` }), h('span', { class: 'err', text: String(res.exception || res.error) }));
    } else {
      mount(out, h('span', { class: 'eval-meta', text: `${ms} ms · ${pkg || state.live?.foreground || 'foreground app'}` }), ...jsonNodes(res?.value));
    }
  } catch (err) {
    mount(out, h('span', { class: 'eval-meta', text: 'error' }), h('span', { class: 'err', text: err.message }));
  } finally {
    btn.disabled = !liveDevice();
  }
}

export function initApps() {
  $('#apps-refresh').addEventListener('click', loadApps);
  $('#install-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#apk-path');
    const path = input.value.trim();
    const d = liveDevice();
    if (!path) {
      input.focus();
      return;
    }
    if (!/\.apk$/i.test(path)) {
      toast.fail('That isn’t an .apk file', path);
      return;
    }
    const btn = $('#install-form button');
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
      const res = await post(`${dev(d.id)}/apps/install`, { path }, { timeout: 180000 });
      toast.ok(`Installed ${res?.package || path}`);
      input.value = '';
      await loadApps();
    } catch (err) {
      toast.fail('Install failed', err.message);
    } finally {
      btn.classList.remove('is-busy');
      btn.disabled = !liveDevice();
    }
  });

  mount($('#eval-snippets'), SNIPPETS.map((s) => h('button', { class: 'snippet', type: 'button', onclick: () => { setExpr(s); runEval(); } }, s)));
  const ta = $('#eval-expr');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runEval();
      return;
    }
    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === ta.value.length;
    if (e.key === 'ArrowUp' && (atStart || !ta.value.includes('\n')) && history.length) {
      e.preventDefault();
      histPos = Math.min(history.length - 1, histPos + 1);
      setExpr(history[histPos]);
    } else if (e.key === 'ArrowDown' && (atEnd || !ta.value.includes('\n')) && histPos >= 0) {
      e.preventDefault();
      histPos -= 1;
      setExpr(histPos >= 0 ? history[histPos] : '');
    }
  });
  $('#eval-run').addEventListener('click', runEval);
  if (navigator.platform && !/Mac/i.test(navigator.platform)) $('#eval-run kbd').textContent = 'Ctrl↵';
  renderHistory();

  // Reload only when the live device actually changes (the list polls every few seconds).
  let liveId;
  const sync = () => {
    const id = liveDevice()?.id || null;
    if (id === liveId) return;
    liveId = id;
    loadApps();
  };
  on('select', sync);
  on('devices', sync);
  let fg;
  on('state', (e) => {
    if (e.foreground === fg) return;
    fg = e.foreground;
    render();
  });
  render();
}
