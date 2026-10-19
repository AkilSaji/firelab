/**
 * `firelab wrap`: turn any web URL into an installable Fire TV / Android TV
 * APK (a full-screen WebView), built with the Android SDK command-line tools
 * only. No Gradle, no Android Studio project.
 *
 *   firelab wrap --url http://192.168.1.20:8080/ --name "Firefly Lake"
 *   firelab wrap --url https://example.com/game/ --name Game --package com.example.game --out game.apk --install 192.168.1.50
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { locateToolchain, defaultEnv, type ToolEnv } from './sdk.js';
import { ACTIVITY, buildApk, packageIdProblem, slug, versionCodeFor, type WrapConfig } from './build.js';
import { findAdb, ADB_INSTALL_HINT } from '../adb/locate.js';

export { buildApk, ACTIVITY, packageIdProblem, slug, versionCodeFor, renderManifest, androidString, appConfig } from './build.js';
export { locateToolchain, sdkCandidates, jdkCandidates, findBuildTools, findPlatform, findJdk, parseJavacVersion, compareVersions } from './sdk.js';
export type { WrapConfig, BuildResult, Keystore } from './build.js';
export type { Toolchain, ToolchainResult, ToolEnv } from './sdk.js';

const HELP = `firelab wrap: turn a web URL into a Fire TV / Android TV app (APK)

Usage:
  firelab wrap --url <url> --name <name> [options]

Required:
  --url <url>            the page the app opens (http or https)
  --name <name>          the app name in the launcher

Options:
  --package <id>         application id (default dev.firelab.<name>)
  --out <file.apk>       where to write the APK (default ./<name>.apk)
  --version <x.y.z>      versionName (default 1.0.0); --version-code <n> overrides the code
  --icon <png|jpg>       launcher icon (default: generated from the name)
  --banner <png|jpg>     Fire TV / Android TV banner, 320x180 (default: generated)
  --background <#rgb>    colour behind the page while it loads (default #000000)
  --release              no WebView debugging, not debuggable (FireLab's tester needs a debug build)
  --no-scan              don't look for the server on the LAN when a private address stops answering
  --scan-path <path>     path to probe while scanning (default: the URL's path)
  --keystore <file>      sign with this keystore instead of the debug key
  --ks-pass <spec>       keystore password: env:VAR, file:path or pass:text (default pass:android)
  --key-alias <alias>    key alias in the keystore; --key-pass <spec> its password
  --install <device>     adb serial or IP to install and launch on (e.g. 192.168.1.50)
  --sdk <dir>            Android SDK folder (default $ANDROID_HOME, ~/Library/Android/sdk, ...)
  --java-home <dir>      JDK folder (default $JAVA_HOME, then the usual places)
  --template <dir>       a customised copy of FireLab's android-template folder
  --keep-work            keep the build folder (printed) for debugging
  --check                only check that the SDK and JDK are there
  --json                 print the result as JSON
  -h, --help

The app forwards the remote to the page as keyboard events (arrows, Enter,
MediaPlayPause/Rewind/FastForward, ContextMenu for the menu button). Back
sends Escape: call preventDefault() on it to handle Back yourself; otherwise
the app goes back in history and exits at the first page. Holding Back quits.
Open another URL without rebuilding:
  adb shell am start -n <package>/${ACTIVITY} -e url <url>`;

type Out = { log: (s: string) => void; err: (s: string) => void };
const defaultOut: Out = { log: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) };

/** Doctor checks in the shape `firelab doctor` prints. */
export function wrapDoctorChecks(e: ToolEnv = defaultEnv()): { name: string; ok: boolean | 'warn'; detail: string; fix?: string[] }[] {
  const r = locateToolchain(e);
  if (r.ok) {
    const t = r.toolchain;
    return [
      {
        name: 'APK builds (firelab wrap)',
        ok: r.warnings.length ? 'warn' : true,
        detail: `build-tools ${t.buildTools.version}, android-${t.platform.api}, JDK ${t.jdk.version}`,
        fix: r.warnings.length ? r.warnings : undefined,
      },
    ];
  }
  return [{ name: 'APK builds (firelab wrap)', ok: 'warn', detail: r.problems[0], fix: r.problems.slice(1) }];
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host) || host === '0.0.0.0';
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: e.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

