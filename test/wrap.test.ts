// Tests for `firelab wrap` (src/wrap). Drop into test/wrap.test.ts.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { appendToZip, listZip } from '../src/wrap/zip.js';
import { crc32, encodePng, imageSize, makeBanner, makeIcon, fontText, layoutLines, hueOf } from '../src/wrap/png.js';
import { slug, packageIdProblem, versionCodeFor, androidString, renderManifest, appConfig, templateDir, passArg, buildApk, type WrapConfig } from '../src/wrap/build.js';
import { compareVersions, parseJavacVersion, findBuildTools, findPlatform, jdkCandidates, sdkCandidates, locateToolchain, type ToolEnv } from '../src/wrap/sdk.js';
import { runWrap } from '../src/wrap/index.js';
import { zipEntries, zipRead, readApk } from '../src/adb/apk.js';

/** A zip with one stored file, as a minimal "aapt2 output". */
function tinyZip(): Buffer {
  return appendToZip(Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]), [{ name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>'), compress: false }]);
}

describe('zip', () => {
  test('appends entries that other zip readers can read back', () => {
    const dex = Buffer.from('dex\n035\0'.repeat(500));
    const zip = appendToZip(tinyZip(), [{ name: 'classes.dex', data: dex }]);
    expect(listZip(zip)).toEqual(['AndroidManifest.xml', 'classes.dex']);
    // Cross-check with the APK reader in src/adb/apk.ts.
    const entries = zipEntries(zip);
    const e = entries.find((x) => x.name === 'classes.dex');
    expect(e).toBeTruthy();
    expect(zipRead(zip, e!).equals(dex)).toBe(true);
    // And by hand: the local header points at deflated data with the right CRC.
    const at = zip.indexOf(Buffer.from('classes.dex')) - 30;
    expect(zip.readUInt32LE(at)).toBe(0x04034b50);
    expect(zip.readUInt32LE(at + 14)).toBe(crc32(dex));
    const body = zip.subarray(at + 30 + 11, at + 30 + 11 + zip.readUInt32LE(at + 18));
    expect(inflateRawSync(body).equals(dex)).toBe(true);
  });

  test('is deterministic and refuses duplicates and non-zips', () => {
    const a = appendToZip(tinyZip(), [{ name: 'x', data: Buffer.from('1') }]);
    const b = appendToZip(tinyZip(), [{ name: 'x', data: Buffer.from('1') }]);
    expect(a.equals(b)).toBe(true);
    expect(() => appendToZip(a, [{ name: 'x', data: Buffer.from('2') }])).toThrow(/already/);
    expect(() => listZip(Buffer.from('not a zip at all, sorry'))).toThrow(/not a zip/);
  });
});

describe('png and launcher art', () => {
  test('crc32 check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
  test('encodes a PNG that reads back with the right size', () => {
    const png = encodePng(3, 2, new Uint8Array(3 * 2 * 4).fill(200));
    expect(imageSize(png)).toEqual({ width: 3, height: 2, type: 'png' });
    expect(() => encodePng(3, 2, new Uint8Array(5))).toThrow(RangeError);
  });
  test('banner is 320x180 and icon 192x192, different per name', () => {
    expect(imageSize(makeBanner('Firefly Lake'))).toMatchObject({ width: 320, height: 180 });
    expect(imageSize(makeIcon('Firefly Lake'))).toMatchObject({ width: 192, height: 192 });
    expect(makeBanner('A').equals(makeBanner('B'))).toBe(false);
    expect(hueOf('same')).toBe(hueOf('same'));
    expect(() => makeBanner('')).not.toThrow();
    expect(() => makeBanner('✨🎮')).not.toThrow();
    expect(() => makeBanner('A really very extremely long application name for a television')).not.toThrow();
  });
  test('reads JPEG sizes', () => {
    // SOI, APP0 (len 16), SOF0 (len 17: precision, height 0x00B4=180, width 0x0140=320)
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xb4, 0x01, 0x40, 0x03, ...new Array(9).fill(0)]);
    expect(imageSize(jpg)).toEqual({ width: 320, height: 180, type: 'jpg' });
    expect(imageSize(Buffer.from('GIF89a........'))).toBeNull();
  });
  test('font text and line layout', () => {
    expect(fontText('Crème brûlée!')).toBe('CREME BRULEE!');
    expect(fontText('🎮 Go')).toBe('GO');
    expect(layoutLines('FIREFLY LAKE', 100)).toEqual(['FIREFLY LAKE']);
    expect(layoutLines('FIREFLY LAKE', 40)).toEqual(['FIREFLY', 'LAKE']);
  });
});

