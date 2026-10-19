// Tests for the Vega OS driver (src/vega) against a fake `vega` CLI. These check
// the commands FireLab sends and how it reads the replies; they do not prove the
// real Vega tools behave this way (see docs/VEGA.md: not yet tested on a device).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/adb/png.js';
import { createDriver } from '../src/driver/index.js';
import {
  VdaDriver,
  VEGA_KEYS,
  escapeSendText,
  findVega,
  inputdArgs,
  parseAceMemusage,
  parsePid,
  parseVdaDevices,
  parseVegaLogLine,
  parseVegaLogs,
  resolveVegaSerial,
  vegaCandidates,
  defaultVegaRunner,
  type VegaRunner,
} from '../src/vega/index.js';

const SERIAL = 'G0XYZ1234567890';
const DEVICES = `List of devices attached\n${SERIAL}  device product:fire_tv_vega model:AFTCA002 transport_id:3\n`;

type Reply = string | { code?: number; stdout?: string | Buffer; stderr?: string } | ((args: string[]) => string | { code?: number; stdout?: string | Buffer; stderr?: string });

/** A fake `vega` CLI: the first rule whose regex matches the joined args answers. Unmatched commands succeed with no output. */
function fakeVega(rules: [RegExp, Reply][] = []) {
  const calls: { args: string[]; serial?: string }[] = [];
  const runner: VegaRunner & { calls: typeof calls; on: (m: RegExp, r: Reply) => void } = {
    calls,
    on(m, r) {
      rules.unshift([m, r]);
    },
    async run(args, opts = {}) {
      calls.push({ args, ...(opts.serial ? { serial: opts.serial } : {}) });
      const line = args.join(' ');
      const rule = rules.find(([m]) => m.test(line));
      let r: Reply = rule ? rule[1] : '';
      if (typeof r === 'function') r = r(args);
      if (typeof r === 'string') r = { stdout: r };
      return { code: r.code ?? 0, stdout: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? ''), stderr: r.stderr ?? '' };
    },
  };
  return runner;
}

/** A small gradient PNG standing in for a 1920x1080 Vega screenshot. */
function screenshotPng(width = 320, height = 180): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x % 256, y % 256, 128, 255], (y * width + x) * 4);
  return encodePng({ width, height, data });
}

function driver(rules: [RegExp, Reply][] = []) {
  const runner = fakeVega([[/devices -l/, DEVICES], ...rules]);
  return { d: new VdaDriver({ serial: SERIAL, runner }), runner };
}

describe('keys', () => {
  it('maps every FireLab remote key to an inputd-cli key name', () => {
    for (const [k, v] of Object.entries(VEGA_KEYS)) expect(v, k).toMatch(/^KEY_[A-Z]+$/);
    expect(inputdArgs({ key: 'up' })).toEqual(['button_press', 'KEY_UP']);
    expect(inputdArgs({ key: 'ok' })).toEqual(['button_press', 'KEY_ENTER']);
    expect(inputdArgs({ key: 'back', mode: 'long' })).toEqual(['button_press', 'KEY_BACK', 'long']);
    expect(inputdArgs({ key: 'right', mode: 'hold', holdMs: 1500 })).toEqual(['button_press', 'KEY_RIGHT', '--holdDuration', '1500']);
    expect(inputdArgs({ key: 'home' }, { ...VEGA_KEYS, home: 'KEY_HOME' })).toEqual(['button_press', 'KEY_HOME']);
  });

  it('rejects unknown keys, modes and hold times', () => {
    expect(() => inputdArgs({ key: 'power' as never })).toThrow(/Unknown remote key/);
    expect(() => inputdArgs({ key: 'up', mode: 'tap' as never })).toThrow(/Unknown key mode/);
    expect(() => inputdArgs({ key: 'up', mode: 'hold', holdMs: 40000 })).toThrow(/1-30000/);
  });

  it('escapes text the way the inputd-cli example does', () => {
    expect(escapeSendText('hello world!')).toBe('hello\\ world\\!');
    expect(escapeSendText('a.b_c-d9')).toBe('a.b_c-d9');
    expect(() => escapeSendText('')).toThrow(/No text/);
    expect(() => escapeSendText('café')).toThrow(/ASCII/);
  });
});

