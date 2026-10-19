// Test Results panel: totals over the last 24 h (test jobs and sweeps) and
// the most recent runs with their outcome, duration and report.

import { api } from './api.js';
import { on, state } from './store.js';
import { $, h, icon, mount } from './dom.js';
import { KIND_INFO, ago, duration, outcome } from './format.js';
import { statusChip, reportLink } from './testkit.js';

const DAY = 24 * 3600e3;
let timer = 0;

/** Test jobs plus sweeps (in the TestJob shape) since `since`, newest first. */
export async function fetchHistory(since = Date.now() - DAY) {
  const [tests, sweeps] = await Promise.all([api(`/tests?since=${Math.floor(since)}&limit=300`).catch(() => []), api('/jobs').catch(() => [])]);
  const sw = (Array.isArray(sweeps) ? sweeps : [])
    .filter((j) => (j.startedAt || 0) >= since)
    .map((j) => ({
      id: j.id, kind: 'sweep', name: `Sweep · ${j.request?.url || ''}`, device: j.device, startedAt: j.startedAt, endedAt: j.endedAt,
      status: j.status === 'error' ? 'failed' : j.status, ...(j.status === 'done' ? { verdict: j.rows?.some((r) => r.ok) ? 'pass' : 'fail' } : {}), error: j.error,
    }));
  return [...(Array.isArray(tests) ? tests : []), ...sw].sort((a, b) => b.startedAt - a.startedAt);
}

/** passed = verdict pass; failed = verdict fail or the job broke; skipped = couldn't measure or stopped. Running jobs count in total only. */
export function totalsOf(list) {
  const t = { total: list.length, pass: 0, fail: 0, skip: 0 };
  for (const j of list) {
    const o = outcome(j);
    if (o === 'pass') t.pass++;
    else if (o === 'fail' || o === 'error') t.fail++;
    else if (o === 'skip' || o === 'stopped') t.skip++;
  }
  return t;
}

export function totalsView(t) {
  const cell = (kind, label, ic, n) => h('div', { class: `total total--${kind}` }, h('span', null, ic ? icon(ic) : null, label), h('b', { text: String(n) }));
  return [cell('all', 'total', null, t.total), cell('pass', 'passed', 'check', t.pass), cell('fail', 'failed', 'x', t.fail), cell('skip', 'skipped', 'info', t.skip)];
}

function recentItem(j) {
  const dur = j.endedAt ? duration(j.endedAt - j.startedAt) : j.status === 'running' ? 'running' : '—';
  const d = state.devices.find((x) => x.id === j.device);
  return h('li', null,
    statusChip(j),
    h('span', { class: 'name', text: j.name || KIND_INFO[j.kind]?.label || j.kind, title: j.error || j.name }),
    h('span', { class: 'meta', text: [dur, ago(j.startedAt), j.device === 'demo-tv' ? 'demo game' : d?.name || j.device].filter(Boolean).join(' · ') }),
    h('span', { class: 'lnk' }, j.report && j.status !== 'running' ? reportLink(j.report, '') : null));
}

async function refresh() {
  clearTimeout(timer);
  const body = $('#results-body');
  try {
    const list = await fetchHistory();
    const t = totalsOf(list);
    mount(body,
      h('div', { class: 'totals' }, totalsView(t)),
      list.length
        ? h('ul', { class: 'recent', 'aria-label': 'Recent runs' }, list.slice(0, 12).map(recentItem))
        : h('div', { class: 'pane-empty' }, icon('check'), h('b', { text: 'Nothing in the last 24 hours' }), h('span', { text: 'Finished tests and sweeps are counted here.' })));
  } catch {
    /* keep what is shown */
  }
  timer = setTimeout(refresh, document.hidden ? 120000 : 30000);
}

export function initResults() {
  on('test:done', () => setTimeout(refresh, 300));
  on('test:started', () => setTimeout(refresh, 300));
  on('page', (p) => p === 'devices' && refresh());
  refresh();
}
