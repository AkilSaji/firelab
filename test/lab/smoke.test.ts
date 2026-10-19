// Tests for the lab's smoke-check verdicts, reports, AVD files and CLI wiring. No emulator needed.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanLogcat, lumaStats, screenVerdict, memoryVerdict, launchVerdict, overall, type SmokeResult } from '../../src/lab/smoke.js';
import { smokeMarkdown, smokeHtml, HONESTY } from '../../src/lab/report.js';
import { writeAvd, listAvds, deleteAvd, findSdk, avdHome, type LabEnv } from '../../src/lab/sdk.js';
import { labSpec } from '../../src/lab/spec.js';
import { runLab, commandLine, quoteArg, bootWarnings, resolveModel } from '../../src/lab/cli.js';

const PKG = 'dev.firelab.game';

describe('scanLogcat', () => {
  test('finds a Java crash of the package, not of others', () => {
    const log = [
      '10-16 13:00:01.000  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main',
      `10-16 13:00:01.000  1234  1234 E AndroidRuntime: Process: ${PKG}, PID: 1234`,
      '10-16 13:00:01.000  1234  1234 E AndroidRuntime: java.lang.NullPointerException',
      '10-16 13:00:02.000  2222  2222 E AndroidRuntime: FATAL EXCEPTION: main',
      '10-16 13:00:02.000  2222  2222 E AndroidRuntime: Process: com.other.app, PID: 2222',
    ].join('\n');
    const p = scanLogcat(log, PKG);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: 'crash' });
    expect(p[0]!.line).toContain(`Process: ${PKG}`);
  });

  test('ANR, native crash, process death and WebView renderer crash', () => {
    const log = [
      `10-16 13:00:03.000   500   520 E ActivityManager: ANR in ${PKG} (${PKG}/.MainActivity)`,
      `10-16 13:00:04.000  3000  3000 F DEBUG   : pid: 1234, tid: 1240, name: GLThread  >>> ${PKG} <<<`,
      `10-16 13:00:05.000   500   530 I ActivityManager: Process ${PKG} (pid 1234) has died: fg  TOP`,
      '10-16 13:00:06.000  1234  1250 E chromium: [ERROR:aw_browser_terminator.cc(165)] Renderer process (4321) crash detected (code -1).',
      `10-16 13:00:07.000   500   520 E ActivityManager: ANR in ${PKG}.other (x)`,
      `10-16 13:00:08.000   500   520 E ActivityManager: ANR in ${PKG}:remote`,
    ].join('\n');
    expect(scanLogcat(log, PKG).map((p) => p.kind)).toEqual(['anr', 'native-crash', 'died', 'renderer-crash', 'anr']);
  });

  test('a clean log has no problems', () => {
    expect(scanLogcat('10-16 13:00:01.000  1  1 I ActivityManager: Start proc 1234:dev.firelab.game/u0a12', PKG)).toEqual([]);
  });
});

describe('verdicts', () => {
  const img = (w: number, h: number, f: (x: number, y: number) => number) => {
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = f(x, y);
      d.set([v, v, v, 255], (y * w + x) * 4);
    }
    return d;
  };
  test('screen: black, flat, content', () => {
    expect(screenVerdict(lumaStats(img(64, 36, () => 0), 64, 36)).status).toBe('warn');
    expect(screenVerdict(lumaStats(img(64, 36, () => 0), 64, 36)).detail).toMatch(/black/);
    expect(screenVerdict(lumaStats(img(64, 36, () => 200), 64, 36)).detail).toMatch(/flat/);
    expect(screenVerdict(lumaStats(img(64, 36, (x) => (x * 4) % 256), 64, 36)).status).toBe('pass');
  });
  test('memory against the real model budget', () => {
    expect(memoryVerdict(300, 415, 458).status).toBe('pass');
    expect(memoryVerdict(430, 415, 458).status).toBe('warn');
    expect(memoryVerdict(470, 415, 458)).toMatchObject({ status: 'fail' });
    expect(memoryVerdict(470, 415, 458).detail).toMatch(/hard limit/);
    expect(memoryVerdict(undefined, 415, 458).status).toBe('skip');
    expect(memoryVerdict(470).status).toBe('pass');
  });
  test('launch time warns, or fails when the limit was asked for', () => {
    expect(launchVerdict(1200, 5000, false).status).toBe('pass');
    expect(launchVerdict(6000, 5000, false).status).toBe('warn');
    expect(launchVerdict(6000, 5000, true).status).toBe('fail');
    expect(launchVerdict(undefined, 5000, true).status).toBe('warn');
  });
  test('overall', () => {
    expect(overall([{ id: 'a', title: 'a', status: 'warn', detail: '' }])).toBe('pass');
    expect(overall([{ id: 'a', title: 'a', status: 'pass', detail: '' }, { id: 'b', title: 'b', status: 'fail', detail: '' }])).toBe('fail');
  });
});

