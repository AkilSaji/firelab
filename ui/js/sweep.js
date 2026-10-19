// Sweep pane: run the app at each quality tier, follow the job's progress over
// SSE (falling back to polling), then show a recommendation, a bar chart per
// tier and a table that copies as Markdown or JSON.

import { api, post, subscribe, dev } from './api.js';
import { state, on, emit, liveDevice, deviceLabel } from './store.js';
import { $, $$, h, icon, mount, storage, save, copyText } from './dom.js';
import { TIERS, TIER_INFO, KEY_NAMES, shortGpu, duration } from './format.js';
import { SweepChart } from './charts.js';
import * as toast from './toast.js';

let job = null;
let ctx = null; // { device, request, startedAt }
let closeStream = null;
let pollTimer = 0;
let chart = null;
let tiers = new Set(storage('firelab.sweep.tiers', TIERS));
const FORM_KEY = 'firelab.sweep.form';

/* ------------------------------------------------------------------ form */

function form() {
  return $('#sweep-form');
}

function renderTierChips() {
  const d = liveDevice();
  mount($('#sweep-tiers'), TIERS.map((t) =>
    h('button', {
      class: `tier-toggle${d?.tier === t ? ' is-device' : ''}`, type: 'button', style: { '--c': `var(--tier-${t})` },
      'aria-pressed': String(tiers.has(t)), title: TIER_INFO[t],
      onclick: () => {
        if (tiers.has(t)) tiers.delete(t);
        else tiers.add(t);
        save('firelab.sweep.tiers', TIERS.filter((x) => tiers.has(x)));
        renderTierChips();
        estimate();
      },
    }, t)));
}

function values() {
  const f = form();
  const v = (n) => f.elements[n]?.value?.trim() ?? '';
  return {
    url: v('url'), param: v('param') || 'q', targetFps: Number(v('targetFps')) || 30,
    warmupS: Number(v('warmupS')), sampleS: Number(v('sampleS')),
    keys: v('keys'), eval: v('eval'), package: v('package'),
  };
}

function estimate() {
  const v = values();
  const n = TIERS.filter((t) => tiers.has(t)).length;
  const per = (Number.isFinite(v.warmupS) ? v.warmupS : 5) + (Number.isFinite(v.sampleS) ? v.sampleS : 10) + 6;
  $('#sweep-estimate').textContent = n ? `${n} tier${n === 1 ? '' : 's'} · ~${duration(n * per * 1000)}` : 'pick at least one tier';
  $('#sweep-estimate').title = 'Rough time on the TV: warm-up + sample + about 6 s to load, per tier';
}

function showError(msg, field) {
  const el = $('#sweep-error');
  for (const i of $$('[aria-invalid]', form())) i.removeAttribute('aria-invalid');
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  if (field) {
    const input = form().elements[field];
    input?.setAttribute('aria-invalid', 'true');
    input?.focus();
  }
}

