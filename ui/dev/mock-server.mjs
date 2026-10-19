#!/usr/bin/env node
// FireLab dashboard mock server.
//
// Serves ui/ and fakes the whole dashboard HTTP API from docs/CONTRACT.md with
// believable data, so the dashboard can be built and demoed without adb or a
// device. Node built-ins only.
//
//   node ui/dev/mock-server.mjs                     # http://localhost:7310
//   node ui/dev/mock-server.mjs --scenario empty    # no devices yet (Scan Wi-Fi finds some)
//   node ui/dev/mock-server.mjs --scenario no-adb   # adb is not installed
//   node ui/dev/mock-server.mjs --scenario trouble  # one offline, one unauthorized device
//   node ui/dev/mock-server.mjs --port 7400
//
// Mock-only extras: POST /__mock/scenario { name } resets to a scenario, and
// GET /api/sessions/:id/thumbs/:n.jpg serves watch-session thumbnails.
// The test engine (tests, runs, scenarios, reports, GPU models, vitals) lives
// in mock-tests.mjs.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderScreen, HOME_NAV } from './scenes.mjs';
import { createTestLab, mockVitals } from './mock-tests.mjs';

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* --------------------------------------------------------------- options */

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  if (argv[i].includes('=')) return argv[i].slice(argv[i].indexOf('=') + 1);
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
if (opt('help', false)) {
  console.log('Usage: node ui/dev/mock-server.mjs [--port 7310] [--scenario default|empty|no-adb|trouble]');
  process.exit(0);
}
const PORT = Number(opt('port', process.env.PORT || 7310));
const SCENARIOS = ['default', 'empty', 'no-adb', 'trouble'];
let scenario = String(opt('scenario', 'default'));
if (!SCENARIOS.includes(scenario)) {
  console.error(`Unknown scenario "${scenario}". Use one of: ${SCENARIOS.join(', ')}`);
  process.exit(1);
}

/* ------------------------------------------------------------ vocabulary */

