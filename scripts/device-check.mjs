#!/usr/bin/env node
// Real-device check for FireLab: runs every feature against a connected device
// and prints a report (and the "tested on" row for the README).
//
//   npm run build
//   npm run device:check -- --device 192.168.1.50:5555
//   npm run device:check -- --device 192.168.1.50:5555 --package com.example.game \
//       --url http://192.168.1.20:4173/ --tiers tv,tv-hd,high --sweep --home-url http://192.168.1.20:4173/ --keys
//
// Games that don't render their 3D scene under menus need an action after each
// load to reach gameplay: --action-keys "down,down,ok" and/or --action-eval "<js>".
// --fps-expr reads the app's own fps meter instead of FireLab's probe.
//
// By default it only reads (device info, apps, screenshots, WebView evals,
// frame rate, memory, a short watch session). --sweep reloads the WebView at
// each tier, --keys presses Home and a held D-pad key on the launcher, --stop
// force-stops the app at the end. It always leaves the device on Home when it
// pressed keys, and the WebView on --home-url (or where it was) after a sweep.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { FireLab, FpsSampler, SurfaceFlingerSampler, KeyRecorder, captureScreen, parseKeys, HidRemote, InputKeyInjector, sweepMarkdown, median } from '../dist/index.js';

const { values: o } = parseArgs({
  options: {
    device: { type: 'string', short: 'd' },
    package: { type: 'string', short: 'p' },
    url: { type: 'string', short: 'u' },
    tiers: { type: 'string', default: 'low,tv,tv-hd,high' },
    param: { type: 'string', default: 'q' },
    'home-url': { type: 'string' },
    sweep: { type: 'boolean' },
    keys: { type: 'boolean' },
    stop: { type: 'boolean' },
    seconds: { type: 'string', default: '15' },
    warmup: { type: 'string', default: '8' },
    'watch-seconds': { type: 'string', default: '20' },
    'action-keys': { type: 'string' },
    'action-eval': { type: 'string' },
    'fps-expr': { type: 'string' },
    out: { type: 'string' },
  },
});

const lab = new FireLab({ autoReconnect: false });
const report = { startedAt: new Date().toISOString(), checks: [], sweep: undefined, testedOn: undefined };
const log = (...a) => console.error('[check]', ...a);
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    report.checks.push({ name, ok: true, ms: Date.now() - t0, detail });
    log(`ok   ${name} (${Date.now() - t0} ms)${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`);
    return detail;
  } catch (e) {
    report.checks.push({ name, ok: false, ms: Date.now() - t0, error: e?.friendly ?? e?.message ?? String(e) });
    log(`FAIL ${name}: ${e?.friendly ?? e?.message ?? e}`);
    return undefined;
  }
}

const serial = await lab.resolveDevice(o.device);
const health = await check('adb found', async () => (await lab.health()).adb);
const info = await check('device info', async () => {
  const i = await lab.deviceInfo(serial);
  return { name: i.name, model: i.model, os: i.os, abis: i.abis, ramMB: i.ramMB, resolution: i.resolution, gpu: i.gpu, tier: i.tier, power: i.power, foreground: i.foreground };
});
await check('list apps', async () => `${(await lab.apps(serial)).apps.length} third-party apps`);
await check('wake (no-op when awake)', async () => lab.wake(serial));
for (const method of ['raw', 'png']) {
  await check(`screenshot (${method})`, async () => {
    const times = [];
    for (let i = 0; i < 2; i++) times.push((await captureScreen(lab.adb, serial, method)).ms);
    return `${times.join(' ms, ')} ms`;
  });
}
await check('screenshot JPEG 960w', async () => {
  const s = await lab.screenshot(serial, { width: 960 });
  return `${s.width}x${s.height}, ${Math.round(s.data.length / 1024)} KB, ${s.method}`;
});
await check('logcat dump', async () => `${(await lab.logcat(serial, { lines: 20 })).lines.length} lines`);

