// Key log: a 60-second timeline of remote presses in two lanes (the physical
// remote, from SSE `key` events, and this dashboard), plus a list. Physical
// presses can be copied as a keys array or replayed.

import { state, on, liveDevice } from './store.js';
import { $, h, mount, copyText } from './dom.js';
import { clock, KEY_GLYPH } from './format.js';
import { cssVar } from './theme.js';
import { sendKeys } from './remote.js';
import * as toast from './toast.js';

const WINDOW_MS = 60000;
const MAX = 400;

let presses = []; // { key, t0, t1, src: 'remote' | 'dashboard', hold }
const openDown = new Map();
let canvas;
let ctx;
let host;
let w = 0;
let hgt = 0;
let dpr = 1;
let unseen = 0;
let timer = 0;
let listDirty = true;

function add(p) {
  presses.push(p);
  if (presses.length > MAX) presses.splice(0, presses.length - MAX);
  listDirty = true;
  if (state.tab !== 'keys' && p.src === 'remote' && Date.now() - p.t0 < 5000) unseen += 1;
  schedule();
}

function onKey(ev) {
  if (!ev || !ev.key) return;
  if (ev.action === 'down') {
    const p = { key: ev.key, t0: ev.ts, t1: null, src: 'remote' };
    openDown.set(ev.key, p);
    add(p);
  } else if (ev.action === 'up') {
    const p = openDown.get(ev.key);
    if (p) {
      p.t1 = ev.ts;
      openDown.delete(ev.key);
      listDirty = true;
      schedule();
    } else add({ key: ev.key, t0: ev.ts - 100, t1: ev.ts, src: 'remote' });
  }
}

function onSent({ keys, holdMs, gapMs, ts }) {
  keys.forEach((key, i) => {
    const t0 = ts + i * (gapMs || 120) + (holdMs ? 0 : 0);
    add({ key, t0, t1: t0 + (holdMs || 90), src: 'dashboard', hold: holdMs || 0 });
  });
}

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
}

function resize() {
  const r = host.getBoundingClientRect();
  dpr = Math.min(3, window.devicePixelRatio || 1);
  w = Math.max(1, Math.round(r.width));
  hgt = Math.max(1, Math.round(r.height));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  draw();
}