const TIERS = ['low', 'tv', 'tv-hd', 'high'];
const KEYS = ['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'playpause', 'rewind', 'fastforward', 'volup', 'voldown', 'mute', 'search', 'wake'];
const TIER_CAP = { low: '540p', tv: '720p', 'tv-hd': '1080p', high: 'native resolution' };
const LAUNCHER = 'com.amazon.tv.launcher';
const GAME = 'com.firelab.webgame';

const CATALOG = {
  '192.168.1.194:5555': {
    info: {
      model: 'AFTMA08C15', name: 'Fire TV Stick 4K Plus', os: 'Fire OS 8 (Android 11)',
      abi: 'armeabi-v7a', ramMB: 2048, gpu: 'PowerVR Rogue GE9215', tier: 'tv-hd', resolution: { width: 1920, height: 1080 },
    },
    profile: {
      gameFps: { low: 60, tv: 57, 'tv-hd': 45, high: 22 },
      sweep: { low: [59.6, 57.0], tv: [56.4, 50.2], 'tv-hd': [41.3, 33.4], high: [21.6, 16.2] },
      scale: { low: 1, tv: 1, 'tv-hd': 1, high: 0.85 },
      mem: [262, 334], cpu: 38, latency: [70, 140], build: 'RS8130', chrome: '130.0.6723.102',
    },
  },
  '192.168.1.205:5555': {
    info: {
      model: 'AFTSSS', name: 'Fire TV Stick (3rd gen)', os: 'Fire OS 7 (Android 9)',
      abi: 'armeabi-v7a', ramMB: 1024, gpu: 'PowerVR Rogue GE8300', tier: 'tv', resolution: { width: 1920, height: 1080 },
    },
    profile: {
      gameFps: { low: 38, tv: 27, 'tv-hd': 15, high: 7 },
      sweep: { low: [38.4, 33.2], tv: [27.2, 24.1], 'tv-hd': [15.4, 12.9], high: [7.1, 5.2] },
      scale: { low: 1, tv: 0.8, 'tv-hd': 0.62, high: 0.5 },
      mem: [206, 272], cpu: 64, latency: [160, 290], build: 'PS7633', chrome: '126.0.6478.134',
    },
  },
  // Some other box on the LAN with adb open. It never authorizes us.
  '192.168.1.77:5555': { info: null, profile: null, unauthorized: true },
};

const BASE_APPS = [
  { package: GAME, label: 'FireLab Web Game', version: '0.1.0', color: ['#ff7b29', '#9a3412'], webview: true },
  { package: 'com.sunsetvilla.tv', label: 'Sunset Villa', version: '1.6.0', color: ['#f59e0b', '#be185d'], webview: true },
  { package: 'com.example.lobbykiosk', label: 'Lobby Kiosk', version: '2.0.3', color: ['#14b8a6', '#134e4a'], webview: true },
  { package: 'org.videolan.vlc', label: 'VLC', version: '3.6.0', color: ['#fb923c', '#7c2d12'], webview: false },
];

/* ----------------------------------------------------------------- utils */

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}_${Math.random().toString(16).slice(2, 8)}`;
function gauss() {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 0.5;
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/* ----------------------------------------------------------------- state */

/** @type {Map<string, any>} */
let devices = new Map();
/** @type {Map<string, any>} */
let jobs = new Map();
/** @type {any[]} */
let sessions = [];

function makeRuntime(id, state) {
  const c = CATALOG[id];
  const rt = {
    id, ip: id.split(':')[0], state: state || (c.unauthorized ? 'unauthorized' : 'device'),
    info: c.info, profile: c.profile,
    apps: BASE_APPS.map((a) => ({ ...a })),
    scene: 'game', app: GAME, url: null, focus: { row: 1, col: 0 },
    lane: 0, prevLane: 0, laneAt: 0,
    tier: c.info?.tier || 'tv', sweeping: false,
    paused: false, pausedAt: 0, screenOn: true, overlay: {}, volume: 8, muted: false,
    clients: new Set(), perfHist: [], logHist: [], keyHist: [], fpsHistory: [],
    lastKeyAt: 0, phase: Math.random() * 6, scoreBase: Math.random() * 40000,
    scale: c.profile ? c.profile.scale[c.info.tier] : 1, mem: c.profile ? c.profile.mem[0] + 20 : 150,
    dipUntil: 0, nextDip: 0, nextLog: 0, nextBurst: 0, watch: null,
  };
  return rt;
}

function publicDevice(rt) {
  const base = { id: rt.id, ip: rt.ip, state: rt.state };
  if (rt.state === 'unauthorized' || !rt.info) return base;
  return { ...base, ...rt.info, tier: rt.info.tier };
}

function resetScenario(name) {
  for (const rt of devices.values()) closeClients(rt);
  for (const j of jobs.values()) clearInterval(j._timer);
  devices = new Map();
  jobs = new Map();
  sessions = [];
  scenario = name;
  testLab.reset();
  if (name === 'default' || name === 'trouble') {
    devices.set('192.168.1.194:5555', makeRuntime('192.168.1.194:5555'));
    devices.set('192.168.1.205:5555', makeRuntime('192.168.1.205:5555', name === 'trouble' ? 'offline' : 'device'));
    if (name === 'trouble') devices.set('192.168.1.77:5555', makeRuntime('192.168.1.77:5555'));
    seedSessions();
  }
  for (const rt of devices.values()) if (rt.state === 'device') seedHistory(rt);
}

/* ------------------------------------------------------------ simulation */

function samplePerf(rt, now) {
  const P = rt.profile;
  const s = now / 1000;
  const moving = now - rt.lastKeyAt < 2500;
  if (rt.scene === 'game') {
    const base = rt.sweeping ? P.sweep[rt.tier][0] : P.gameFps[rt.tier] ?? 30;
    let fps = base + base * 0.05 * Math.sin(s / 6.1 + rt.phase) + base * 0.03 * Math.sin(s / 1.7) + gauss() * base * 0.025;
    if (moving) fps -= base * 0.1;
    if (now >= rt.nextDip) {
      rt.dipUntil = now + 2000;
      rt.nextDip = now + rand(35000, 65000);
      pushLog(rt, 'warn', 'console', `[firelab/perf] long frame ${Math.round(rand(110, 180))} ms (texture upload: track-0${Math.ceil(rand(1, 4))}.ktx2)`, now);
    }
    if (now < rt.dipUntil) fps -= base * 0.28;
    fps = clamp(fps, 1, 60);
    const want = P.scale[rt.tier];
    if (fps < 24 && rt.scale > want - 0.15) rt.scale -= 0.04;
    else rt.scale += (want - rt.scale) * 0.08;
    rt.mem += rand(0.25, 0.55);
    if (rt.mem > P.mem[1]) {
      rt.mem = P.mem[0] + rand(0, 12);
      pushLog(rt, 'info', 'logcat', `art: Background concurrent copying GC freed ${Math.round(rand(14, 40))}MB AllocSpace bytes, ${Math.round(rand(30, 48))}% free`, now);
    }
    const cpu = P.cpu + 6 * Math.sin(s / 5) + gauss() * 3 + (moving ? 7 : 0);
    rt.fpsHistory.push(fps);
    if (rt.fpsHistory.length > 20) rt.fpsHistory.shift();
    return {
      ts: now, fps: r1(fps), fpsMedian: r1(median(rt.fpsHistory)), scale: r2(rt.scale),
      memMB: Math.round(rt.mem), cpuPct: Math.round(clamp(cpu, 2, 100)), source: 'page',
      // window.firelab.frameMs from @firelab/perf: only 'page' samples carry a measured frame time.
      frameMs: r1((1000 / fps) * (1 + gauss() * 0.02)), frameP95Ms: r1((1000 / fps) * rand(1.25, 1.5)),
    };
  }
  const fps = clamp(58.6 + rand(-1.2, 1.2) - (rt.scene === 'app' ? rand(0, 6) : 0) - (moving ? rand(0, 4) : 0), 1, 60);
  rt.fpsHistory.push(fps);
  if (rt.fpsHistory.length > 20) rt.fpsHistory.shift();
  return {
    ts: now, fps: r1(fps), fpsMedian: r1(median(rt.fpsHistory)),
    memMB: Math.round(rt.scene === 'app' ? 96 + 4 * Math.sin(s / 7) : 142 + 5 * Math.sin(s / 9)),
    cpuPct: Math.round(clamp(12 + rand(0, 6) + (moving ? 10 : 0), 1, 100)), source: 'native',
  };
}

const GAME_LOGS = [
  [5, 'info', 'console', (rt) => `[firelab/perf] tier=${rt.tier} gpu="${rt.info.gpu}" scale=${rt.scale.toFixed(2)} canvas=${Math.round(960 * rt.scale)}x${Math.round(540 * rt.scale)}`],
  [6, 'log', 'console', () => `[game] checkpoint ${Math.ceil(rand(1, 8))} · lap 2 · split ${rand(9, 14).toFixed(2)} s`],
  [4, 'log', 'console', () => `[net] GET /assets/track-0${Math.ceil(rand(1, 4))}.glb 200 · ${rand(0.4, 2.2).toFixed(1)} MB · ${Math.round(rand(90, 420))} ms`],
  [2, 'warn', 'console', (rt) => `[firelab/perf] fps ${rand(19, 23).toFixed(1)} under target 30 for 3 s, render scale ${rt.scale.toFixed(2)} → ${(rt.scale - 0.05).toFixed(2)}`],
  [2, 'warn', 'console', () => 'WebGL: INVALID_OPERATION: uniformMatrix4fv: location is not from the associated program'],
  [2, 'info', 'logcat', () => 'chromium: [INFO:CONSOLE(1)] "AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page."'],
  [1, 'warn', 'logcat', () => `Choreographer: Skipped ${Math.round(rand(31, 64))} frames!  The application may be doing too much work on its main thread.`],
  [1, 'error', 'exception', () => "Uncaught TypeError: Cannot read properties of undefined (reading 'mesh')\n    at Car.update (game.js:412:18)\n    at Track.tick (track.js:96:12)\n    at loop (main.js:88:7)"],
];
const HOME_LOGS = [
  [3, 'info', 'logcat', () => `WifiNetworkMonitor: RSSI ${-Math.round(rand(48, 62))} dBm, link speed ${pick([390, 433, 866])} Mbps`],
  [2, 'log', 'logcat', () => `ActivityTaskManager: Displayed ${LAUNCHER}/.ui.HomeActivity: +${Math.round(rand(240, 420))}ms`],
  [1, 'warn', 'logcat', () => `AudioFlinger: write blocked for ${Math.round(rand(60, 120))} msecs, ${Math.round(rand(1, 9))} delayed writes`],
];

function weighted(list) {
  const total = list.reduce((a, x) => a + x[0], 0);
  let r = Math.random() * total;
  for (const x of list) if ((r -= x[0]) <= 0) return x;
  return list[0];
}

function pushLog(rt, level, source, text, ts = Date.now()) {
  const ev = { ts, level, text, source };
  rt.logHist.push(ev);
  if (rt.logHist.length > 400) rt.logHist.shift();
  if (rt.watch && level === 'error') rt.watch.errors++;
  broadcast(rt, 'log', ev);
}

function maybeLog(rt, now) {
  if (now < rt.nextLog) return;
  rt.nextLog = now + rand(1500, 5200);
  const [, level, source, fn] = weighted(rt.scene === 'game' ? GAME_LOGS : HOME_LOGS);
  pushLog(rt, level, source, fn(rt), now);
}

function emitHumanKey(rt, key, now = Date.now()) {
  const dur = Math.round(rand(70, 180));
  const down = { ts: now, key, action: 'down' };
  const up = { ts: now + dur, key, action: 'up' };
  rt.keyHist.push(down, up);
  if (rt.keyHist.length > 200) rt.keyHist.splice(0, rt.keyHist.length - 200);
  broadcast(rt, 'key', down);
  setTimeout(() => broadcast(rt, 'key', up), dur);
  if (rt.watch) rt.watch.keys++;
  applyKey(rt, key, {});
}

function maybeHuman(rt, now) {
  // A person with the physical remote: busy during watch sessions, the odd burst otherwise.
  if (rt.watch) {
    if (now >= rt.nextBurst) {
      rt.nextBurst = now + rand(350, 1500);
      const k = rt.scene === 'game' ? pick(['left', 'right', 'right', 'left', 'up', 'ok']) : pick(['right', 'right', 'down', 'ok', 'left']);
      emitHumanKey(rt, k, now);
    }
    return;
  }
  if (!rt.nextBurst) rt.nextBurst = now + rand(20000, 40000);
  if (now >= rt.nextBurst && rt.scene === 'game' && !rt.sweeping) {
    rt.nextBurst = now + rand(40000, 70000);
    const seq = Array.from({ length: Math.ceil(rand(3, 6)) }, () => pick(['left', 'right']));
    seq.forEach((k, i) => setTimeout(() => devices.get(rt.id) === rt && emitHumanKey(rt, k), i * rand(250, 600)));
  }
}

function broadcast(rt, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of rt.clients) res.write(msg);
}

function stateEvent(rt) {
  return { ts: Date.now(), foreground: rt.scene === 'home' ? LAUNCHER : rt.app, screenOn: rt.screenOn, connected: rt.state === 'device' };
}

function closeClients(rt) {
  for (const res of rt.clients) {
    res.write(`event: state\ndata: ${JSON.stringify({ ...stateEvent(rt), connected: false })}\n\n`);
    res.end();
  }
  rt.clients.clear();
}

function seedHistory(rt) {
  const now = Date.now();
  const start = now - 150_000;
  rt.nextDip = start + 40_000;
  for (let t = start; t < now; t += 500) {
    const p = samplePerf(rt, t);
    rt.perfHist.push(p);
    if (Math.random() < 0.16) {
      const [, level, source, fn] = weighted(GAME_LOGS);
      rt.logHist.push({ ts: t, level, source, text: fn(rt) });
    }
  }
  // a couple of earlier bursts on the physical remote
  for (const [ago, seq] of [[92_000, ['right', 'right', 'down', 'ok']], [31_000, ['left', 'left', 'right', 'up', 'right']]]) {
    let t = now - ago;
    for (const key of seq) {
      const dur = Math.round(rand(70, 200));
      rt.keyHist.push({ ts: t, key, action: 'down' }, { ts: t + dur, key, action: 'up' });
      t += Math.round(rand(300, 700));
    }
  }
  rt.nextLog = now + 1000;
}

function setForeground(rt, scene, app) {
  rt.scene = scene;
  rt.app = app;
  rt.paused = false;
  rt.fpsHistory = [];
  broadcast(rt, 'state', stateEvent(rt));
}

function launchApp(rt, pkg, url) {
  const a = rt.apps.find((x) => x.package === pkg);
  rt.url = url || null;
  const q = url && /[?&]q=([\w-]+)/.exec(url);
  if (q && TIERS.includes(q[1])) rt.tier = q[1];
  const pid = Math.round(rand(4000, 32000));
  pushLog(rt, 'info', 'logcat', `ActivityManager: Start proc ${pid}:${pkg}/u0a${Math.round(rand(60, 140))} for activity ${pkg}/.MainActivity`);
  setForeground(rt, pkg === GAME ? 'game' : 'app', pkg);
  setTimeout(() => pushLog(rt, 'info', 'logcat', `ActivityTaskManager: Displayed ${pkg}/.MainActivity: +${(rand(0.8, 1.9)).toFixed(3).replace('.', 's')}ms`), 700);
  if (a?.webview) setTimeout(() => pushLog(rt, 'info', 'console', `[firelab/perf] v1 · autoTier=${rt.info.tier} tier=${rt.tier} gpu="${rt.info.gpu}"`), 1200);
  return pid;
}

function overlay(rt, kind, ms, extra = {}) {
  rt.overlay[kind] = { until: Date.now() + ms, ...extra };
}

function applyKey(rt, key, { holdMs = 0 } = {}) {
  const now = Date.now();
  const steps = holdMs >= 500 && ['up', 'down', 'left', 'right'].includes(key) ? Math.min(6, Math.round(holdMs / 250)) : 1;
  if (['up', 'down', 'left', 'right', 'ok'].includes(key)) rt.lastKeyAt = now;
  if (key === 'wake') {
    rt.screenOn = true;
    broadcast(rt, 'state', stateEvent(rt));
    return;
  }
  if (!rt.screenOn) return;
  if (key === 'volup' || key === 'voldown' || key === 'mute') {
    if (key === 'mute') rt.muted = !rt.muted;
    else {
      rt.muted = false;
      rt.volume = clamp(rt.volume + (key === 'volup' ? 1 : -1), 0, 15);
    }
    overlay(rt, 'volume', 1600, { level: rt.volume, muted: rt.muted });
    return;
  }
  if (key === 'search') {
    overlay(rt, 'search', 4000, { text: '' });
    return;
  }
  if (key === 'home') {
    rt.overlay = {};
    if (rt.scene !== 'home') setForeground(rt, 'home', LAUNCHER);
    return;
  }
  if (rt.scene === 'home') {
    const f = rt.focus;
    for (let i = 0; i < steps; i++) {
      if (key === 'left') f.col = Math.max(0, f.col - 1);
      if (key === 'right') f.col = Math.min((f.row === 0 ? HOME_NAV.length : rt.apps.length) - 1, f.col + 1);
      if (key === 'up' && f.row > 0) {
        f.row = 0;
        f.col = Math.min(f.col, HOME_NAV.length - 1);
      }
      if (key === 'down' && f.row < 1) {
        f.row = 1;
        f.col = Math.min(f.col, rt.apps.length - 1);
      }
    }
    if (key === 'ok') {
      if (f.row === 1 && rt.apps[f.col]) {
        if (holdMs >= 500) overlay(rt, 'menu', 2500);
        else launchApp(rt, rt.apps[f.col].package);
      } else overlay(rt, 'toast', 1500, { text: HOME_NAV[f.col] });
    }
    if (key === 'menu') overlay(rt, 'menu', 2500);
    return;
  }
  if (rt.scene === 'game') {
    if (key === 'left' || key === 'right') {
      rt.prevLane = laneNow(rt, now);
      rt.lane = clamp(rt.lane + (key === 'left' ? -1 : 1) * steps, -1, 1);
      rt.laneAt = now;
    }
    if (key === 'playpause') {
      rt.paused = !rt.paused;
      rt.pausedAt = now;
    }
    if (key === 'menu') overlay(rt, 'menu', 2500);
    if (key === 'ok' || key === 'up') overlay(rt, 'toast', 900, { text: key === 'ok' ? 'Boost!' : 'Nitro ready' });
    if (key === 'rewind' || key === 'fastforward') overlay(rt, 'toast', 1000, { text: key === 'rewind' ? 'Replay: last 10 s' : 'Skip intro' });
    if (key === 'back') {
      if (rt.overlay.menu && rt.overlay.menu.until > now) rt.overlay.menu = null;
      else setForeground(rt, 'home', LAUNCHER);
    }
    return;
  }
  if (key === 'back') setForeground(rt, 'home', LAUNCHER);
}

function laneNow(rt, now) {
  const k = clamp((now - rt.laneAt) / 220, 0, 1);
  return rt.prevLane + (rt.lane - rt.prevLane) * k;
}

function snapshot(rt, now = Date.now()) {
  return {
    scene: rt.scene, app: rt.app, apps: rt.apps, focus: { ...rt.focus }, lane: rt.lane, laneX: laneNow(rt, now),
    tier: rt.tier, paused: rt.paused, pausedAt: rt.pausedAt, screenOn: rt.screenOn,
    overlay: { ...rt.overlay }, scoreBase: rt.scoreBase,
    perf: rt.lastPerf || rt.perfHist.at(-1) || {}, fpsHistory: rt.perfHist.slice(-40).map((p) => p.fps ?? 0),
  };
}

/* ----------------------------------------------------------------- sweep */

function startSweep(rt, req) {
  const tiers = (req.tiers?.length ? req.tiers : TIERS).filter((t) => TIERS.includes(t));
  const target = Number(req.targetFps) || 30;
  const param = req.param || 'q';
  const job = {
    id: uid('job'), kind: 'sweep', status: 'running', progress: 0, device: rt.id, rows: [],
    current: null, startedAt: Date.now(), request: { ...req, tiers, targetFps: target, param },
  };
  const clients = new Set();
  Object.defineProperty(job, '_clients', { value: clients, enumerable: false });
  jobs.set(job.id, job);
  const total = 9600;
  const per = total / tiers.length;
  const pkg = req.package || GAME;
  rt.sweeping = true;
  let lastIdx = -1;
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (devices.get(rt.id) !== rt) {
      job.status = 'error';
      job.error = 'The device disconnected during the sweep. Reconnect it and run the sweep again.';
      finishJob(job, rt, timer);
      return;
    }
    const el = Date.now() - t0;
    const idx = Math.min(tiers.length - 1, Math.floor(el / per));
    const frac = (el - idx * per) / per;
    const tier = tiers[idx];
    if (idx !== lastIdx) {
      lastIdx = idx;
      rt.tier = tier;
      const sep = req.url.includes('?') ? '&' : '?';
      launchApp(rt, pkg, `${req.url}${sep}${param}=${tier}`);
      rt.scene = 'game';
      pushLog(rt, 'info', 'console', `[sweep] ${tier}: loading ${req.url}${sep}${param}=${tier}`);
    }
    const phase = frac < 0.14 ? 'launching' : frac < 0.38 ? 'warming up' : 'sampling';
    const live = rt.lastPerf?.fps;
    job.current = { tier, index: idx, phase, fps: live };
    job.progress = r2(Math.min(0.999, el / total));
    // finish rows for tiers already done
    while (job.rows.length < idx || (el >= total && job.rows.length < tiers.length)) {
      job.rows.push(sweepRow(rt, tiers[job.rows.length], target));
    }
    if (el >= total) {
      job.status = 'done';
      job.progress = 1;
      job.current = null;
      job.recommendation = recommend(rt, job.rows, target);
      finishJob(job, rt, timer);
      return;
    }
    sendJob(job, 'progress');
  }, 250);
  Object.defineProperty(job, '_timer', { value: timer, enumerable: false, writable: true });
  return job;
}

function sweepRow(rt, tier, target) {
  const [m, p10] = rt.profile.sweep[tier];
  const fpsMedian = r1(m + rand(-0.5, 0.5));
  const fpsP10 = r1(p10 + rand(-0.5, 0.5));
  const scale = rt.profile.scale[tier];
  const ok = fpsMedian >= target * 0.85 && fpsP10 >= target * 0.75;
  const memMB = Math.round(rt.profile.mem[0] + { low: -40, tv: 0, 'tv-hd': 38, high: 85 }[tier] + rand(-6, 6));
  const w = Math.round(960 * scale * (tier === 'tv-hd' || tier === 'high' ? 2 : tier === 'low' ? 0.75 : 1));
  const notes = {
    low: `${w}x${Math.round((w * 9) / 16)} · minimal effects`,
    tv: `${w}x${Math.round((w * 9) / 16)} · no shadows`,
    'tv-hd': ok ? `${w}x${Math.round((w * 9) / 16)} · sun shadows` : `GPU-bound: frame p95 ${Math.round(1000 / fpsP10 + 9)} ms`,
    high: ok ? 'full effects' : `unplayable: frame p95 ${Math.round(1000 / Math.max(1, fpsP10) + 12)} ms`,
  };
  return { tier, fpsMedian, fpsP10, memMB, scale, ok, note: notes[tier] };
}

function recommend(rt, rows, target) {
  const okRows = rows.filter((r) => r.ok);
  if (!okRows.length) {
    const best = [...rows].sort((a, b) => b.fpsMedian - a.fpsMedian)[0];
    return {
      tier: best.tier,
      reason: `No tier holds ${target} fps on this device. ${best.tier} comes closest (median ${Math.round(best.fpsMedian)} fps, p10 ${Math.round(best.fpsP10)}); profile the app before shipping.`,
    };
  }
  const best = okRows.sort((a, b) => TIERS.indexOf(b.tier) - TIERS.indexOf(a.tier))[0];
  const next = rows.find((r) => TIERS.indexOf(r.tier) === TIERS.indexOf(best.tier) + 1);
  let reason = `Use ${best.tier} at up to ${TIER_CAP[best.tier]} on this device: median ${Math.round(best.fpsMedian)} fps, p10 ${Math.round(best.fpsP10)}.`;
  if (next) reason += ` ${next.tier} drops to ${Math.round(next.fpsMedian)} fps.`;
  return { tier: best.tier, reason };
}

function sendJob(job, event) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(job)}\n\n`;
  for (const res of job._clients) res.write(msg);
}

