/**
 * `firelab lab`: Fire-TV-shaped Android emulators, for testing without a
 * Fire TV (and in CI).
 *
 *   firelab lab doctor
 *   firelab lab create --profile AFTSSS [--install]
 *   firelab lab start firelab-AFTSSS [--headless]
 *   firelab lab smoke --apk app.apk
 *   firelab lab stop firelab-AFTSSS
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { FireLab } from '../core/firelab.js';
import { errorMessage } from '../lib/errors.js';
import { loadProfiles, defaultProfilesDir } from '../profile/load.js';
import { buildTargets } from '../fit/targets.js';
import { compareVersions } from '../wrap/sdk.js';
import type { FitTarget } from '../fit/types.js';
import type { DeviceProfile } from '../profile/types.js';
import { avdNameFor, chooseImage, emulatorArgs, freePort, hostAbi, imagePackage, labSpec, sdkPackages, serialFor, type LabSpec, type SystemImage } from './spec.js';
import {
  accelCheck,
  avdHome,
  deleteAvd,
  emulatorVersion,
  findSdk,
  imageInstalled,
  javaHomeFor,
  killEmulator,
  labEnv,
  listAvds,
  prepareForTests,
  runningEmulators,
  spawnEmulator,
  waitForBoot,
  writeAvd,
  type AvdEntry,
  type LabEnv,
  type LabMeta,
  type SdkTools,
} from './sdk.js';
import { runSmoke } from './smoke.js';
import { HONESTY, smokeHtml, smokeMarkdown } from './report.js';

export const LAB_HELP = `firelab lab: Fire-TV-shaped Android emulators (no Fire TV needed)

Usage:
  firelab lab doctor [--profile <model>]       check the SDK, emulator, acceleration and system images; prints install commands
  firelab lab create --profile <model> [options]
  firelab lab start [<name>] [--headless] [--timeout 600] [--port 5554] [--wipe] [--cold] [--gpu <mode>]
  firelab lab stop [<name>|<serial>|--all]
  firelab lab list
  firelab lab delete <name> --yes
  firelab lab smoke (--apk <file.apk> | --package <id>) [-d <serial>] [--out <dir>] [--settle 10] [--max-launch-ms 5000] [--summary <file.md>]

Models: AFTSSS (Fire TV Stick 3rd gen, 1 GB, Fire OS 7), AFTMA08C15 (Fire TV Stick 4K Plus, 2 GB, Fire OS 8),
and every other model in \`firelab fit\`'s table (\`firelab lab create --list-models\`).

create options:
  --profile <model>    the Fire TV model to imitate (its profile in profiles/ if there is one)
  --name <name>        AVD name (default firelab-<model>)
  --install            download a missing system image with sdkmanager (it asks you to accept Google's licence)
  --image <package>    use this system image, e.g. "system-images;android-30;google_apis;x86_64"
  --prefer-tv          take the nearest Android TV image when none exists at the model's API level
  --api <n> --ram <MB> --heap <MB> --density <dpi>   override what the profile says
  --headless           configure for CI (SwiftShader GPU)
  --force              replace an existing AVD with that name
  --dry-run            print the config without writing anything
  --sdk <dir>          Android SDK folder (default $ANDROID_HOME, ~/Library/Android/sdk, ~/Android/Sdk)

Honest limits: ${HONESTY}`;

type Out = { log: (s: string) => void; err: (s: string) => void };
const defaultOut: Out = { log: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) };

const OPTIONS = {
  profile: { type: 'string' },
  name: { type: 'string' },
  install: { type: 'boolean' },
  image: { type: 'string' },
  'prefer-tv': { type: 'boolean' },
  api: { type: 'string' },
  ram: { type: 'string' },
  heap: { type: 'string' },
  density: { type: 'string' },
  headless: { type: 'boolean' },
  force: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  sdk: { type: 'string' },
  profiles: { type: 'string' },
  'list-models': { type: 'boolean' },
  timeout: { type: 'string' },
  port: { type: 'string' },
  wipe: { type: 'boolean' },
  cold: { type: 'boolean' },
  gpu: { type: 'string' },
  all: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  apk: { type: 'string' },
  package: { type: 'string', short: 'p' },
  url: { type: 'string' },
  out: { type: 'string', short: 'o' },
  settle: { type: 'string' },
  'max-launch-ms': { type: 'string' },
  summary: { type: 'string' },
  device: { type: 'string', short: 'd' },
  adb: { type: 'string' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string };

class UsageError extends Error {}

const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) throw new UsageError(`--${name} must be a positive number`);
  return x;
};

export function quoteArg(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function commandLine(cmd: string, args: string[]): string {
  return [cmd, ...args].map(quoteArg).join(' ');
}

/** The model's fit target and profile, or a helpful error. */
export function resolveModel(model: string, profileDirs?: string[]): { target: FitTarget; profile?: DeviceProfile } {
  const { profiles } = loadProfiles(profileDirs ?? [defaultProfilesDir()]);
  const targets = buildTargets(profiles);
  const t = targets.find((x) => x.model.toLowerCase() === model.toLowerCase());
  if (!t) throw new UsageError(`Unknown model "${model}". Known: ${targets.map((x) => x.model).join(', ')}`);
  const profile = [...profiles.values()].find((p) => p.model.toLowerCase() === t.model.toLowerCase());
  return { target: t, ...(profile ? { profile } : {}) };
}

