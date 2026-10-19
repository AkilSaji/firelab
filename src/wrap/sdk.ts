/**
 * Finds what `firelab wrap` needs to build an APK without Gradle: the Android
 * SDK (build-tools for aapt2, d8, zipalign and apksigner, plus a platform's
 * android.jar) and a JDK (javac, keytool, and java for d8/apksigner).
 * Every lookup takes its environment as an argument, so it is testable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type ToolEnv = {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  exists?: (file: string) => boolean;
  readdir?: (dir: string) => string[];
  /** Runs a command and returns stdout + stderr, or null if it failed. */
  run?: (cmd: string, args: string[]) => string | null;
};

export type BuildTools = { dir: string; version: string; aapt2: string; d8: string; zipalign: string; apksigner: string };
export type Platform = { jar: string; api: number };
export type Jdk = { home: string; javac: string; java: string; keytool: string; version: number };
export type Toolchain = { sdk: string; buildTools: BuildTools; platform: Platform; jdk: Jdk };
export type ToolchainResult = { ok: true; toolchain: Toolchain; warnings: string[] } | { ok: false; problems: string[]; warnings: string[]; partial: Partial<Toolchain> };

export function defaultEnv(): ToolEnv {
  return { env: process.env, platform: process.platform, home: os.homedir() };
}

const defaultExists = (f: string) => {
  try {
    fs.accessSync(f);
    return true;
  } catch {
    return false;
  }
};
const defaultReaddir = (d: string) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};
const defaultRun = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    return out || null;
  }
};

function tools(e: ToolEnv) {
  const win = e.platform === 'win32';
  return {
    win,
    join: win ? path.win32.join : path.posix.join,
    exists: e.exists ?? defaultExists,
    readdir: e.readdir ?? defaultReaddir,
    run: e.run ?? defaultRun,
    exe: (name: string) => (win ? `${name}.exe` : name),
    script: (name: string) => (win ? `${name}.bat` : name),
  };
}