const pkg = o.package;
let originalUrl;
if (pkg) {
  await check('WebView eval', async () => {
    const r = await lab.evaluate(serial, '({ ua: navigator.userAgent, href: location.href, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, firelab: !!window.firelab })', { package: pkg });
    originalUrl = r.value.href;
    return r.value;
  });
  await check('WebGL renderer -> device GPU', async () => {
    const d = await lab.deviceInfo(serial);
    return { gpu: d.gpu, source: d.gpuSource, tier: d.tier };
  });
  await check('fps: injected probe vs SurfaceFlinger (10 s)', async () => {
    const s = await lab.webview(serial, pkg);
    const probe = new FpsSampler(s);
    await probe.install();
    await probe.reset();
    const sf = new SurfaceFlingerSampler(lab.adb, serial, pkg);
    await sf.read();
    const a = [];
    const b = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      a.push(...(await probe.read()).map((x) => x.fps));
      b.push(...(await sf.read()).map((x) => x.fps));
    }
    return { probeMedian: median(a), surfaceflingerMedian: median(b), probe: a, surfaceflinger: b };
  });
  await check('webview console (5 s)', async () => `${(await lab.consoleLogs(serial, { package: pkg, waitMs: 5000 })).entries.length} entries`);
  await check('measure_performance (10 s)', async () => lab.measure(serial, { package: pkg, seconds: 10 }));
  await check(`watch session (${o['watch-seconds']} s)`, async () => {
    await lab.watchStart(serial, { package: pkg, intervalMs: 3000, thumbEveryMs: 5000 });
    await new Promise((r) => setTimeout(r, Number(o['watch-seconds']) * 1000));
    const s = await lab.watchStop(serial);
    return { keys: s.keys, fps: s.fps, memMB: s.memMB, errors: s.errors, thumbnails: s.thumbnails.length, dir: s.dir };
  });
  if (o.sweep && o.url) {
    const sweep = await check('performance sweep', async () => {
      const r = await lab.sweep(serial, {
        url: o.url,
        package: pkg,
        tiers: o.tiers.split(',').map((t) => t.trim()),
        param: o.param,
        sampleS: Number(o.seconds),
        warmupS: Number(o.warmup),
        restore: !o['home-url'],
        fpsExpr: o['fps-expr'],
        action: o['action-keys'] || o['action-eval'] ? { keys: o['action-keys']?.split(/[\s,]+/).filter(Boolean), eval: o['action-eval'] } : undefined,
      }, (j, m) => log(`  [${Math.round(j.progress * 100)}%] ${m}`));
      return { markdown: r.markdown, rows: r.job.rows, recommendation: r.job.recommendation, resultPath: r.job.resultPath };
    });
    report.sweep = sweep;
    if (o['home-url']) {
      await check(`leave the WebView on ${o['home-url']}`, async () => {
        const s = await lab.webview(serial, pkg);
        await s.navigate(o['home-url'], 45000);
        return await s.url();
      });
    }
  }
}

if (o.keys) {
  await check('keys: input keyevent latency (home)', async () => {
    const inj = new InputKeyInjector(lab.adb, serial);
    const t0 = Date.now();
    await inj.press(parseKeys(['home']));
    return `${Date.now() - t0} ms`;
  });
  await check('keys: virtual HID remote (home tap, right held 1.5 s) seen by getevent', async () => {
    const rec = new KeyRecorder(lab.adb, serial);
    rec.start();
    await new Promise((r) => setTimeout(r, 800));
    const hid = new HidRemote(lab.adb, serial);
    const t0 = Date.now();
    await hid.press(parseKeys(['home']));
    const tapMs = Date.now() - t0;
    await hid.press(parseKeys(['right:1500']));
    await new Promise((r) => setTimeout(r, 500));
    await hid.press(parseKeys(['home']));
    await hid.close();
    rec.stop();
    if (!hid.available) throw new Error('hid not available on this device (fell back to input keyevent)');
    return { firstTapMsIncludingRegister: tapMs, recorded: rec.keys.map((k) => `${k.key}:${k.action}${k.holdMs !== undefined ? `:${k.holdMs}ms` : ''}`) };
  });
  await check('back on Home', async () => (await lab.foreground(serial))?.package);
}
if (o.stop && pkg) await check(`force-stop ${pkg}`, async () => lab.stop(serial, pkg));

await lab.close();
const okCount = report.checks.filter((c) => c.ok).length;
report.testedOn = info && {
  device: `${info.name} (${info.model})`,
  os: info.os,
  gpu: info.gpu,
  passed: `${okCount}/${report.checks.length}`,
  failed: report.checks.filter((c) => !c.ok).map((c) => c.name),
};
const md = [
  `## FireLab device check: ${info?.name ?? serial}`,
  '',
  `| Check | Result |`,
  `|---|---|`,
  ...report.checks.map((c) => `| ${c.name} | ${c.ok ? `ok (${c.ms} ms)` : `**failed**: ${String(c.error).replace(/\|/g, '/')}`} |`),
  '',
  report.sweep?.markdown ?? '',
  '',
  `Tested-on row: | ${info?.name} | ${info?.model} | ${info?.os} | ${info?.gpu} | ${okCount}/${report.checks.length} checks |`,
].join('\n');
console.log(md);
if (o.out) {
  fs.writeFileSync(o.out, JSON.stringify(report, null, 2));
  fs.writeFileSync(o.out.replace(/\.json$/, '') + '.md', `${md}\n`);
  log(`wrote ${o.out}`);
}
void health;
void originalUrl;
process.exit(report.checks.every((c) => c.ok) ? 0 : 1);
