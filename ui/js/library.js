// Scenarios page (finding traces and watch sessions, each with Replay and the
// last replay result) and Reports page (engine reports and benchmarks).

import { api } from './api.js';
import { state, on, liveDevice } from './store.js';
import { $, h, icon, mount } from './dom.js';
import { ago, dateTime, duration } from './format.js';
import { keySeq, reportLink, sevChips, statusChip } from './testkit.js';
import { replayScenario } from './engine.js';

let scen = { sessions: [], traces: [] };
const replaying = new Map(); // scenario key -> running TestJob

/* ------------------------------------------------------------- scenarios */

function lastReplay(key, last) {
  const live = replaying.get(key);
  if (live) return h('span', { class: 'scen-last' }, statusChip(live), ` ${live.phase || ''} ${live.progress != null ? `${Math.round(live.progress * 100)}%` : ''}`);
  if (!last) return h('span', { class: 'scen-last', text: 'never replayed' });
  return h('span', { class: 'scen-last', title: last.text }, statusChip({ status: 'done', verdict: last.verdict }), ` ${last.text} · ${ago(last.at)}`);
}

async function replay(key, target) {
  const job = await replayScenario(target);
  if (job) {
    replaying.set(key, job);
    renderScenarios();
  }
}

function traceCard(t) {
  const key = `run:${t.runId}/${t.file}`;
  const canRun = !!liveDevice() || t.demo;
  return h('article', { class: 'scen' },
    h('div', { class: 'scen-top' }, t.severity ? h('span', { class: `sev sev--${t.severity}`, text: t.severity }) : null, h('b', { text: t.title || t.file })),
    h('div', { class: 'scen-meta', text: [t.package, t.kind, t.status, `${t.length} keys${t.minimized ? ' (shrunk)' : ''}`, t.demo ? 'demo run' : null, t.runId].filter(Boolean).join(' · ') }),
    keySeq(t.keys, 30),
    h('div', { class: 'scen-foot' },
      lastReplay(key, t.lastReplay),
      h('a', { class: 'icon-btn icon-btn-sm', href: `/api/runs/${encodeURIComponent(t.runId)}/traces/${encodeURIComponent(t.file)}`, target: '_blank', rel: 'noopener', title: 'Open the trace JSON', 'aria-label': 'Open the trace JSON' }, icon('code')),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: !canRun || replaying.has(key), title: canRun ? 'Relaunch the app, press these keys with the recorded gaps, check for the finding' : 'Connect a device first', onclick: () => replay(key, { runId: t.runId, trace: t.file, demo: t.demo }) }, icon('replay'), 'Replay')));
}

function sessionCard(s) {
  const key = `session:${s.sessionId}`;
  const canRun = !!liveDevice() && s.replayable;
  return h('article', { class: 'scen' },
    s.thumbnails?.length ? h('img', { class: 'scen-thumb', src: s.thumbnails[Math.min(1, s.thumbnails.length - 1)], alt: '', loading: 'lazy' }) : null,
    h('div', { class: 'scen-top' }, h('b', { text: dateTime(s.startedAt) }), h('span', { class: 'chip', text: s.package || 'no app recorded' })),
    h('div', { class: 'scen-meta', text: [s.device, s.endedAt ? duration(s.endedAt - s.startedAt) : null, `${s.keys} presses`, s.fps ? `fps median ${s.fps.median}` : null, s.errors ? `${s.errors} errors` : null].filter(Boolean).join(' · ') }),
    keySeq(s.keySequence, 30),
    h('div', { class: 'scen-foot' },
      lastReplay(key, s.lastReplay),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: !canRun || replaying.has(key), title: !s.replayable ? 'This session recorded no app or no presses' : canRun ? 'Relaunch the app and press the recorded keys with their gaps' : 'Connect a device first', onclick: () => replay(key, { sessionId: s.sessionId }) }, icon('replay'), 'Replay')));
}

