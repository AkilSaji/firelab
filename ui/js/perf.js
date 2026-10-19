// Performance panel: live charts and readouts from SSE `perf` events, plus
// network and device temperature from `vitals` events. A value the device
// didn't give shows as n/a with the reason; estimates say "est.".

import { state, on, liveDevice, selected } from './store.js';
import { LineChart } from './charts.js';
import { $, h, icon, mount, storage, save } from './dom.js';
import { median, quantile, shortGpu } from './format.js';

const WINDOW_MS = 120000;
const KEEP_MS = 300000;

const SOURCES = {
  page: ['page', 'Numbers from window.firelab, published by @firelab/perf inside the page.'],
  raf: ['raf', 'No @firelab/perf on the page, so FireLab counts requestAnimationFrame callbacks in the WebView.'],
  native: ['native', 'Android frame stats (dumpsys gfxinfo) for the foreground app.'],
};

let buf = { fps: [], scale: [], mem: [], cpu: [], frame: [], net: [], temp: [] };
let lastEv = null;
let lastVitals = null;
let now = 0;
let target = storage('firelab.targetFps', 30);
let charts;
let big = null; // the expanded view's charts, made on first open
let bigWindow = Number(storage('firelab.perfWindow', 120000)) || 120000;
let staleTimer = 0;

function reset() {
  buf = { fps: [], scale: [], mem: [], cpu: [], frame: [], net: [], temp: [] };
  lastEv = null;
  lastVitals = null;
  now = 0;
  draw();
  readouts();
}

function push(arr, t, v) {
  if (v == null || !Number.isFinite(v)) return;
  arr.push({ t, v });
  const cut = t - KEEP_MS;
  let i = 0;
  while (i < arr.length && arr[i].t < cut) i++;
  if (i) arr.splice(0, i);
}

function onPerf(ev) {
  const t = ev.ts || Date.now();
  push(buf.fps, t, ev.fps);
  push(buf.scale, t, ev.scale);
  push(buf.mem, t, ev.memMB);
  push(buf.cpu, t, ev.cpuPct);
  // Frame time: the page's own measurement when it publishes one, else 1000 / fps (an estimate).
  push(buf.frame, t, ev.frameMs ?? (ev.fps ? 1000 / ev.fps : null));
  lastEv = ev;
  now = Math.max(now, t);
  draw();
  readouts();
  clearTimeout(staleTimer);
  staleTimer = setTimeout(readouts, 6000);
}

function onVitals(v) {
  if (!v || typeof v.ts !== 'number') return;
  lastVitals = v;
  push(buf.net, v.ts, v.network?.rxMbps);
  push(buf.temp, v.ts, v.temperature?.c);
  now = Math.max(now, v.ts);
  draw();
  readouts();
}

function windowVals(arr) {
  const cut = now - WINDOW_MS;
  return arr.filter((p) => p.t >= cut).map((p) => p.v);
}

function draw() {
  if (!charts) return;
  const n = now || Date.now();
  const fpsVals = windowVals(buf.fps);
  charts.fps.setRefs({ target, median: median(fpsVals) });
  charts.fps.setData(buf.fps, n);
  charts.scale.setData(buf.scale, n);
  charts.mem.setData(buf.mem, n);
  charts.cpu.setData(buf.cpu, n);
  charts.frame.setData(buf.frame, n);
  charts.net.setData(buf.net, n);
  charts.temp.setData(buf.temp, n);
  drawBig();
}

// ---------- expanded view: the same four series, big, with axes and stats ----------

const BIG = {
  fps: { color: '--series-fps', min: 0, unit: 'fps', fmt: (v) => v.toFixed(v < 10 ? 1 : 0) },
  mem: { color: '--series-mem', unit: 'MB', gapMs: 20000, fmt: (v) => String(Math.round(v)) },
  cpu: { color: '--series-cpu', min: 0, unit: '%', fmt: (v) => String(Math.round(v)) },
  scale: { color: '--series-scale', min: 0, max: 1.05, unit: '', fmt: (v) => `×${v.toFixed(2)}` },
};

function makeBig() {
  big = {};
  for (const [k, o] of Object.entries(BIG)) {
    big[k] = new LineChart($(`#big-chart-${k}`), {
      color: o.color,
      axis: true,
      windowMs: bigWindow,
      min: o.min ?? null,
      max: o.max ?? null,
      ...(o.gapMs ? { gapMs: o.gapMs } : {}),
      format: (v, tip) => (tip ? `${o.fmt(v)}${o.unit ? ` ${o.unit}` : ''}` : o.fmt(v)),
    });
  }
}

