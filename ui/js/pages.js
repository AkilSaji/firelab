// Pages: Devices · Tests · Scenarios · Logs · Reports. The hash holds the page
// (#page=tests, combinable with #tab=sweep), the last one is remembered. The
// console is a single instance: on the Logs page its DOM moves there.

import { state, on, emit, select } from './store.js';
import { $, $$, h, mount, storage, save } from './dom.js';

const PAGES = ['devices', 'tests', 'scenarios', 'logs', 'reports'];
const TITLES = { devices: 'Device Lab', tests: 'Tests', scenarios: 'Scenarios', logs: 'Logs', reports: 'Reports' };

function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1)).get('page');
  return PAGES.includes(p) ? p : null;
}

export function showPage(name) {
  const page = PAGES.includes(name) ? name : 'devices';
  $('#app').dataset.page = page;
  $('#main').hidden = page !== 'devices';
  for (const p of PAGES.slice(1)) $(`#page-${p}`).hidden = p !== page;
  for (const a of $$('.pagenav-link')) {
    if (a.dataset.page === page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  moveConsole(page === 'logs');
  document.title = `FireLab · ${TITLES[page]}`;
  const changed = state.page !== page;
  state.page = page;
  save('firelab.page', page);
  if (changed) emit('page', page);
}

function moveConsole(toLogs) {
  const body = $('#console-body');
  const host = toLogs ? $('#logs-host') : $('#pane-console');
  if (body.parentElement !== host) host.append(body);
  $('#console-moved').hidden = !toLogs;
}

/** Device pickers on the Tests, Scenarios and Logs pages (the rail is hidden there). */
function renderPickers() {
  for (const sel of $$('.page-device')) {
    const list = state.devices;
    mount(sel, list.length
      ? list.map((d) => h('option', { value: d.id, text: `${d.name || d.model || d.id}${d.state !== 'device' ? ` (${d.state})` : ''}` }))
      : h('option', { value: '', text: 'no device' }));
    sel.value = state.selectedId || '';
    sel.disabled = !list.length;
  }
}

export function initPages() {
  for (const sel of $$('.page-device')) sel.addEventListener('change', () => select(sel.value || null));
  on('devices', renderPickers);
  on('select', renderPickers);
  for (const b of $$('[data-refresh]')) b.addEventListener('click', () => emit('refresh', b.dataset.refresh));
  window.addEventListener('hashchange', () => {
    const p = fromHash();
    if (p) showPage(p);
  });
  // Re-clicking the current page link still works when the hash is already set.
  for (const a of $$('.pagenav-link')) a.addEventListener('click', () => requestAnimationFrame(() => showPage(a.dataset.page)));
  showPage(fromHash() || storage('firelab.page', 'devices'));
}