describe('parsers', () => {
  it('reads `vda devices -l`', () => {
    expect(parseVdaDevices(`${DEVICES}emulator-5554 device product:vvd model:Vega_Virtual_Device\n192.168.1.80:5555 unauthorized\n`)).toEqual([
      { serial: SERIAL, state: 'device', product: 'fire tv vega', model: 'AFTCA002' },
      { serial: 'emulator-5554', state: 'device', product: 'vvd', model: 'Vega Virtual Device' },
      { serial: '192.168.1.80:5555', state: 'unauthorized' },
    ]);
    expect(parseVdaDevices('List of devices attached\n\n* daemon started\n')).toEqual([]);
  });

  it('reads short-precise log lines, guesses levels and joins continuation lines', () => {
    const l = parseVegaLogLine('Oct 16 15:42:11.123456 vega com.example.game[4321]: TypeError: undefined is not a function', 2026);
    expect(l).toMatchObject({ level: 'error', tag: 'com.example.game', pid: 4321, text: 'TypeError: undefined is not a function' });
    expect(new Date(l!.ts).toISOString().slice(5, 23)).toBe(new Date(2026, 9, 16, 15, 42, 11, 123).toISOString().slice(5, 23));
    expect(parseVegaLogLine('not a log line')).toBeNull();
    const all = parseVegaLogs('Oct 16 15:42:12.000001 vega kernel: warning: low memory\nOct 16 15:42:13.5 vega app[9]: started\n   at frame 2\n', 2026);
    expect(all.map((x) => x.level)).toEqual(['warn', 'info']);
    expect(all[1]!.text).toBe('started\nat frame 2');
  });

  it('reads an app row from ace_memusage in kB, MB and with unit suffixes', () => {
    expect(parseAceMemusage('  PID  NAME                 PSS(kB)   RSS(kB)\n 4321  com.example.game     204800    262144\n  100  launcher             51200     80000\n', 'com.example.game')).toEqual({ pssMB: 200, column: 'PSS(kB)' });
    expect(parseAceMemusage('Process            RSS (MB)\ncom.example.game.main   187.5\n', 'com.example.game')).toEqual({ pssMB: 187.5, column: 'RSS (MB)' });
    expect(parseAceMemusage('pid name pss rss\n77 com.example.game 150M 190M\n', 'com.example.game')).toEqual({ pssMB: 150, column: 'pss' });
    expect(parseAceMemusage('PID NAME PSS\n1 other 10\n', 'com.example.game')).toBeNull();
    expect(parseAceMemusage('nothing useful here', 'com.example.game')).toBeNull();
  });

  it('reads a pid from pidof or a ps table', () => {
    expect(parsePid('4321\n', 'com.example.game')).toBe(4321);
    expect(parsePid('USER PID PPID NAME\nu0 4321 1 com.example.game\nu0 99 1 other\n', 'com.example.game')).toBe(4321);
    expect(parsePid('USER PID NAME\nu0 99 other\n', 'com.example.game')).toBeUndefined();
  });
});