function finishJob(job, rt, timer) {
  clearInterval(timer);
  rt.sweeping = false;
  rt.tier = rt.info.tier;
  sendJob(job, 'done');
  for (const res of job._clients) res.end();
  job._clients.clear();
  if (job.status === 'done') pushLog(rt, 'info', 'console', `[sweep] done · ${job.recommendation.reason}`);
}

/* ----------------------------------------------------------------- watch */

function watchSummary(w) {
  const fps = w.fpsSamples.length ? { median: r1(median(w.fpsSamples)), p10: r1(quantile(w.fpsSamples, 0.1)) } : undefined;
  return {
    sessionId: w.sessionId, device: w.device, startedAt: w.startedAt, endedAt: w.endedAt,
    keys: w.keys, fps, memMB: w.memMax ? { max: w.memMax } : undefined, errors: w.errors,
    thumbnails: w.snaps.map((_, i) => `/api/sessions/${w.sessionId}/thumbs/${i}.jpg`),
  };
}

function watchTick(rt, now, p) {
  const w = rt.watch;
  if (p.fps != null && p.source === 'page') w.fpsSamples.push(p.fps);
  if (p.memMB) w.memMax = Math.max(w.memMax, p.memMB);
  if (now - w.lastSnap >= w.intervalMs) {
    w.lastSnap = now;
    w.snaps.push({ ...snapshot(rt, now), t: now });
  }
}