describe('build helpers', () => {
  test('slug and package ids', () => {
    expect(slug('Firefly Lake!')).toBe('fireflylake');
    expect(slug('2048')).toBe('app2048');
    expect(slug('Crème')).toBe('creme');
    expect(slug('new')).toBe('newapp');
    expect(slug('🎮')).toBe('app');
    expect(packageIdProblem('dev.firelab.fireflylake')).toBeNull();
    expect(packageIdProblem('game')).toMatch(/two segments/);
    expect(packageIdProblem('com.2048.game')).toMatch(/start with a letter/);
    expect(packageIdProblem('com.example.new')).toMatch(/keyword/);
    expect(packageIdProblem('com.my-game.app')).toMatch(/letters, digits/);
  });

  test('version codes', () => {
    expect(versionCodeFor('1.0.0')).toBe(10000);
    expect(versionCodeFor('2.3.4')).toBe(20304);
    expect(versionCodeFor('0.1')).toBe(100);
    expect(versionCodeFor('beta')).toBe(1);
  });

  test('Android string escaping', () => {
    expect(androidString("Rehaan's Game")).toBe("Rehaan\\'s Game");
    expect(androidString('Tom & "Jerry"')).toBe('Tom &amp; \\"Jerry\\"');
    expect(androidString('@home')).toBe('\\@home');
    expect(androidString('a<b>')).toBe('a&lt;b&gt;');
  });

  test('manifest template is filled completely', () => {
    const tpl = fs.readFileSync(path.join(templateDir(), 'AndroidManifest.xml'), 'utf8');
    const xml = renderManifest(tpl, { packageId: 'com.example.game', versionName: '1.2.3 "beta"', versionCode: 10203, debug: false });
    expect(xml).toContain('package="com.example.game"');
    expect(xml).toContain('android:versionCode="10203"');
    expect(xml).toContain('android:versionName="1.2.3 &quot;beta&quot;"');
    expect(xml).toContain('android:debuggable="false"');
    expect(xml).toContain('android.intent.category.LEANBACK_LAUNCHER');
    expect(xml).toContain('android:banner="@drawable/banner"');
    expect(() => renderManifest('<manifest package="{{package}}" x="{{nope}}"/>', { packageId: 'a.b', versionName: '1', versionCode: 1, debug: true })).toThrow(/unfilled/);
  });

  test('app config and apksigner password specs', () => {
    const c = appConfig({ url: 'http://192.168.1.2:8080/', name: 'G', scan: true, scanPath: '/health', debug: true, keepScreenOn: true, background: '#000000', userAgent: 'FireLab/1' } as WrapConfig);
    expect(c).toEqual({ url: 'http://192.168.1.2:8080/', name: 'G', scan: true, scanPath: '/health', debug: true, keepScreenOn: true, background: '#000000', userAgent: 'FireLab/1' });
    expect(passArg('secret')).toBe('pass:secret');
    expect(passArg('env:KS_PASS')).toBe('env:KS_PASS');
    expect(passArg('file:/tmp/p')).toBe('file:/tmp/p');
  });
});

