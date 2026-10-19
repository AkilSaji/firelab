/**
 * The I/O side of the lab: where the SDK and its tools are, which system
 * images are installed, the AVD files, and the emulator process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { sdkCandidates, findJdk, type ToolEnv } from '../wrap/sdk.js';
import { dataDir, ensureDir } from '../lib/paths.js';
import { sleep } from '../lib/util.js';
import { avdConfig, avdPointerIni, imageSysdir, parseIni, renderIni, type LabSpec, type SystemImage, parseImagePackage } from './spec.js';

export type LabEnv = ToolEnv;

export function labEnv(): LabEnv {
  return { env: process.env, platform: process.platform, home: os.homedir() };
}

const exists = (e: LabEnv, f: string) => (e.exists ? e.exists(f) : fs.existsSync(f));
const exe = (e: LabEnv, name: string) => (e.platform === 'win32' ? `${name}.exe` : name);
const bat = (e: LabEnv, name: string) => (e.platform === 'win32' ? `${name}.bat` : name);

export type SdkTools = {
  sdk: string | null;
  emulator: string | null;
  adb: string | null;
  sdkmanager: string | null;
  avdmanager: string | null;
};

/** The first SDK folder that exists, and the tools in it. */
export function findSdk(e: LabEnv = labEnv(), override?: string): SdkTools {
  const candidates = override ? [override] : sdkCandidates(e);
  const sdk = candidates.find((d) => exists(e, d)) ?? null;
  if (!sdk) return { sdk: null, emulator: null, adb: null, sdkmanager: null, avdmanager: null };
  const j = e.platform === 'win32' ? path.win32.join : path.posix.join;
  const first = (...files: string[]) => files.find((f) => exists(e, f)) ?? null;
  return {
    sdk,
    emulator: first(j(sdk, 'emulator', exe(e, 'emulator'))),
    adb: first(j(sdk, 'platform-tools', exe(e, 'adb'))),
    sdkmanager: first(j(sdk, 'cmdline-tools', 'latest', 'bin', bat(e, 'sdkmanager')), j(sdk, 'tools', 'bin', bat(e, 'sdkmanager'))),
    avdmanager: first(j(sdk, 'cmdline-tools', 'latest', 'bin', bat(e, 'avdmanager')), j(sdk, 'tools', 'bin', bat(e, 'avdmanager'))),
  };
}

/** Where AVDs live: $ANDROID_AVD_HOME, $ANDROID_USER_HOME/avd, $ANDROID_EMULATOR_HOME/avd or ~/.android/avd. */
export function avdHome(e: LabEnv = labEnv()): string {
  if (e.env.ANDROID_AVD_HOME) return e.env.ANDROID_AVD_HOME;
  if (e.env.ANDROID_USER_HOME) return path.join(e.env.ANDROID_USER_HOME, 'avd');
  if (e.env.ANDROID_EMULATOR_HOME) return path.join(e.env.ANDROID_EMULATOR_HOME, 'avd');
  return path.join(e.home, '.android', 'avd');
}

/** Installed system images (folders with a system.img or system partition). */
export function installedImages(sdk: string): SystemImage[] {
  const out: SystemImage[] = [];
  const root = path.join(sdk, 'system-images');
  const ls = (d: string) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  for (const a of ls(root)) for (const t of ls(path.join(root, a))) for (const abi of ls(path.join(root, a, t))) {
    const img = parseImagePackage(`system-images;${a};${t};${abi}`);
    const dir = path.join(root, a, t, abi);
    if (img && (fs.existsSync(path.join(dir, 'system.img')) || fs.existsSync(path.join(dir, 'source.properties')))) out.push(img);
  }
  return out;
}

export function imageInstalled(sdk: string, image: SystemImage): boolean {
  return fs.existsSync(path.join(sdk, imageSysdir(image)));
}

export type LabMeta = {
  firelab: 1;
  name: string;
  model: string;
  modelName: string;
  fireOs?: string;
  api: number;
  image: string;
  imageWhy: string;
  ramMB: number;
  heapMB: number;
  width: number;
  height: number;
  density: number;
  budgetMB?: number;
  limitMB?: number;
  gpu?: string;
  createdAt: string;
  notes: string[];
};