/** Installs and launches on a device over adb. Returns an error message or null. */
async function installAndLaunch(apk: string, pkg: string, device: string, o: Out): Promise<string | null> {
  const adb = findAdb();
  if (!adb) return `adb not found. ${ADB_INSTALL_HINT}`;
  let serial = device;
  // A bare IP (or ip:port) is a network device: connect first.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(device)) {
    serial = device.includes(':') ? device : `${device}:5555`;
    const c = await run(adb, ['connect', serial]);
    if (!/connected to|already connected/i.test(c.out)) return `adb connect ${serial} failed: ${c.out.trim()}`;
  }
  o.err(`- installing on ${serial}`);
  const inst = await run(adb, ['-s', serial, 'install', '-r', apk]);
  if (inst.code !== 0 || !/Success/.test(inst.out)) return `adb install failed: ${inst.out.trim()}`;
  const start = await run(adb, ['-s', serial, 'shell', 'am', 'start', '-n', `${pkg}/${ACTIVITY}`]);
  if (start.code !== 0 || /Error/.test(start.out)) return `installed, but launching failed: ${start.out.trim()}`;
  return null;
}

/**
 * Entry point for `firelab wrap`. Accepts argv with or without the leading
 * "wrap". Returns the process exit code (0 ok, 1 build failed, 2 usage error,
 * 3 toolchain missing).
 */