/** Compares dotted versions ("36.0.0" vs "35.0.1"); also handles "36.0.0-rc1". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Where the Android SDK could be, in the order we try. */
export function sdkCandidates(e: ToolEnv): string[] {
  const t = tools(e);
  const out: string[] = [];
  for (const k of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_SDK']) if (e.env[k]) out.push(e.env[k] as string);
  if (e.platform === 'darwin') out.push(t.join(e.home, 'Library/Android/sdk'), '/opt/homebrew/share/android-commandlinetools', '/usr/local/share/android-commandlinetools');
  else if (t.win) out.push(t.join(e.env.LOCALAPPDATA ?? t.join(e.home, 'AppData', 'Local'), 'Android', 'Sdk'));
  else out.push(t.join(e.home, 'Android/Sdk'), '/opt/android-sdk', '/usr/lib/android-sdk', '/opt/android-sdk-linux');
  return [...new Set(out)];
}

/** The newest build-tools folder that has aapt2, d8, zipalign and apksigner. */
export function findBuildTools(sdk: string, e: ToolEnv): BuildTools | null {
  const t = tools(e);
  const versions = t.readdir(t.join(sdk, 'build-tools')).sort(compareVersions).reverse();
  for (const v of versions) {
    const dir = t.join(sdk, 'build-tools', v);
    const bt = { dir, version: v, aapt2: t.join(dir, t.exe('aapt2')), d8: t.join(dir, t.script('d8')), zipalign: t.join(dir, t.exe('zipalign')), apksigner: t.join(dir, t.script('apksigner')) };
    if ([bt.aapt2, bt.d8, bt.zipalign, bt.apksigner].every(t.exists)) return bt;
  }
  return null;
}

/** The newest platforms/android-N/android.jar. */
export function findPlatform(sdk: string, e: ToolEnv): Platform | null {
  const t = tools(e);
  const found = t
    .readdir(t.join(sdk, 'platforms'))
    .map((d) => ({ d, api: Number(/^android-(\d+)/.exec(d)?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.api))
    .sort((a, b) => b.api - a.api);
  for (const { d, api } of found) {
    const jar = t.join(sdk, 'platforms', d, 'android.jar');
    if (t.exists(jar)) return { jar, api };
  }
  return null;
}

/** Where a JDK could be, in the order we try. */
export function jdkCandidates(e: ToolEnv): string[] {
  const t = tools(e);
  const out: string[] = [];
  if (e.env.JAVA_HOME) out.push(e.env.JAVA_HOME);
  if (e.platform === 'darwin') {
    const jh = t.run('/usr/libexec/java_home', []);
    if (jh && !/Unable to locate/i.test(jh)) out.push(jh.trim().split('\n')[0]);
    out.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
    for (const d of t.readdir('/Library/Java/JavaVirtualMachines').sort().reverse()) out.push(`/Library/Java/JavaVirtualMachines/${d}/Contents/Home`);
    for (const d of t.readdir(t.join(e.home, '.jdks')).sort().reverse()) out.push(t.join(e.home, '.jdks', d, 'Contents/Home'), t.join(e.home, '.jdks', d));
  } else if (t.win) {
    const pf = e.env.ProgramFiles ?? 'C:\\Program Files';
    out.push(t.join(pf, 'Android', 'Android Studio', 'jbr'));
    for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu']) for (const d of t.readdir(t.join(pf, vendor)).sort().reverse()) out.push(t.join(pf, vendor, d));
    for (const d of t.readdir(t.join(e.home, '.jdks')).sort().reverse()) out.push(t.join(e.home, '.jdks', d));
  } else {
    out.push(t.join(e.home, 'android-studio/jbr'), '/opt/android-studio/jbr', '/snap/android-studio/current/jbr');
    for (const d of t.readdir('/usr/lib/jvm').sort().reverse()) out.push(`/usr/lib/jvm/${d}`);
    for (const d of t.readdir(t.join(e.home, '.jdks')).sort().reverse()) out.push(t.join(e.home, '.jdks', d));
  }
  // Finally, whatever javac is on PATH.
  const pathVar = e.env.PATH ?? e.env.Path ?? '';
  for (const dir of pathVar.split(t.win ? ';' : ':')) if (dir && t.exists(t.join(dir, t.exe('javac')))) out.push(t.join(dir, '..'));
  return [...new Set(out)];
}

/** "javac 17.0.2" / "javac 1.8.0_392" -> 17 / 8. */
export function parseJavacVersion(text: string): number | null {
  const m = /javac\s+(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  const major = Number(m[1]);
  return major === 1 && m[2] ? Number(m[2]) : major;
}

/** The first JDK (11 or newer) with javac, java and keytool. */
export function findJdk(e: ToolEnv): { jdk: Jdk | null; tooOld: Jdk[] } {
  const t = tools(e);
  const tooOld: Jdk[] = [];
  for (const home of jdkCandidates(e)) {
    const bin = t.join(home, 'bin');
    const javac = t.join(bin, t.exe('javac'));
    const java = t.join(bin, t.exe('java'));
    const keytool = t.join(bin, t.exe('keytool'));
    if (![javac, java, keytool].every(t.exists)) continue;
    const version = parseJavacVersion(t.run(javac, ['-version']) ?? '') ?? 0;
    const jdk = { home: path.resolve(home), javac, java, keytool, version };
    if (version >= 11) return { jdk, tooOld };
    tooOld.push(jdk);
  }
  return { jdk: null, tooOld };
}

export const SDK_HELP = [
  'Install the Android SDK command-line tools (no Android Studio needed):',
  '  1. Download "Command line tools only" from https://developer.android.com/studio#command-tools',
  '     (macOS: `brew install --cask android-commandlinetools`)',
  '  2. sdkmanager "build-tools;35.0.0" "platforms;android-35" "platform-tools"',
  '  3. Point FireLab at it: export ANDROID_HOME=<the sdk folder>',
];

export const JDK_HELP = [
  'Install a JDK 17 (javac, keytool):',
  '  macOS: `brew install --cask temurin@17`   Debian/Ubuntu: `sudo apt install openjdk-17-jdk-headless`',
  '  Windows: https://adoptium.net/temurin/releases/?version=17',
  '  Then point FireLab at it: export JAVA_HOME=<the JDK folder> (Android Studio users: its bundled "jbr" folder works).',
];

/** Locates the whole toolchain and explains what is missing. */
export function locateToolchain(e: ToolEnv = defaultEnv(), overrides: { sdk?: string; javaHome?: string } = {}): ToolchainResult {
  const env: ToolEnv = overrides.javaHome ? { ...e, env: { ...e.env, JAVA_HOME: overrides.javaHome } } : e;
  const problems: string[] = [];
  const warnings: string[] = [];
  const partial: Partial<Toolchain> = {};
  const t = tools(env);
  const sdks = overrides.sdk ? [overrides.sdk] : sdkCandidates(env).filter((d) => t.exists(d));
  let bt: BuildTools | null = null;
  let pf: Platform | null = null;
  let sdk: string | undefined;
  for (const s of sdks) {
    bt = findBuildTools(s, env);
    pf = findPlatform(s, env);
    sdk = s;
    if (bt && pf) break;
  }
  if (!sdk) problems.push(`Android SDK not found (looked in ${sdkCandidates(env).join(', ')}).`, ...SDK_HELP);
  else {
    partial.sdk = sdk;
    if (!bt) problems.push(`No usable build-tools in ${t.join(sdk, 'build-tools')} (need aapt2, d8, zipalign, apksigner).`, `  Run: sdkmanager "build-tools;35.0.0"`);
    else partial.buildTools = bt;
    if (!pf) problems.push(`No platform android.jar in ${t.join(sdk, 'platforms')}.`, `  Run: sdkmanager "platforms;android-35"`);
    else partial.platform = pf;
  }
  const { jdk, tooOld } = findJdk(env);
  if (!jdk) {
    problems.push(tooOld.length ? `Only old JDKs found (${tooOld.map((j) => `${j.version} at ${j.home}`).join(', ')}); d8 and apksigner need 11+ (17 recommended).` : 'No JDK found (javac, java and keytool are needed).', ...JDK_HELP);
  } else {
    partial.jdk = jdk;
    if (jdk.version < 17) warnings.push(`JDK ${jdk.version} at ${jdk.home}: newer build-tools want JDK 17.`);
  }
  if (problems.length) return { ok: false, problems, warnings, partial };
  return { ok: true, toolchain: partial as Toolchain, warnings };
}
