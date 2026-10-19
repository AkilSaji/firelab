/**
 * What a Fire-TV-shaped emulator looks like for one model: the Android
 * system image (API level from the Fire OS version), RAM, heap, screen and
 * density, all from the model's device profile (or FireLab's model table).
 *
 * Everything here is pure (no files, no processes) so it can be tested
 * without an SDK. src/lab/sdk.ts does the I/O.
 *
 * What the emulator does NOT match: the GPU (Fire TVs have Mali/PowerVR
 * GPUs, the emulator renders with the host GPU or SwiftShader), the CPU
 * (ARM cores at 1.5-2 GHz vs the host's), the Amazon WebView and Fire OS's
 * launcher and services. Frame rates measured on it say nothing about a real
 * stick: use `firelab fit` with the real profiles for performance.
 */
import type { FitTarget } from '../fit/types.js';
import type { DeviceProfile } from '../profile/types.js';
import { val } from '../profile/types.js';

export type HostAbi = 'arm64-v8a' | 'x86_64';
export type ImageAbi = 'arm64-v8a' | 'x86_64' | 'x86';
export type ImageTag = 'android-tv' | 'google-tv' | 'google_apis' | 'default';

export type SystemImage = { api: number; tag: ImageTag; abi: ImageAbi };

const range = (a: number, b: number, skip: number[] = []) => Array.from({ length: b - a + 1 }, (_, i) => a + i).filter((x) => !skip.includes(x));
const imgs = (tag: ImageTag, abi: ImageAbi, apis: number[]): SystemImage[] => apis.map((api) => ({ api, tag, abi }));

/**
 * System images Google publishes (`sdkmanager --list`, October 2026) from
 * API 22 (Fire OS 5) up. Android TV images exist for x86 at every Fire OS
 * API level, but arm64 Android TV starts at API 31.
 */
export const KNOWN_IMAGES: readonly SystemImage[] = [
  ...imgs('android-tv', 'x86', [...range(22, 31), 33, 34, 36]),
  ...imgs('android-tv', 'x86_64', [36]),
  ...imgs('android-tv', 'arm64-v8a', [31, 33, 34, 36]),
  ...imgs('google_apis', 'arm64-v8a', range(22, 36)),
  ...imgs('google_apis', 'x86_64', range(22, 36, [27])),
  ...imgs('google_apis', 'x86', range(22, 30)),
  ...imgs('default', 'arm64-v8a', range(22, 36)),
  ...imgs('default', 'x86_64', range(22, 36)),
];

export const TAG_DISPLAY: Record<ImageTag, string> = {
  'android-tv': 'Android TV',
  'google-tv': 'Google TV',
  google_apis: 'Google APIs',
  default: 'Default Android System Image',
};

export function imagePackage(i: SystemImage): string {
  return `system-images;android-${i.api};${i.tag};${i.abi}`;
}

/** The SDK-relative folder of an image, as config.ini's image.sysdir.1 wants it. */
export function imageSysdir(i: SystemImage): string {
  return `system-images/android-${i.api}/${i.tag}/${i.abi}/`;
}

/** Parses "system-images;android-28;android-tv;x86" (also with / separators). */
export function parseImagePackage(s: string): SystemImage | null {
  const m = /^system-images[;/]android-(\d+)[;/]([a-z_-]+)[;/](arm64-v8a|x86_64|x86)\/?$/.exec(s.trim());
  if (!m) return null;
  return { api: Number(m[1]), tag: m[2] as ImageTag, abi: m[3] as ImageAbi };
}