export async function runWrap(argv: string[], out: Out = defaultOut): Promise<number> {
  const args = argv[0] === 'wrap' ? argv.slice(1) : argv;
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args,
      allowPositionals: false,
      options: {
        url: { type: 'string' },
        name: { type: 'string' },
        package: { type: 'string' },
        out: { type: 'string' },
        version: { type: 'string' },
        'version-code': { type: 'string' },
        icon: { type: 'string' },
        banner: { type: 'string' },
        background: { type: 'string' },
        release: { type: 'boolean' },
        'no-scan': { type: 'boolean' },
        'scan-path': { type: 'string' },
        keystore: { type: 'string' },
        'ks-pass': { type: 'string' },
        'key-alias': { type: 'string' },
        'key-pass': { type: 'string' },
        install: { type: 'string' },
        sdk: { type: 'string' },
        'java-home': { type: 'string' },
        'keep-work': { type: 'boolean' },
        template: { type: 'string' },
        'work-dir': { type: 'string' },
        check: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values as Record<string, string | boolean | undefined>;
  } catch (e) {
    out.err(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
  if (v.help) {
    out.log(HELP);
    return 0;
  }

  const tc = locateToolchain(defaultEnv(), { sdk: str('sdk'), javaHome: str('java-home') });
  if (v.check) {
    if (v.json) out.log(JSON.stringify(tc.ok ? { ok: true, ...tc.toolchain, warnings: tc.warnings } : tc, null, 2));
    else if (tc.ok) {
      const t = tc.toolchain;
      out.log(`Ready to build APKs:\n  SDK         ${t.sdk}\n  build-tools ${t.buildTools.version}\n  platform    android-${t.platform.api}\n  JDK         ${t.jdk.version} at ${t.jdk.home}`);
      for (const w of tc.warnings) out.log(`  warning: ${w}`);
    } else out.err(`Can't build APKs yet:\n${tc.problems.join('\n')}`);
    return tc.ok ? 0 : 3;
  }

  // ---- validate the request ----
  const url = str('url');
  const name = str('name')?.trim();
  if (!url || !name) {
    out.err(`--url and --name are required.\n\n${HELP}`);
    return 2;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('not http');
  } catch {
    out.err(`--url must be an http:// or https:// address, got "${url}"`);
    return 2;
  }
  if (isLoopback(parsed.hostname)) {
    out.err(
      `warning: ${parsed.hostname} on a TV means the TV itself. Use this computer's LAN address (e.g. http://192.168.1.20:${parsed.port || 80}/),\n` +
        `         or forward the port to the device first: adb reverse tcp:${parsed.port || 80} tcp:${parsed.port || 80}`,
    );
  }
  const packageId = str('package') ?? `dev.firelab.${slug(name)}`;
  const pkgProblem = packageIdProblem(packageId);
  if (pkgProblem) {
    out.err(`--package "${packageId}" ${pkgProblem}`);
    return 2;
  }
  const versionName = str('version') ?? '1.0.0';
  const versionCode = str('version-code') !== undefined ? Number(str('version-code')) : versionCodeFor(versionName);
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
    out.err(`--version-code must be a whole number from 1 to 2100000000`);
    return 2;
  }
  const background = str('background') ?? '#000000';
  if (!/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(background)) {
    out.err(`--background must look like #1c1440 (or #AARRGGBB)`);
    return 2;
  }
  for (const k of ['icon', 'banner', 'keystore', 'template']) {
    const f = str(k);
    if (f && !fs.existsSync(f)) {
      out.err(`--${k}: ${f} does not exist`);
      return 2;
    }
  }
  if (!tc.ok) {
    out.err(`Can't build the APK: the Android build tools are missing.\n${tc.problems.join('\n')}`);
    return 3;
  }
  for (const w of tc.warnings) out.err(`warning: ${w}`);

  const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname);
  const config: WrapConfig = {
    url: parsed.toString(),
    name,
    packageId,
    out: str('out') ?? path.resolve(`${slug(name)}.apk`),
    versionName,
    versionCode,
    icon: str('icon'),
    banner: str('banner'),
    debug: !v.release,
    scan: !v['no-scan'] && isPrivate,
    scanPath: str('scan-path'),
    background,
    keepScreenOn: true,
    userAgent: 'FireLab/1',
    keystore: str('keystore')
      ? { path: str('keystore') as string, storePass: str('ks-pass') ?? 'pass:android', keyAlias: str('key-alias'), keyPass: str('key-pass') }
      : undefined,
    keepWorkDir: Boolean(v['keep-work']),
    templateDir: str('template'),
    workDir: str('work-dir'),
  };

  out.err(`Wrapping ${config.url} as "${name}" (${packageId} ${versionName}, ${config.debug ? 'debug: WebView DevTools on' : 'release'})`);
  let result;
  try {
    result = await buildApk(config, tc.toolchain, (line) => out.err(line));
  } catch (e) {
    out.err(`Build failed: ${(e as Error).message}`);
    return 1;
  }

  let installError: string | null = null;
  const device = str('install');
  if (device) installError = await installAndLaunch(result.apk, packageId, device, out);

  if (v.json) {
    out.log(JSON.stringify({ ...result, url: config.url, installed: device ? !installError : undefined, installError: installError ?? undefined }, null, 2));
  } else {
    out.log(`Built ${result.apk} (${(result.bytes / 1024).toFixed(0)} KB, sha256 ${result.sha256.slice(0, 12)}...)`);
    if (result.workDir) out.log(`  build folder kept: ${result.workDir}`);
    if (device && !installError) out.log(`Installed and launched on ${device}.`);
    else {
      out.log(`Install:  adb install -r ${JSON.stringify(result.apk)}`);
      out.log(`Launch:   adb shell am start -n ${packageId}/${ACTIVITY}`);
    }
    out.log(`Other URL without rebuilding: adb shell am start -n ${packageId}/${ACTIVITY} -e url <url>`);
  }
  if (installError) {
    out.err(installError);
    return 1;
  }
  return 0;
}