export type DoctorCheck = { name: string; ok: boolean | 'warn'; detail: string; fix?: string[] };

function sdkInstallHelp(e: LabEnv): string[] {
  if (e.platform === 'darwin') {
    return [
      'Install Android Studio (https://developer.android.com/studio), open it once and let it install the SDK, or: brew install --cask android-commandlinetools',
      'Then: export ANDROID_HOME="$HOME/Library/Android/sdk"   (Homebrew: /opt/homebrew/share/android-commandlinetools)',
    ];
  }
  if (e.platform === 'win32') return ['Install Android Studio (https://developer.android.com/studio) and open it once; the SDK goes to %LOCALAPPDATA%\\Android\\Sdk.'];
  return [
    'mkdir -p ~/Android/Sdk/cmdline-tools && cd ~/Android/Sdk/cmdline-tools',
    'curl -fLo tools.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip && unzip -q tools.zip && mv cmdline-tools latest && rm tools.zip',
    'export ANDROID_HOME=~/Android/Sdk',
  ];
}

/** Checks for `firelab lab doctor`. Never installs anything. */
export async function labDoctorChecks(e: LabEnv, opts: { sdk?: string; models?: string[]; profileDirs?: string[] } = {}): Promise<{ checks: DoctorCheck[]; tools: SdkTools }> {
  const checks: DoctorCheck[] = [];
  const tools = findSdk(e, opts.sdk);
  if (!tools.sdk) {
    checks.push({ name: 'Android SDK', ok: false, detail: 'not found', fix: sdkInstallHelp(e) });
    return { checks, tools };
  }
  checks.push({ name: 'Android SDK', ok: true, detail: tools.sdk });
  const sm = tools.sdkmanager ? quoteArg(tools.sdkmanager) : null;
  const javaHome = javaHomeFor(e);
  if (!tools.sdkmanager) {
    checks.push({ name: 'sdkmanager', ok: false, detail: 'cmdline-tools not installed', fix: ['Android Studio > Settings > Android SDK > SDK Tools > tick "Android SDK Command-line Tools (latest)"', ...(e.platform === 'darwin' ? ['or: brew install --cask android-commandlinetools'] : sdkInstallHelp(e).slice(0, 2))] });
  } else {
    checks.push({ name: 'sdkmanager', ok: javaHome || e.env.JAVA_HOME ? true : 'warn', detail: `${tools.sdkmanager}${javaHome ? ` (Java at ${javaHome})` : ''}`, fix: javaHome || e.env.JAVA_HOME ? undefined : ['sdkmanager needs Java 17+: install Temurin 17 (https://adoptium.net) or point JAVA_HOME at Android Studio\'s bundled "jbr" folder.'] });
  }
  const licensed = fs.existsSync(path.join(tools.sdk, 'licenses', 'android-sdk-license'));
  checks.push({ name: 'SDK licences', ok: licensed ? true : 'warn', detail: licensed ? 'accepted' : 'not accepted yet', fix: licensed ? undefined : [`Read and accept them yourself: ${sm ?? 'sdkmanager'} --licenses`] });
  if (!tools.emulator) checks.push({ name: 'Emulator', ok: false, detail: 'not installed', fix: [`${sm ?? 'sdkmanager'} --install emulator`] });
  else {
    const v = await emulatorVersion(tools.emulator);
    checks.push({ name: 'Emulator', ok: true, detail: `${v ?? 'unknown version'} at ${tools.emulator}` });
  }
  if (!tools.adb) checks.push({ name: 'adb', ok: false, detail: 'platform-tools not installed', fix: [`${sm ?? 'sdkmanager'} --install platform-tools`] });
  else checks.push({ name: 'adb', ok: true, detail: tools.adb });

  // Hardware acceleration.
  if (e.platform === 'linux') {
    let kvm: string | null = null;
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
      kvm = fs.existsSync('/dev/kvm') ? 'no permission on /dev/kvm' : '/dev/kvm missing';
      void err;
    }
    checks.push({
      name: 'KVM',
      ok: kvm ? false : true,
      detail: kvm ?? '/dev/kvm usable',
      fix: kvm
        ? kvm.includes('permission')
          ? ['sudo usermod -aG kvm "$USER"  (then log out and in)', 'GitHub Actions: echo \'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"\' | sudo tee /etc/udev/rules.d/99-kvm4all.rules && sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=kvm']
          : ['Enable virtualization (VT-x/AMD-V) in the BIOS, then: sudo apt-get install -y qemu-kvm', 'Cloud VMs need nested virtualization; GitHub\'s ubuntu-latest runners have KVM.']
        : undefined,
    });
  } else if (tools.emulator) {
    const a = await accelCheck(tools.emulator);
    checks.push({
      name: e.platform === 'darwin' ? 'Hypervisor.framework' : 'Acceleration',
      ok: a.ok,
      detail: a.detail,
      fix: a.ok ? undefined : e.platform === 'darwin' ? ['macOS on a virtual machine has no nested Hypervisor.framework; use a real Mac.'] : ['Enable Windows Hypervisor Platform (Windows Features) or install the Android Emulator hypervisor driver with sdkmanager.'],
    });
  }

  // System images for the models.
  const host = hostAbi(process.arch);
  const models = opts.models?.length ? opts.models : ['AFTSSS', 'AFTMA08C15'];
  for (const m of models) {
    let spec: LabSpec;
    try {
      const { target, profile } = resolveModel(m, opts.profileDirs);
      spec = labSpec(target, profile, { host });
    } catch (err) {
      checks.push({ name: `Image for ${m}`, ok: false, detail: errorMessage(err) });
      continue;
    }
    const pkg = imagePackage(spec.image);
    const have = imageInstalled(tools.sdk, spec.image);
    checks.push({
      name: `Image for ${spec.model}`,
      ok: have ? true : 'warn',
      detail: `${pkg} ${have ? 'installed' : 'not installed'} (API ${spec.api.value}${spec.tvImage ? ', Android TV' : ', phone image with TV hardware'})`,
      fix: have ? undefined : [`firelab lab create --profile ${spec.model} --install`, `or: ${sm ?? 'sdkmanager'} --install ${quoteArg(pkg)}   (about 1 GB)`],
    });
  }
  const labs = listAvds(avdHome(e)).filter((a) => a.meta);
  checks.push({ name: 'Labs', ok: true, detail: labs.length ? labs.map((a) => a.name).join(', ') : `none yet (${avdHome(e)})` });
  return { checks, tools };
}