export function metaFromSpec(spec: LabSpec, imagePkg: string, now = new Date()): LabMeta {
  return {
    firelab: 1,
    name: spec.name,
    model: spec.model,
    modelName: spec.modelName,
    ...(spec.fireOs ? { fireOs: spec.fireOs } : {}),
    api: spec.image.api,
    image: imagePkg,
    imageWhy: spec.imageWhy,
    ramMB: spec.ramMB.value,
    heapMB: spec.heapMB.value,
    width: spec.width.value,
    height: spec.height.value,
    density: spec.density.value,
    ...(spec.budgetMB !== undefined ? { budgetMB: spec.budgetMB } : {}),
    ...(spec.limitMB !== undefined ? { limitMB: spec.limitMB } : {}),
    ...(spec.gpu ? { gpu: spec.gpu } : {}),
    createdAt: now.toISOString(),
    notes: spec.notes,
  };
}

/** Writes <home>/<name>.ini and <home>/<name>.avd/{config.ini,firelab.json}. */
export function writeAvd(spec: LabSpec, imagePkg: string, home: string, opts: { force?: boolean; headless?: boolean } = {}): { dir: string; config: string } {
  const dir = path.join(home, `${spec.name}.avd`);
  const pointer = path.join(home, `${spec.name}.ini`);
  if ((fs.existsSync(dir) || fs.existsSync(pointer)) && !opts.force) {
    throw new Error(`An AVD named ${spec.name} already exists (${dir}). Add --force to replace it, or --name to pick another name.`);
  }
  if (opts.force) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(pointer, { force: true });
  }
  ensureDir(dir);
  const config = path.join(dir, 'config.ini');
  fs.writeFileSync(config, renderIni(avdConfig(spec, { headless: opts.headless })));
  fs.writeFileSync(path.join(dir, 'firelab.json'), `${JSON.stringify(metaFromSpec(spec, imagePkg), null, 2)}\n`);
  fs.writeFileSync(pointer, renderIni(avdPointerIni(spec, dir)));
  return { dir, config };
}

export type AvdEntry = { name: string; dir: string; config: Map<string, string>; meta?: LabMeta };

export function listAvds(home: string): AvdEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(home).filter((f) => f.endsWith('.ini'));
  } catch {
    return [];
  }
  const out: AvdEntry[] = [];
  for (const f of names.sort()) {
    const name = f.slice(0, -4);
    const ptr = parseIni(fs.readFileSync(path.join(home, f), 'utf8'));
    const dir = ptr.get('path') && fs.existsSync(ptr.get('path') as string) ? (ptr.get('path') as string) : path.join(home, `${name}.avd`);
    let config = new Map<string, string>();
    try {
      config = parseIni(fs.readFileSync(path.join(dir, 'config.ini'), 'utf8'));
    } catch {
      /* broken AVD: listed without config */
    }
    let meta: LabMeta | undefined;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'firelab.json'), 'utf8')) as LabMeta;
    } catch {
      /* not a FireLab lab */
    }
    out.push({ name, dir, config, ...(meta ? { meta } : {}) });
  }
  return out;
}

export function deleteAvd(home: string, name: string): boolean {
  const dir = path.join(home, `${name}.avd`);
  const had = fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(home, `${name}.ini`), { force: true });
  return had;
}

export function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: opts.timeoutMs ?? 30000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: opts.env ?? process.env }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: unknown }).code !== undefined && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (err ? String(err.message) : '') });
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** `emulator -accel-check`: 0 = hardware acceleration usable. */
export async function accelCheck(emulator: string): Promise<{ ok: boolean; detail: string }> {
  const r = await run(emulator, ['-accel-check'], { timeoutMs: 20000 });
  const text = `${r.stdout}\n${r.stderr}`.trim();
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && l !== 'accel:' && l !== 'accel');
  const ok = r.code === 0 || /^0$/m.test(text);
  return { ok, detail: lines.filter((l) => l !== '0').join(' ') || (ok ? 'available' : 'not available') };
}

export async function emulatorVersion(emulator: string): Promise<string | null> {
  const r = await run(emulator, ['-version'], { timeoutMs: 20000 });
  return /version ([\d.]+)/.exec(r.stdout)?.[1] ?? null;
}