describe('VdaDriver', () => {
  it('claims only what the Vega docs support', () => {
    const { d } = driver();
    expect(d.kind).toBe('vda');
    expect(d.caps).toMatchObject({ keys: true, holds: true, text: true, screenshot: true, rgbaThumb: true, launch: true, logs: true, install: true, memory: true });
    expect(d.caps).toMatchObject({ eval: false, console: false, cdp: false, reset: false, measure: false, recordKeys: false });
  });

  it('presses keys with inputd-cli on the right device', async () => {
    const { d, runner } = driver();
    await d.press([{ key: 'down' }, { key: 'ok', mode: 'long' }, { key: 'left', mode: 'hold', holdMs: 800 }]);
    expect(runner.calls.map((c) => c.args.join(' '))).toEqual([
      'exec inputd-cli button_press KEY_DOWN',
      'exec inputd-cli button_press KEY_ENTER long',
      'exec inputd-cli button_press KEY_LEFT --holdDuration 800',
    ]);
    expect(runner.calls.every((c) => c.serial === SERIAL)).toBe(true);
    await expect(d.press([])).rejects.toThrow(/No keys/);
    await expect(d.press([{ key: 'up' }, { key: 'nope' as never }])).rejects.toThrow(/Unknown remote key/);
    expect(runner.calls).toHaveLength(3); // validated before sending anything
  });

  it('types text', async () => {
    const { d, runner } = driver();
    await d.typeText('fire lab');
    expect(runner.calls[0]!.args).toEqual(['exec', 'inputd-cli', 'send_text', 'fire\\ lab']);
  });

  it('reports a failed command with the CLI message', async () => {
    const { d } = driver([[/inputd-cli/, { code: 1, stderr: 'error: no device connected' }]]);
    await expect(d.press([{ key: 'up' }])).rejects.toMatchObject({ code: 'adb-failed', message: expect.stringMatching(/no device connected/) });
  });

  it('takes a screenshot with gwsi-tool-screenshooter + vda pull, as RGBA, JPEG or PNG', async () => {
    const png = screenshotPng();
    const { d, runner } = driver([[/ pull /, (args) => (fs.writeFileSync(args[args.length - 1] as string, png), '')]]);
    const rgba = await d.screenshot({ format: 'rgba', width: 64 });
    expect([rgba.width, rgba.height, rgba.rgba?.length]).toEqual([64, 36, 64 * 36 * 4]);
    expect(runner.calls[0]!.args).toEqual(['exec', 'vda', '-s', SERIAL, 'shell', 'gwsi-tool-screenshooter', '/tmp/firelab-shot.png']);
    expect(runner.calls[1]!.args.slice(0, 6)).toEqual(['exec', 'vda', '-s', SERIAL, 'pull', '/tmp/firelab-shot.png']);
    const jpg = await d.screenshot({ width: 160 });
    expect([jpg.mime, jpg.width, jpg.data?.[0], jpg.data?.[1]]).toEqual(['image/jpeg', 160, 0xff, 0xd8]);
    const full = await d.screenshot({ format: 'png' });
    expect([full.mime, full.width, full.data?.equals(png)]).toEqual(['image/png', 320, true]);
    expect((await d.info()).resolution).toEqual({ width: 320, height: 180 });
  });

  it('fails clearly when the screenshot never arrives', async () => {
    const { d } = driver();
    await expect(d.screenshot()).rejects.toThrow(/not pulled/);
  });

  it('reads device info from vda devices', async () => {
    const { d } = driver();
    expect(await d.info()).toEqual({ os: 'Vega OS', model: 'AFTCA002', name: 'AFTCA002' });
    const vvd = new VdaDriver({ serial: 'emulator-5554', runner: fakeVega([[/devices -l/, 'emulator-5554 device model:Vega_Virtual_Device\n']]) });
    expect(await vvd.info()).toMatchObject({ name: 'Vega Virtual Device' });
  });

  it('launches with `vega device launch-app`, and falls back to vlcm', async () => {
    const { d, runner } = driver([[/pidof/, '4321\n']]);
    expect(await d.launch({ package: 'com.example.game' })).toMatchObject({ pid: 4321 });
    expect(runner.calls[0]!.args).toEqual(['device', 'launch-app', '--appName', 'com.example.game']);
    expect(await d.foreground()).toEqual({ package: 'com.example.game' });

    const old = driver([[/device launch-app/, { code: 2, stderr: 'unknown command' }]]);
    await old.d.launch({ package: 'com.example.game' });
    expect(old.runner.calls.map((c) => c.args.join(' '))).toContain(`exec vda -s ${SERIAL} shell vlcm launch-app pkg://com.example.game`);

    const both = driver([[/launch-app/, { code: 1, stderr: 'app not found' }]]);
    await expect(both.d.launch({ package: 'com.example.game' })).rejects.toThrow(/app not found/);
    await expect(d.launch({ package: 'bad id; rm -rf /' })).rejects.toThrow(/not a Vega app id/);
  });

  it('stops with terminate-app, falling back to vlcm', async () => {
    const { d, runner } = driver([[/device terminate-app/, { code: 2 }]]);
    await d.stop({ package: 'com.example.game' });
    expect(runner.calls.map((c) => c.args.join(' '))).toEqual(['device terminate-app --appName com.example.game', `exec vda -s ${SERIAL} shell vlcm terminate-app pkg://com.example.game`]);
  });

  it('installs a .vpkg with `vega device install-app`', async () => {
    const file = `${fs.mkdtempSync('/tmp/firelab-vpkg-')}/game_armv7.vpkg`;
    fs.writeFileSync(file, 'vpkg');
    const { d, runner } = driver([[/install-app/, 'Installed com.example.game successfully\n']]);
    expect(await d.install(file)).toEqual({ package: 'com.example.game' });
    expect(runner.calls[0]!.args).toEqual(['device', 'install-app', '--packagePath', file]);
    const quiet = driver();
    expect(await quiet.d.install(file)).toEqual({ package: 'game' });
    await expect(d.install('/tmp/app.apk')).rejects.toThrow(/\.vpkg/);
    await expect(d.install('/tmp/missing.vpkg')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('reads logs and filters them by time, level and app', async () => {
    const log = [
      'Oct 16 15:40:00.000000 vega launcher[10]: started',
      'Oct 16 15:42:00.000000 vega com.example.game[4321]: warning: slow frame',
      'Oct 16 15:42:01.000000 vega com.example.game[4321]: Error: texture failed',
      'Oct 16 15:42:02.000000 vega launcher[10]: error: unrelated',
    ].join('\n');
    const { d } = driver([[/loggingctl/, log], [/pidof/, '4321\n']]);
    expect(await d.logs()).toHaveLength(4);
    const since = new Date(new Date().getFullYear(), 9, 16, 15, 41).getTime();
    expect((await d.logs({ sinceTs: since })).map((l) => l.text)).toEqual(['warning: slow frame', 'Error: texture failed', 'error: unrelated']);
    expect((await d.logs({ minLevel: 'error' })).map((l) => l.text)).toEqual(['Error: texture failed', 'error: unrelated']);
    expect((await d.logs({ app: { package: 'com.example.game' }, minLevel: 'warn' })).map((l) => l.text)).toEqual(['warning: slow frame', 'Error: texture failed']);
  });

  it('retries logs without --no-pager when loggingctl rejects it', async () => {
    const { d, runner } = driver([[/--no-pager/, { code: 1, stderr: 'unknown option' }], [/loggingctl/, 'Oct 16 15:42:00.000000 vega a[1]: hi']]);
    expect(await d.logs()).toHaveLength(1);
    expect(runner.calls.filter((c) => c.args.includes('loggingctl'))).toHaveLength(2);
  });

  it('reads memory with ace_memusage, and probes it per app', async () => {
    const { d } = driver([[/ace_memusage/, 'PID NAME PSS(kB)\n4321 com.example.game 102400\n']]);
    expect(await d.memory({ package: 'com.example.game' })).toMatchObject({ pssMB: 100 });
    await expect(d.memory({ package: 'com.other.app' })).rejects.toMatchObject({ code: 'not-found' });
    expect((await d.probe({ package: 'com.other.app' })).memory).toBe(false);
    expect((await d.probe({ package: 'com.example.game' })).memory).toBe(true);
  });

  it('refuses work after close()', async () => {
    const { d } = driver();
    await d.close();
    await expect(d.press([{ key: 'up' }])).rejects.toThrow(/closed/);
  });
});

describe('device selection and registry', () => {
  it('picks the only device, checks a named one, and explains the rest', async () => {
    expect(await resolveVegaSerial(fakeVega([[/devices/, DEVICES]]))).toBe(SERIAL);
    expect(await resolveVegaSerial(fakeVega([[/devices/, DEVICES]]), SERIAL)).toBe(SERIAL);
    await expect(resolveVegaSerial(fakeVega([[/devices/, 'List of devices attached\n']]))).rejects.toMatchObject({ code: 'no-device' });
    await expect(resolveVegaSerial(fakeVega([[/devices/, `${DEVICES}emulator-5554 device\n`]]))).rejects.toMatchObject({ code: 'ambiguous-device' });
    await expect(resolveVegaSerial(fakeVega([[/devices/, 'x unauthorized\n']]), 'x')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(resolveVegaSerial(fakeVega([[/devices/, DEVICES]]), 'other')).rejects.toMatchObject({ code: 'device-not-found' });
    await expect(resolveVegaSerial(fakeVega([[/devices/, { code: 1, stderr: 'vda server not running' }]]))).rejects.toThrow(/vda server not running/);
  });

  it('createDriver({ kind: "vda" }) builds and probes a VdaDriver', async () => {
    const runner = fakeVega([[/devices -l/, DEVICES], [/get-serialno/, `${SERIAL}\n`]]);
    const d = await createDriver({ kind: 'vda', extra: { runner } });
    expect([d.kind, d.serial]).toEqual(['vda', SERIAL]);
    expect(runner.calls.map((c) => c.args.join(' '))).toContain(`exec vda -s ${SERIAL} get-serialno`);
    await d.close();
  });

  it('finds the vega CLI from VEGA_CLI or PATH, and says how to install it', () => {
    expect(vegaCandidates({ VEGA_CLI: '/opt/vega/bin/vega', PATH: '/usr/bin' }, '/home/u', 'linux').slice(0, 3)).toEqual(['/opt/vega/bin/vega', '/usr/bin/vega', '/usr/bin/kepler']);
    expect(findVega({ PATH: '/a:/b' }, (f) => f === '/b/vega')).toBe('/b/vega');
    expect(findVega({ PATH: '' }, () => false)).toBeNull();
    expect(() => defaultVegaRunner({ PATH: '', HOME: '/nonexistent', VEGA_CLI: '/nonexistent/vega' })).toThrow(/Vega SDK/);
  });
});