function printChecks(out: Out, checks: DoctorCheck[]): void {
  for (const ch of checks) {
    const mark = ch.ok === true ? '[ok]' : ch.ok === 'warn' ? '[!!]' : '[XX]';
    out.log(`${mark} ${ch.name}: ${ch.detail}`);
    for (const f of ch.fix ?? []) out.log(`     ${f}`);
  }
}

function describeSpec(spec: LabSpec, pkg: string): string[] {
  const src = (s: { source: string; note?: string }) => `${s.source}${s.note ? `: ${s.note}` : ''}`;
  return [
    `Lab ${spec.name}: shaped like the ${spec.model} (${spec.modelName})`,
    `  image    ${pkg}  (${spec.imageWhy})`,
    `  API      ${spec.api.value}${spec.fireOs ? ` = Fire OS ${spec.fireOs}` : ''}  [${src(spec.api)}]`,
    `  RAM      ${spec.ramMB.value} MB  [${src(spec.ramMB)}]`,
    `  heap     ${spec.heapMB.value} MB  [${src(spec.heapMB)}]`,
    `  screen   ${spec.width.value}x${spec.height.value} @ ${spec.density.value} dpi  [${src(spec.density)}]`,
    `  CPU      ${spec.cores.value} cores  [${src(spec.cores)}]`,
    ...(spec.budgetMB !== undefined ? [`  budget   app memory ${spec.budgetMB} MB comfortable, ${spec.limitMB ?? '?'} MB hard limit (checked by \`lab smoke\`)`] : []),
    ...spec.notes.map((n) => `  note     ${n}`),
  ];
}

