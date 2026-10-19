// Test Execution panel: follows the job started last (a test job over SSE,
// falling back to polling, or a sweep adapted to the same shape) and shows
// its progress, counters, times and live step list. On load it picks up a
// job that is still running on the selected device.

import { api, post, subscribe } from './api.js';
import { state, on, emit, deviceLabel } from './store.js';
import { $, $$, h, icon, mount } from './dom.js';
import { KIND_INFO, clock, duration, outcome } from './format.js';
import { statusChip, sevChips, reportLink } from './testkit.js';
import * as toast from './toast.js';

let cur = null; // { kind: 'test' | 'sweep', job }
let close = null;
let pollTimer = 0;
let tickTimer = 0;
let sweepLog = [];

/* ------------------------------------------------------------- adapters */

/** A sweep Job in the TestJob shape. */
function fromSweep(j, event) {
  const req = j.request || {};
  const tiers = req.tiers?.length || 4;
  const est = req.warmupS != null && req.sampleS != null ? tiers * (req.warmupS + req.sampleS + 6) * 1000 : undefined;
  if (event?.message && sweepLog.at(-1)?.text !== event.message) sweepLog.push({ ts: Date.now(), text: event.message });
  for (const r of j.rows || []) {
    const text = `${r.tier}: median ${r.fpsMedian.toFixed(1)} fps, p10 ${r.fpsP10.toFixed(1)} · ${r.ok ? 'holds the target' : 'below the target'}`;
    if (!sweepLog.some((l) => l.text === text)) sweepLog.push({ ts: Date.now(), text, status: r.ok ? 'ok' : 'fail' });
  }
  if (j.recommendation && !sweepLog.some((l) => l.text === j.recommendation.reason)) sweepLog.push({ ts: Date.now(), text: j.recommendation.reason, status: 'info' });
  if (j.error && !sweepLog.some((l) => l.text === j.error)) sweepLog.push({ ts: Date.now(), text: j.error, status: 'fail' });
  return {
    id: j.id,
    kind: 'sweep',
    name: `Sweep · ${req.url || 'quality tiers'}`,
    device: j.device,
    status: j.status === 'error' ? 'failed' : j.status,
    ...(j.status === 'done' ? { verdict: j.rows?.some((r) => r.ok) ? 'pass' : 'fail' } : {}),
    progress: j.progress ?? 0,
    phase: j.current ? `${j.current.tier}: ${j.current.phase}` : j.status === 'running' ? 'starting' : undefined,
    startedAt: j.startedAt || cur?.job?.startedAt || Date.now(),
    endedAt: j.endedAt,
    ...(est ? { estimatedMs: est, estimated: true } : {}),
    log: sweepLog.slice(-200),
    error: j.error,
  };
}

/* ---------------------------------------------------------------- follow */

function stopFollowing() {
  close?.();
  close = null;
  clearTimeout(pollTimer);
}

export function follow(kind, job) {
  stopFollowing();
  if (kind === 'sweep') sweepLog = [];
  cur = { kind, job: kind === 'sweep' ? fromSweep(job) : job };
  render();
  if (cur.job.status !== 'running') return;
  const path = kind === 'sweep' ? `/jobs/${encodeURIComponent(job.id)}/stream` : `/tests/${encodeURIComponent(job.id)}/stream`;
  let done = false;
  close = subscribe(path, {
    progress: (j) => update(kind === 'sweep' ? fromSweep(j, j.event) : j),
    done: (j) => {
      done = true;
      update(kind === 'sweep' ? fromSweep(j) : j);
      stopFollowing();
    },
  }, {
    onerror: () => {
      if (done) return;
      stopFollowing();
      poll(kind, job.id);
    },
  });
}

async function poll(kind, id) {
  try {
    const j = await api(kind === 'sweep' ? `/jobs/${encodeURIComponent(id)}` : `/tests/${encodeURIComponent(id)}`);
    update(kind === 'sweep' ? fromSweep(j) : j);
    if (j.status === 'running') pollTimer = setTimeout(() => poll(kind, id), 1500);
  } catch {
    pollTimer = setTimeout(() => poll(kind, id), 4000);
  }
}

function update(job) {
  if (!cur || job.id !== cur.job.id) return;
  const was = cur.job.status;
  cur.job = { ...cur.job, ...job };
  emit('test:update', cur.job);
  if (was === 'running' && cur.job.status !== 'running') {
    emit('test:done', cur.job);
    const o = outcome(cur.job);
    const name = cur.job.name;
    // A replay "fails" when the finding shows again: say what happened instead.
    if (cur.job.kind === 'replay' && (o === 'pass' || o === 'fail')) toast.info('Replay finished', cur.job.log?.at(-1)?.text || name);
    else if (o === 'pass') toast.ok('Test passed', name);
    else if (o === 'fail') toast.fail('Test failed', name);
    else if (o === 'error') toast.fail('Test stopped with an error', cur.job.error || name);
    else toast.info(`Test ${o === 'stopped' ? 'stopped' : 'skipped'}`, name);
  }
  render();
}

/** On load or device change: show a job that is still running there, else the last one. */
async function discover() {
  if (cur?.job?.status === 'running') return;
  const id = state.selectedId;
  try {
    const [tests, sweeps] = await Promise.all([api('/tests?limit=30').catch(() => []), api('/jobs').catch(() => [])]);
    const running = tests.find((t) => t.status === 'running' && (t.device === id || t.device === 'demo-tv'));
    if (running) return follow('test', await api(`/tests/${encodeURIComponent(running.id)}`));
    const sw = sweeps.find((j) => j.status === 'running' && j.device === id);
    if (sw) return follow('sweep', sw);
    const last = tests.find((t) => t.device === id);
    if (last && !cur) {
      cur = { kind: 'test', job: await api(`/tests/${encodeURIComponent(last.id)}`).catch(() => last) };
      render();
    }
  } catch {
    /* the panel stays empty */
  }
}

