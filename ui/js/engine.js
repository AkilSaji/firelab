// Test Engine card (devices rail): Quick Tests, Custom explore, Scenarios.
// Each quick test is a real backend job on the selected device; the Test
// Execution panel follows it.

import { api } from './api.js';
import { on, liveDevice, deviceLabel } from './store.js';
import { $, $$, h, icon, mount, storage, save } from './dom.js';
import { KEY_NAMES } from './format.js';
import { getTarget } from './perf.js';
import { startSweepFromEngine } from './sweep.js';
import { startTest } from './testkit.js';
import { selectTab } from './dock.js';
import * as toast from './toast.js';

let models = [];
let scenarios = { sessions: [], traces: [] };
const OPTS_KEY = 'firelab.engine';
const opts = { navMin: 3, exploreMin: 10, perfS: 15, gpu: '', gpuForExplore: false, app: '', ...storage(OPTS_KEY, {}) };

function persist() {
  save(OPTS_KEY, opts);
}

/* ------------------------------------------------------------------ tabs */

function selectEngineTab(name) {
  for (const t of $$('.engine-tabs [role="tab"]')) {
    const on = t.id === `etab-${name}`;
    t.setAttribute('aria-selected', String(on));
    t.setAttribute('aria-pressed', String(on));
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  }
  save('firelab.engineTab', name);
  if (name === 'scen') loadScenarios();
}

/* ----------------------------------------------------------------- quick */

function appBody() {
  return opts.app ? { package: opts.app } : {};
}

function gpuForExplore() {
  return opts.gpuForExplore && opts.gpu ? { emulateGpu: opts.gpu } : {};
}

async function quick(kind) {
  switch (kind) {
    case 'app-launch':
      return startTest('app-launch', appBody());
    case 'navigation':
      return startTest('navigation', { ...appBody(), minutes: opts.navMin, ...gpuForExplore() });
    case 'performance':
      return startTest('performance', { ...appBody(), seconds: opts.perfS, targetFps: getTarget() });
    case 'explore':
      return startTest('explore', { ...appBody(), minutes: opts.exploreMin, ...gpuForExplore() });
    case 'gpu':
      if (!opts.gpu) {
        toast.info('Pick a Fire TV model first', 'GPU check needs the model whose GPU to emulate.');
        $('#gpu-model').focus();
        return null;
      }
      return startTest('gpu', { ...appBody(), model: opts.gpu });
    case 'sweep':
      // The sweep has its own form (URL, tiers): run it if it is filled in, else open it.
      if (!startSweepFromEngine()) {
        location.hash = 'page=devices&tab=sweep';
        selectTab('sweep');
        $('#sweep-url').focus();
        toast.info('Sweep needs your game’s URL', 'Fill it in on the Sweep tab, then run it from there or here.');
      }
      return null;
    default:
      return null;
  }
}

function renderQuickLabels() {
  const set = (k, v) => $$(`[data-q="${k}"]`).forEach((el) => (el.textContent = v));
  set('nav-min', String(opts.navMin));
  set('explore-min', String(opts.exploreMin));
  set('perf-s', String(opts.perfS));
  set('target', String(getTarget()));
  const m = models.find((x) => x.model === opts.gpu);
  set('gpu-short', m ? `as ${m.gpu || m.model}` : 'pick a model');
  const d = liveDevice();
  $('#engine-dev').textContent = d ? `on ${deviceLabel(d)}` : 'no live device';
  const busy = !d;
  for (const b of $$('.quick')) b.disabled = busy;
}

function renderModels() {
  const opt = (m) => h('option', { value: m.model, disabled: !m.emulatable, title: m.reason || '' }, `${m.name} · ${m.gpu || '?'}${m.emulatable ? '' : ' (no profile)'}`);
  const kinds = [['stick', 'Sticks'], ['box', 'Boxes'], ['cube', 'Cubes'], ['tv', 'Smart TVs']];
  const groups = kinds.map(([k, label]) => {
    const list = models.filter((m) => m.kind === k);
    return list.length ? h('optgroup', { label }, list.map(opt)) : null;
  });
  mount($('#gpu-model'), h('option', { value: '', text: 'Pick a Fire TV model…' }), groups);
  $('#gpu-model').value = models.some((m) => m.model === opts.gpu) ? opts.gpu : '';
  const custom = $('#custom-gpu');
  const cur = custom.value;
  mount(custom, h('option', { value: '', text: 'no (the device’s own GPU)' }), kinds.map(([k, label]) => {
    const list = models.filter((m) => m.kind === k && m.emulatable);
    return list.length ? h('optgroup', { label }, list.map(opt)) : null;
  }));
  custom.value = cur;
  renderQuickLabels();
}

async function loadModels() {
  try {
    models = (await api('/gpu/models')).models || [];
  } catch {
    models = [];
    mount($('#gpu-model'), h('option', { value: '', text: 'GPU models unavailable' }));
    return;
  }
  renderModels();
}

/* ---------------------------------------------------------------- custom */

function customError(msg) {
  const el = $('#custom-error');
  el.hidden = !msg;
  el.textContent = msg || '';
}