function drawBig() {
  const dlg = $('#perf-dialog');
  if (!big || !dlg?.open) return;
  const n = now || Date.now();
  const cut = n - bigWindow;
  for (const k of Object.keys(BIG)) {
    const o = BIG[k];
    const pts = buf[k];
    const vals = pts.filter((p) => p.t >= cut).map((p) => p.v);
    if (k === 'fps') big.fps.setRefs({ target, median: median(vals) });
    big[k].opts.windowMs = bigWindow;
    big[k].setData(pts, n);
    const lastPt = pts.length ? pts[pts.length - 1] : null;
    const last = lastPt && lastPt.t >= cut ? lastPt.v : null; // nothing newer than the window: show "—", not a stale number
    setText(`#big-now-${k}`, last != null ? o.fmt(last) : '—');
    const why = {
      scale: 'this app doesn\'t publish a render scale (it comes from @firelab/perf\'s adaptive resolution inside the page)',
      fps: 'no frame rate from this app yet',
      mem: 'no memory samples yet',
      cpu: 'no CPU samples yet',
    };
    const stats = vals.length
      ? `median ${o.fmt(median(vals))} · min ${o.fmt(Math.min(...vals))} · max ${o.fmt(Math.max(...vals))}${k === 'fps' ? ` · p10 ${o.fmt(quantile(vals, 0.1))}` : ''}`
      : (pts.length ? 'no data in this window' : why[k]);
    setText(`#big-stats-${k}`, stats);
    dlg.querySelector(`[data-big="${k}"]`).classList.toggle('is-empty', !vals.length);
  }
  const d = selected();
  setText('#perf-dialog-dev', d ? `· ${d.name || d.model || d.id}${d.gpu ? ` · ${shortGpu(d.gpu)}` : ''}` : '');
}

function openBig() {
  const dlg = $('#perf-dialog');
  if (!big) makeBig();
  if (!dlg.open) dlg.showModal();
  // the canvases get their size once the dialog is laid out
  requestAnimationFrame(() => {
    for (const c of Object.values(big)) c.resize();
    drawBig();
  });
}

function setText(sel, text) {
  const el = $(sel);
  if (el.textContent !== text) el.textContent = text;
}

function readouts() {
  const ev = lastEv;
  const fpsVals = windowVals(buf.fps);
  // Window stats (2 min) for the readouts and the chart's median line;
  // the page's own ~10 s median drives the on/below-target status.
  const med = median(fpsVals);
  const p10 = quantile(fpsVals, 0.1);
  setText('#r-fps', ev?.fps != null ? ev.fps.toFixed(ev.fps < 10 ? 1 : 0) : '—');
  setText('#r-median', med != null ? med.toFixed(1) : '—');
  setText('#r-p10', p10 != null ? p10.toFixed(1) : '—');
  setText('#r-min', fpsVals.length ? Math.min(...fpsVals).toFixed(1) : '—');
  tiles(ev);

  // fps status against the target, always with words and an icon
  const st = $('#fps-status');
  const basis = ev?.fpsMedian ?? med ?? ev?.fps;
  if (basis == null) st.hidden = true;
  else {
    const kind = basis >= target ? 'ok' : basis >= target * 0.85 ? 'warn' : 'bad';
    const text = kind === 'ok' ? 'on target' : kind === 'warn' ? 'near target' : 'below target';
    st.hidden = false;
    st.className = `fps-status fps-status--${kind}`;
    mount(st, icon(kind === 'ok' ? 'check' : 'alert'), text);
  }

  const src = $('#perf-source');
  if (ev?.source && SOURCES[ev.source]) {
    src.hidden = false;
    src.textContent = SOURCES[ev.source][0];
    src.title = SOURCES[ev.source][1];
    src.className = `source-badge source-badge--${ev.source}`;
  } else src.hidden = true;

  const d = selected();
  const stale = ev && Date.now() - (ev.ts || 0) > 6000 && state.stream !== 'live';
  setText('#perf-window', stale ? 'stream paused · showing last data' : 'last 2 min');
  setText('#perf-gpu', d?.gpu ? shortGpu(d.gpu) : '');
  emptyState();
}

/** One tile: value, a note under it (source, estimate or why it's n/a). */
function tile(key, value, note, { na = false, est = false } = {}) {
  setText(`#r-${key}`, value);
  const n = $(`#n-${key}`);
  const text = est ? `est. · ${note}` : note;
  if (n.textContent !== text) {
    if (est) mount(n, h('span', { class: 'est', text: 'est.' }), ` · ${note}`);
    else n.textContent = note;
    n.title = text;
  }
  const el = $(`.tile[data-metric="${key}"]`);
  el.classList.toggle('is-na', na);
  el.classList.toggle('is-empty', na || value === '—');
}

