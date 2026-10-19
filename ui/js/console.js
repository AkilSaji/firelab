// Console pane: SSE `log` events with level/source filters, search, follow
// (auto-scroll), copy, download and clear. Rows are appended in batches per
// frame. The same instance shows in the dock and, full width, on the Logs page.

import { state, on, selected } from './store.js';
import { $, $$, h, icon, highlight, mount, copyText } from './dom.js';
import { clock } from './format.js';
import * as toast from './toast.js';

const MAX = 2000;
const SRC_LABEL = { console: 'page', exception: 'exception', logcat: 'logcat' };

let logs = [];
let pending = [];
let raf = 0;
let follow = true;
let unseen = 0;
let unreadErrors = 0;
const levels = new Set(['log', 'info', 'warn', 'error']);
const sources = new Set(['console', 'exception', 'logcat']);
let query = '';
let list;
let ignoreScrollUntil = 0; // moving the list between the dock and the Logs page fires scroll events

const counts = () => {
  const c = { log: 0, info: 0, warn: 0, error: 0 };
  for (const l of logs) c[l.level] = (c[l.level] || 0) + 1;
  return c;
};

function matches(l) {
  if (!levels.has(l.level)) return false;
  if (!sources.has(l.source || 'console')) return false;
  if (query && !l.text.toLowerCase().includes(query)) return false;
  return true;
}

function row(l) {
  return h(
    'div',
    { class: `log-row log-row--${l.level}` },
    h('span', { class: 'log-time', text: clock(l.ts, true) }),
    h('span', { class: 'log-level', text: l.level }),
    h('span', { class: 'log-src', text: SRC_LABEL[l.source] || l.source || '' }),
    h('span', { class: 'log-text' }, highlight(l.text, query)),
  );
}

function emptyRow() {
  const anyLogs = logs.length > 0;
  return h(
    'div',
    { class: 'log-empty' },
    icon('terminal'),
    h('b', { text: anyLogs ? 'Nothing matches these filters' : state.selectedId ? 'No console output yet' : 'No device selected' }),
    h('span', {
      text: anyLogs
        ? 'Turn levels or sources back on, or clear the search.'
        : 'console.* calls and uncaught errors from the app’s WebView show here, along with its logcat lines.',
    }),
  );
}

function nearBottom() {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 24;
}

function scrollToEnd() {
  list.scrollTop = list.scrollHeight;
}

function rerender() {
  pending = [];
  const vis = logs.filter(matches);
  if (!vis.length) mount(list, emptyRow());
  else {
    const frag = document.createDocumentFragment();
    for (const l of vis.slice(-MAX)) frag.append(row(l));
    mount(list, frag);
  }
  unseen = 0;
  if (follow) scrollToEnd();
  updateChrome();
}

function flush() {
  raf = 0;
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  if (list.firstChild?.classList?.contains('log-empty')) list.firstChild.remove();
  const frag = document.createDocumentFragment();
  for (const l of batch) frag.append(row(l));
  list.append(frag);
  while (list.childElementCount > MAX) list.firstChild.remove();
  if (follow) scrollToEnd();
  else unseen += batch.length;
  updateChrome();
}

function updateChrome() {
  const c = counts();
  for (const b of $$('#log-levels .seg-btn')) b.querySelector('.n').textContent = String(c[b.dataset.level] || 0);
  const jump = $('#log-jump');
  jump.hidden = follow || unseen === 0;
  jump.textContent = `${unseen} new ↓`;
  const badge = $('#badge-console');
  badge.hidden = unreadErrors === 0;
  badge.textContent = String(unreadErrors);
  badge.title = `${unreadErrors} new error${unreadErrors === 1 ? '' : 's'}`;
}

function setFollow(v) {
  follow = v;
  $('#log-autoscroll').setAttribute('aria-pressed', String(v));
  if (v) {
    unseen = 0;
    scrollToEnd();
  }
  updateChrome();
}

function onLog(l) {
  if (!l || typeof l.text !== 'string') return;
  logs.push(l);
  if (logs.length > MAX * 1.5) logs = logs.slice(-MAX);
  // Count only errors that just happened, not a backlog replayed on connect.
  if (l.level === 'error' && state.tab !== 'console' && Date.now() - l.ts < 5000) unreadErrors += 1;
  if (matches(l)) {
    pending.push(l);
    if (!raf) raf = requestAnimationFrame(flush);
  } else updateChrome();
}

export function initConsole() {
  list = $('#log-list');
  for (const b of $$('#log-levels .seg-btn')) {
    b.addEventListener('click', () => {
      const lv = b.dataset.level;
      if (levels.has(lv)) levels.delete(lv);
      else levels.add(lv);
      b.setAttribute('aria-pressed', String(levels.has(lv)));
      rerender();
    });
  }
  for (const b of $$('#log-sources .seg-btn')) {
    b.addEventListener('click', () => {
      const s = b.dataset.source;
      if (sources.has(s)) sources.delete(s);
      else sources.add(s);
      b.setAttribute('aria-pressed', String(sources.has(s)));
      rerender();
    });
  }
  let debounce = 0;
  $('#log-search').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      query = e.target.value.trim().toLowerCase();
      rerender();
    }, 120);
  });
  $('#log-autoscroll').addEventListener('click', () => setFollow(!follow));
  $('#log-jump').addEventListener('click', () => setFollow(true));
  list.addEventListener('scroll', () => {
    if (Date.now() < ignoreScrollUntil) return;
    // Scrolling up pauses follow; scrolling back to the end resumes it.
    if (follow && !nearBottom()) setFollow(false);
    else if (!follow && nearBottom()) setFollow(true);
  }, { passive: true });
  $('#log-copy').addEventListener('click', async () => {
    const vis = logs.filter(matches);
    if (!vis.length) {
      toast.info('Nothing to copy');
      return;
    }
    const text = vis.map((l) => `${clock(l.ts, true)} [${l.level}] [${l.source || 'console'}] ${l.text}`).join('\n');
    if (await copyText(text)) toast.ok(`Copied ${vis.length} line${vis.length === 1 ? '' : 's'}`);
  });
  $('#log-download').addEventListener('click', () => {
    const vis = logs.filter(matches);
    if (!vis.length) {
      toast.info('Nothing to download');
      return;
    }
    const d = selected();
    const head = `# FireLab console · ${d ? `${d.name || d.model || ''} ${d.id}`.trim() : 'no device'} · ${new Date().toISOString()}\n`;
    const text = head + vis.map((l) => `${new Date(l.ts).toISOString()} [${l.level}] [${l.source || 'console'}] ${l.text}`).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = h('a', { href: url, download: `firelab-${(d?.id || 'console').replace(/[^\w.-]+/g, '_')}-${stamp}.log` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#log-clear').addEventListener('click', () => {
    logs = [];
    unreadErrors = 0;
    rerender();
  });
  on('log', onLog);
  on('select', () => {
    logs = [];
    unreadErrors = 0;
    rerender();
  });
  on('page', () => {
    ignoreScrollUntil = Date.now() + 500;
    requestAnimationFrame(() => follow && scrollToEnd());
  });
  on('tab', (tab) => {
    if (tab === 'console') {
      unreadErrors = 0;
      updateChrome();
      if (follow) requestAnimationFrame(scrollToEnd);
    }
  });
  rerender();
}