function buildRequest() {
  const v = values();
  if (!v.url) return { error: ['Add the URL of your game or app first.', 'url'] };
  if (!/^https?:\/\//i.test(v.url)) return { error: ['The URL needs to start with http:// or https:// (the TV loads it).', 'url'] };
  const list = TIERS.filter((t) => tiers.has(t));
  if (!list.length) return { error: ['Pick at least one tier to test.'] };
  if (!/^[A-Za-z_][\w-]*$/.test(v.param)) return { error: ['The URL param should be a plain name, like q.', 'param'] };
  const keys = v.keys ? v.keys.split(/[\s,]+/).filter(Boolean).map((k) => k.toLowerCase()) : [];
  const bad = keys.find((k) => !KEY_NAMES.includes(k));
  if (bad) return { error: [`“${bad}” isn’t a remote key. Use: ${KEY_NAMES.join(' ')}`, 'keys'] };
  const req = { url: v.url, tiers: list, param: v.param, targetFps: v.targetFps };
  if (Number.isFinite(v.warmupS)) req.warmupS = v.warmupS;
  if (Number.isFinite(v.sampleS)) req.sampleS = v.sampleS;
  if (v.package) req.package = v.package;
  if (keys.length || v.eval) req.action = { ...(keys.length ? { keys } : {}), ...(v.eval ? { eval: v.eval } : {}) };
  return { req };
}

async function submit(e) {
  e.preventDefault();
  const d = liveDevice();
  if (!d) {
    showError('Connect a device first: the sweep runs on a real TV.');
    return;
  }
  if (state.sweeping) return;
  const { req, error } = buildRequest();
  if (error) {
    showError(...error);
    return;
  }
  showError(null);
  persistForm();
  setRunning(true);
  try {
    const res = await post(`${dev(d.id)}/sweep`, req);
    ctx = { device: { ...d }, request: req, startedAt: Date.now() };
    job = { id: res.jobId, status: 'running', progress: 0, rows: [], device: d.id };
    emit('test:started', { kind: 'sweep', job: { ...job, request: req } });
    render();
    follow(res.jobId);
  } catch (err) {
    setRunning(false);
    showError(err.message);
  }
}

function persistForm() {
  const v = values();
  save(FORM_KEY, { url: v.url, param: v.param, targetFps: v.targetFps, warmupS: v.warmupS, sampleS: v.sampleS, keys: v.keys, eval: v.eval });
}

function restoreForm() {
  const saved = storage(FORM_KEY, null);
  if (!saved) return;
  const f = form();
  for (const [k, val] of Object.entries(saved)) {
    if (f.elements[k] && val != null && val !== '') f.elements[k].value = val;
  }
  if (saved.keys || saved.eval) f.querySelector('.field-more').open = true;
}

function setRunning(v) {
  state.sweeping = v;
  const btn = $('#sweep-run');
  btn.disabled = v;
  btn.classList.toggle('is-busy', v);
  btn.lastChild.textContent = v ? 'Sweeping…' : 'Run sweep';
  $('#dot-sweep').hidden = !v;
  emit('sweeping', v);
}

/* ------------------------------------------------------------- follow job */

function follow(id) {
  closeStream?.();
  clearTimeout(pollTimer);
  let done = false;
  closeStream = subscribe(`/jobs/${encodeURIComponent(id)}/stream`, {
    progress: (j) => onJob(j),
    done: (j) => {
      done = true;
      onJob(j);
      closeStream?.();
      closeStream = null;
    },
  }, {
    onerror: () => {
      if (done) return;
      // SSE dropped before "done": poll instead.
      closeStream?.();
      closeStream = null;
      poll(id);
    },
  });
}

async function poll(id) {
  clearTimeout(pollTimer);
  try {
    const j = await api(`/jobs/${encodeURIComponent(id)}`);
    onJob(j);
    if (j.status === 'running') pollTimer = setTimeout(() => poll(id), 1000);
  } catch (err) {
    onJob({ ...job, status: 'error', error: err.message });
  }
}

function onJob(j) {
  if (!j || (job && j.id && job.id && j.id !== job.id)) return;
  const wasRunning = job?.status === 'running';
  job = { ...job, ...j };
  if (job.status !== 'running') {
    setRunning(false);
    clearTimeout(pollTimer);
    if (wasRunning) {
      if (job.status === 'done' && job.recommendation) {
        if (state.tab !== 'sweep') toast.ok('Sweep finished', `Recommended tier: ${job.recommendation.tier}`);
      } else if (job.status === 'error') toast.fail('Sweep failed', job.error);
    }
  }
  render();
}

/* ---------------------------------------------------------------- render */

function intro() {
  return h('div', { class: 'sweep-intro' },
    h('div', { class: 'sweep-intro-art', 'aria-hidden': 'true' },
      h('i', { style: { height: '78%' } }), h('i', { style: { height: '62%' } }), h('i', { class: 'is-pick', style: { height: '52%' } }), h('i', { style: { height: '24%' } })),
    h('div', null,
      h('h3', { text: 'Find the right quality tier for this TV' }),
      h('p', { text: 'FireLab loads your game once per tier (?q=low, ?q=tv, ?q=tv-hd, ?q=high), lets it warm up, samples the frame rate, then recommends the richest tier that holds your target.' }),
      h('p', { text: 'Any page that reads a quality URL parameter works. Pages using @firelab/perf report exact numbers; others fall back to counting frames.' })));
}

function progressView() {
  const n = job.request?.tiers?.length || ctx?.request?.tiers?.length || 1;
  const list = job.request?.tiers || ctx?.request?.tiers || TIERS;
  const cur = job.current;
  const pct = Math.round((job.progress || 0) * 100);
  const segs = list.map((t, i) => {
    const p = Math.max(0, Math.min(1, (job.progress || 0) * n - i));
    const doneRow = job.rows?.find((r) => r.tier === t);
    const active = cur ? cur.tier === t : !doneRow && p > 0;
    return h('div', { class: `sweep-seg${doneRow ? ' is-done' : ''}${active ? ' is-active' : ''}` },
      h('div', { class: 'sweep-seg-bar' }, h('i', { style: { '--p': `${(doneRow ? 1 : p) * 100}%` } })),
      h('div', { class: 'sweep-seg-label' }, h('b', { text: t }), h('span', { text: doneRow ? `${doneRow.fpsMedian.toFixed(1)} fps median` : active ? (cur?.phase || 'running') : 'queued' })));
  });
  return h('div', { class: 'sweep-progress' },
    h('div', { class: 'sweep-progress-head' },
      h('h3', { text: `Sweeping on ${deviceLabel(ctx?.device) || job.device}` }),
      h('span', { class: 'pct', text: `${pct}%` })),
    h('div', { class: 'sweep-track' }, segs),
    h('div', { class: 'sweep-phase' }, h('div', { class: 'ov-spinner' }),
      h('span', { text: cur ? `${cur.tier}: ${cur.phase}${cur.fps ? ` · ${cur.fps.toFixed(0)} fps right now` : ''}` : 'Working…' })),
    h('p', { class: 'hint', text: 'Watch the TV screen above: the game reloads at each tier.' }),
    job.rows?.length ? table(job.rows, null) : null);
}

function table(rows, pick) {
  return h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', { text: 'Tier' }), h('th', { class: 'num', text: 'Median' }), h('th', { class: 'num', text: 'P10' }),
      h('th', { class: 'num', text: 'Memory' }), h('th', { class: 'num', text: 'Scale' }), h('th', { text: 'Target' }))),
    h('tbody', null, rows.map((r) => h('tr', { class: r.tier === pick ? 'is-pick' : '', title: r.note || '' },
      h('td', null, h('span', { class: `tier tier--${r.tier}`, text: r.tier })),
      h('td', { class: 'num', text: r.fpsMedian.toFixed(1) }),
      h('td', { class: 'num', text: r.fpsP10.toFixed(1) }),
      h('td', { class: 'num', text: r.memMB != null ? `${Math.round(r.memMB)} MB` : '—' }),
      h('td', { class: 'num', text: r.scale != null ? r.scale.toFixed(2) : '—' }),
      h('td', null, h('span', { class: `ok-cell ok-cell--${r.ok ? 'ok' : 'bad'}` }, icon(r.ok ? 'check' : 'x'), r.ok ? 'holds' : 'below'))))));
}

