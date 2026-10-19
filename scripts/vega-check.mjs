#!/usr/bin/env node
// Real-device check for the Vega OS driver (src/vega). It runs every driver
// feature against a connected Vega device (a Vega Fire TV or the Vega Virtual
// Device) and says which ones work, so docs/VEGA.md can move from "assumed" to
// "verified".
//
//   npm run build
//   node scripts/vega-check.mjs                                  # device info, screenshot, logs (read-only)
//   node scripts/vega-check.mjs --keys                           # also presses every remote key once (ends on Home)
//   node scripts/vega-check.mjs --app com.example.game           # also launch, pid, memory, app logs, stop
//   node scripts/vega-check.mjs --vpkg build/game_armv7.vpkg     # also installs that package first
//   node scripts/vega-check.mjs --serial emulator-5554 --out vega-check
//
// Needs the Vega SDK's `vega` CLI on PATH (or VEGA_CLI=/path/to/vega).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createDriver, DRIVER_KEYS } from '../dist/driver/index.js';
import { VEGA_KEYS, DOCUMENTED_VEGA_KEYS } from '../dist/vega/index.js';

const { values: o } = parseArgs({
  options: {
    serial: { type: 'string', short: 's' },
    app: { type: 'string', short: 'a' },
    vpkg: { type: 'string' },
    keys: { type: 'boolean' },
    out: { type: 'string', default: 'vega-check' },
  },
});

const results = [];
fs.mkdirSync(o.out, { recursive: true });
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
    console.log(`[ok] ${name}${detail ? `: ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: e.message, hint: e.hint });
    console.log(`[XX] ${name}: ${e.message}${e.hint ? `\n     ${e.hint}` : ''}`);
  }
}

const tv = await createDriver({ kind: 'vda', serial: o.serial, probe: false }).catch((e) => {
  console.error(`Could not open a Vega device: ${e.message}${e.hint ? `\n${e.hint}` : ''}`);
  process.exit(1);
});
console.log(`Vega device ${tv.serial}\n`);

await step('probe (vda get-serialno)', async () => JSON.stringify(await tv.probe()));
await step('info (vda devices -l)', async () => JSON.stringify(await tv.info()));
await step('screenshot as JPEG (gwsi-tool-screenshooter + pull)', async () => {
  const f = await tv.screenshot({ width: 960 });
  fs.writeFileSync(path.join(o.out, 'screen.jpg'), f.data);
  return `${f.width}x${f.height} in ${f.captureMs} ms -> ${path.join(o.out, 'screen.jpg')}`;
});
await step('screenshot as 64 px RGBA (engine thumbnails)', async () => {
  const f = await tv.screenshot({ format: 'rgba', width: 64 });
  return `${f.width}x${f.height}, ${f.rgba.length} bytes`;
});
await step('logs (loggingctl log -o short-precise)', async () => {
  const lines = await tv.logs({});
  fs.writeFileSync(path.join(o.out, 'logs.json'), JSON.stringify(lines.slice(-500), null, 2));
  if (!lines.length) throw new Error('no lines parsed: save `vega exec vda shell loggingctl log -o short-precise | head -50` and compare with parseVegaLogLine');
  return `${lines.length} lines parsed, last: ${lines.at(-1).text.slice(0, 80)}`;
});

if (o.vpkg) await step(`install ${o.vpkg} (vega device install-app)`, async () => JSON.stringify(await tv.install(o.vpkg)));

if (o.app) {
  const app = { package: o.app };
  await step(`launch ${o.app} (vega device launch-app)`, async () => JSON.stringify(await tv.launch(app)));
  await new Promise((r) => setTimeout(r, 4000));
  await step('pid (pidof / ps)', async () => {
    const pid = await tv.pid(app);
    if (!pid) throw new Error('no pid found while the app should be running');
    return `pid ${pid}`;
  });
  await step('memory (ace_memusage)', async () => JSON.stringify(await tv.memory(app)));
  await step('app logs', async () => `${(await tv.logs({ app })).length} lines for ${o.app}`);
  await step('text input (inputd-cli send_text)', async () => (await tv.typeText('firelab'), 'sent "firelab" (check the screen if a text field had focus)'));
}

if (o.keys) {
  // Every key once; each one is reported, so a wrong key name shows up as an error here.
  for (const key of DRIVER_KEYS.filter((k) => k !== 'home' && k !== 'wake')) {
    await step(`key ${key} -> ${VEGA_KEYS[key]}${DOCUMENTED_VEGA_KEYS.includes(key) ? '' : ' (unverified name)'}`, async () => tv.press([{ key }]));
  }
  await step('long press ok', async () => tv.press([{ key: 'ok', mode: 'long' }]));
  await step('hold right 1200 ms (--holdDuration)', async () => tv.press([{ key: 'right', mode: 'hold', holdMs: 1200 }]));
  await step('key home -> KEY_HOMEPAGE (unverified name; should show the home screen)', async () => tv.press([{ key: 'home' }]));
  await new Promise((r) => setTimeout(r, 1500));
  await step('screenshot after Home', async () => {
    const f = await tv.screenshot({ width: 960 });
    fs.writeFileSync(path.join(o.out, 'after-home.jpg'), f.data);
    return path.join(o.out, 'after-home.jpg');
  });
}

if (o.app) await step(`stop ${o.app} (terminate-app)`, async () => tv.stop({ package: o.app }));
await tv.close();

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify({ serial: tv.serial, date: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed. Report: ${path.join(o.out, 'report.json')}`);
console.log('Look at the screenshots too: a key can "succeed" without doing anything if its name is wrong.');
process.exit(failed.length ? 1 : 0);