/* ---------------------------------------------------------------- render */

function stat(label, value, title) {
  return h('div', { title: title || '' }, h('dt', { text: label }), h('dd', null, value));
}

function empty() {
  return h('div', { class: 'pane-empty' }, icon('play'),
    h('b', { text: 'No test running' }),
    h('span', { text: 'Start a quick test from the Test Engine in the left rail. Its progress, counters and steps show here.' }));
}

function stepRow(s) {
  const ic = { ok: 'check', warn: 'alert', fail: 'x', info: 'info' }[s.status] || 'chevright';
  return h('li', { class: `step step--${s.status || 'plain'}` }, h('time', { text: clock(s.ts) }), icon(ic), h('span', { text: s.text }));
}

function render() {
  const body = $('#exec-body');
  const stop = $('#exec-stop');
  const running = cur?.job?.status === 'running';
  stop.hidden = !running;
  $('#nav-running').hidden = !running;
  for (const b of $$('.quick')) b.classList.toggle('is-running', running && (b.dataset.test === cur.job.kind));
  clearInterval(tickTimer);
  if (!cur) {
    mount(body, empty());
    return;
  }
  const j = cur.job;
  const info = KIND_INFO[j.kind] || { label: j.kind, icon: 'flask' };
  const now = j.endedAt || Date.now();
  const elapsed = now - j.startedAt;
  const total = j.findings ? Object.values(j.findings).reduce((a, b) => a + b, 0) : null;
  const pct = j.progress == null ? null : Math.round(j.progress * 100);
  const d = state.devices.find((x) => x.id === j.device);
  const est = j.estimatedMs;
  const estWord = j.kind === 'explore' || j.kind === 'navigation' ? (j.request?.steps ? 'est. total' : 'budget') : 'est. total';

  const list = h('ol', { class: 'step-list', 'aria-label': 'Steps' }, (j.log || []).map(stepRow));
  const links = [];
  if (j.report && j.status !== 'running') links.push(reportLink(j.report, 'Engine report'));
  if (j.result?.screenshot) links.push(reportLink(j.result.screenshot, 'Screenshot'));
  if (j.result?.logcat) links.push(reportLink(j.result.logcat, 'logcat.txt'));

  mount(body,
    h('div', { class: 'exec-head' },
      h('div', { class: 'exec-name' }, icon(info.icon), h('b', { text: j.name, title: j.name }), h('span', { class: 'spacer' }), statusChip(j)),
      h('div', { class: `bar${pct == null && running ? ' is-indeterminate' : ''}`, role: 'progressbar', 'aria-label': 'Progress', 'aria-valuemin': '0', 'aria-valuemax': '100', ...(pct != null ? { 'aria-valuenow': String(pct) } : {}) },
        h('i', { style: { '--p': `${pct ?? 0}%` } })),
      h('dl', { class: 'exec-stats' },
        stat('steps', j.steps != null ? String(j.steps) : '—', 'Remote presses the engine made (explore and navigation)'),
        stat('states', j.states != null ? String(j.states) : '—', 'Distinct screens the engine has seen'),
        stat('findings', total != null ? sevChips(j.findings) : '—', 'Findings so far, per severity'),
        stat('phase', j.phase || (running ? 'running' : j.status), 'What the job is doing')),
      h('div', { class: 'exec-times' },
        h('span', null, 'elapsed ', h('b', { text: duration(elapsed) })),
        h('span', { title: est ? (j.estimated || estWord === 'est. total' ? 'An estimate' : 'The time budget you gave (shrinking and the report come after it)') : 'This job can’t tell in advance' }, `${estWord} `, h('b', { text: est ? duration(est) : 'n/a' })),
        running && est && pct != null ? h('span', null, 'left ', h('b', { text: `~${duration(Math.max(0, est - elapsed))}` })) : null,
        h('span', null, 'on ', h('b', { text: j.device === 'demo-tv' ? 'demo game' : deviceLabel(d) || j.device }))),
      links.length ? h('div', { class: 'exec-links' }, links) : null),
    list);
  list.scrollTop = list.scrollHeight;
  if (running) {
    // Elapsed time ticks without re-rendering the list.
    tickTimer = setInterval(() => {
      const b = body.querySelector('.exec-times b');
      if (b) b.textContent = duration(Date.now() - j.startedAt);
    }, 1000);
  }
}

/* ------------------------------------------------------------------ init */

export function initExec() {
  $('#exec-stop').addEventListener('click', async () => {
    if (!cur || cur.job.status !== 'running') return;
    try {
      if (cur.kind === 'sweep') await post(`/jobs/${encodeURIComponent(cur.job.id)}/cancel`);
      else await post(`/tests/${encodeURIComponent(cur.job.id)}/stop`);
      toast.info('Stopping…', cur.job.kind === 'explore' || cur.job.kind === 'navigation' ? 'The engine keeps what it found and writes the report.' : cur.job.name);
    } catch (err) {
      toast.fail('Couldn’t stop it', err.message);
    }
  });
  on('test:started', ({ kind, job }) => follow(kind, job));
  on('select', () => {
    if (cur?.job?.status !== 'running') {
      cur = null;
      render();
    }
    discover();
  });
  render();
  discover();
}

export function currentJob() {
  return cur?.job || null;
}