function resultView() {
  const rec = job.recommendation;
  const d = ctx?.device || state.devices.find((x) => x.id === job.device);
  const req = job.request || ctx?.request || {};
  const target = req.targetFps || 30;
  const meta = [deviceLabel(d) || job.device, d?.model, d?.gpu && shortGpu(d.gpu), `target ${target} fps`, `${job.rows.length} tiers`, ctx ? new Date(ctx.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null].filter(Boolean).join(' · ');
  const okAny = job.rows.some((r) => r.ok);
  const wrap = h('div', { class: 'sweep-chart-wrap' },
    h('div', { class: 'sweep-chart chart', id: 'sweep-chart' }, h('canvas', { role: 'img', 'aria-label': `Median and p10 fps per tier against a ${target} fps target` })),
    h('div', { class: 'chart-legend' },
      h('span', null, h('i', { class: 'lg-bar' }), 'recommended'),
      h('span', null, h('i', { class: 'lg-bar lg-bar--muted' }), 'other'),
      h('span', { title: 'The solid part of each bar ends at p10 (the slowest 10% of frames); the full bar is the median.' }, h('i', { class: 'lg-split' }), 'p10 | median'),
      h('span', null, h('i', { class: 'lg-target' }), 'target')));
  const view = h('div', { class: 'sweep-done' },
    h('div', { class: `reco${okAny ? '' : ' reco--none'}` },
      h('div', { class: 'reco-badge' }, h('small', { text: okAny ? 'use' : 'closest' }), h('b', { text: rec?.tier || '—' })),
      h('div', { class: 'reco-text' },
        h('h3', { text: rec?.reason || 'No recommendation came back.' }),
        h('div', { class: 'reco-meta' },
          h('p', { text: meta }),
          h('div', { class: 'reco-actions' },
            h('button', { class: 'btn btn-sm', type: 'button', onclick: copyMarkdown }, icon('copy'), 'Markdown'),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: copyJson }, icon('code'), 'JSON'))))),
    h('div', { class: 'sweep-grid' }, wrap, table(job.rows, rec?.tier)));
  requestAnimationFrame(() => {
    chart?.destroy();
    chart = new SweepChart($('#sweep-chart'));
    chart.set({ rows: job.rows, target, pick: rec?.tier });
  });
  return view;
}

