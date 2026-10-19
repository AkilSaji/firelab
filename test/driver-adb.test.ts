import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdbDriver, keySpecString } from '../src/driver/adb.js';
import { FireLab } from '../src/core/firelab.js';
import { recordInstall } from '../src/core/installs.js';
import { inputHoldScript } from '../src/adb/keys.js';
import { SmartRemote, forgetHidVerdicts } from '../src/adb/hid.js';
import { fakeAdb, SERIAL, DEVICES_L, type FakeRunner } from './helpers/fake-adb.js';
import { fakeLab } from './helpers/fake-lab.js';
import { fakeHidDevice } from './helpers/fake-hid.js';
import { FakeDevtools } from './helpers/fake-devtools.js';

const APP = { package: 'com.example.game' };
const fxPath = (f: string) => new URL(`./fixtures/${f}`, import.meta.url).pathname;
const SOCKETS = '00000000: 00000002 00000000 00010000 0001 01 193653 @webview_devtools_remote_4242\n@@ps\n  PID NAME\n4242 com.example.game\n';

/** Rules added in front of the fake lab's own (the first matching rule wins). */
function prefer(runner: FakeRunner, match: RegExp, reply: Parameters<FakeRunner['on']>[1]): void {
  runner.rules.unshift({ match, reply });
}

/** A driver on the scripted Fire TV Stick 4K Plus (Fire OS 8) from fake-lab. */
function world(o: { webviewWaitMs?: number; resetAllow?: string[] } = {}) {
  const w = fakeLab();
  w.runner
    .on(/getprop ro.product.manufacturer/, 'Amazon\n')
    .on(/command -v getevent/, '@@yes\n')
    .on(/resolve-activity/, 'com.example.game/.Main\n')
    .on(/am start -W/, 'Starting: Intent { cmp=com.example.game/.Main }\nStatus: ok\nLaunchState: COLD\nTotalTime: 812\n')
    .on(/input keyevent/, '')
    .on(/forward --remove/, '');
  const driver = new AdbDriver({ serial: SERIAL, lab: w.lab, webviewWaitMs: o.webviewWaitMs ?? 150, ...(o.resetAllow ? { resetAllow: o.resetAllow } : {}) });
  return { ...w, driver };
}

/** A plain Android TV (not Fire OS) whose virtual remote works or fails silently. */
function androidTvWorld(delivers: boolean) {
  const { adb, runner } = fakeAdb();
  runner
    .on(/^devices -l$/, DEVICES_L)
    .on(/input keyevent/, '')
    .on(/command -v getevent/, '@@yes\n');
  const dev = fakeHidDevice(runner, { listed: true, delivers });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-drv-'));
  const lab = new FireLab({ adb, home, autoReconnect: false, keyInjector: (a, s) => new SmartRemote(a, s, 'auto', { registerWaitMs: 5, fireOs: false }) });
  return { runner, lab, dev, driver: new AdbDriver({ serial: SERIAL, lab, ownsLab: true }) };
}

beforeEach(() => forgetHidVerdicts());

