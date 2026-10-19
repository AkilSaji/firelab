#!/usr/bin/env node
// Regenerates the dashboard screenshots in docs/img/ from the mock server.
//
//   node ui/dev/screenshots.mjs              # 2x PNGs into docs/img/
//   node ui/dev/screenshots.mjs --dpr 1      # smaller files
//   node ui/dev/screenshots.mjs --only dashboard-light.png --out /tmp/shots
//   CHROME_PATH=/usr/bin/chromium node ui/dev/screenshots.mjs
//
// Starts its own mock server (port 7319 by default, --port to change) and its
// own headless Chrome. Chrome picks a free DevTools port and we read it from
// DevToolsActivePort, so this never attaches to another DevTools endpoint
// (on a dev machine a fixed port can be an `adb forward` to a real TV).
// Node >= 22 (global WebSocket), no dependencies.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const OUT = path.resolve(opt('out', path.join(here, '../../docs/img')));
const ONLY = opt('only', '');
const PORT = Number(opt('port', 7319));
const DPR = Number(opt('dpr', 2));
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH
  || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CHROME) {
  console.error('Chrome not found. Set CHROME_PATH.');
  process.exit(1);
}
if (typeof WebSocket === 'undefined') {
  console.error('Needs Node 22+ (global WebSocket).');
  process.exit(1);
}

const SHOTS = [
  {
    file: 'getting-started.png', scenario: 'empty', theme: 'dark', wait: 2500,
  },
  {
    // Wide enough for the whole Devices page: Test Engine, performance tiles, dock, Test Execution and Test Results.
    file: 'dashboard-dark.png', scenario: 'default', theme: 'dark', wait: 4000, w: 1920, h: 1080,
    steps: [
      { eval: "location.hash = 'page=devices&tab=console'", wait: 800 },
      { eval: "const a = document.querySelector('#engine-app'); a.value = 'com.firelab.webgame'; a.dispatchEvent(new Event('change')); document.querySelector('.quick[data-test=\"navigation\"]').click()", wait: 9000 },
    ],
  },
  {
    file: 'dashboard-light.png', theme: 'light', wait: 3500,
    steps: [{ eval: "location.hash = 'tab=watch'", wait: 1800 }],
  },
  {
    file: 'sweep.png', theme: 'dark', wait: 2500,
    steps: [
      { eval: "document.querySelectorAll('.device-main')[1].click(); location.hash = 'tab=sweep'", wait: 3000 },
      { eval: "document.querySelector('#sweep-url').value = 'https://game.example.com/play/'; document.querySelector('#sweep-run').click()", wait: 11500 },
    ],
  },
];

const children = [];
let ws;
let seq = 0;
const pending = new Map();
const problems = [];
let profile = null;

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

async function waitFor(fn, what, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  children.push(spawn(process.execPath, [path.join(here, 'mock-server.mjs'), '--port', String(PORT)], { stdio: 'ignore' }));
  await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, 'the mock server');

  profile = mkdtempSync(path.join(tmpdir(), 'firelab-shots-'));
  children.push(spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' }));
  const port = await waitFor(() => existsSync(`${profile}/DevToolsActivePort`) && Number(readFileSync(`${profile}/DevToolsActivePort`, 'utf8').split('\n')[0]), 'Chrome');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  if (!/HeadlessChrome/.test(version['User-Agent'] || '')) throw new Error(`Not our headless Chrome: ${version.Browser}`);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'), 'a page');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');

  for (const shot of SHOTS.filter((x) => !ONLY || ONLY.split(',').includes(x.file))) {
    if (shot.scenario) await fetch(`${BASE}/__mock/scenario`, { method: 'POST', body: JSON.stringify({ name: shot.scenario }) });
    await send('Emulation.setDeviceMetricsOverride', { width: shot.w || 1440, height: shot.h || 900, deviceScaleFactor: DPR, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: shot.theme }] });
    // The dashboard is dark unless the viewer picked light (stored by the theme toggle).
    await send('Page.navigate', { url: `${BASE}/favicon.png` });
    await sleep(300);
    await send('Runtime.evaluate', { expression: `localStorage.setItem('firelab.theme', ${JSON.stringify(JSON.stringify(shot.theme === 'light' ? 'light' : null))})` });
    await send('Page.navigate', { url: `${BASE}/?shot=${encodeURIComponent(shot.file)}` });
    await sleep(shot.wait);
    for (const step of shot.steps || []) {
      if (step.eval) await send('Runtime.evaluate', { expression: step.eval, awaitPromise: true });
      if (step.wait) await sleep(step.wait);
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, shot.file), Buffer.from(data, 'base64'));
    console.log(`wrote ${path.join(OUT, shot.file)}`);
  }
  if (problems.length) console.warn(`Page errors:\n${problems.join('\n')}`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      ws?.close();
    } catch {
      /* closed */
    }
    for (const c of children) c.kill('SIGTERM');
    await sleep(500);
    if (profile) rmSync(profile, { recursive: true, force: true });
    process.exit();
  });