/** JAVA_HOME for sdkmanager (it needs Java 17+). */
export function javaHomeFor(e: LabEnv = labEnv()): string | undefined {
  const { jdk } = findJdk(e);
  return jdk?.home;
}

export type RunningEmulator = { serial: string; port: number; state: string; avd?: string };

export async function runningEmulators(adb: string): Promise<RunningEmulator[]> {
  const r = await run(adb, ['devices'], { timeoutMs: 15000 });
  const out: RunningEmulator[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^(emulator-(\d+))\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    const e: RunningEmulator = { serial: m[1] as string, port: Number(m[2]), state: m[3] as string };
    const name = await run(adb, ['-s', e.serial, 'emu', 'avd', 'name'], { timeoutMs: 8000 });
    const avd = name.stdout.split('\n').map((l) => l.trim()).find((l) => l && l !== 'OK');
    if (avd) e.avd = avd;
    out.push(e);
  }
  return out;
}

export function labLogDir(): string {
  return ensureDir(path.join(dataDir(), 'lab'));
}

/** Starts the emulator detached; its output goes to ~/.firelab/lab/<name>.log. */
export function spawnEmulator(emulator: string, args: string[], name: string, env: NodeJS.ProcessEnv = process.env): { pid: number | undefined; log: string } {
  const log = path.join(labLogDir(), `${name}.log`);
  const fd = fs.openSync(log, 'w');
  const child = spawn(emulator, args, { detached: true, stdio: ['ignore', fd, fd], env });
  child.unref();
  fs.closeSync(fd);
  return { pid: child.pid, log };
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tail(file: string, lines = 15): string {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Waits until the emulator's Android has booted (sys.boot_completed=1 and
 * the package manager answers). Fails early when the emulator process dies.
 */
export async function waitForBoot(adb: string, serial: string, opts: { timeoutMs: number; pid?: number; log?: string; onTick?: (s: string) => void }): Promise<{ ms: number }> {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < opts.timeoutMs) {
    if (!processAlive(opts.pid)) {
      throw new Error(`The emulator exited during boot.${opts.log ? `\nLast lines of ${opts.log}:\n${tail(opts.log)}` : ''}`);
    }
    const r = await run(adb, ['-s', serial, 'shell', 'getprop sys.boot_completed; getprop init.svc.bootanim'], { timeoutMs: 10000 });
    const [boot, anim] = r.stdout.split('\n').map((s) => s.trim());
    const state = r.code === 0 ? (boot === '1' ? 'booted' : `booting${anim ? ` (bootanim ${anim})` : ''}`) : 'starting';
    if (state !== last) opts.onTick?.(state);
    last = state;
    if (boot === '1') {
      const pm = await run(adb, ['-s', serial, 'shell', 'pm path android'], { timeoutMs: 15000 });
      if (pm.code === 0 && pm.stdout.includes('package:')) return { ms: Date.now() - t0 };
    }
    await sleep(2000);
  }
  throw new Error(`The emulator did not finish booting in ${Math.round(opts.timeoutMs / 1000)} s.${opts.log ? `\nLast lines of ${opts.log}:\n${tail(opts.log)}` : ''}`);
}

/** Settles a freshly booted emulator for testing: screen on, unlocked, never sleeps, no animations. */
export async function prepareForTests(adb: string, serial: string): Promise<void> {
  const cmds = [
    'settings put global window_animation_scale 0',
    'settings put global transition_animation_scale 0',
    'settings put global animator_duration_scale 0',
    'settings put system screen_off_timeout 2147483647',
    'settings put secure screensaver_enabled 0',
    // Phone images show a "Viewing full screen" dialog over immersive apps.
    'settings put secure immersive_mode_confirmations confirmed',
    'svc power stayon true',
    'input keyevent KEYCODE_WAKEUP',
    'wm dismiss-keyguard',
  ];
  await run(adb, ['-s', serial, 'shell', cmds.join('; ')], { timeoutMs: 20000 });
}

export async function killEmulator(adb: string, serial: string): Promise<boolean> {
  const r = await run(adb, ['-s', serial, 'emu', 'kill'], { timeoutMs: 15000 });
  return r.code === 0;
}