describe('AdbDriver caps', () => {
  it('starts honest: only what every adb device can do, nothing it has not checked', () => {
    const { driver } = world();
    expect(driver.kind).toBe('adb');
    expect(driver.serial).toBe(SERIAL);
    expect(driver.caps).toMatchObject({ keys: true, screenshot: true, launch: true, logs: true, rgbaThumb: true, text: true, install: true, memory: true, measure: true });
    expect(driver.caps).toMatchObject({ holds: false, eval: false, console: false, cdp: false, reset: false, recordKeys: false });
  });

  it('probes device caps: no true holds on Fire OS until HID is verified, and no virtual remote put on the TV to find out', async () => {
    const { driver, runner } = world();
    const caps = await driver.probe();
    expect(caps).toBe(driver.caps);
    expect(caps.holds).toBe(false);
    expect(caps.recordKeys).toBe(true);
    expect(runner.spawned).toHaveLength(0);
  });

  it('says recordKeys is off when the device has no getevent', async () => {
    const { driver, runner } = world();
    prefer(runner, /command -v getevent/, '');
    expect((await driver.probe()).recordKeys).toBe(false);
  });

  it('turns eval/console/cdp on only for an app with a debuggable WebView, and reset only for FireLab-installed apps', async () => {
    const { driver, runner, home } = world();
    await driver.probe(APP);
    expect(driver.caps).toMatchObject({ eval: false, console: false, cdp: false, reset: false });
    prefer(runner, /grep -a devtools_remote/, SOCKETS);
    recordInstall(home, SERIAL, APP.package);
    await driver.probe(APP);
    expect(driver.caps).toMatchObject({ eval: true, console: true, cdp: true, reset: true });
    // Another app without a WebView: the app-level caps follow the current app.
    prefer(runner, /pidof com.native.game/, '5151\n');
    await driver.probe({ package: 'com.native.game' });
    expect(driver.caps).toMatchObject({ eval: false, console: false, cdp: false, reset: false });
  });

  it('launch() waits for the WebView socket to appear before deciding', async () => {
    const { driver, runner } = world({ webviewWaitMs: 3000 });
    let polls = 0;
    prefer(runner, /grep -a devtools_remote/, () => (++polls >= 3 ? SOCKETS : '@@ps\n'));
    await driver.launch(APP);
    expect(polls).toBe(3);
    expect(driver.caps.eval).toBe(true);
  });

  it('launch() stops waiting for a WebView in an app that never had one', async () => {
    const { driver, runner } = world({ webviewWaitMs: 200 });
    const t0 = Date.now();
    await driver.launch(APP);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(driver.caps.eval).toBe(false);
    const polls = () => runner.shellCommands().filter((c) => c.includes('devtools_remote')).length;
    const before = polls();
    await driver.launch(APP);
    expect(polls() - before).toBe(1);
  });

  it('holds become true on a non-Fire OS TV once the virtual remote proved itself', async () => {
    const { driver } = androidTvWorld(true);
    expect((await driver.probe()).holds).toBe(false); // registered, not yet proven
    await driver.press([{ key: 'right', mode: 'hold', holdMs: 120 }]);
    expect(driver.caps.holds).toBe(true);
    await driver.close();
  });

  it('holds stay false when the virtual remote fails silently, and the key still arrives via input', async () => {
    const { driver, runner } = androidTvWorld(false);
    await driver.press([{ key: 'right', mode: 'hold', holdMs: 120 }]);
    expect(driver.caps.holds).toBe(false);
    expect(runner.shellCommands().filter((c) => c.includes('input keyevent'))).toEqual([inputHoldScript('22', 120)]);
    await driver.close();
  });
});