function seedSessions() {
  const now = Date.now();
  const mk = (sessionId, device, startedAt, durS, keys, fps, mem, errors, n, scenes) => {
    const rt = { apps: BASE_APPS, tier: CATALOG[device].info.tier };
    const snaps = Array.from({ length: n }, (_, i) => {
      const t = startedAt + ((i + 0.5) / n) * durS * 1000;
      const scene = scenes[i % scenes.length];
      return {
        scene, app: scene === 'game' ? GAME : LAUNCHER, apps: rt.apps, focus: { row: 1, col: i % 3 }, lane: (i % 3) - 1,
        laneX: (i % 3) - 1, tier: rt.tier, paused: false, screenOn: true, overlay: {}, scoreBase: 1000 * i,
        perf: { fps: fps.median + rand(-3, 3), scale: CATALOG[device].profile.scale[rt.tier] }, fpsHistory: [], t,
      };
    });
    return {
      sessionId, device, package: GAME, startedAt, endedAt: startedAt + durS * 1000, keys, fps, memMB: { max: mem }, errors,
      fpsSamples: [], snaps, thumbnails: snaps.map((_, i) => `/api/sessions/${sessionId}/thumbs/${i}.jpg`),
    };
  };
  sessions.push(
    mk('w_5c1e9a', '192.168.1.194:5555', now - 3.4 * 3600e3, 221, 96, { median: 44.6, p10: 37.9 }, 318, 0, 6, ['home', 'game', 'game', 'game', 'game', 'game']),
    mk('w_8d21f0', '192.168.1.205:5555', now - 26.2 * 3600e3, 372, 214, { median: 26.8, p10: 22.1 }, 268, 2, 8, ['home', 'game', 'game', 'game', 'game', 'game', 'game', 'game']),
  );
}