function errorView() {
  return h('div', { class: 'callout callout--bad' }, icon('alert'),
    h('div', { class: 'callout-body' }, h('b', { text: 'The sweep stopped' }), h('span', { text: job.error || 'Unknown error' }),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => form().requestSubmit() }, icon('replay'), 'Run again')));
}

function render() {
  const out = $('#sweep-result');
  if (!job) mount(out, intro());
  else if (job.status === 'running') mount(out, progressView());
  else if (job.status === 'error') mount(out, errorView(), job.rows?.length ? table(job.rows, null) : null);
  else mount(out, resultView());
}

/* ------------------------------------------------------------------ copy */

function exportData() {
  const d = ctx?.device || state.devices.find((x) => x.id === job.device) || { id: job.device };
  return {
    device: { id: d.id, name: d.name, model: d.model, os: d.os, gpu: d.gpu },
    request: job.request || ctx?.request,
    rows: job.rows,
    recommendation: job.recommendation,
    finishedAt: new Date().toISOString(),
  };
}

async function copyMarkdown() {
  const x = exportData();
  const req = x.request || {};
  const lines = [
    `### FireLab sweep: ${x.device.name || x.device.id}`,
    '',
    `${[x.device.model, x.device.gpu, x.device.os].filter(Boolean).join(' · ')}  `,
    `URL \`${req.url}\` · param \`${req.param || 'q'}\` · target ${req.targetFps || 30} fps`,
    '',
    '| Tier | Median fps | P10 fps | Memory | Scale | Holds target | Note |',
    '| --- | ---: | ---: | ---: | ---: | :-: | --- |',
    ...x.rows.map((r) => `| ${r.tier === x.recommendation?.tier ? `**${r.tier}**` : r.tier} | ${r.fpsMedian.toFixed(1)} | ${r.fpsP10.toFixed(1)} | ${r.memMB != null ? `${Math.round(r.memMB)} MB` : ''} | ${r.scale != null ? r.scale.toFixed(2) : ''} | ${r.ok ? 'yes' : 'no'} | ${r.note || ''} |`),
    '',
    x.recommendation ? `**Recommendation:** ${x.recommendation.reason}` : '',
  ];
  if (await copyText(lines.join('\n').trim())) toast.ok('Copied as Markdown', 'Paste it into an issue, PR or README.');
}

async function copyJson() {
  if (await copyText(JSON.stringify(exportData(), null, 2))) toast.ok('Copied as JSON');
}

/**
 * The Test Engine's Sweep button: runs the sweep with the Sweep tab's form if
 * it is ready (a live device, a URL, a tier). Returns false when it isn't.
 */
export function startSweepFromEngine() {
  if (!liveDevice() || state.sweeping || buildRequest().error) return false;
  form().requestSubmit();
  return true;
}

/* ------------------------------------------------------------------ init */

export function initSweep() {
  restoreForm();
  renderTierChips();
  estimate();
  form().addEventListener('submit', submit);
  form().addEventListener('input', () => {
    estimate();
    if (!$('#sweep-error').hidden) showError(null);
  });
  // Mark "this TV" on the device's own tier; re-render only when that changes.
  let shownTier;
  const syncTier = () => {
    const t = liveDevice()?.tier || null;
    if (t === shownTier) return;
    shownTier = t;
    renderTierChips();
  };
  on('select', syncTier);
  on('devices', syncTier);
  on('apps', (apps) => {
    const sel = $('#sweep-pkg');
    const cur = sel.value;
    mount(sel, h('option', { value: '', text: 'FireLab default WebView' }), apps.map((a) => h('option', { value: a.package, text: a.label ? `${a.label} (${a.package})` : a.package })));
    sel.value = apps.some((a) => a.package === cur) ? cur : '';
  });
  on('tab', (t) => {
    if (t === 'sweep' && chart) requestAnimationFrame(() => chart.resize());
  });
  render();
}