describe('AdbDriver keys', () => {
  it('maps KeySpecs to FireLab key syntax', () => {
    expect(keySpecString({ key: 'up' })).toBe('up');
    expect(keySpecString({ key: 'ok', mode: 'long' })).toBe('ok:long');
    expect(keySpecString({ key: 'right', mode: 'hold', holdMs: 1500 })).toBe('right:1500');
    expect(keySpecString({ key: 'left', mode: 'hold' })).toBe('left:500');
    expect(() => keySpecString({ key: 'jump' as never })).toThrow(/Unknown remote key/);
    expect(() => keySpecString({ key: 'up', mode: 'hold', holdMs: 0 })).toThrow(/1-30000/);
    expect(() => keySpecString({ key: 'up', mode: 'hold', holdMs: 40000 })).toThrow(/1-30000/);
  });

  it('presses taps in one batch, long presses with --longpress, and holds as an emulated repeat on Fire OS', async () => {
    const { driver, runner } = world();
    await driver.press([{ key: 'up' }, { key: 'down' }]);
    await driver.press([{ key: 'ok', mode: 'long' }]);
    await driver.press([{ key: 'right', mode: 'hold', holdMs: 1500 }]);
    const input = runner.shellCommands().filter((c) => c.includes('input keyevent'));
    expect(input).toEqual(['input keyevent 19 20', 'input keyevent --longpress 23', inputHoldScript('22', 1500)]);
    expect(driver.caps.holds).toBe(false);
    expect(runner.spawned).toHaveLength(0);
  });

  it('splits long sequences into FireLab-sized calls and rejects bad input', async () => {
    const { driver, runner } = world();
    await driver.press(Array.from({ length: 150 }, () => ({ key: 'down' as const })));
    const input = runner.shellCommands().filter((c) => c.includes('input keyevent'));
    expect(input.map((c) => c.split(' ').length - 2)).toEqual([100, 50]);
    await expect(driver.press([])).rejects.toMatchObject({ code: 'bad-request' });
    await expect(driver.press([{ key: 'nope' as never }])).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('types text', async () => {
    const { driver, runner } = world();
    await driver.typeText('hi there');
    expect(runner.shellCommands()).toContain("input text 'hi%sthere'");
  });
});

describe('AdbDriver screenshots', () => {
  it('returns a 64-px RGBA thumbnail straight from the raw framebuffer', async () => {
    const { driver, runner } = world();
    const f = await driver.screenshot({ format: 'rgba', width: 64 });
    expect([f.width, f.height]).toEqual([64, 36]);
    expect(f.rgba).toBeInstanceOf(Uint8Array);
    expect(f.rgba?.length).toBe(64 * 36 * 4);
    expect([...(f.rgba?.slice(0, 4) ?? [])]).toEqual([128, 128, 128, 128]);
    expect(f.data).toBeUndefined();
    expect(runner.calls.filter((c) => c.includes('exec-out')).map((c) => c[3])).toEqual(['screencap 2>/dev/null | gzip -1']);
  });

  it('defaults to 64 px for rgba and returns JPEG or PNG when asked', async () => {
    const { driver } = world();
    expect((await driver.screenshot({ format: 'rgba' })).width).toBe(64);
    const jpg = await driver.screenshot();
    expect(jpg.mime).toBe('image/jpeg');
    expect([...(jpg.data?.subarray(0, 2) ?? [])]).toEqual([0xff, 0xd8]);
    const png = await driver.screenshot({ format: 'png', width: 32 });
    expect(png).toMatchObject({ mime: 'image/png', width: 32, height: 18 });
    expect(png.data?.subarray(1, 4).toString()).toBe('PNG');
  });
});

describe('AdbDriver uiDump', () => {
  const XML = '<?xml version=\'1.0\' ?><hierarchy rotation="0"><node index="0" text="Play" focusable="true" focused="true" bounds="[0,0][100,50]" /></hierarchy>';

  it('reads the hierarchy straight from exec-out', async () => {
    const { driver, runner } = world();
    prefer(runner, /exec-out uiautomator dump \/dev\/stdout/, `${XML}UI hierchary dumped to: /dev/stdout\n`);
    expect(await driver.uiDump()).toContain('focused="true"');
  });

  it('falls back to a dump file, and explains a dump that never comes', async () => {
    const { driver, runner } = world();
    prefer(runner, /exec-out uiautomator dump/, 'ERROR: null root node returned by UiTestAutomationBridge.\n');
    prefer(runner, /shell uiautomator dump \/data\/local\/tmp\/firelab-ui.xml/, XML, 1);
    expect(await driver.uiDump()).toBe(XML);
    prefer(runner, /shell uiautomator dump \/data\/local\/tmp\/firelab-ui.xml/, '');
    await expect(driver.uiDump()).rejects.toThrow(/no hierarchy.*null root node/);
  });
});

describe('AdbDriver apps', () => {
  it('foreground, launch, stop and pid', async () => {
    const { driver, runner } = world();
    expect(await driver.foreground()).toEqual({ package: 'com.amazon.tv.launcher', activity: 'com.amazon.tv.launcher.ui.HomeActivity_vNext' });
    expect(await driver.launch(APP)).toEqual({ pid: 4242, launchMs: 812 });
    expect(runner.shellCommands().some((c) => c.startsWith("am start -W -n 'com.example.game/.Main'"))).toBe(true);
    expect(await driver.pid(APP)).toBe(4242);
    await driver.stop(APP);
    expect(runner.shellCommands()).toContain('am force-stop com.example.game');
    prefer(runner, /pidof com.example.game/, { stdout: Buffer.from(''), stderr: '', code: 1 });
    expect(await driver.pid(APP)).toBeUndefined();
  });

  it('passes the URL of a wrapped web app to the launch intent', async () => {
    const { driver, runner } = world();
    await driver.launch({ package: 'com.example.game', url: 'http://192.168.1.20:4173/?q=tv' });
    expect(runner.shellCommands().find((c) => c.startsWith('am start'))).toContain("--es url 'http://192.168.1.20:4173/?q=tv'");
  });

  it('reports device info', async () => {
    const { driver } = world();
    const i = await driver.info();
    expect(i).toMatchObject({ model: 'AFTMA08C15', os: expect.stringMatching(/Fire OS/), tier: expect.any(String) });
    expect(i.ramMB).toBeGreaterThan(0);
  });
});

describe('AdbDriver reset safety', () => {
  it('needs confirm: true', async () => {
    const { driver, home, runner } = world();
    recordInstall(home, SERIAL, APP.package);
    await expect(driver.reset(APP, {} as never)).rejects.toMatchObject({ code: 'confirm-required' });
    expect(runner.shellCommands().some((c) => c.startsWith('pm clear'))).toBe(false);
  });

  it("refuses an app FireLab didn't install, unless the caller overrides", async () => {
    const { driver, runner } = world();
    await expect(driver.reset(APP, { confirm: true })).rejects.toMatchObject({ code: 'confirm-required', message: expect.stringMatching(/didn't install/) });
    expect(runner.shellCommands().some((c) => c.startsWith('pm clear'))).toBe(false);
    await driver.reset(APP, { confirm: true, allowAnyPackage: true });
    expect(runner.shellCommands()).toContain('pm clear com.example.game');
  });

  it('clears apps FireLab installed (recorded installs, firelab wrap apps, resetAllow)', async () => {
    const a = world();
    recordInstall(a.home, SERIAL, APP.package);
    await a.driver.reset(APP, { confirm: true });
    expect(a.runner.shellCommands()).toContain('pm clear com.example.game');

    const b = world();
    b.runner.on(/pm clear dev.firelab.demo/, 'Success\n');
    await b.driver.reset({ package: 'dev.firelab.demo' }, { confirm: true });
    expect(b.runner.shellCommands()).toContain('pm clear dev.firelab.demo');

    const c = world({ resetAllow: ['com.example.game'] });
    await c.driver.reset(APP, { confirm: true });
    expect(c.runner.shellCommands()).toContain('pm clear com.example.game');
  });

  it('install() records the package, so reset is allowed afterwards (only on that device)', async () => {
    const { driver, runner, home } = world();
    runner.on(/install -r/, 'Performing Streamed Install\nSuccess\n').on(/pm clear com.firelab.fixture/, 'Success\n');
    expect(await driver.install(fxPath('fixture-armv7.apk'))).toEqual({ package: 'com.firelab.fixture' });
    expect(JSON.parse(fs.readFileSync(`${home}/installed.json`, 'utf8'))[SERIAL]['com.firelab.fixture']).toBeTruthy();
    await driver.reset({ package: 'com.firelab.fixture' }, { confirm: true });
    const other = new AdbDriver({ serial: '192.168.1.77:5555', lab: driver.lab });
    await expect(other.reset({ package: 'com.firelab.fixture' }, { confirm: true })).rejects.toMatchObject({ code: 'confirm-required' });
  });
});

describe('AdbDriver logs', () => {
  const LOG = [
    '1760538790.000  4242  4242 I GameMain: start',
    '1760538791.300  4242  4242 E GameMain: boom',
    '1760538791.400  1111  1111 I ActivityManager: Process com.example.game (pid 4242) has died',
    '1760538791.500  5555  5555 W Other: unrelated',
    '1760538792.000  3333  3333 E AndroidRuntime: FATAL EXCEPTION: main',
  ].join('\n');

  it('returns lines since a timestamp, at or above a level', async () => {
    const { driver, runner } = world();
    prefer(runner, /shell logcat -d/, `${LOG}\n`);
    const since = await driver.logs({ sinceTs: 1760538791000 });
    expect(since.map((l) => l.text)).toEqual(['boom', 'Process com.example.game (pid 4242) has died', 'unrelated', 'FATAL EXCEPTION: main']);
    expect(since[0]).toEqual({ ts: 1760538791300, level: 'error', tag: 'GameMain', pid: 4242, text: 'boom' });
    expect((await driver.logs({ sinceTs: 1760538791000, minLevel: 'warn' })).map((l) => l.level)).toEqual(['error', 'warn', 'error']);
  });

  it("filters to the app's processes, including ones that have since died, and lines naming it", async () => {
    const { driver, runner } = world();
    prefer(runner, /shell logcat -d/, `${LOG}\n`);
    prefer(runner, /pidof com.example.game/, '3333\n');
    await driver.pid(APP); // the old process
    runner.rules.shift();
    const lines = await driver.logs({ app: APP }); // now pid 4242
    expect(lines.map((l) => l.text)).toEqual(['start', 'boom', 'Process com.example.game (pid 4242) has died', 'FATAL EXCEPTION: main']);
  });

  it('puts device timestamps on the host clock when the TV clock is off', async () => {
    const { driver, runner } = world();
    prefer(runner, /shell logcat -d/, `${LOG}\n`);
    prefer(runner, /shell date \+%s/, () => `${Math.floor(Date.now() / 1000) + 3600}\n`);
    const lines = await driver.logs({});
    expect(Math.abs((lines[0]?.ts ?? 0) - (1760538790000 - 3600000))).toBeLessThan(1500);
  });
});

describe('AdbDriver performance', () => {
  it('measure() is FireLab.measure for the app, passed through', async () => {
    const { driver, lab } = world();
    const m = { seconds: 5, fps: { median: 29.5, p10: 24, min: 20, max: 31, samples: 5, source: 'hook' as const }, memMB: 310, cpuPct: 140, page: { tier: 'tv' }, notes: [], device: SERIAL, package: APP.package };
    const spy = vi.spyOn(lab, 'measure').mockResolvedValue(m);
    expect(await driver.measure(APP, 5)).toBe(m);
    expect(spy).toHaveBeenCalledWith(SERIAL, { package: 'com.example.game', seconds: 5 });
  });

  it('memory() samples app PSS, graphics and free memory', async () => {
    const { driver, runner } = world();
    runner
      .on(/stat -c %u \/proc\/4242/, '10123\n@@procs\n')
      .on(/cat \/proc\/uptime/, '5992.26 100.00\n@@stat\ncpu  100 0 100 1000 0 0 0 0 0 0\n@@app\n4242 (com.example.game) S 1 1 0 0 -1 0 0 0 0 0 50 20 0 0\n@@meminfo\nMemTotal:        1900000 kB\nMemAvailable:     512000 kB\n@@appmem\n    GL mtrack   152087   152087        0        0   152087\n        TOTAL   266411   194943     6836    39255   295103    61650    53366     8283\n');
    const s = await driver.memory(APP);
    expect(s).toMatchObject({ pssMB: 260.2, graphicsMB: 148.5, availMB: 500 });
    expect(s.jsHeapMB).toBeUndefined(); // no WebView known for the app
  });
});

describe('AdbDriver recordKeys', () => {
  it('wraps the getevent recorder', async () => {
    const { driver, runner } = world();
    const rec = driver.recordKeys();
    const p = runner.spawned[0];
    expect(p?.args).toEqual(['-s', SERIAL, 'shell', 'getevent -lt']);
    p?.proc.write('[  100.000000] /dev/input/event3: EV_KEY       KEY_RIGHT            DOWN\n[  100.750000] /dev/input/event3: EV_KEY       KEY_RIGHT            UP\n');
    await new Promise((r) => setTimeout(r, 10));
    const keys = await rec.stop();
    expect(keys.map((k) => [k.key, k.action, k.holdMs])).toEqual([['right', 'down', undefined], ['right', 'up', 750]]);
    expect(p?.proc.killed).toBe(true);
  });
});

describe('AdbDriver WebView, and close() cleanup', () => {
  let dt: FakeDevtools;
  beforeEach(async () => {
    dt = await new FakeDevtools().start(); // our own server on an OS-assigned port
  });
  afterEach(async () => {
    await dt.stop();
  });

  function webWorld(owned: boolean) {
    const w = world();
    prefer(w.runner, /grep -a devtools_remote/, SOCKETS);
    w.runner.on(/forward tcp:0 localabstract:webview_devtools_remote_4242/, `${dt.port}\n`);
    if (!owned) return w;
    const driver = new AdbDriver({ serial: SERIAL, labOptions: { adb: w.lab.adb, home: w.home, autoReconnect: false } });
    return { ...w, lab: driver.lab, driver };
  }

  it('evaluates in the app and learns that eval works', async () => {
    const { driver } = webWorld(false);
    dt.handler = (m) => (m.method === 'Runtime.evaluate' && String(m.params?.expression) === 'game.state' ? { result: { type: 'object', value: { scene: 'menu' } } } : {});
    await driver.probe({ package: 'com.example.game' });
    expect(await driver.evaluate('game.state')).toEqual({ scene: 'menu' });
    expect(driver.caps.eval).toBe(true);
    await driver.close();
  });

  it('streams console entries until unsubscribed, and passes raw CDP', async () => {
    const { driver } = webWorld(false);
    await driver.probe(APP);
    const got: string[] = [];
    const off = driver.onConsole(APP, (e) => got.push(`${e.level}:${e.text}`));
    // The subscription attaches asynchronously (slower when the machine is busy): send until it is listening.
    for (let i = 0; i < 100 && !got.length; i++) {
      dt.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }], timestamp: 1 });
      await new Promise((r) => setTimeout(r, 30));
    }
    off();
    dt.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'after' }], timestamp: 2 });
    await new Promise((r) => setTimeout(r, 30));
    expect(got.length).toBeGreaterThan(0);
    expect(new Set(got)).toEqual(new Set(['error:boom'])); // nothing after unsubscribing
    dt.handler = (m) => (m.method === 'Runtime.getHeapUsage' ? { usedSize: 10485760, totalSize: 20971520 } : {});
    expect(await driver.cdp('Runtime.getHeapUsage')).toEqual({ usedSize: 10485760, totalSize: 20971520 });
    await driver.close();
  });

  it('close() on an owned FireLab: stops recorders and listeners, removes the forward, closes the lab', async () => {
    const { driver, runner, lab } = webWorld(true);
    const labClose = vi.spyOn(lab, 'close');
    await driver.probe(APP);
    const rec = driver.recordKeys();
    void rec;
    driver.onConsole(APP, () => {});
    await new Promise((r) => setTimeout(r, 80));
    await driver.evaluate('1');
    await driver.close();
    expect(labClose).toHaveBeenCalled();
    expect(runner.spawned.find((s) => s.args[3] === 'getevent -lt')?.proc.killed).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const removes = runner.calls.filter((c) => c.includes('--remove'));
    expect(removes.map((c) => c.join(' '))).toEqual([`-s ${SERIAL} forward --remove tcp:${dt.port}`]);
    // No reconnect attempts after close, and calls fail cleanly.
    await new Promise((r) => setTimeout(r, 600));
    expect(runner.calls.filter((c) => c.includes('forward') && !c.includes('--remove'))).toHaveLength(1);
    await expect(driver.press([{ key: 'up' }])).rejects.toMatchObject({ code: 'bad-request' });
    await driver.close(); // idempotent
  });

  it('close() on a shared FireLab: releases only its sessions and leaves the lab running', async () => {
    const { driver, runner, lab } = webWorld(false);
    const labClose = vi.spyOn(lab, 'close');
    await driver.probe(APP);
    await driver.evaluate('1');
    await driver.close();
    expect(labClose).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.calls.some((c) => c.join(' ') === `-s ${SERIAL} forward --remove tcp:${dt.port}`)).toBe(true);
    expect((await lab.foreground(SERIAL))?.package).toBe('com.amazon.tv.launcher');
    await lab.close();
  });

  it('close() ends the virtual remote the driver started', async () => {
    const { driver, runner } = androidTvWorld(true);
    await driver.press([{ key: 'ok', mode: 'hold', holdMs: 80 }]);
    const hid = runner.spawned.find((s) => s.args[3] === 'hid');
    expect(hid?.proc.killed).toBe(false);
    await driver.close();
    expect(hid?.proc.killed).toBe(true);
  });
});