function sessionList() {
  return sessions.map((s) => {
    if (s.live) return watchSummary(s.live);
    const { fpsSamples, snaps, live, ...pub } = s;
    return pub;
  });
}

/* ------------------------------------------------------------------ eval */

function firelabObject(rt) {
  const p = rt.lastPerf || {};
  const scale = rt.scale;
  return {
    version: '1', tier: rt.tier, autoTier: rt.info.tier, gpu: rt.info.gpu,
    fps: p.fps, fpsMedian: p.fpsMedian,
    frameMs: { p50: r1(1000 / Math.max(1, p.fpsMedian || 30)), p95: r1(1000 / Math.max(1, (p.fpsMedian || 30) * 0.72)) },
    scale: r2(scale), canvas: { width: Math.round(960 * scale), height: Math.round(540 * scale) },
    drawCalls: rt.tier === 'tv-hd' ? 212 : 175, triangles: rt.tier === 'tv-hd' ? 384120 : 249360, heapMB: Math.round(p.memMB * 0.22) || 54,
    marks: { scene: rt.paused ? 'paused' : 'race', lap: 2 },
  };
}

function fakeEval(rt, expression) {
  const e = expression.trim().replace(/;+$/, '');
  const fl = firelabObject(rt);
  const ua = `Mozilla/5.0 (Linux; Android ${rt.info.os.match(/Android (\d+)/)?.[1] || 11}; ${rt.info.model} Build/${rt.profile.build}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${rt.profile.chrome} Mobile Safari/537.36`;
  const table = {
    'window.firelab': fl, firelab: fl,
    'document.title': rt.apps.find((a) => a.package === rt.app)?.label || 'Untitled',
    'location.href': rt.url || `https://game.example.com/play/?q=${rt.tier}`,
    'navigator.userAgent': ua,
    devicePixelRatio: 1, 'window.devicePixelRatio': 1,
    innerWidth: 960, innerHeight: 540, 'window.innerWidth': 960, 'window.innerHeight': 540,
    'navigator.hardwareConcurrency': 4, 'navigator.deviceMemory': rt.info.ramMB >= 2048 ? 2 : 1,
    'performance.memory': { usedJSHeapSize: fl.heapMB * 1048576, totalJSHeapSize: (fl.heapMB + 18) * 1048576, jsHeapSizeLimit: 1136 * 1048576 },
    'performance.memory.usedJSHeapSize': fl.heapMB * 1048576,
    'Object.keys(localStorage)': ['firelab.tier', 'game.save.v2', 'game.settings'],
    "localStorage.getItem('firelab.tier')": rt.tier,
    "document.querySelectorAll('canvas').length": 1,
    'document.readyState': 'complete',
  };
  if (Object.hasOwn(table, e)) return table[e];
  const f = /^(?:window\.)?firelab\.(\w+)$/.exec(e);
  if (f) return fl[f[1]];
  if (/^[\d\s+\-*/().%]+$/.test(e)) return Function(`"use strict"; return (${e});`)();
  const ident = /^[A-Za-z_$][\w$]*/.exec(e)?.[0];
  const known = ['window', 'document', 'navigator', 'location', 'performance', 'localStorage', 'console', 'Math', 'JSON', 'Date', 'Object'];
  if (ident && !known.includes(ident)) throw new Error(`ReferenceError: ${ident} is not defined`);
  if (/^console\./.test(e)) return undefined;
  if (/^Math\./.test(e) || /^Date\.now\(\)$/.test(e)) return e.startsWith('Date') ? Date.now() : 0.4172;
  return null;
}

