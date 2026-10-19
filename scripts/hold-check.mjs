#!/usr/bin/env node
// Hold check: what does a held remote key actually deliver to an app, per method?
//
//   npm run build
//   node scripts/hold-check.mjs --device 192.168.1.194:5555 --package dev.firelab.fireflylake
//   node scripts/hold-check.mjs -d 192.168.1.194 -p dev.firelab.fireflylake --key right --hold 2000 \
//       --methods input-longpress,input-repeat,hid,hid-keyboard,sendevent,input-duration,cdp,firelab --out hold.json
//
// It needs a FireLab-wrapped WebView app (dev.firelab.*, built with `firelab wrap`
// or any app with WebView debugging on; pass --allow-any for other packages).
// It launches the app if needed, installs a keydown/keyup counter in the page
// through a WebView eval, and then, for each method, holds one key and reads
// back what the page saw: key-downs (and how many were auto-repeats), key-ups,
// and the longest stretch the key stayed down. It also records the kernel input
// events (getevent) during each hold, which tells "never reached the kernel"
// apart from "reached the kernel but not the app".
//
// Methods:
//   input-longpress  `input keyevent --longpress K` (FireLab's old hold): down, an instant repeat, up
//   input-repeat     FireLab's input hold now: a press, ~400 ms, presses every ~30 ms until the end
//   hid              raw virtual HID remote (consumer page), no fallback, with diagnostics
//   hid-keyboard     raw virtual HID keyboard (keyboard page), no fallback
//   sendevent        EV_KEY down / sleep / up written to the remote's own /dev/input node
//   input-duration   `input keyevent --duration MS K` (Android 14+; skipped when `input` lacks it)
//   cdp              DevTools Input.dispatchKeyEvent in the page (page-level only, not Android input)
//   firelab          what FireLab's default remote does now (SmartRemote, verified HID or input)
//
// It only presses the chosen key inside the chosen app. It never clears data
// or uninstalls anything, and it opens only its own adb forward (tcp:0).
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
  FireLab,
  InputKeyInjector,
  SmartRemote,
  HidRemote,
  KeyRecorder,
  parseKeys,
  hidScript,
  registerCommand,
  HID_PROFILES,
  parseGeteventDevices,
  kernelKeyMap,
  sendeventScript,
  forgetHidVerdicts,
  hidVerdict,
  REMOTE_KEYS,
} from '../dist/index.js';