/** The emulator's image ABI for this computer: arm64 on Apple Silicon / ARM Linux, x86_64 everywhere else. */
export function hostAbi(arch: string = process.arch): HostAbi {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

/** Image ABIs a host runs with hardware acceleration, best first. */
export function runnableAbis(host: HostAbi): ImageAbi[] {
  return host === 'arm64-v8a' ? ['arm64-v8a'] : ['x86_64', 'x86'];
}

export type ImageChoice = { image: SystemImage; exactApi: boolean; tv: boolean; why: string };

/**
 * Picks the system image for an API level on this host:
 *  1. an Android TV image at exactly that API level,
 *  2. otherwise the Google APIs image at that API level (phone system with
 *     TV hardware: D-pad, no touch, 1080p; its WebView can be updated),
 *  3. otherwise the default image at that API level.
 * With `preferTv`, the nearest Android TV image at or above the API level
 * wins over an exact-API phone image.
 */
export function chooseImage(api: number, host: HostAbi, opts: { preferTv?: boolean; images?: readonly SystemImage[] } = {}): ImageChoice | null {
  const images = opts.images ?? KNOWN_IMAGES;
  const abis = runnableAbis(host);
  const rank = (i: SystemImage) => abis.indexOf(i.abi);
  const pick = (list: SystemImage[]) => list.filter((i) => rank(i) >= 0).sort((a, b) => a.api - b.api || rank(a) - rank(b))[0];
  const tvExact = pick(images.filter((i) => i.api === api && i.tag === 'android-tv'));
  if (tvExact) return { image: tvExact, exactApi: true, tv: true, why: `Android TV image at API ${api}` };
  const tvNear = pick(images.filter((i) => i.api > api && i.tag === 'android-tv'));
  if (opts.preferTv && tvNear) {
    return { image: tvNear, exactApi: false, tv: true, why: `no ${abis[0]} Android TV image at API ${api}; nearest is API ${tvNear.api} (--prefer-tv)` };
  }
  for (const tag of ['google_apis', 'default'] as const) {
    const exact = pick(images.filter((i) => i.api === api && i.tag === tag));
    if (exact) {
      return {
        image: exact,
        exactApi: true,
        tv: false,
        why: `no ${abis[0]} Android TV image exists at API ${api}: using the ${TAG_DISPLAY[tag]} image at API ${api} with TV hardware (D-pad, no touch screen, landscape)${tvNear ? `. For the Android TV launcher at API ${tvNear.api} instead, add --prefer-tv` : ''}`,
      };
    }
  }
  if (tvNear) return { image: tvNear, exactApi: false, tv: true, why: `nothing at API ${api} for ${abis[0]}; nearest Android TV image is API ${tvNear.api}` };
  return null;
}

/** Marketed RAM for a MemTotal (the GPU/video carve-outs make MemTotal smaller): 900 MB -> 1024, 1670 -> 2048. */
export function marketedRamMB(totalMB: number): number {
  const steps = [512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192];
  return steps.find((s) => totalMB <= s) ?? Math.ceil(totalMB / 1024) * 1024;
}

/**
 * Dalvik heap (dalvik.vm.heapsize) for a RAM size. Fire TV profiles don't
 * record it yet, so these are the usual Android TV values for that RAM
 * (estimated); override with --heap.
 */
export function heapMBFor(ramMB: number): number {
  if (ramMB <= 1024) return 192;
  if (ramMB <= 2048) return 256;
  return 384;
}

/** lcd density for a screen when the profile doesn't have one: 1080p TVs report xhdpi (320), 720p tvdpi (213). */
export function densityFor(width: number, height: number): number {
  const short = Math.min(width, height);
  if (short >= 2160) return 640;
  if (short >= 1080) return 320;
  return 213;
}

export type Sourced<T> = { value: T; source: 'measured' | 'spec' | 'estimated' | 'default' | 'override'; note?: string };

export type LabSpec = {
  /** AVD name, e.g. firelab-AFTSSS. */
  name: string;
  model: string;
  modelName: string;
  fireOs?: string;
  api: Sourced<number>;
  image: SystemImage;
  imageWhy: string;
  exactApi: boolean;
  tvImage: boolean;
  ramMB: Sourced<number>;
  heapMB: Sourced<number>;
  cores: Sourced<number>;
  width: Sourced<number>;
  height: Sourced<number>;
  density: Sourced<number>;
  /** The app memory budget and hard limit on the real device (from fit). */
  budgetMB?: number;
  limitMB?: number;
  /** The real device's GPU and ABIs (for the honesty notes). */
  gpu?: string;
  abis?: string[];
  dataPartitionMB: number;
  notes: string[];
};

export type SpecOptions = {
  name?: string;
  host?: HostAbi;
  image?: string;
  preferTv?: boolean;
  api?: number;
  ramMB?: number;
  heapMB?: number;
  density?: number;
};

const fromFact = <T>(f: { value: T | null; source: string; note?: string } | undefined): Sourced<T> | undefined =>
  f && f.value !== null && f.source !== 'unknown' ? { value: f.value, source: f.source as Sourced<T>['source'], ...(f.note ? { note: f.note } : {}) } : undefined;

export function avdNameFor(model: string): string {
  return `firelab-${model.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export function validAvdName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** Builds the lab spec for one model. Throws on a bad --image or an impossible choice. */
export function labSpec(target: FitTarget, profile: DeviceProfile | undefined, opts: SpecOptions = {}): LabSpec {
  const host = opts.host ?? hostAbi();
  const notes: string[] = [];
  if (target.vega) throw new Error(`The ${target.model} (${target.name}) runs Vega OS, not Android: there is no Android emulator image for it. Use Amazon's Vega Virtual Device from the Vega SDK.`);
  const name = opts.name ?? avdNameFor(target.model);
  if (!validAvdName(name)) throw new Error(`"${name}" is not a valid AVD name (letters, digits, . _ - only)`);

  const sdkFact = fromFact(target.sdk);
  const api: Sourced<number> = opts.api ? { value: opts.api, source: 'override' } : sdkFact ?? { value: 30, source: 'default', note: 'Fire OS version unknown: assumed Fire OS 8 (API 30)' };

  let choice: ImageChoice | null;
  if (opts.image) {
    const img = parseImagePackage(opts.image);
    if (!img) throw new Error(`--image must look like system-images;android-28;android-tv;x86 (got "${opts.image}")`);
    if (!runnableAbis(host).includes(img.abi)) notes.push(`${img.abi} images run without hardware acceleration on this ${host} computer: expect a very slow emulator.`);
    choice = { image: img, exactApi: img.api === api.value, tv: img.tag === 'android-tv' || img.tag === 'google-tv', why: `chosen with --image` };
  } else {
    choice = chooseImage(api.value, host, { preferTv: opts.preferTv });
  }
  if (!choice) throw new Error(`No system image for API ${api.value} runs on this ${host} computer`);
  if (!choice.exactApi) notes.push(`The image is API ${choice.image.api} but the real ${target.model} runs API ${api.value}: behaviour that changed between those Android versions (permissions, WebView, background limits) may differ.`);

  const total = fromFact(profile?.memory.totalMB) ?? fromFact(target.memory.totalMB);
  const ramMB: Sourced<number> = opts.ramMB
    ? { value: opts.ramMB, source: 'override' }
    : target.ramMB
      ? { value: target.ramMB, source: 'spec', note: `${target.ramMB} MB marketed RAM${total ? ` (MemTotal on the device: ${total.value} MB)` : ''}` }
      : total
        ? { value: marketedRamMB(total.value), source: 'estimated', note: `rounded up from MemTotal ${total.value} MB` }
        : { value: 1024, source: 'default', note: 'RAM unknown: assumed 1 GB (the smallest Fire TV Stick)' };
  const heapMB: Sourced<number> = opts.heapMB ? { value: opts.heapMB, source: 'override' } : { value: heapMBFor(ramMB.value), source: 'estimated', note: `usual Android TV dalvik.vm.heapsize for ${ramMB.value} MB` };
  const cores: Sourced<number> = fromFact(profile?.cpu.cores) ?? { value: 4, source: 'estimated', note: 'every Fire TV since 2017 has 4 cores or more' };
  const width: Sourced<number> = fromFact(profile?.display.width) ?? fromFact(target.display.width) ?? { value: 1920, source: 'default' };
  const height: Sourced<number> = fromFact(profile?.display.height) ?? fromFact(target.display.height) ?? { value: 1080, source: 'default' };
  if (width.value > 1920 && !opts.density) notes.push(`${width.value}x${height.value} needs a lot of host GPU memory; Fire TV apps draw at 1920x1080 on 4K models anyway.`);
  const density: Sourced<number> = opts.density
    ? { value: opts.density, source: 'override' }
    : fromFact(profile?.display.density) ?? { value: densityFor(width.value, height.value), source: 'estimated', note: 'usual density for that resolution' };

  if (!choice.tv) notes.push('Phone system image: no Android TV launcher or Leanback, so apps are started by FireLab (am start), not from a TV home screen.');
  const abis = val(target.abis);
  if (abis && !abis.includes('arm64-v8a') && choice.image.abi === 'arm64-v8a') {
    notes.push(`The real ${target.model} runs 32-bit ARM (${abis.join(', ')}); the emulator is 64-bit ARM. Apps with only armeabi-v7a native libraries may not install or run (Apple Silicon can't execute 32-bit ARM). Pure Java/Kotlin and web apps are fine.`);
  }
  if (choice.image.abi.startsWith('x86')) {
    notes.push(`x86 image: apps with only ARM native libraries need ARM translation, which the x86 Android TV images lack. If install fails with INSTALL_FAILED_NO_MATCHING_ABIS, use --image system-images;android-30;google_apis;x86_64.`);
  }
  const gpu = target.gpu;
  notes.push(`Matches the ${target.model}'s memory, screen${choice.exactApi ? ' and API level' : ''}, not its ${gpu ?? 'Mali/PowerVR'} GPU or ARM CPU: frame rates here mean nothing for the real device. Use \`firelab fit\` with the real profiles for performance.`);

  return {
    name,
    model: target.model,
    modelName: target.name,
    ...(profile ? { fireOs: val(profile.os.fireOs) } : target.fireOsMajor ? { fireOs: String(target.fireOsMajor) } : {}),
    api,
    image: choice.image,
    imageWhy: choice.why,
    exactApi: choice.exactApi,
    tvImage: choice.tv,
    ramMB,
    heapMB,
    cores,
    width,
    height,
    density,
    ...(val(target.memory.budgetMB) !== undefined ? { budgetMB: val(target.memory.budgetMB) } : {}),
    ...(val(target.memory.limitMB) !== undefined ? { limitMB: val(target.memory.limitMB) } : {}),
    ...(gpu ? { gpu } : {}),
    ...(abis ? { abis } : {}),
    dataPartitionMB: 4096,
    notes,
  };
}

const ARCH: Record<ImageAbi, string> = { 'arm64-v8a': 'arm64', x86_64: 'x86_64', x86: 'x86' };

/** config.ini for the AVD (keys in a stable order). */
export function avdConfig(spec: LabSpec, opts: { headless?: boolean } = {}): [string, string][] {
  const i = spec.image;
  return [
    ['avd.ini.encoding', 'UTF-8'],
    ['AvdId', spec.name],
    ['avd.ini.displayname', `FireLab ${spec.model} (${spec.modelName})`],
    ['PlayStore.enabled', 'false'],
    ['abi.type', i.abi],
    ['hw.cpu.arch', ARCH[i.abi]],
    ['hw.cpu.ncore', String(spec.cores.value)],
    ['image.sysdir.1', imageSysdir(i)],
    ['tag.id', i.tag],
    ['tag.display', TAG_DISPLAY[i.tag]],
    ['target', `android-${i.api}`],
    ['hw.ramSize', String(spec.ramMB.value)],
    ['vm.heapSize', String(spec.heapMB.value)],
    ['hw.lcd.width', String(spec.width.value)],
    ['hw.lcd.height', String(spec.height.value)],
    ['hw.lcd.density', String(spec.density.value)],
    ['hw.initialOrientation', 'landscape'],
    ['hw.device.name', spec.width.value > 1920 ? 'tv_4k' : spec.width.value >= 1920 ? 'tv_1080p' : 'tv_720p'],
    ['hw.device.manufacturer', 'Google'],
    ['hw.keyboard', 'yes'],
    ['hw.dPad', 'yes'],
    ['hw.mainKeys', 'yes'],
    ['hw.trackBall', 'no'],
    ['hw.screen', 'no-touch'],
    ['hw.accelerometer', 'no'],
    ['hw.gyroscope', 'no'],
    ['hw.sensors.proximity', 'no'],
    ['hw.sensors.orientation', 'no'],
    ['hw.sensors.magnetic_field', 'no'],
    ['hw.gps', 'no'],
    ['hw.battery', 'no'],
    ['hw.camera.back', 'none'],
    ['hw.camera.front', 'none'],
    ['hw.audioInput', 'no'],
    ['hw.audioOutput', 'yes'],
    ['hw.gpu.enabled', 'yes'],
    ['hw.gpu.mode', opts.headless ? 'swiftshader_indirect' : 'auto'],
    ['disk.dataPartition.size', `${spec.dataPartitionMB}M`],
    ['skin.dynamic', 'no'],
    ['skin.name', `${spec.width.value}x${spec.height.value}`],
    ['skin.path', '_no_skin'],
    ['showDeviceFrame', 'no'],
    ['fastboot.forceColdBoot', 'no'],
    ['runtime.network.latency', 'none'],
    ['runtime.network.speed', 'full'],
  ];
}

export function renderIni(entries: [string, string][]): string {
  return `${entries.map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

export function parseIni(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0 || line.trimStart().startsWith('#')) continue;
    m.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return m;
}

/** The <name>.ini pointer file next to the <name>.avd folder. */
export function avdPointerIni(spec: Pick<LabSpec, 'name' | 'image'>, avdDir: string): [string, string][] {
  return [
    ['avd.ini.encoding', 'UTF-8'],
    ['path', avdDir],
    ['path.rel', `avd/${spec.name}.avd`],
    ['target', `android-${spec.image.api}`],
  ];
}

export type EmulatorOptions = {
  port: number;
  headless?: boolean;
  wipe?: boolean;
  /** Boot without loading or saving the quick-boot snapshot (CI: always cold). */
  coldBoot?: boolean;
  gpu?: string;
  ramMB?: number;
  /** -no-metrics exists on emulator 33.1.5+. */
  noMetrics?: boolean;
  extra?: string[];
};

export function emulatorArgs(name: string, o: EmulatorOptions): string[] {
  const args = ['-avd', name, '-port', String(o.port), '-no-boot-anim', '-netdelay', 'none', '-netspeed', 'full'];
  if (o.ramMB) args.push('-memory', String(o.ramMB));
  if (o.headless) args.push('-no-window', '-no-audio');
  const gpu = o.gpu ?? (o.headless ? 'swiftshader_indirect' : undefined);
  if (gpu) args.push('-gpu', gpu);
  if (o.coldBoot) args.push('-no-snapshot');
  else args.push('-no-snapshot-save');
  if (o.wipe) args.push('-wipe-data');
  if (o.noMetrics !== false) args.push('-no-metrics');
  if (o.extra) args.push(...o.extra);
  return args;
}

/** sdkmanager packages a lab needs. */
export function sdkPackages(image: SystemImage, have: { emulator: boolean; platformTools: boolean }): string[] {
  return [...(have.emulator ? [] : ['emulator']), ...(have.platformTools ? [] : ['platform-tools']), imagePackage(image)];
}

/** Emulator console ports: 5554, 5556, ... 5584 (adb serial emulator-<port>). */
export function freePort(used: Iterable<number>): number | null {
  const taken = new Set(used);
  for (let p = 5554; p <= 5584; p += 2) if (!taken.has(p)) return p;
  return null;
}

export function serialFor(port: number): string {
  return `emulator-${port}`;
}

export function portOf(serial: string): number | null {
  const m = /^emulator-(\d+)$/.exec(serial);
  return m ? Number(m[1]) : null;
}