async function submitCustom(e) {
  e.preventDefault();
  const f = e.target.elements;
  const amount = Number(f.budget.value);
  if (!(amount > 0)) return customError('The budget needs a positive number.');
  const keys = f.keys.value.trim() ? f.keys.value.trim().split(/[\s,]+/).map((k) => k.toLowerCase()) : undefined;
  const bad = keys?.find((k) => !KEY_NAMES.includes(k) || ['volup', 'voldown', 'mute', 'wake'].includes(k));
  if (bad) return customError(`“${bad}” isn’t a key the engine presses.`);
  customError(null);
  const body = {
    ...appBody(),
    [f.budgetKind.value === 'steps' ? 'steps' : 'minutes']: f.budgetKind.value === 'steps' ? Math.round(amount) : amount,
    seed: Number(f.seed.value) || 1,
    strategy: f.strategy.value,
    minimize: f.minimize.checked,
    ...(keys ? { keys } : {}),
    ...(f.stateExpr.value.trim() ? { stateExpr: f.stateExpr.value.trim() } : {}),
    ...(f.focusSelector.value.trim() ? { focusSelector: f.focusSelector.value.trim() } : {}),
    ...(f.emulateGpu.value ? { emulateGpu: f.emulateGpu.value } : {}),
    ...(f.failOn.value.trim() ? { failOn: f.failOn.value.trim().split(/[\s,]+/) } : {}),
    ...(f.demo.checked ? { driver: 'demo' } : {}),
  };
  if (f.demo.checked) delete body.package;
  save('firelab.engine.custom', Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, v])));
  await startTest('explore', body);
}

function restoreCustom() {
  const saved = storage('firelab.engine.custom', null);
  if (!saved) return;
  const f = $('#custom-form').elements;
  for (const [k, v] of Object.entries(saved)) {
    if (!f[k]) continue;
    if (f[k].type === 'checkbox') f[k].checked = v === 'on';
    else f[k].value = v;
  }
  if (!('minimize' in saved)) f.minimize.checked = false;
}

/* ------------------------------------------------------------- scenarios */

async function loadScenarios() {
  try {
    scenarios = await api('/scenarios');
  } catch {
    return;
  }
  const items = [
    ...scenarios.traces.slice(0, 5).map((t) => ({ title: t.title || t.file, sub: t.keys, replay: { runId: t.runId, trace: t.file, ...(t.demo ? { demo: true } : {}) } })),
    ...scenarios.sessions.filter((s) => s.replayable).slice(0, 3).map((s) => ({ title: `Watch session · ${new Date(s.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`, sub: s.keySequence, replay: { sessionId: s.sessionId } })),
  ];
  mount($('#engine-scen'), items.length
    ? items.map((it) => h('li', null,
      h('span', { class: 't', text: it.title, title: it.title }),
      h('span', { class: 's', text: it.sub.join(' ') || '—' }),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => replayScenario(it.replay) }, icon('replay'), 'Replay')))
    : h('li', { class: 'empty' }, h('span', { text: 'No scenarios yet. Engine findings and watch sessions show up here.' })));
}

/** Replays a finding trace or a watch session (demo traces run on the simulated game). */
export function replayScenario({ runId, trace, sessionId, demo }) {
  const body = sessionId ? { sessionId } : { runId, trace };
  if (demo && !liveDevice()) body.driver = 'demo';
  return startTest('replay', body);
}

/* ------------------------------------------------------------------ init */

export function initEngine() {
  for (const t of $$('.engine-tabs [role="tab"]')) t.addEventListener('click', () => selectEngineTab(t.id.slice(5)));
  $('.engine-tabs').addEventListener('keydown', (e) => {
    const tabs = $$('.engine-tabs [role="tab"]');
    const i = tabs.indexOf(document.activeElement);
    if (i < 0 || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    e.preventDefault();
    const j = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    selectEngineTab(tabs[j].id.slice(5));
    tabs[j].focus();
  });
  for (const b of $$('.quick')) b.addEventListener('click', () => quick(b.dataset.test));

  const app = $('#engine-app');
  app.addEventListener('change', () => {
    opts.app = app.value;
    persist();
  });
  on('apps', (apps) => {
    mount(app, h('option', { value: '', text: 'foreground app' }), apps.map((a) => h('option', { value: a.package, text: a.label ? `${a.label} (${a.package})` : a.package })));
    app.value = apps.some((a) => a.package === opts.app) ? opts.app : '';
  });

  $('#gpu-model').addEventListener('change', (e) => {
    opts.gpu = e.target.value;
    persist();
    renderQuickLabels();
  });
  const gfe = $('#gpu-for-explore');
  gfe.checked = !!opts.gpuForExplore;
  gfe.addEventListener('change', () => {
    opts.gpuForExplore = gfe.checked;
    persist();
  });
  const num = (id, key, lo, hi) => {
    const el = $(id);
    el.value = String(opts[key]);
    el.addEventListener('change', () => {
      const v = Math.min(hi, Math.max(lo, Number(el.value) || opts[key]));
      el.value = String(v);
      opts[key] = v;
      persist();
      renderQuickLabels();
    });
  };
  num('#q-nav-min', 'navMin', 1, 30);
  num('#q-explore-min', 'exploreMin', 1, 240);
  num('#q-perf-s', 'perfS', 5, 120);
  $('#perf-target').addEventListener('change', renderQuickLabels);

  restoreCustom();
  $('#custom-form').addEventListener('submit', submitCustom);
  $('#custom-form').addEventListener('input', () => customError(null));

  on('select', renderQuickLabels);
  on('devices', renderQuickLabels);
  on('test:done', () => {
    if (!$('#epane-scen').hidden) loadScenarios();
  });
  selectEngineTab(storage('firelab.engineTab', 'quick'));
  loadModels();
  renderQuickLabels();
}

