// Shared bits for the test engine views: starting a test, status chips,
// severity chips and key sequences. Every view starts tests through
// startTest() so the Test Execution panel follows whatever was started last.

import { post, dev } from './api.js';
import { emit, liveDevice, selected, deviceLabel } from './store.js';
import { h, icon } from './dom.js';
import { KIND_INFO, OUTCOME, SEVERITIES, outcome } from './format.js';
import * as toast from './toast.js';

/**
 * POST /api/devices/:id/tests/<kind>. Demo explore runs need no device.
 * Returns the TestJob, or null when it couldn't start (a toast says why).
 */
export async function startTest(kind, body = {}) {
  const demo = body.driver === 'demo';
  const d = liveDevice();
  if (!d && !demo) {
    const s = selected();
    toast.fail('No device to test on', s ? `${deviceLabel(s)} is ${s.state}. Reconnect it first.` : 'Connect a TV in the Devices rail first.');
    return null;
  }
  const id = d ? d.id : 'demo';
  try {
    const job = await post(`${dev(id)}/tests/${kind}`, body, { timeout: 120000 });
    emit('test:started', { kind: 'test', job });
    toast.info(`${KIND_INFO[kind]?.label || kind} started`, job.name);
    return job;
  } catch (err) {
    toast.fail(`Couldn't start ${KIND_INFO[kind]?.label || kind}`, err.message);
    return null;
  }
}

export function statusChip(job) {
  const o = outcome(job);
  const info = OUTCOME[o] || OUTCOME.skip;
  return h('span', { class: `status status--${o}`, title: job?.error || '' }, icon(info.icon), info.word);
}

/** Findings per severity. `zeros` keeps empty severities (greyed). */
export function sevChips(counts, { zeros = false } = {}) {
  const c = counts || {};
  const list = SEVERITIES.filter((s) => zeros || c[s]);
  if (!list.length) return h('span', { class: 'sev is-zero', text: 'none' });
  return h('span', { class: 'sev-chips' }, list.map((s) => h('span', { class: `sev sev--${s}${c[s] ? '' : ' is-zero'}`, title: `${c[s] || 0} ${s}` }, String(c[s] || 0), ` ${s}`)));
}

export function keySeq(keys, max = 24) {
  const list = keys || [];
  if (!list.length) return h('span', { class: 'muted', text: 'no keys' });
  return h('span', { class: 'keyseq', 'aria-label': list.join(' ') },
    list.slice(0, max).map((k) => h('kbd', { text: k })),
    list.length > max ? h('span', { class: 'more', text: `+${list.length - max}` }) : null);
}

/** Link that opens a report in a new tab. */
export function reportLink(url, label = 'Report', small = true) {
  return h('a', { class: `btn ${small ? 'btn-sm' : ''} btn-ghost`, href: url, target: '_blank', rel: 'noopener', title: `Open ${label || 'the report'} in a new tab`, 'aria-label': label || 'Open the report' }, icon('external'), label || null);
}