function tiles(ev) {
  const live = !!liveDevice();
  const wait = live ? 'waiting for a sample' : 'no live device';
  if (ev?.cpuPct != null) tile('cpu', String(Math.round(ev.cpuPct)), '% of one core, the foreground app');
  else tile('cpu', ev ? 'n/a' : '—', ev ? 'the device gave no CPU reading' : wait, { na: !!ev });
  if (ev?.memMB != null) tile('mem', String(Math.round(ev.memMB)), 'PSS: app + WebView renderer');
  else tile('mem', ev ? 'n/a' : '—', ev ? 'no memory reading yet' : wait, { na: !!ev });
  if (ev?.frameMs != null) tile('frame', ev.frameMs.toFixed(1), `measured by the page${ev.frameP95Ms != null ? ` · p95 ${ev.frameP95Ms.toFixed(1)} ms` : ''}`);
  else if (ev?.fps) tile('frame', (1000 / ev.fps).toFixed(1), 'from 1000 / fps', { est: true });
  else tile('frame', ev ? 'n/a' : '—', ev ? 'no frame rate from this app' : wait, { na: !!ev });
  if (ev?.scale != null) tile('scale', `×${ev.scale.toFixed(2)}`, 'adaptive resolution (@firelab/perf)');
  else tile('scale', ev ? 'n/a' : '—', ev ? 'the page doesn’t publish a render scale' : wait, { na: !!ev });
  const v = lastVitals;
  if (v?.network) tile('net', v.network.rxMbps.toFixed(v.network.rxMbps < 10 ? 2 : 1), `down · up ${v.network.txMbps.toFixed(2)} Mbps · ${v.network.iface}`);
  else tile('net', v ? 'n/a' : '—', v?.networkNote || (live ? 'waiting for two readings' : 'no live device'), { na: !!v && !v.network && !/first reading/.test(v.networkNote || '') });
  if (v?.temperature) tile('temp', v.temperature.c.toFixed(1), `${v.temperature.sensor} · ${v.temperature.source === 'thermalservice' ? 'thermal HAL' : 'thermal zone'}`);
  else tile('temp', v ? 'n/a' : '—', v?.temperatureNote || (live ? 'waiting for a reading' : 'no live device'), { na: !!v });
}

function emptyState() {
  const el = $('#perf-empty');
  if (buf.fps.length || buf.mem.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const live = liveDevice();
  if (!live) {
    mount(el, h('h3', null, icon('activity'), 'No live device'), h('p', { text: 'Charts start as soon as a device is connected and streaming.' }));
    return;
  }
  mount(
    el,
    h('h3', null, icon('activity'), 'Waiting for numbers…'),
    h('p', { text: 'FireLab picks the best source it can find:' }),
    h(
      'ul',
      null,
      h('li', null, h('b', { text: 'page' }), h('span', { text: 'window.firelab from @firelab/perf in your page' })),
      h('li', null, h('b', { text: 'raf' }), h('span', { text: 'requestAnimationFrame counting in a debuggable WebView' })),
      h('li', null, h('b', { text: 'native' }), h('span', { text: 'Android frame stats for any foreground app' })),
    ),
  );
}

export function getTarget() {
  return target;
}

export function initPerf() {
  charts = {
    fps: new LineChart($('#chart-fps'), { color: '--series-fps', min: 0, axis: true, format: (v, tip) => (tip ? `${v.toFixed(1)} fps` : String(Math.round(v))) }),
    scale: new LineChart($('#chart-scale'), { color: '--series-scale', min: 0, max: 1.05, format: (v) => `×${v.toFixed(2)}` }),
    // Memory is sampled every few seconds (dumpsys meminfo is slow): allow longer gaps before breaking the line.
    mem: new LineChart($('#chart-mem'), { color: '--series-mem', gapMs: 20000, format: (v) => `${Math.round(v)} MB` }),
    cpu: new LineChart($('#chart-cpu'), { color: '--series-cpu', min: 0, max: 100, format: (v) => `${Math.round(v)}%` }),
    frame: new LineChart($('#chart-frame'), { color: '--series-frame', min: 0, format: (v) => `${v.toFixed(1)} ms` }),
    // vitals come every 4 s: allow longer gaps before breaking the line
    net: new LineChart($('#chart-net'), { color: '--series-net', min: 0, gapMs: 15000, format: (v) => `${v.toFixed(2)} Mbps` }),
    temp: new LineChart($('#chart-temp'), { color: '--series-temp', gapMs: 25000, format: (v) => `${v.toFixed(1)} °C` }),
  };
  const sel = $('#perf-target');
  sel.value = String(target);
  if (sel.value !== String(target)) {
    sel.append(h('option', { value: String(target), text: String(target) }));
    sel.value = String(target);
  }
  sel.addEventListener('change', () => {
    target = Number(sel.value) || 30;
    save('firelab.targetFps', target);
    draw();
    readouts();
  });
  $('#perf-expand').addEventListener('click', openBig);
  // A click on any small chart opens the big view too.
  for (const id of ['#chart-fps', '#chart-mem', '#chart-cpu', '#chart-scale', '#chart-frame']) {
    const el = $(id);
    el.style.cursor = 'zoom-in';
    el.title = 'Click to expand';
    el.addEventListener('click', openBig);
  }
  const win = $('#perf-dialog-window');
  win.value = String(bigWindow);
  win.addEventListener('change', () => {
    bigWindow = Number(win.value) || 120000;
    save('firelab.perfWindow', bigWindow);
    drawBig();
  });
  on('perf', onPerf);
  on('vitals', onVitals);
  on('select', reset);
  on('devices', readouts);
  on('stream', readouts);
  reset();
}
