/**
 * Builds the WebView wrapper APK with the plain SDK tools, no Gradle:
 * aapt2 (resources + manifest) -> javac -> d8 (dex) -> add classes.dex ->
 * zipalign -> apksigner. The approach is the one Sunset Villa ships with
 * (android/build.sh), generalised: name, package id, URL, art and version.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Toolchain } from './sdk.js';
import { appendToZip, listZip } from './zip.js';
import { imageSize, makeBanner, makeIcon } from './png.js';

export type Keystore = { path: string; storePass: string; keyAlias?: string; keyPass?: string };

export type WrapConfig = {
  url: string;
  name: string;
  packageId: string;
  out: string;
  versionName: string;
  versionCode: number;
  icon?: string;
  banner?: string;
  /** WebView debugging + android:debuggable (FireLab reads window.firelab over DevTools). */
  debug: boolean;
  /** Look for the server on the LAN when its address stops answering. */
  scan: boolean;
  scanPath?: string;
  background: string;
  keepScreenOn: boolean;
  keystore?: Keystore;
  userAgent: string;
  workDir?: string;
  keepWorkDir?: boolean;
  templateDir?: string;
};

export type BuildResult = {
  apk: string;
  packageId: string;
  versionName: string;
  versionCode: number;
  bytes: number;
  sha256: string;
  activity: string;
  signedWith: string;
  workDir?: string;
};

export const ACTIVITY = 'dev.firelab.wrap.MainActivity';

/** The android-template folder, from src/wrap or dist/wrap. */
export function templateDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../android-template', '../android-template', '../../../android-template']) {
    const dir = path.resolve(here, rel);
    if (fs.existsSync(path.join(dir, 'AndroidManifest.xml'))) return dir;
  }
  throw new Error(`android-template not found next to ${here}`);
}

const JAVA_KEYWORDS = new Set(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield'.split(' '),
);

/** Problems with an Android application id, or null when it is valid. */
export function packageIdProblem(id: string): string | null {
  const parts = id.split('.');
  if (parts.length < 2) return 'needs at least two segments, e.g. com.example.game';
  for (const p of parts) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(p)) return `segment "${p}" must start with a letter and use only letters, digits and _`;
    if (JAVA_KEYWORDS.has(p)) return `segment "${p}" is a Java keyword`;
  }
  if (id.length > 150) return 'is too long';
  return null;
}

/** "Firefly Lake!" -> "fireflylake" (a package-id segment). */
export function slug(name: string): string {
  let s = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 30);
  if (!s) s = 'app';
  if (!/^[a-z]/.test(s)) s = `app${s}`;
  if (JAVA_KEYWORDS.has(s)) s = `${s}app`;
  return s;
}

/** "1.2.3" -> 10203; anything unparsable -> 1. */
export function versionCodeFor(versionName: string): number {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(versionName.trim());
  if (!m) return 1;
  const code = Number(m[1]) * 10000 + Number(m[2] ?? 0) * 100 + Number(m[3] ?? 0);
  return Math.max(1, Math.min(2100000000, code));
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Escapes text for an Android string resource (aapt2 treats ' " \ @ ? specially). */
export function androidString(s: string): string {
  let out = xmlEscape(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/&quot;/g, '\\"');
  if (/^[@?]/.test(out)) out = `\\${out}`;
  return out;
}

/** Fills the manifest template. */
export function renderManifest(template: string, c: Pick<WrapConfig, 'packageId' | 'versionName' | 'versionCode' | 'debug'>): string {
  const values: Record<string, string> = {
    package: c.packageId,
    versionCode: String(c.versionCode),
    versionName: xmlEscape(c.versionName),
    debuggable: c.debug ? 'true' : 'false',
  };
  const out = template.replace(/\{\{(package|versionCode|versionName|debuggable)\}\}/g, (_, k: string) => values[k]);
  const left = /=\s*"[^"]*\{\{\w+\}\}[^"]*"/.exec(out);
  if (left) throw new Error(`unfilled placeholder in the manifest template: ${left[0]}`);
  return out;
}

/** The JSON the app reads from assets/firelab.json. */
export function appConfig(c: WrapConfig): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    url: c.url,
    name: c.name,
    scan: c.scan,
    debug: c.debug,
    keepScreenOn: c.keepScreenOn,
    background: c.background,
    userAgent: c.userAgent,
  };
  if (c.scanPath) cfg.scanPath = c.scanPath;
  return cfg;
}

type Logger = (line: string) => void;

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(cmd);
    const child = spawn(cmd, args, { env, cwd, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => reject(new Error(`${path.basename(cmd)} could not start: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} failed (exit ${code}):\n${out.trim().split('\n').slice(-25).join('\n')}`));
    });
  });
}

function findFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/** Uses ~/.android/debug.keystore (shared with Android Studio) or creates ~/.firelab/debug.keystore. */
export async function debugKeystore(tc: Toolchain, env: NodeJS.ProcessEnv, log: Logger): Promise<Keystore> {
  const android = path.join(os.homedir(), '.android', 'debug.keystore');
  const ks: Keystore = { path: android, storePass: 'pass:android', keyAlias: 'androiddebugkey', keyPass: 'pass:android' };
  if (fs.existsSync(android)) return ks;
  const own = path.join(process.env.FIRELAB_HOME || path.join(os.homedir(), '.firelab'), 'debug.keystore');
  if (!fs.existsSync(own)) {
    fs.mkdirSync(path.dirname(own), { recursive: true });
    log(`- creating a debug signing key at ${own}`);
    await run(
      tc.jdk.keytool,
      ['-genkeypair', '-keystore', own, '-storepass', 'android', '-alias', 'androiddebugkey', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US'],
      env,
    );
  }
  return { ...ks, path: own };
}

/** apksigner wants pass:/env:/file: prefixes; a bare value is taken as a literal password. */
export function passArg(v: string): string {
  return /^(pass|env|file|stdin):/.test(v) || v === 'stdin' ? v : `pass:${v}`;
}

/** Builds and signs the APK. */
export async function buildApk(c: WrapConfig, tc: Toolchain, log: Logger = () => {}): Promise<BuildResult> {
  const tpl = c.templateDir ?? templateDir();
  const work = c.workDir ? path.resolve(c.workDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-wrap-'));
  fs.mkdirSync(work, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JAVA_HOME: tc.jdk.home,
    PATH: `${path.join(tc.jdk.home, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const bt = tc.buildTools;
  try {
    // ---- stage the project ----
    const res = path.join(work, 'res');
    const assets = path.join(work, 'assets');
    for (const d of ['res/values', 'res/drawable-xhdpi', 'res/drawable-xxxhdpi', 'assets', 'gen', 'classes', 'dex']) fs.mkdirSync(path.join(work, d), { recursive: true });
    fs.writeFileSync(path.join(work, 'AndroidManifest.xml'), renderManifest(fs.readFileSync(path.join(tpl, 'AndroidManifest.xml'), 'utf8'), c));
    fs.writeFileSync(path.join(res, 'values', 'strings.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <string name="app_name">${androidString(c.name)}</string>\n</resources>\n`);
    fs.writeFileSync(path.join(assets, 'firelab.json'), `${JSON.stringify(appConfig(c), null, 2)}\n`);
    const art = (file: string | undefined, kind: 'banner' | 'icon', dir: string) => {
      if (!file) {
        fs.writeFileSync(path.join(res, dir, `${kind}.png`), kind === 'banner' ? makeBanner(c.name) : makeIcon(c.name));
        return;
      }
      const buf = fs.readFileSync(file);
      const size = imageSize(buf);
      if (!size) throw new Error(`${file}: the ${kind} must be a PNG or JPEG image`);
      if (kind === 'banner' && Math.abs(size.width / size.height - 16 / 9) > 0.02) log(`  warning: the banner is ${size.width}x${size.height}; Fire TV expects 16:9 (320x180)`);
      if (kind === 'banner' && size.width < 320) log(`  warning: the banner is ${size.width}x${size.height}; 320x180 or larger looks best`);
      fs.writeFileSync(path.join(res, dir, `${kind}.${size.type}`), buf);
    };
    art(c.banner, 'banner', 'drawable-xhdpi');
    art(c.icon, 'icon', 'drawable-xxxhdpi');

    // ---- resources and manifest ----
    log(`- resources (aapt2, build-tools ${bt.version}, android-${tc.platform.api})`);
    await run(bt.aapt2, ['compile', '--dir', res, '-o', path.join(work, 'res.zip')], env);
    const unsigned = path.join(work, 'unsigned.apk');
    await run(
      bt.aapt2,
      ['link', '-I', tc.platform.jar, '--manifest', path.join(work, 'AndroidManifest.xml'), '-A', assets, '--java', path.join(work, 'gen'), '--custom-package', 'dev.firelab.wrap', '-o', unsigned, path.join(work, 'res.zip')],
      env,
    );

    // ---- code ----
    log(`- java (javac ${tc.jdk.version}, d8)`);
    const sources = [...findFiles(path.join(tpl, 'src'), '.java'), ...findFiles(path.join(work, 'gen'), '.java')];
    await run(
      tc.jdk.javac,
      ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-Xlint:-options', '-nowarn', '-bootclasspath', tc.platform.jar, '-classpath', tc.platform.jar, '-d', path.join(work, 'classes'), ...sources],
      env,
    );
    const classes = findFiles(path.join(work, 'classes'), '.class');
    await run(bt.d8, ['--release', '--min-api', '22', '--lib', tc.platform.jar, '--output', path.join(work, 'dex'), ...classes], env);
    const dex = fs.readFileSync(path.join(work, 'dex', 'classes.dex'));
    fs.writeFileSync(unsigned, appendToZip(fs.readFileSync(unsigned), [{ name: 'classes.dex', data: dex }]));

    // ---- align and sign ----
    log('- align and sign (zipalign, apksigner)');
    const aligned = path.join(work, 'aligned.apk');
    await run(bt.zipalign, ['-f', '-p', '4', unsigned, aligned], env);
    const ks = c.keystore ?? (await debugKeystore(tc, env, log));
    const out = path.resolve(c.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const signArgs = ['sign', '--ks', ks.path, '--ks-pass', passArg(ks.storePass)];
    if (ks.keyAlias) signArgs.push('--ks-key-alias', ks.keyAlias);
    if (ks.keyPass) signArgs.push('--key-pass', passArg(ks.keyPass));
    signArgs.push('--out', out, aligned);
    await run(bt.apksigner, signArgs, env);
    await run(bt.apksigner, ['verify', out], env);
    try {
      fs.rmSync(`${out}.idsig`, { force: true }); // v4 signature side file: not needed for adb install
    } catch {
      /* ignore */
    }

    const bytes = fs.readFileSync(out);
    const names = listZip(bytes);
    for (const must of ['AndroidManifest.xml', 'classes.dex', 'resources.arsc', 'assets/firelab.json']) {
      if (!names.includes(must)) throw new Error(`built APK is missing ${must}`);
    }
    return {
      apk: out,
      packageId: c.packageId,
      versionName: c.versionName,
      versionCode: c.versionCode,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      activity: ACTIVITY,
      signedWith: ks.path,
      workDir: c.keepWorkDir ? work : undefined,
    };
  } finally {
    if (!c.keepWorkDir && !c.workDir) fs.rmSync(work, { recursive: true, force: true });
  }
}
