// Tests page: every engine run on this computer (strategy, steps, states,
// findings by severity, pass/fail, report, re-run, findings with their key
// sequences) and the dashboard's test-job history.

import { api } from './api.js';
import { state, on, liveDevice } from './store.js';
import { $, h, icon, mount } from './dom.js';
import { KIND_INFO, ago, dateTime, duration } from './format.js';
import { startTest, statusChip, sevChips, keySeq, reportLink } from './testkit.js';
import { replayScenario } from './engine.js';
import { fetchHistory, totalsOf, totalsView } from './results.js';

let runs = [];
let jobs = [];
let open = new Set();
const details = new Map();
let query = '';
let loaded = false;

async function load() {
  loaded = true;
  const [r, j] = await Promise.all([api('/runs').catch(() => null), fetchHistory(0).catch(() => [])]);
  if (r) runs = r;
  jobs = j;
  render();
}

function rerun(run) {
  const body = {
    package: run.package,
    ...(run.url ? { url: run.url } : {}),
    strategy: run.strategy === 'random' ? 'random' : 'explore',
    ...(run.emulateGpu ? { emulateGpu: run.emulateGpu } : {}),
    // the same budget: minutes from the run's duration (at least one)
    minutes: Math.max(1, Math.round(run.durationMs / 60000)),
  };
  if (run.demo) {
    delete body.package;
    body.driver = 'demo';
  }
  return startTest('explore', body);
}

async function toggle(run) {
  if (open.has(run.runId)) open.delete(run.runId);
  else {
    open.add(run.runId);
    if (!details.has(run.runId)) {
      details.set(run.runId, null);
      api(`/runs/${encodeURIComponent(run.runId)}`).then((d) => {
        details.set(run.runId, d);
        render();
      }).catch((err) => {
        details.set(run.runId, { error: err.message });
        render();
      });
    }
  }
  render();
}

function detailRow(run) {
  const d = details.get(run.runId);
  let inner;
  if (!d) inner = h('span', { class: 'muted', text: 'Loading findings…' });
  else if (d.error) inner = h('span', { class: 'muted', text: d.error });
  else if (!d.findingList.length) inner = h('span', { class: 'muted', text: 'No findings in this run.' });
  else {
    inner = h('div', { class: 'finding-list' }, d.findingList.map((f) => h('div', { class: 'finding' },
      h('span', { class: `sev sev--${f.severity}`, text: f.severity }),
      h('span', { class: 'ft' }, f.title, h('span', { class: 'muted', text: ` · ${f.kind} · ${f.status}${f.repro ? ` ${f.repro.hits}/${f.repro.runs}` : ''}` })),
      f.keys.length ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => replayScenario({ runId: run.runId, trace: f.trace, demo: run.demo }) }, icon('replay'), 'Replay') : h('span'),
      h('span', { class: 'fk' }, keySeq(f.keys)))));
  }
  return h('tr', { class: 'run-detail' }, h('td', { colspan: '10' }, inner, d?.notes?.length ? h('p', { class: 'hint', text: d.notes.join(' ') }) : null));
}