describe('reports', () => {
  const r: SmokeResult = {
    ok: false,
    verdict: 'fail',
    device: 'emulator-5554',
    package: PKG,
    model: 'AFTSSS',
    checks: [
      { id: 'install', title: 'Installs', status: 'pass', detail: PKG },
      { id: 'logcat', title: 'No crash or ANR in logcat', status: 'fail', detail: 'crash: FATAL | Process: x' },
    ],
    problems: [],
    notes: ['a <note>'],
  };
  test('markdown summary has the table, the explore row and the honesty note', () => {
    const md = smokeMarkdown(r, { explore: { status: 'skip', detail: 'firelab explore is not available in this FireLab version' } });
    expect(md).toMatch(/## FireLab lab: ❌ failed/);
    expect(md).toContain('| ✅ | Installs |');
    expect(md).toContain('crash: FATAL \\| Process: x');
    expect(md).toMatch(/Explore .* not available/);
    expect(md).toContain(HONESTY);
  });
  test('HTML escapes and is a full page', () => {
    const html = smokeHtml(r, { lab: { name: 'firelab-AFTSSS', model: 'AFTSSS', image: 'system-images;android-28;android-tv;x86', ramMB: 1024, width: 1920, height: 1080, density: 320 } });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('a &lt;note&gt;');
    expect(html).toContain('<b>AFTSSS</b>');
    expect(html).toMatch(/prefers-color-scheme:dark/);
  });
});

describe('AVD files', () => {
  test('writeAvd writes config.ini, firelab.json and the pointer; listAvds reads them back', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-avd-'));
    try {
      const { target, profile } = resolveModel('AFTSSS');
      const spec = labSpec(target, profile, { host: 'x86_64' });
      const r = writeAvd(spec, 'system-images;android-28;android-tv;x86', home, { headless: true });
      expect(fs.readFileSync(r.config, 'utf8')).toContain('hw.gpu.mode=swiftshader_indirect');
      expect(() => writeAvd(spec, 'x', home)).toThrow(/already exists/);
      writeAvd(spec, 'system-images;android-28;android-tv;x86', home, { force: true });
      const [avd] = listAvds(home);
      expect(avd).toMatchObject({ name: 'firelab-AFTSSS', meta: { model: 'AFTSSS', api: 28, ramMB: 1024, budgetMB: 415, limitMB: 458 } });
      expect(avd!.config.get('hw.ramSize')).toBe('1024');
      expect(deleteAvd(home, 'firelab-AFTSSS')).toBe(true);
      expect(listAvds(home)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('avdHome and findSdk follow the environment', () => {
    const e = (env: Record<string, string>): LabEnv => ({ env, platform: 'linux', home: '/home/u', exists: (f) => f.startsWith('/sdk') });
    expect(avdHome(e({}))).toBe('/home/u/.android/avd');
    expect(avdHome(e({ ANDROID_USER_HOME: '/x' }))).toBe('/x/avd');
    expect(avdHome(e({ ANDROID_AVD_HOME: '/y' }))).toBe('/y');
    expect(findSdk(e({ ANDROID_HOME: '/sdk' }))).toEqual({
      sdk: '/sdk',
      emulator: '/sdk/emulator/emulator',
      adb: '/sdk/platform-tools/adb',
      sdkmanager: '/sdk/cmdline-tools/latest/bin/sdkmanager',
      avdmanager: '/sdk/cmdline-tools/latest/bin/avdmanager',
    });
    expect(findSdk(e({})).sdk).toBeNull();
  });
});

describe('CLI', () => {
  const capture = () => {
    const lines: string[] = [];
    const errs: string[] = [];
    return { out: { log: (s: string) => lines.push(s), err: (s: string) => errs.push(s) }, lines, errs };
  };
  test('help, unknown command and bad flags', async () => {
    const c = capture();
    expect(await runLab(['help'], c.out)).toBe(0);
    expect(c.lines.join('\n')).toMatch(/firelab lab create --profile/);
    expect(await runLab(['nope'], c.out)).toBe(2);
    expect(await runLab(['create', '--bogus'], c.out)).toBe(2);
    expect(await runLab(['create'], c.out)).toBe(2);
    expect(await runLab(['create', '--profile', 'NOPE'], c.out)).toBe(2);
    expect(c.errs.join('\n')).toMatch(/Unknown model "NOPE"/);
  });
  test('create --dry-run prints the spec as JSON without touching the SDK', async () => {
    const c = capture();
    const env: LabEnv = { env: {}, platform: 'linux', home: '/nonexistent', exists: () => false };
    expect(await runLab(['create', '--profile', 'AFTMA08C15', '--dry-run', '--json'], c.out, env)).toBe(0);
    const j = JSON.parse(c.lines.join('\n')) as { image: string; spec: { ramMB: { value: number } } };
    expect(j.image).toMatch(/^system-images;android-30;/);
    expect(j.spec.ramMB.value).toBe(2048);
  });
  test('create without an SDK explains how to get one', async () => {
    const c = capture();
    const env: LabEnv = { env: {}, platform: 'linux', home: '/nonexistent', exists: () => false };
    expect(await runLab(['create', '--profile', 'AFTSSS'], c.out, env)).toBe(1);
    expect(c.errs.join('\n')).toMatch(/No Android SDK found.*commandlinetools-linux/);
  });
  test('shell quoting for printed commands', () => {
    expect(quoteArg('system-images;android-28;android-tv;x86')).toBe('"system-images;android-28;android-tv;x86"');
    expect(quoteArg('/opt/sdk/bin/sdkmanager')).toBe('/opt/sdk/bin/sdkmanager');
    expect(commandLine('sdkmanager', ['--install', 'a b'])).toBe('sdkmanager --install "a b"');
  });
  test('boot warnings when the emulator overrides RAM', () => {
    const meta = { firelab: 1 as const, name: 'l', model: 'AFTSSS', modelName: 'x', api: 28, image: 'i', imageWhy: '', ramMB: 1024, heapMB: 192, width: 1920, height: 1080, density: 320, createdAt: '', notes: [] };
    expect(bootWarnings(meta, 1000, 28)).toEqual([]);
    expect(bootWarnings(meta, 2473, 36).join('\n')).toMatch(/raised RAM to 2473 MB.*API 36/s);
    expect(bootWarnings(undefined, 9999, 1)).toEqual([]);
  });
});