describe('toolchain discovery', () => {
  const fakeFs = (files: string[]) => {
    const set = new Set(files);
    return {
      exists: (f: string) => set.has(f) || [...set].some((x) => x.startsWith(`${f}/`)),
      readdir: (d: string) => [...new Set([...set].filter((x) => x.startsWith(`${d}/`)).map((x) => x.slice(d.length + 1).split('/')[0]))],
    };
  };
  const bt = (sdk: string, v: string, missing = '') => ['aapt2', 'd8', 'zipalign', 'apksigner'].filter((t) => t !== missing).map((t) => `${sdk}/build-tools/${v}/${t}`);

  test('version helpers', () => {
    expect(compareVersions('36.0.0', '35.0.1')).toBeGreaterThan(0);
    expect(compareVersions('34.0.0-rc1', '34.0.0')).toBeLessThan(0);
    expect(parseJavacVersion('javac 17.0.20')).toBe(17);
    expect(parseJavacVersion('javac 1.8.0_392')).toBe(8);
    expect(parseJavacVersion('nope')).toBeNull();
  });

  test('picks the newest complete build-tools and platform', () => {
    const sdk = '/sdk';
    const f = fakeFs([...bt(sdk, '36.0.0', 'd8'), ...bt(sdk, '35.0.1'), ...bt(sdk, '34.0.0'), `${sdk}/platforms/android-35/android.jar`, `${sdk}/platforms/android-36/README`]);
    const e: ToolEnv = { env: {}, platform: 'linux', home: '/home/u', ...f };
    expect(findBuildTools(sdk, e)?.version).toBe('35.0.1');
    expect(findPlatform(sdk, e)).toEqual({ jar: '/sdk/platforms/android-35/android.jar', api: 35 });
  });

  test('looks in ANDROID_HOME first, then the OS default', () => {
    expect(sdkCandidates({ env: { ANDROID_HOME: '/a' }, platform: 'darwin', home: '/Users/u' })).toEqual([
      '/a',
      '/Users/u/Library/Android/sdk',
      '/opt/homebrew/share/android-commandlinetools',
      '/usr/local/share/android-commandlinetools',
    ]);
    expect(sdkCandidates({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\u' })).toEqual(['C:\\Users\\u\\AppData\\Local\\Android\\Sdk']);
  });

  test('JAVA_HOME comes first among JDK candidates', () => {
    const e: ToolEnv = { env: { JAVA_HOME: '/jdk17' }, platform: 'linux', home: '/home/u', exists: () => false, readdir: () => [], run: () => null };
    expect(jdkCandidates(e)[0]).toBe('/jdk17');
  });

  test('explains what is missing', () => {
    const e: ToolEnv = { env: {}, platform: 'linux', home: '/home/u', exists: () => false, readdir: () => [], run: () => null };
    const r = locateToolchain(e);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.join('\n')).toMatch(/Android SDK not found/);
      expect(r.problems.join('\n')).toMatch(/sdkmanager "build-tools;35.0.0" "platforms;android-35"/);
      expect(r.problems.join('\n')).toMatch(/No JDK found/);
      expect(r.problems.join('\n')).toMatch(/JAVA_HOME/);
    }
  });
});

describe('runWrap CLI', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, out: { log: (s: string) => lines.push(s), err: (s: string) => lines.push(s) } };
  };
  test('--help', async () => {
    const c = capture();
    expect(await runWrap(['wrap', '--help'], c.out)).toBe(0);
    expect(c.lines.join('\n')).toMatch(/--url <url>/);
  });
  test('usage errors exit with 2 and say why', async () => {
    const cases: [string[], RegExp][] = [
      [['--name', 'X'], /--url and --name are required/],
      [['--url', 'ftp://x/', '--name', 'X'], /http:\/\/ or https:\/\//],
      [['--url', 'http://192.168.1.2/', '--name', 'X', '--package', 'bad'], /two segments/],
      [['--url', 'http://192.168.1.2/', '--name', 'X', '--version-code', '0'], /version-code/],
      [['--url', 'http://192.168.1.2/', '--name', 'X', '--background', 'red'], /background/],
      [['--url', 'http://192.168.1.2/', '--name', 'X', '--icon', '/no/such/icon.png'], /does not exist/],
      [['--bogus'], /Unknown option/],
    ];
    for (const [args, re] of cases) {
      const c = capture();
      expect(await runWrap(args, c.out), args.join(' ')).toBe(2);
      expect(c.lines.join('\n')).toMatch(re);
    }
  });
});

// A real build, when this machine has the Android SDK and a JDK.
const tc = locateToolchain();
describe.skipIf(!tc.ok)('real APK build', () => {
  test('builds, aligns and signs an installable APK', { timeout: 180000 }, async () => {
    if (!tc.ok) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-wrap-test-'));
    try {
      const res = await buildApk(
        {
          url: 'http://192.168.1.20:8080/examples/web-game/',
          name: "Rehaan's Lake & Co",
          packageId: 'dev.firelab.testlake',
          out: path.join(dir, 'lake.apk'),
          versionName: '1.2.3',
          versionCode: 10203,
          debug: true,
          scan: true,
          background: '#1c1440',
          keepScreenOn: true,
          userAgent: 'FireLab/1',
        },
        tc.toolchain,
      );
      const apk = fs.readFileSync(res.apk);
      const names = listZip(apk);
      for (const n of ['AndroidManifest.xml', 'classes.dex', 'resources.arsc', 'assets/firelab.json', 'res/drawable-xhdpi-v4/banner.png']) expect(names).toContain(n);
      expect(names.some((n) => n.startsWith('META-INF/'))).toBe(true);
      const cfgEntry = zipEntries(apk).find((e) => e.name === 'assets/firelab.json')!;
      expect(JSON.parse(zipRead(apk, cfgEntry).toString('utf8')).url).toBe('http://192.168.1.20:8080/examples/web-game/');
      // FireLab's own APK reader (used by install_app) understands it.
      const info = readApk(apk);
      expect(info).toMatchObject({ package: 'dev.firelab.testlake', versionCode: 10203, versionName: '1.2.3', minSdk: 22, targetSdk: 28, leanback: true, nativeAbis: [] });
      expect(info.permissions).toContain('android.permission.INTERNET');
      expect(res.packageId).toBe('dev.firelab.testlake');
      expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