/* ------------------------------------------------------------------ http */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1e6) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

function openSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
    connection: 'keep-alive', 'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(ping));
}

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function needDevice(id, { live = true } = {}) {
  const rt = devices.get(id);
  if (!rt) throw new HttpError(404, `No device ${id}. Connect it first: Scan Wi-Fi, or enter its IP address.`);
  if (live && rt.state === 'unauthorized') throw new HttpError(409, `${id} has not authorized this computer. Accept "Allow USB debugging?" on the TV, then connect again.`);
  if (live && rt.state !== 'device') throw new HttpError(409, `${id} is ${rt.state}. Check that it is on and on the same network, then connect again.`);
  return rt;
}

function normalizeId(raw) {
  const id = decodeURIComponent(raw).trim();
  return id.includes(':') ? id : `${id}:5555`;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const noAdb = scenario === 'no-adb';

  if (p === '/api/health' && method === 'GET') {
    return json(res, 200, { ok: true, adb: noAdb ? null : { path: '/opt/homebrew/bin/adb', version: '35.0.2' }, version: '0.1.0', mock: true });
  }
  if (noAdb && p !== '/api/sessions') {
    throw new HttpError(503, 'adb was not found. Install Android platform-tools, then run `npx firelab doctor`.');
  }
  if (p === '/api/devices' && method === 'GET') return json(res, 200, [...devices.values()].map(publicDevice));
  if (p === '/api/scan' && method === 'POST') {
    const body = await readBody(req);
    await sleep(1600);
    if (body.subnet && !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(body.subnet)) throw new HttpError(400, `"${body.subnet}" is not a subnet. Use CIDR form, e.g. 192.168.1.0/24.`);
    return json(res, 200, { found: Object.keys(CATALOG).map((id) => ({ ip: id.split(':')[0], port: 5555 })), subnet: body.subnet || '192.168.1.0/24' });
  }
  if (p === '/api/sessions' && method === 'GET') return json(res, 200, sessionList());
  try {
    if (method === 'GET' && testLab.handleGet(req, res, url)) return;
    if (method === 'POST' && testLab.handlePost(res, p)) return;
  } catch (err) {
    throw new HttpError(err.status || 500, err.message);
  }

  let m = /^\/api\/sessions\/([^/]+)\/thumbs\/(\d+)\.jpg$/.exec(p);
  if (m && method === 'GET') {
    const s = sessions.find((x) => x.sessionId === m[1]);
    const snap = (s?.live ? s.live.snaps : s?.snaps)?.[Number(m[2])];
    if (!snap) throw new HttpError(404, 'No such thumbnail');
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
    return res.end(renderScreen(snap, { now: snap.t, w: Number(url.searchParams.get('w')) || 320 }));
  }

  if (p === '/api/jobs' && method === 'GET') return json(res, 200, [...jobs.values()].reverse());
  m = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(p);
  if (m && method === 'POST') {
    const job = jobs.get(m[1]);
    if (!job || job.status !== 'running') return json(res, 200, { ok: false });
    job.status = 'error';
    job.error = 'Cancelled from the dashboard';
    finishJob(job, devices.get(job.device) || { info: { tier: 'tv' } }, job._timer);
    return json(res, 200, { ok: true });
  }
  m = /^\/api\/jobs\/([^/]+)(\/stream)?$/.exec(p);
  if (m && method === 'GET') {
    const job = jobs.get(m[1]);
    if (!job) throw new HttpError(404, `No job ${m[1]}`);
    if (!m[2]) return json(res, 200, job);
    openSse(req, res);
    if (job.status !== 'running') {
      send(res, 'done', job);
      return res.end();
    }
    send(res, 'progress', job);
    job._clients.add(res);
    req.on('close', () => job._clients.delete(res));
    return;
  }

  m = /^\/api\/devices\/([^/]+)\/(.+)$/.exec(p);
  if (!m) throw new HttpError(404, `No route for ${method} ${p}`);
  const id = normalizeId(m[1]);
  const action = m[2];

  if (action === 'connect' && method === 'POST') {
    await sleep(rand(600, 1100));
    if (!CATALOG[id]) throw new HttpError(502, `Couldn't connect to ${id}: connection refused. Is ADB debugging on, and is the TV on this network?`);
    let rt = devices.get(id);
    if (!rt) {
      rt = makeRuntime(id);
      devices.set(id, rt);
      if (rt.state === 'device') seedHistory(rt);
    } else if (rt.state === 'offline') {
      rt.state = 'device';
      seedHistory(rt);
    }
    return json(res, 200, publicDevice(rt));
  }
  if (action === 'disconnect' && method === 'POST') {
    const rt = needDevice(id, { live: false });
    closeClients(rt);
    if (rt.watch) stopWatch(rt);
    devices.delete(id);
    return json(res, 200, { ok: true });
  }

  if (action.startsWith('tests/') && method === 'POST') {
    const body = await readBody(req);
    const target = body.driver === 'demo' ? devices.get(id) : needDevice(id);
    await sleep(rand(80, 200));
    try {
      return json(res, 200, testLab.startTest(target, action.slice(6), body));
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
  }

  const rt = needDevice(id);

  if (action === 'vitals' && method === 'GET') return json(res, 200, mockVitals(rt));
  if (action === 'screen.jpg' && method === 'GET') {
    await sleep(rand(...rt.profile.latency));
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
    return res.end(renderScreen(snapshot(rt), { w: Number(url.searchParams.get('w')) || 960 }));
  }
  if (action === 'stream' && method === 'GET') {
    openSse(req, res);
    send(res, 'state', stateEvent(rt));
    for (const ev of rt.perfHist.slice(-240)) send(res, 'perf', ev);
    for (const ev of rt.logHist.slice(-120)) send(res, 'log', ev);
    for (const ev of rt.keyHist.slice(-60)) send(res, 'key', ev);
    send(res, 'vitals', mockVitals(rt));
    rt.clients.add(res);
    req.on('close', () => rt.clients.delete(res));
    return;
  }
  if (method !== 'POST' && action !== 'apps') throw new HttpError(405, `Use POST for ${action}`);

  if (action === 'apps' && method === 'GET') {
    await sleep(rand(120, 260));
    return json(res, 200, { apps: rt.apps.map(({ package: pkg, label, version }) => ({ package: pkg, label, version })) });
  }

  const body = await readBody(req);
  switch (action) {
    case 'keys': {
      const keys = body.keys;
      if (!Array.isArray(keys) || !keys.length) throw new HttpError(400, 'keys must be a non-empty array, e.g. { "keys": ["down", "ok"] }');
      const bad = keys.find((k) => !KEYS.includes(k));
      if (bad) throw new HttpError(400, `Unknown key "${bad}". Use one of: ${KEYS.join(' ')}`);
      const holdMs = clamp(Number(body.holdMs) || 0, 0, 10000);
      const gap = clamp(Number(body.gapMs) || 120, 0, 5000);
      await sleep(rand(25, 60) + holdMs);
      keys.forEach((k, i) => setTimeout(() => applyKey(rt, k, { holdMs }), i * gap));
      return json(res, 200, { ok: true });
    }
    case 'text': {
      if (typeof body.text !== 'string' || !body.text) throw new HttpError(400, 'text must be a non-empty string');
      await sleep(80);
      if (rt.overlay.search && rt.overlay.search.until > Date.now()) overlay(rt, 'search', 4000, { text: body.text });
      else if (rt.scene === 'home') overlay(rt, 'search', 4000, { text: body.text });
      else overlay(rt, 'toast', 2000, { text: `Typed “${body.text.slice(0, 40)}”` });
      return json(res, 200, { ok: true });
    }
    case 'wake': {
      await sleep(120);
      applyKey(rt, 'wake');
      return json(res, 200, { ok: true });
    }
    case 'apps/launch': {
      const pkg = body.package;
      if (!pkg) throw new HttpError(400, 'package is required');
      if (!rt.apps.some((a) => a.package === pkg)) throw new HttpError(404, `${pkg} is not installed on this device`);
      await sleep(rand(400, 900));
      if (body.url && !/^https?:\/\//.test(body.url)) throw new HttpError(400, `url must start with http:// or https:// (got "${body.url}")`);
      const pid = launchApp(rt, pkg, body.url);
      return json(res, 200, { ok: true, pid });
    }
    case 'apps/stop': {
      if (!body.package) throw new HttpError(400, 'package is required');
      await sleep(200);
      if (rt.app === body.package && rt.scene !== 'home') setForeground(rt, 'home', LAUNCHER);
      pushLog(rt, 'info', 'logcat', `ActivityManager: Force stopping ${body.package} appid=10087 user=0: from pid ${Math.round(rand(2000, 9000))}`);
      return json(res, 200, { ok: true });
    }
    case 'apps/reset': {
      if (!body.package) throw new HttpError(400, 'package is required');
      if (body.confirm !== true) throw new HttpError(400, "Reset clears all of the app's data. Send { \"confirm\": true } to go ahead.");
      await sleep(rand(500, 900));
      if (rt.app === body.package && rt.scene !== 'home') setForeground(rt, 'home', LAUNCHER);
      pushLog(rt, 'warn', 'logcat', `ActivityManager: Force stopping ${body.package} appid=10087 user=0: clear data`);
      return json(res, 200, { ok: true });
    }
    case 'apps/install': {
      const file = String(body.path || '').trim();
      if (!file) throw new HttpError(400, 'path is required: the .apk file on this computer');
      if (!/\.apk$/i.test(file)) throw new HttpError(400, `${file} is not an .apk file`);
      await sleep(rand(1800, 2600));
      const base = path.basename(file).replace(/\.apk$/i, '');
      const pkg = `com.example.${base.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'app'}`;
      if (!rt.apps.some((a) => a.package === pkg)) {
        rt.apps.push({ package: pkg, label: base.replace(/[-_]+/g, ' '), version: '1.0.0', color: ['#64748b', '#1e293b'], webview: true });
      }
      pushLog(rt, 'info', 'logcat', `PackageManager: installed ${pkg} (${(rand(4, 40)).toFixed(1)} MB)`);
      return json(res, 200, { ok: true, package: pkg });
    }
    case 'webview/eval': {
      if (!body.expression) throw new HttpError(400, 'expression is required');
      await sleep(rand(60, 180));
      const pkg = body.package || (rt.scene === 'home' ? LAUNCHER : rt.app);
      const app = rt.apps.find((a) => a.package === pkg);
      if (!app) throw new HttpError(409, `No debuggable WebView in ${pkg}. Launch a WebView app first (or pick its package).`);
      if (!app.webview) throw new HttpError(409, `${pkg} has no WebView to inspect.`);
      if (pkg !== rt.app || rt.scene === 'home') throw new HttpError(409, `${pkg} is not running. Launch it, then try again.`);
      try {
        return json(res, 200, { value: fakeEval(rt, String(body.expression)) });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
    case 'sweep': {
      if (!body.url) throw new HttpError(400, 'url is required: the page to load at each tier, e.g. https://example.com/game/');
      if (rt.sweeping) throw new HttpError(409, 'A sweep is already running on this device.');
      const job = startSweep(rt, body);
      return json(res, 200, { jobId: job.id });
    }
    case 'watch/start': {
      if (rt.watch) throw new HttpError(409, `Already watching this device (session ${rt.watch.sessionId}). Stop it first.`);
      const w = {
        sessionId: uid('w'), device: rt.id, startedAt: Date.now(), keys: 0, errors: 0, fpsSamples: [], memMax: 0,
        snaps: [], lastSnap: 0, intervalMs: clamp(Number(body.intervalMs) || 5000, 1000, 60000), package: body.package,
      };
      rt.watch = w;
      rt.nextBurst = Date.now() + 800;
      sessions.unshift({ sessionId: w.sessionId, live: w });
      return json(res, 200, { sessionId: w.sessionId });
    }
    case 'watch/stop': {
      if (!rt.watch) throw new HttpError(409, 'Not watching this device. Start a watch session first.');
      return json(res, 200, stopWatch(rt));
    }
    default:
      throw new HttpError(404, `No route for ${method} ${p}`);
  }
}

function stopWatch(rt) {
  const w = rt.watch;
  w.endedAt = Date.now();
  if (!w.snaps.length) w.snaps.push({ ...snapshot(rt), t: Date.now() });
  const summary = watchSummary(w);
  const i = sessions.findIndex((s) => s.sessionId === w.sessionId);
  sessions[i] = { ...summary, snaps: w.snaps, fpsSamples: w.fpsSamples };
  rt.watch = null;
  return summary;
}

async function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return json(res, 400, { error: 'Bad path' });
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(UI_ROOT, `.${rel}`);
  if (!file.startsWith(UI_ROOT + path.sep)) return json(res, 403, { error: 'Forbidden' });
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch {
    json(res, 404, { error: `Not found: ${rel}` });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/__mock/scenario' && req.method === 'POST') {
      const { name } = await readBody(req);
      if (!SCENARIOS.includes(name)) throw new HttpError(400, `Use one of: ${SCENARIOS.join(', ')}`);
      resetScenario(name);
      return json(res, 200, { ok: true, scenario: name });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: err.message || 'Internal error' });
    else res.end();
  }
});