function renderScenarios() {
  if (state.page !== 'scenarios') return;
  $('#traces-count').textContent = String(scen.traces.length);
  $('#wsessions-count').textContent = String(scen.sessions.length);
  mount($('#traces-list'), scen.traces.length ? scen.traces.map(traceCard) : h('div', { class: 'empty' }, h('b', { text: 'No finding traces yet' }), h('span', { text: 'Every engine finding comes with the key sequence that reproduces it. Run Navigation or Explore.' })));
  mount($('#wsessions-list'), scen.sessions.length ? scen.sessions.map(sessionCard) : h('div', { class: 'empty' }, h('b', { text: 'No watch sessions yet' }), h('span', { text: 'Start one on the Devices page (Watch tab) and hand the remote to a player.' })));
}

async function loadScenarios() {
  try {
    scen = await api('/scenarios');
  } catch {
    /* keep the last list */
  }
  renderScenarios();
}

/* --------------------------------------------------------------- reports */

async function loadReports() {
  let r = { engine: [], bench: [] };
  try {
    r = await api('/reports');
  } catch {
    /* empty */
  }
  if (state.page !== 'reports') return;
  $('#bench-count').textContent = String(r.bench.length);
  $('#ereports-count').textContent = String(r.engine.length);
  const when = (t) => (typeof t === 'number' ? dateTime(t) : t ? String(t) : 'date unknown');
  mount($('#reports-bench'), r.bench.length
    ? r.bench.map((b) => h('article', { class: 'report' },
      h('h3', { text: b.title }),
      b.headline ? h('p', { text: b.headline }) : null,
      h('div', { class: 'scen-meta' }, h('span', { text: when(b.createdAt) }), h('span', { text: b.id })),
      b.subjects.length ? h('div', { class: 'chips', 'aria-label': 'Subjects' }, b.subjects.map((x) => h('span', { class: 'chip', text: x }))) : null,
      b.strategies.length ? h('div', { class: 'chips', 'aria-label': 'Strategies' }, b.strategies.map((x) => h('span', { class: 'chip', text: x }))) : null,
      b.report ? reportLink(b.report, 'Open report') : h('span', { class: 'muted', text: 'no report.html next to bench.json' })))
    : h('div', { class: 'empty' }, h('b', { text: 'No benchmarks yet' }), h('span', { text: 'Benchmark reports appear here when a run writes ~/.firelab/bench/<id>/bench.json and report.html.' })));
  mount($('#reports-engine'), r.engine.length
    ? r.engine.map((e) => h('article', { class: 'report' },
      h('h3', { text: e.package }),
      h('div', { class: 'scen-meta' }, h('span', { text: e.demo ? 'demo game' : e.device?.name || e.device?.serial }), h('span', { text: e.demo ? ago(e.createdAt) : dateTime(e.createdAt) }), h('span', { text: e.strategy })),
      h('p', { text: `${e.steps} steps · ${e.states} screens` }),
      h('div', { class: 'chips' }, h('span', { class: `status status--${e.failed ? 'fail' : 'pass'}` }, icon(e.failed ? 'x' : 'check'), e.failed ? 'fail' : 'pass'), sevChips(e.findings)),
      reportLink(e.report, 'Open report')))
    : h('div', { class: 'empty' }, h('b', { text: 'No engine reports yet' }), h('span', { text: 'Each Navigation or Explore run writes one.' })));
}

/* ------------------------------------------------------------------ init */

export function initLibrary() {
  on('page', (p) => {
    if (p === 'scenarios') loadScenarios();
    if (p === 'reports') loadReports();
  });
  on('refresh', (p) => {
    if (p === 'scenarios') loadScenarios();
    if (p === 'reports') loadReports();
  });
  on('test:update', (j) => {
    for (const [k, v] of replaying) if (v.id === j.id) replaying.set(k, j);
    renderScenarios();
  });
  on('test:done', (j) => {
    for (const [k, v] of replaying) if (v.id === j.id) replaying.delete(k);
    if (state.page === 'scenarios') loadScenarios();
    if (state.page === 'reports') loadReports();
  });
  // Device polls come every few seconds: re-render only when the live device changes (keeps focus).
  let liveId;
  const onDevices = () => {
    const id = liveDevice()?.id;
    if (id === liveId) return;
    liveId = id;
    renderScenarios();
  };
  on('select', onDevices);
  on('devices', onDevices);
  if (state.page === 'scenarios') loadScenarios();
  if (state.page === 'reports') loadReports();
}