function runsTable() {
  const showDemo = $('#runs-demo').checked;
  const q = query.toLowerCase();
  const list = runs.filter((r) => (showDemo || !r.demo) && (!q || [r.runId, r.package, r.device?.name, r.device?.model, r.device?.serial, r.strategy].join(' ').toLowerCase().includes(q)));
  $('#runs-count').textContent = String(list.length);
  if (!runs.length) {
    return h('div', { class: 'empty' }, h('b', { text: 'No engine runs yet' }),
      h('span', { text: 'Start Navigation or Explore from the Test Engine, or run it in a terminal:' }),
      h('code', { text: 'npx firelab explore --package com.example.game --minutes 10' }),
      h('span', { text: 'No TV? Try the simulated game:' }), h('code', { text: 'npx firelab demo' }));
  }
  if (!list.length) return h('div', { class: 'empty' }, h('span', { text: 'No run matches this filter.' }));
  const live = !!liveDevice();
  const rows = [];
  for (const r of list) {
    const isOpen = open.has(r.runId);
    rows.push(h('tr', { class: isOpen ? 'is-open' : '' },
      h('td', null, h('button', { class: 'icon-btn icon-btn-sm', type: 'button', 'aria-expanded': String(isOpen), 'aria-label': `${isOpen ? 'Hide' : 'Show'} findings of ${r.runId}`, onclick: () => toggle(r) }, icon(isOpen ? 'chevdown' : 'chevright'))),
      h('td', null, h('div', { class: 'run-id' }, h('b', { text: r.package }), h('small', { text: r.runId }))),
      h('td', { text: r.demo ? 'demo game' : r.device?.name || r.device?.serial || '—' }),
      h('td', null, r.strategy, r.emulateGpu ? h('span', { class: 'chip', title: 'GPU emulated (features and limits, not speed)', text: ` GPU ${r.emulateGpu}` }) : null),
      h('td', { class: 'num', text: String(r.steps) }),
      h('td', { class: 'num', text: String(r.states) }),
      h('td', null, sevChips(r.findings)),
      h('td', null, h('span', { class: `status status--${r.stopped === 'error' ? 'error' : r.failed ? 'fail' : 'pass'}`, title: r.error || 'Default rule: fails on a critical or major finding that reproduced, or an engine error' }, icon(r.failed ? 'x' : 'check'), r.stopped === 'error' ? 'error' : r.failed ? 'fail' : 'pass')),
      h('td', null, h('div', { class: 'run-id' }, h('span', { text: r.demo ? ago(r.writtenAt) : dateTime(r.startedAt), title: new Date(r.writtenAt).toLocaleString() }), h('small', { text: `${duration(r.durationMs)}${r.stopped === 'aborted' ? ' · stopped' : ''}` }))),
      h('td', null, h('span', { class: 'row-actions' },
        r.report ? reportLink(r.report, 'Report') : null,
        h('button', { class: 'btn btn-sm', type: 'button', disabled: !live && !r.demo, title: r.demo ? 'Run the demo game again' : live ? 'Run it again on the device picked above' : 'Connect a device first', onclick: () => rerun(r) }, icon('replay'), 'Re-run')))));
    if (isOpen) rows.push(detailRow(r));
  }
  return h('table', { class: 'data-table' },
    h('thead', null, h('tr', null, h('th', { class: 'sr-only', text: 'Expand' }), h('th', { text: 'App · run' }), h('th', { text: 'Device' }), h('th', { text: 'Strategy' }), h('th', { class: 'num', text: 'Steps' }), h('th', { class: 'num', text: 'States' }), h('th', { text: 'Findings' }), h('th', { text: 'Result' }), h('th', { text: 'When' }), h('th', { text: 'Actions' }))),
    h('tbody', null, rows));
}

function jobsTable() {
  $('#jobs-count').textContent = String(jobs.length);
  if (!jobs.length) return h('div', { class: 'empty' }, h('span', { text: 'No test jobs yet. Quick tests from the Test Engine are listed here.' }));
  return h('table', { class: 'data-table' },
    h('thead', null, h('tr', null, h('th', { text: 'Result' }), h('th', { text: 'Test' }), h('th', { text: 'Device' }), h('th', { text: 'Started' }), h('th', { class: 'num', text: 'Duration' }), h('th', { text: 'Last step' }), h('th', { text: '' }))),
    h('tbody', null, jobs.slice(0, 100).map((j) => {
      const d = state.devices.find((x) => x.id === j.device);
      return h('tr', null,
        h('td', null, statusChip(j)),
        h('td', null, h('div', { class: 'run-id' }, h('b', { text: KIND_INFO[j.kind]?.label || j.kind }), h('small', { text: j.name }))),
        h('td', { text: j.device === 'demo-tv' ? 'demo game' : d?.name || j.device }),
        h('td', { text: dateTime(j.startedAt) }),
        h('td', { class: 'num', text: j.endedAt ? duration(j.endedAt - j.startedAt) : '—' }),
        h('td', { class: 'note', text: j.error || j.log?.at(-1)?.text || '' }),
        h('td', null, j.report && j.status !== 'running' ? reportLink(j.report, 'Report') : null));
    })));
}

function render() {
  if (state.page !== 'tests') return;
  mount($('#tests-totals'), totalsView(totalsOf(jobs.filter((j) => j.startedAt >= Date.now() - 24 * 3600e3))));
  mount($('#runs-table'), runsTable());
  mount($('#jobs-table'), jobsTable());
}

export function initTestsPage() {
  let t = 0;
  $('#runs-search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      query = e.target.value.trim();
      render();
    }, 120);
  });
  $('#runs-demo').addEventListener('change', render);
  on('page', (p) => p === 'tests' && load());
  on('refresh', (p) => p === 'tests' && load());
  on('test:done', () => state.page === 'tests' && load());
  // Device polls come every few seconds: re-render only when what the table shows changes.
  let sig = '';
  const onDevices = () => {
    const next = JSON.stringify([liveDevice()?.id, state.devices.map((d) => [d.id, d.name])]);
    if (next === sig) return;
    sig = next;
    if (loaded) render();
  };
  on('devices', onDevices);
  on('select', onDevices);
  if (state.page === 'tests') load();
}