function draw() {
  if (!w || !ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const now = Date.now();
  const t0 = now - WINDOW_MS;
  const padL = 122;
  const padR = 14;
  const pw = w - padL - padR;
  const X = (t) => padL + ((t - t0) / WINDOW_MS) * pw;
  const grid = cssVar('--chart-grid');
  const axis = cssVar('--chart-axis');
  const ink1 = cssVar('--ink-1');
  const ink3 = cssVar('--ink-3');
  // Two lanes, spaced evenly above the time axis.
  const plotH = hgt - 22;
  const laneH = 22;
  const lanes = [
    { src: 'remote', label: 'Physical remote', y: Math.round(plotH * 0.3 - laneH / 2), color: cssVar('--key-remote') },
    { src: 'dashboard', label: 'Dashboard', y: Math.round(plotH * 0.74 - laneH / 2), color: cssVar('--key-dash') },
  ];
  const font = cssVar('--font-ui') || 'system-ui, sans-serif';
  const ui = (wgt, size) => `${wgt} ${size}px ${font}`;
  const mono = (wgt, size) => `${wgt} ${size}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

  // time grid
  ctx.lineWidth = 1;
  ctx.font = mono(500, 10);
  ctx.textAlign = 'center';
  for (let s = 0; s <= 60; s += 10) {
    const x = Math.round(padL + (s / 60) * pw) + 0.5;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x, hgt - 20);
    ctx.stroke();
    ctx.fillStyle = axis;
    ctx.fillText(s === 60 ? 'now' : `-${60 - s}s`, Math.min(x, w - padR - 8), hgt - 5);
  }

  for (const lane of lanes) {
    const cy = lane.y + laneH / 2;
    ctx.fillStyle = lane.color;
    ctx.beginPath();
    ctx.arc(18, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ink3;
    ctx.font = ui(600, 11);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(lane.label, 30, cy);
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(cy) + 0.5);
    ctx.lineTo(w - padR, Math.round(cy) + 0.5);
    ctx.stroke();

    let lastLabelX = -Infinity;
    for (const p of presses) {
      if (p.src !== lane.src) continue;
      const end = p.t1 ?? now;
      if (end < t0) continue;
      const x0 = Math.max(padL, X(p.t0));
      const x1 = Math.max(x0 + 5, X(end));
      const bh = 12;
      ctx.fillStyle = lane.color;
      roundRect(x0, cy - bh / 2, x1 - x0, bh, 3);
      if (x0 - lastLabelX > 30) {
        ctx.fillStyle = ink1;
        ctx.font = ui(700, 10);
        ctx.textAlign = 'left';
        ctx.fillText(KEY_GLYPH[p.key] || p.key, x0, cy - bh / 2 - 7);
        lastLabelX = x0;
      }
    }
  }
  ctx.textBaseline = 'alphabetic';
}

function roundRect(x, y, wd, ht, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + wd, y, x + wd, y + ht, r);
  ctx.arcTo(x + wd, y + ht, x, y + ht, r);
  ctx.arcTo(x, y + ht, x, y, r);
  ctx.arcTo(x, y, x + wd, y, r);
  ctx.closePath();
  ctx.fill();
}

function renderList() {
  if (!listDirty) return;
  listDirty = false;
  const recent = presses.slice(-90).reverse();
  const list = $('#key-list');
  if (!recent.length) {
    mount(list, h('li', { class: 'pane-empty' }, h('b', { text: 'No presses yet' }), h('span', { text: 'Presses on the physical remote (via getevent) and on this dashboard’s remote show here.' })));
    return;
  }
  mount(list, recent.map((p) => {
    const dur = p.t1 ? p.t1 - p.t0 : null;
    return h('li', { class: `key-row key-row--${p.src}` },
      h('time', { text: clock(p.t0, true) }),
      h('span', { class: 'key-glyph', text: KEY_GLYPH[p.key] || p.key }),
      p.hold ? h('span', { class: 'key-hold', text: `hold ${(p.hold / 1000).toFixed(1)}s` }) : h('span', { text: dur != null ? `${Math.round(dur)} ms` : '…' }),
      h('span', { class: 'key-src', text: p.src === 'remote' ? 'remote' : 'dashboard' }));
  }));
}

function render() {
  if (state.tab === 'keys') {
    draw();
    renderList();
  }
  const minute = presses.filter((p) => p.t0 > Date.now() - 60000);
  $('#keys-rate').textContent = minute.length ? `${minute.length} press${minute.length === 1 ? '' : 'es'} in the last minute` : '';
  const badge = $('#badge-keys');
  badge.hidden = unseen === 0;
  badge.textContent = String(unseen);
}

/** The last burst of physical presses (gaps under 3 s). */
function lastBurst() {
  const remote = presses.filter((p) => p.src === 'remote');
  const out = [];
  for (let i = remote.length - 1; i >= 0; i--) {
    if (out.length && out[0].t0 - remote[i].t0 > 3000) break;
    out.unshift(remote[i]);
  }
  return out;
}

export function initTimeline() {
  host = $('#keys-timeline');
  canvas = host.querySelector('canvas');
  ctx = canvas.getContext('2d');
  new ResizeObserver(resize).observe(host);
  on('key', onKey);
  on('keysent', onSent);
  on('select', () => {
    presses = [];
    openDown.clear();
    unseen = 0;
    listDirty = true;
    render();
  });
  on('theme', draw);
  on('tab', (tab) => {
    if (tab === 'keys') {
      unseen = 0;
      listDirty = true;
      requestAnimationFrame(() => {
        resize();
        render();
      });
    }
  });
  $('#keys-copy').addEventListener('click', async () => {
    const burst = lastBurst();
    if (!burst.length) {
      toast.info('No physical-remote presses to copy yet');
      return;
    }
    const text = JSON.stringify(burst.map((p) => p.key));
    if (await copyText(text)) toast.ok(`Copied ${burst.length} keys`, text);
  });
  $('#keys-replay').addEventListener('click', async () => {
    const burst = lastBurst();
    if (!burst.length || !liveDevice()) {
      toast.info(liveDevice() ? 'No physical-remote presses to replay yet' : 'Connect a device first');
      return;
    }
    const gaps = burst.slice(1).map((p, i) => p.t0 - burst[i].t0).sort((a, b) => a - b);
    const gapMs = gaps.length ? Math.max(150, Math.min(1200, gaps[gaps.length >> 1])) : 300;
    if (await sendKeys(burst.map((p) => p.key), { gapMs })) toast.ok(`Replayed ${burst.length} keys`, `${gapMs} ms apart`);
  });
  $('#keys-clear').addEventListener('click', () => {
    presses = [];
    openDown.clear();
    listDirty = true;
    render();
  });
  clearInterval(timer);
  timer = setInterval(() => {
    if (state.tab === 'keys' && !document.hidden) draw();
  }, 500);
  render();
}