let ticks = 0;
const tick = setInterval(() => {
  const now = Date.now();
  ticks++;
  for (const rt of devices.values()) {
    if (rt.state !== 'device') continue;
    const p = samplePerf(rt, now);
    rt.lastPerf = p;
    rt.perfHist.push(p);
    if (rt.perfHist.length > 720) rt.perfHist.shift();
    broadcast(rt, 'perf', p);
    maybeLog(rt, now);
    maybeHuman(rt, now);
    if (rt.watch) watchTick(rt, now, p);
    if (ticks % 8 === 0) broadcast(rt, 'vitals', mockVitals(rt, now));
  }
}, 500);

const testLab = createTestLab({
  applyKey: (rt, key) => devices.get(rt.id) === rt && applyKey(rt, key, {}),
  launchApp: (rt, pkg) => devices.get(rt.id) === rt && rt.apps.some((a) => a.package === pkg) && launchApp(rt, pkg),
  sessions: () => sessionList(),
});

resetScenario(scenario);
server.listen(PORT, () => {
  console.log(`FireLab mock dashboard on http://localhost:${PORT}  (scenario: ${scenario})`);
});

function shutdown() {
  clearInterval(tick);
  for (const rt of devices.values()) closeClients(rt);
  for (const j of jobs.values()) clearInterval(j._timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