const { values: o } = parseArgs({
  options: {
    device: { type: 'string', short: 'd' },
    package: { type: 'string', short: 'p' },
    key: { type: 'string', default: 'right' },
    hold: { type: 'string', default: '2000' },
    methods: { type: 'string', default: 'input-longpress,input-repeat,hid,hid-keyboard,sendevent,input-duration,cdp,firelab' },
    settle: { type: 'string', default: '700' },
    'allow-any': { type: 'boolean' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (o.help || !o.device || !o.package) {
  console.error('Usage: node scripts/hold-check.mjs --device <ip[:port]> --package <dev.firelab.app> [--key right] [--hold 2000] [--methods a,b,...] [--out hold.json]');
  process.exit(o.help ? 0 : 2);
}
if (!o.package.startsWith('dev.firelab.') && !o['allow-any']) {
  console.error(`${o.package} is not a FireLab-wrapped app (dev.firelab.*). Pass --allow-any if pressing keys in it is fine.`);
  process.exit(2);
}
const KEY = o.key;
const HOLD = Number(o.hold);
const SETTLE = Number(o.settle);
if (!REMOTE_KEYS[KEY] || !['up', 'down', 'left', 'right', 'ok'].includes(KEY)) {
  console.error('--key must be one of up, down, left, right, ok');
  process.exit(2);
}
if (!(HOLD >= 100 && HOLD <= 10000)) {
  console.error('--hold must be 100-10000 ms');
  process.exit(2);
}
const ANDROID_CODE = REMOTE_KEYS[KEY].code;
const DOM = { up: [38, 'ArrowUp'], down: [40, 'ArrowDown'], left: [37, 'ArrowLeft'], right: [39, 'ArrowRight'], ok: [13, 'Enter'] }[KEY];
const log = (...a) => console.error('[hold]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lab = new FireLab({ autoReconnect: false });
const serial = await lab.resolveDevice(o.device);
const info = await lab.deviceInfo(serial).catch(() => undefined);
log(`device ${serial}: ${info?.name ?? '?'} (${info?.model ?? '?'}), ${info?.os ?? '?'}`);

// ---------- the page counter ----------

const COUNTER = `(() => {
  const w = window;
  if (!w.__firelabHoldCheck) {
    const s = (w.__firelabHoldCheck = { events: [] });
    const rec = (type) => (e) => { if (s.events.length < 5000) s.events.push({ t: performance.now(), type, key: e.key, code: e.code, keyCode: e.keyCode, repeat: e.repeat, trusted: e.isTrusted }); };
    window.addEventListener('keydown', rec('keydown'), true);
    window.addEventListener('keyup', rec('keyup'), true);
  }
  w.__firelabHoldCheck.events = [];
  return { url: location.href, focus: document.hasFocus() };
})()`;

if (!(await lab.foreground(serial))?.package?.startsWith(o.package)) {
  log(`launching ${o.package}`);
  await lab.launch(serial, o.package);
  await sleep(3000);
}
let page;
for (let i = 0; ; i++) {
  try {
    page = await lab.evaluate(serial, COUNTER, { package: o.package });
    break;
  } catch (e) {
    if (i >= 15) throw e;
    log(`waiting for the page (${e?.code ?? e?.message})`);
    await sleep(1000);
  }
}
log(`counter installed in ${page.value?.url} (page focus: ${page.value?.focus})`);

async function resetCounter() {
  await lab.evaluate(serial, 'window.__firelabHoldCheck.events = []; true', { package: o.package });
}

async function readCounter() {
  const r = await lab.evaluate(serial, 'window.__firelabHoldCheck.events', { package: o.package });
  const all = Array.isArray(r.value) ? r.value : [];
  const ev = all.filter((e) => e.keyCode === DOM[0] || e.key === DOM[1]);
  let down = null;
  let longest = 0;
  for (const e of ev) {
    if (e.type === 'keydown' && down === null) down = e.t;
    if (e.type === 'keyup' && down !== null) {
      longest = Math.max(longest, e.t - down);
      down = null;
    }
  }
  const downs = ev.filter((e) => e.type === 'keydown');
  const ups = ev.filter((e) => e.type === 'keyup');
  return {
    keydown: downs.length,
    repeatKeydown: downs.filter((e) => e.repeat).length,
    keyup: ups.length,
    spanMs: ev.length ? Math.round(ev[ev.length - 1].t - ev[0].t) : 0,
    longestHoldMs: Math.round(longest),
    stillDown: down !== null,
    trusted: ev.length ? ev.every((e) => e.trusted) : undefined,
    otherKeys: all.length - ev.length,
  };
}

function verdict(d) {
  if (!d.keydown) return 'nothing delivered';
  if (d.keyup === 1 && d.longestHoldMs >= HOLD * 0.8) return `true hold (${d.longestHoldMs} ms, ${d.repeatKeydown} auto-repeats)`;
  if (d.keyup >= 2) return `repeated presses (${d.keydown} downs, ${d.keyup} ups, longest ${d.longestHoldMs} ms)`;
  return `short press (${d.keydown} down, ${d.keyup} up, ${d.longestHoldMs} ms)`;
}

// ---------- methods ----------

const shell = (cmd, timeoutMs = 20000) => lab.adb.shell(serial, cmd, { timeoutMs });

async function rawHid(profileName) {
  const profile = HID_PROFILES[profileName];
  const name = `${profile.name} check`;
  const p = lab.adb.spawn(['-s', serial, 'shell', 'hid', '-']);
  let out = '';
  let exited = null;
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('exit', (c) => (exited = c ?? 0));
  p.on('error', (e) => (out += String(e)));
  p.stdin.on('error', () => {});
  p.stdin.write(`${registerCommand(1, profile, name)}\n`);
  await sleep(1200);
  const lp = await shell('getevent -lp 2>/dev/null').catch(() => '');
  const dev = parseGeteventDevices(lp).find((d) => d.name === name);
  const notes = {
    hidOutput: out.trim().slice(0, 400) || '(none)',
    hidExited: exited,
    listedInGetevent: dev ? `${dev.path}: ${dev.keys.length} keys (${dev.keys.slice(0, 8).join(' ')}${dev.keys.length > 8 ? ' ...' : ''})` : 'no',
    uhid: (await shell('ls -lZ /dev/uhid 2>&1 || ls -l /dev/uhid 2>&1').catch((e) => e.message)).trim(),
    dumpsysInput: dev ? (await shell(`dumpsys input | grep -A6 '${name}' | head -14`).catch(() => '')).trim().slice(0, 700) : undefined,
  };
  if (exited === null) {
    const { lines, durationMs } = hidScript(parseKeys([`${KEY}:${HOLD}`]), { profile });
    p.stdin.write(`${lines.join('\n')}\n`);
    await sleep(durationMs + 200);
  }
  await sleep(300);
  try {
    p.stdin.end();
  } catch {}
  p.kill();
  return notes;
}

const METHODS = {
  'input-longpress': async () => {
    const reps = Math.max(1, Math.round(HOLD / 1000));
    await shell(`input keyevent --longpress ${Array(reps).fill(ANDROID_CODE).join(' ')}`);
    return { command: `input keyevent --longpress x${reps}` };
  },
  'input-repeat': async () => {
    const t0 = Date.now();
    await new InputKeyInjector(lab.adb, serial).press(parseKeys([`${KEY}:${HOLD}`]));
    return { tookMs: Date.now() - t0 };
  },
  hid: () => rawHid('consumer'),
  'hid-keyboard': () => rawHid('keyboard'),
  sendevent: async () => {
    const lp = await shell('getevent -lp 2>/dev/null').catch(() => '');
    const kk = kernelKeyMap(parseGeteventDevices(lp)).get(KEY);
    if (!kk) return { skipped: 'no input node declares this key' };
    const writable = await shell(`sendevent ${kk.path} 0 0 0 2>&1; echo @@rc=$?`).catch((e) => e.message);
    if (!/@@rc=0/.test(writable) || /denied|could not/i.test(writable)) return { skipped: `can't write ${kk.path} (${kk.device}): ${writable.replace(/@@rc=\d+/, '').trim()}` };
    const out = await shell(sendeventScript([{ key: kk, holdMs: HOLD }]), HOLD + 15000);
    return { node: `${kk.path} (${kk.device}) ${kk.linux}`, output: out.trim() || '(none)' };
  },
  'input-duration': async () => {
    const usage = await shell('input 2>&1 | head -40').catch(() => '');
    if (!/--duration/.test(usage)) return { skipped: '`input` has no --duration on this Android version' };
    const out = await shell(`input keyevent --duration ${HOLD} ${ANDROID_CODE} 2>&1`, HOLD + 15000);
    return { output: out.trim() || '(none)' };
  },
  cdp: async () => {
    const s = await lab.webview(serial, o.package);
    const base = { key: DOM[1], code: DOM[1], windowsVirtualKeyCode: DOM[0], nativeVirtualKeyCode: DOM[0] };
    const t0 = Date.now();
    await s.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, autoRepeat: false });
    await sleep(Math.min(500, HOLD));
    while (Date.now() - t0 < HOLD) {
      await s.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, autoRepeat: true });
      await sleep(33);
    }
    await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return { note: 'page-level events from DevTools; Android key handling (activity, focus) is not involved' };
  },
  firelab: async () => {
    forgetHidVerdicts(serial);
    const r = new SmartRemote(lab.adb, serial);
    const path = await r.holdPath();
    await r.press(parseKeys([`${KEY}:${HOLD}`]));
    const out = { mode: r.mode, holdPath: path, holdsAfter: r.holds() ?? 'unknown', hidVerdict: hidVerdict(serial) ?? null };
    await r.close();
    return out;
  },
  // Not in the default list: FireLab's HID remote with its proof step forced on (FIRELAB_REMOTE=hid behaviour).
  'firelab-hid': async () => {
    forgetHidVerdicts(serial);
    const r = new HidRemote(lab.adb, serial);
    await r.press(parseKeys([`${KEY}:${HOLD}`]));
    const out = { verified: r.verified, verdict: r.verdict ?? null };
    await r.close();
    return out;
  },
};

// ---------- run ----------

const results = [];
for (const m of o.methods.split(',').map((x) => x.trim()).filter(Boolean)) {
  const fn = METHODS[m];
  if (!fn) {
    log(`unknown method ${m} (known: ${Object.keys(METHODS).join(', ')})`);
    continue;
  }
  log(`--- ${m}: holding ${KEY} for ${HOLD} ms`);
  const row = { method: m };
  const rec = new KeyRecorder(lab.adb, serial);
  try {
    await resetCounter();
    rec.on('error', () => {});
    rec.start();
    await sleep(600);
    const t0 = Date.now();
    row.notes = await fn();
    row.callMs = Date.now() - t0;
    await sleep(SETTLE);
    rec.stop();
    row.kernel = rec.keys.map((k) => `${k.key}:${k.action}${k.holdMs !== undefined ? `:${k.holdMs}ms` : ''}`);
    if (row.notes?.skipped) {
      row.verdict = `skipped: ${row.notes.skipped}`;
    } else {
      row.delivered = await readCounter();
      row.verdict = verdict(row.delivered);
    }
  } catch (e) {
    rec.stop();
    row.error = e?.friendly ?? e?.message ?? String(e);
    row.verdict = `error: ${row.error}`;
  }
  log(`    ${row.verdict}${row.kernel ? `; getevent: ${row.kernel.length ? row.kernel.slice(0, 6).join(' ') : 'nothing'}` : ''}`);
  results.push(row);
  await sleep(1000);
}

await lab.close();

const md = [
  `## Hold check: ${info?.name ?? serial} (${info?.model ?? '?'}, ${info?.os ?? '?'})`,
  '',
  `App \`${o.package}\`, key \`${KEY}\` held ${HOLD} ms. "Downs" counts every keydown the page saw (auto-repeats in brackets).`,
  '',
  '| Method | Downs (repeats) | Ups | Longest down | Kernel events | Verdict |',
  '|---|---|---|---|---|---|',
  ...results.map((r) => {
    const d = r.delivered;
    return `| ${r.method} | ${d ? `${d.keydown} (${d.repeatKeydown})` : '-'} | ${d ? d.keyup : '-'} | ${d ? `${d.longestHoldMs} ms` : '-'} | ${r.kernel ? r.kernel.length : '-'} | ${String(r.verdict).replace(/\|/g, '/')} |`;
  }),
  '',
].join('\n');
console.log(md);
const report = { at: new Date().toISOString(), device: { serial, name: info?.name, model: info?.model, os: info?.os }, package: o.package, key: KEY, holdMs: HOLD, results };
if (o.out) {
  fs.writeFileSync(o.out, `${JSON.stringify(report, null, 2)}\n`);
  log(`wrote ${o.out}`);
} else {
  console.log('```json');
  console.log(JSON.stringify(results.map((r) => ({ method: r.method, notes: r.notes, error: r.error })), null, 2));
  console.log('```');
}