async function sdkmanagerInstall(tools: SdkTools, packages: string[], e: LabEnv, out: Out): Promise<number> {
  if (!tools.sdkmanager) throw new Error('sdkmanager is not installed: run `firelab lab doctor` for the install steps');
  const javaHome = e.env.JAVA_HOME ?? javaHomeFor(e);
  out.err(`Running: ${commandLine(tools.sdkmanager, ['--install', ...packages])}`);
  out.err('(sdkmanager may ask you to accept Google\'s Android SDK licence: read it and answer y to continue.)');
  return new Promise((resolve) => {
    const child = spawn(tools.sdkmanager as string, ['--install', ...packages], { stdio: 'inherit', env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) } });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

function labByName(e: LabEnv, name: string | undefined): AvdEntry {
  const all = listAvds(avdHome(e));
  if (name) {
    const a = all.find((x) => x.name === name) ?? all.find((x) => x.name === avdNameFor(name));
    if (!a) throw new UsageError(`No AVD named "${name}". Run \`firelab lab list\`, or \`firelab lab create --profile ${name}\`.`);
    return a;
  }
  const labs = all.filter((a) => a.meta);
  if (labs.length === 1) return labs[0] as AvdEntry;
  if (!labs.length) throw new UsageError('No labs yet: run `firelab lab create --profile AFTSSS`');
  throw new UsageError(`Which lab? ${labs.map((a) => a.name).join(', ')}`);
}

/** What the booted emulator didn't take from the lab config (the emulator enforces a minimum RAM on newer images). */
export function bootWarnings(meta: LabMeta | undefined, ramMB: number | undefined, sdk: number | undefined): string[] {
  if (!meta) return [];
  const w: string[] = [];
  if (ramMB && ramMB > meta.ramMB * 1.1) {
    w.push(`the emulator raised RAM to ${ramMB} MB (the ${meta.model} has ${meta.ramMB} MB): this image has a higher minimum. Memory pressure (low-memory kills) won't match; \`lab smoke\` still checks app memory against the ${meta.model}'s budget. Use an image at the model's own API level for a closer match.`);
  }
  if (sdk && sdk !== meta.api) w.push(`the device reports API ${sdk}, the lab was made for API ${meta.api}`);
  return w;
}

function metaFor(e: LabEnv, avd: string | undefined): LabMeta | undefined {
  if (!avd) return undefined;
  return listAvds(avdHome(e)).find((a) => a.name === avd)?.meta;
}

export async function runLab(argv: string[], out: Out = defaultOut, e: LabEnv = labEnv()): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    out.log(LAB_HELP);
    return sub ? 0 : 2;
  }
  let v: Values;
  let pos: string[];
  try {
    const parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
    v = parsed.values as Values;
    pos = parsed.positionals;
  } catch (err) {
    out.err((err as Error).message);
    out.err('Run `firelab lab help` for usage.');
    return 2;
  }
  if (v.help) {
    out.log(LAB_HELP);
    return 0;
  }
  const json = !!v.json;
  const say = (s: string) => (json ? out.err(s) : out.log(s));
  const profileDirs = [defaultProfilesDir(), ...(v.profiles ? [v.profiles] : [])];
  try {
    switch (sub) {
      case 'doctor': {
        const { checks } = await labDoctorChecks(e, { sdk: v.sdk, models: v.profile ? [v.profile] : undefined, profileDirs });
        const ok = checks.every((c) => c.ok !== false);
        if (json) out.log(JSON.stringify({ ok, checks }, null, 2));
        else {
          out.log('FireLab lab doctor');
          printChecks(out, checks);
          out.log('');
          out.log(HONESTY);
        }
        return ok ? 0 : 1;
      }
      case 'create': {
        if (v['list-models']) {
          const { profiles } = loadProfiles(profileDirs);
          for (const t of buildTargets(profiles)) {
            if (t.vega) {
              out.log(`${t.model.padEnd(12)} ${t.name}  (Vega OS: no Android emulator; use Amazon's Vega Virtual Device)`);
              continue;
            }
            const c = t.sdk.value ? chooseImage(t.sdk.value, hostAbi(process.arch)) : null;
            out.log(`${t.model.padEnd(12)} ${t.name}${t.sdk.value ? `  API ${t.sdk.value}` : ''}${t.ramMB ? `, ${t.ramMB} MB` : ''}${c ? `  -> ${imagePackage(c.image)}` : ''}${profiles.has(t.model) ? '  (profile)' : ''}`);
          }
          return 0;
        }
        const model = v.profile ?? pos[0];
        if (!model) throw new UsageError('Usage: firelab lab create --profile <model>   (e.g. AFTSSS, AFTMA08C15)');
        const { target, profile } = resolveModel(model, profileDirs);
        const spec = labSpec(target, profile, {
          ...(v.name ? { name: v.name } : {}),
          ...(v.image ? { image: v.image } : {}),
          preferTv: !!v['prefer-tv'],
          ...(num(v.api, 'api') ? { api: num(v.api, 'api') } : {}),
          ...(num(v.ram, 'ram') ? { ramMB: num(v.ram, 'ram') } : {}),
          ...(num(v.heap, 'heap') ? { heapMB: num(v.heap, 'heap') } : {}),
          ...(num(v.density, 'density') ? { density: num(v.density, 'density') } : {}),
        });
        const pkg = imagePackage(spec.image);
        const tools = findSdk(e, v.sdk);
        if (!json) for (const l of describeSpec(spec, pkg)) out.log(l);
        if (v['dry-run']) {
          if (json) out.log(JSON.stringify({ spec, image: pkg, dryRun: true }, null, 2));
          return 0;
        }
        if (!tools.sdk) throw new Error(`No Android SDK found. ${sdkInstallHelp(e).join(' ')}`);
        const missing = sdkPackages(spec.image, { emulator: !!tools.emulator, platformTools: !!tools.adb }).filter((p) => p !== pkg || !imageInstalled(tools.sdk as string, spec.image));
        if (missing.length) {
          if (!v.install) {
            out.err(`Missing: ${missing.join(', ')}`);
            out.err(`Install with:  firelab lab create --profile ${spec.model}${v.name ? ` --name ${v.name}` : ''} --install`);
            out.err(`or yourself:   ${commandLine(tools.sdkmanager ?? 'sdkmanager', ['--install', ...missing])}`);
            return 1;
          }
          const code = await sdkmanagerInstall(tools, missing, e, out);
          if (code !== 0) {
            out.err(`sdkmanager exited with ${code}.`);
            return 1;
          }
          if (!imageInstalled(tools.sdk, spec.image)) {
            out.err(`sdkmanager finished but ${pkg} is still missing.`);
            return 1;
          }
        }
        const home = avdHome(e);
        fs.mkdirSync(home, { recursive: true });
        const r = writeAvd(spec, pkg, home, { force: !!v.force, headless: !!v.headless });
        if (json) out.log(JSON.stringify({ ok: true, name: spec.name, dir: r.dir, image: pkg, spec }, null, 2));
        else {
          out.log('');
          out.log(`Created ${spec.name} in ${r.dir}`);
          out.log(`Start it:  firelab lab start ${spec.name}${v.headless ? ' --headless' : ''}`);
        }
        return 0;
      }
      case 'start': {
        const tools = findSdk(e, v.sdk);
        if (!tools.emulator || !tools.adb) throw new Error('The emulator or adb is missing: run `firelab lab doctor`');
        const avd = labByName(e, pos[0] ?? (v.profile ? avdNameFor(v.profile) : v.name));
        const running = await runningEmulators(tools.adb);
        const already = running.find((r) => r.avd === avd.name);
        let serial: string;
        let bootMs = 0;
        let log: string | undefined;
        if (already) {
          serial = already.serial;
          say(`${avd.name} is already running as ${serial}.`);
        } else {
          const port = num(v.port, 'port') ?? freePort(running.map((r) => r.port));
          if (!port) throw new Error('No free emulator port between 5554 and 5584');
          const version = await emulatorVersion(tools.emulator);
          const args = emulatorArgs(avd.name, {
            port,
            headless: !!v.headless,
            wipe: !!v.wipe,
            coldBoot: !!v.cold,
            ...(v.gpu ? { gpu: v.gpu } : {}),
            ...(avd.meta ? { ramMB: avd.meta.ramMB } : {}),
            noMetrics: !!version && compareVersions(version, '33.1.5') >= 0,
          });
          serial = serialFor(port);
          const env = { ...process.env, ...(tools.sdk ? { ANDROID_HOME: tools.sdk, ANDROID_SDK_ROOT: tools.sdk } : {}), ANDROID_AVD_HOME: avdHome(e) };
          const p = spawnEmulator(tools.emulator, args, avd.name, env);
          log = p.log;
          say(`Starting ${avd.name} as ${serial}${v.headless ? ' (headless)' : ''}: ${commandLine('emulator', args)}`);
          say(`Emulator log: ${p.log}`);
          const timeoutMs = (num(v.timeout, 'timeout') ?? 600) * 1000;
          const r = await waitForBoot(tools.adb, serial, { timeoutMs, pid: p.pid, log: p.log, onTick: (s) => say(`  ${s}...`) });
          bootMs = r.ms;
          say(`Booted in ${Math.round(bootMs / 1000)} s.`);
        }
        await prepareForTests(tools.adb, serial);
        // Through FireLab's own device layer, like a real Fire TV.
        const lab = new FireLab({ adbPath: v.adb ?? tools.adb, autoReconnect: false });
        try {
          const info = await lab.deviceInfo(serial);
          const warnings = bootWarnings(avd.meta, info.ramMB, info.sdk);
          const device = { id: serial, name: info.name, model: info.model, os: info.os, sdk: info.sdk, abis: info.abis, ramMB: info.ramMB, resolution: info.resolution, density: info.density };
          if (json) out.log(JSON.stringify({ ok: true, name: avd.name, serial, bootMs, ...(log ? { log } : {}), device, lab: avd.meta ?? null, warnings }, null, 2));
          else {
            out.log(`Ready: ${serial}  ${info.os}, API ${info.sdk}, ${info.abis.join('/')}, ${info.ramMB} MB${info.resolution ? `, ${info.resolution.width}x${info.resolution.height} @ ${info.density} dpi` : ''}`);
            out.log(`Use it like a Fire TV:  firelab install app.apk -d ${serial}   ·   firelab lab smoke --apk app.apk -d ${serial}   ·   firelab ui`);
            if (avd.meta) out.log(`Shaped like the ${avd.meta.model}. ${HONESTY}`);
          }
          for (const w of warnings) say(`warning: ${w}`);
        } finally {
          await lab.close();
        }
        return 0;
      }
      case 'stop': {
        const tools = findSdk(e, v.sdk);
        if (!tools.adb) throw new Error('adb is missing: run `firelab lab doctor`');
        const running = await runningEmulators(tools.adb);
        const target = pos[0] ?? v.device;
        const which = v.all ? running : running.filter((r) => (target ? r.serial === target || r.avd === target || r.avd === avdNameFor(target) : !!metaFor(e, r.avd)));
        if (!which.length) {
          say(target ? `${target} is not running.` : 'No lab emulators running.');
          return v.all || !target ? 0 : 1;
        }
        if (!target && !v.all && which.length > 1) throw new UsageError(`Several labs are running (${which.map((w) => w.avd ?? w.serial).join(', ')}): name one, or --all`);
        for (const r of which) {
          const ok = await killEmulator(tools.adb, r.serial);
          say(`${ok ? 'Stopped' : 'Could not stop'} ${r.avd ?? ''} ${r.serial}`.replace('  ', ' '));
        }
        if (json) out.log(JSON.stringify({ ok: true, stopped: which.map((w) => w.serial) }));
        return 0;
      }
      case 'list': {
        const tools = findSdk(e, v.sdk);
        const running = tools.adb ? await runningEmulators(tools.adb) : [];
        const avds = listAvds(avdHome(e));
        const rows = avds.map((a) => ({
          name: a.name,
          lab: !!a.meta,
          model: a.meta?.model,
          image: a.meta?.image ?? a.config.get('image.sysdir.1'),
          ramMB: a.meta?.ramMB ?? (a.config.get('hw.ramSize') ? Number(a.config.get('hw.ramSize')) : undefined),
          running: running.find((r) => r.avd === a.name)?.serial ?? null,
        }));
        if (json) out.log(JSON.stringify(rows, null, 2));
        else if (!rows.length) out.log(`No AVDs in ${avdHome(e)}. Create one: firelab lab create --profile AFTSSS`);
        else
          for (const r of rows)
            out.log(`${r.name.padEnd(24)} ${r.running ? `running as ${r.running}` : 'stopped'.padEnd(20)}  ${r.lab ? `${r.model}, ${r.ramMB} MB, ${r.image}` : `(not a FireLab lab) ${r.image ?? ''}`}`);
        return 0;
      }
      case 'delete': {
        const name = pos[0];
        if (!name) throw new UsageError('Usage: firelab lab delete <name> --yes');
        if (!v.yes) throw new UsageError(`This deletes the AVD ${name} and everything installed on it. Add --yes if you mean it.`);
        const avd = labByName(e, name);
        const tools = findSdk(e, v.sdk);
        if (tools.adb && (await runningEmulators(tools.adb)).some((r) => r.avd === avd.name)) throw new UsageError(`${avd.name} is running: firelab lab stop ${avd.name} first`);
        deleteAvd(avdHome(e), avd.name);
        say(`Deleted ${avd.name}`);
        return 0;
      }
      case 'smoke': {
        if (!v.apk && !v.package) throw new UsageError('Usage: firelab lab smoke (--apk <file.apk> | --package <id>) [-d <serial>]');
        const tools = findSdk(e, v.sdk);
        const lab = new FireLab({ adbPath: v.adb ?? tools.adb ?? undefined, autoReconnect: false });
        try {
          const serial = await lab.resolveDevice(v.device);
          const running = tools.adb ? await runningEmulators(tools.adb).catch(() => []) : [];
          let meta = metaFor(e, running.find((r) => r.serial === serial)?.avd);
          let budget = meta?.budgetMB;
          let limit = meta?.limitMB;
          let model = meta?.model;
          if (v.profile) {
            const { target } = resolveModel(v.profile, profileDirs);
            model = target.model;
            budget = target.memory.budgetMB.value ?? undefined;
            limit = target.memory.limitMB.value ?? undefined;
            if (meta && meta.model !== target.model) meta = undefined;
          }
          const outDir = path.resolve(v.out ?? 'firelab-lab');
          const maxLaunch = num(v['max-launch-ms'], 'max-launch-ms');
          const r = await runSmoke(lab, {
            device: serial,
            ...(v.apk ? { apk: v.apk } : {}),
            ...(v.package ? { package: v.package } : {}),
            ...(v.url ? { url: v.url } : {}),
            outDir,
            settleS: num(v.settle, 'settle') ?? 10,
            maxLaunchMs: maxLaunch ?? 5000,
            strictLaunch: maxLaunch !== undefined,
            ...(budget !== undefined ? { budgetMB: budget } : {}),
            ...(limit !== undefined ? { limitMB: limit } : {}),
            ...(model ? { model } : {}),
            onStep: (s) => out.err(`- ${s}`),
          });
          const ctx = meta ? { lab: { name: meta.name, model: meta.model, modelName: meta.modelName, image: meta.image, ramMB: meta.ramMB, width: meta.width, height: meta.height, density: meta.density } } : {};
          const md = smokeMarkdown(r, ctx);
          fs.writeFileSync(path.join(outDir, 'smoke.json'), `${JSON.stringify({ ...r, lab: meta ?? null }, null, 2)}\n`);
          fs.writeFileSync(path.join(outDir, 'summary.md'), md);
          fs.writeFileSync(path.join(outDir, 'report.html'), smokeHtml(r, ctx));
          if (v.summary) fs.appendFileSync(v.summary, md);
          if (json) out.log(JSON.stringify({ ...r, report: path.join(outDir, 'report.html') }, null, 2));
          else {
            out.log('');
            for (const c of r.checks) out.log(`${c.status === 'pass' ? '[ok]' : c.status === 'warn' ? '[!!]' : c.status === 'fail' ? '[XX]' : '[--]'} ${c.title}: ${c.detail}`);
            out.log('');
            out.log(`${r.verdict === 'pass' ? 'PASS' : 'FAIL'}  report: ${path.join(outDir, 'report.html')}`);
          }
          return r.ok ? 0 : 2;
        } finally {
          await lab.close();
        }
      }
      default:
        out.err(`Unknown lab command "${sub}". Run \`firelab lab help\`.`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      out.err(err.message);
      return 2;
    }
    out.err(errorMessage(err));
    return 1;
  }
}

export type { SystemImage };
