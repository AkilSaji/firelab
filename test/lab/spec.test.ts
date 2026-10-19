// Tests for the lab's AVD config and emulator argument building (src/lab/spec.ts). No emulator needed.
import { describe, test, expect } from 'vitest';
import { loadProfiles, defaultProfilesDir } from '../../src/profile/load.js';
import { buildTargets } from '../../src/fit/targets.js';
import {
  avdConfig,
  avdNameFor,
  avdPointerIni,
  chooseImage,
  densityFor,
  emulatorArgs,
  freePort,
  heapMBFor,
  hostAbi,
  imagePackage,
  imageSysdir,
  labSpec,
  marketedRamMB,
  parseImagePackage,
  parseIni,
  portOf,
  renderIni,
  sdkPackages,
  serialFor,
  validAvdName,
  KNOWN_IMAGES,
} from '../../src/lab/spec.js';

const { profiles } = loadProfiles(defaultProfilesDir());
const targets = buildTargets(profiles);
const target = (m: string) => {
  const t = targets.find((x) => x.model === m);
  if (!t) throw new Error(`no target ${m}`);
  return t;
};
const cfg = (entries: [string, string][]) => Object.fromEntries(entries);

describe('system image choice', () => {
  test('Linux/x86_64 gets the Android TV image at the exact Fire OS API level', () => {
    expect(chooseImage(28, 'x86_64')).toMatchObject({ image: { api: 28, tag: 'android-tv', abi: 'x86' }, exactApi: true, tv: true });
    expect(chooseImage(30, 'x86_64')).toMatchObject({ image: { api: 30, tag: 'android-tv', abi: 'x86' }, exactApi: true, tv: true });
    // x86_64 wins over x86 when both exist.
    expect(chooseImage(36, 'x86_64')?.image).toEqual({ api: 36, tag: 'android-tv', abi: 'x86_64' });
  });

  test('Apple Silicon keeps the API level with a Google APIs image (no arm64 Android TV image below API 31)', () => {
    const c = chooseImage(28, 'arm64-v8a');
    expect(c).toMatchObject({ image: { api: 28, tag: 'google_apis', abi: 'arm64-v8a' }, exactApi: true, tv: false });
    expect(c?.why).toMatch(/no arm64-v8a Android TV image exists at API 28/);
    expect(c?.why).toMatch(/--prefer-tv/);
  });

  test('--prefer-tv takes the nearest Android TV image above the API level', () => {
    expect(chooseImage(28, 'arm64-v8a', { preferTv: true })).toMatchObject({ image: { api: 31, tag: 'android-tv', abi: 'arm64-v8a' }, exactApi: false, tv: true });
    // An exact TV image still wins.
    expect(chooseImage(33, 'arm64-v8a', { preferTv: true })?.image.api).toBe(33);
  });

  test('falls back to the default image, then the nearest TV image, then nothing', () => {
    const images = [{ api: 28, tag: 'default' as const, abi: 'arm64-v8a' as const }];
    expect(chooseImage(28, 'arm64-v8a', { images })?.image.tag).toBe('default');
    expect(chooseImage(28, 'arm64-v8a', { images: [{ api: 31, tag: 'android-tv', abi: 'arm64-v8a' }] })).toMatchObject({ exactApi: false, image: { api: 31 } });
    expect(chooseImage(28, 'arm64-v8a', { images: [{ api: 28, tag: 'android-tv', abi: 'x86' }] })).toBeNull();
  });

  test('every Fire OS API level has an image on both hosts', () => {
    for (const api of [22, 25, 28, 30]) {
      expect(chooseImage(api, 'x86_64')?.exactApi).toBe(true);
      expect(chooseImage(api, 'arm64-v8a')?.exactApi).toBe(true);
    }
    expect(KNOWN_IMAGES.length).toBeGreaterThan(50);
  });

  test('package names round-trip', () => {
    const i = { api: 28, tag: 'android-tv' as const, abi: 'x86' as const };
    expect(imagePackage(i)).toBe('system-images;android-28;android-tv;x86');
    expect(imageSysdir(i)).toBe('system-images/android-28/android-tv/x86/');
    expect(parseImagePackage(imagePackage(i))).toEqual(i);
    expect(parseImagePackage('system-images/android-36/google_apis/arm64-v8a/')).toEqual({ api: 36, tag: 'google_apis', abi: 'arm64-v8a' });
    expect(parseImagePackage('android-28;x86')).toBeNull();
  });

  test('host ABI', () => {
    expect(hostAbi('arm64')).toBe('arm64-v8a');
    expect(hostAbi('x64')).toBe('x86_64');
  });
});

describe('sizes', () => {
  test('marketed RAM from MemTotal', () => {
    expect(marketedRamMB(900.7)).toBe(1024);
    expect(marketedRamMB(1670)).toBe(2048);
    expect(marketedRamMB(1400)).toBe(1536);
    expect(marketedRamMB(9000)).toBe(9216);
  });
  test('heap and density', () => {
    expect(heapMBFor(1024)).toBe(192);
    expect(heapMBFor(2048)).toBe(256);
    expect(heapMBFor(4096)).toBe(384);
    expect(densityFor(1920, 1080)).toBe(320);
    expect(densityFor(1280, 720)).toBe(213);
    expect(densityFor(3840, 2160)).toBe(640);
  });
});

describe('labSpec', () => {
  test('AFTSSS (Fire TV Stick 3rd gen) on Linux: Android 9 TV image, 1 GB, 1080p, its memory budget', () => {
    const s = labSpec(target('AFTSSS'), profiles.get('AFTSSS'), { host: 'x86_64' });
    expect(s.name).toBe('firelab-AFTSSS');
    expect(s.api).toMatchObject({ value: 28, source: 'measured' });
    expect(s.fireOs).toBe('7.7.1.7');
    expect(imagePackage(s.image)).toBe('system-images;android-28;android-tv;x86');
    expect(s.tvImage).toBe(true);
    expect(s.ramMB.value).toBe(1024);
    expect(s.heapMB).toMatchObject({ value: 192, source: 'estimated' });
    expect([s.width.value, s.height.value, s.density.value]).toEqual([1920, 1080, 320]);
    expect(s.budgetMB).toBe(415);
    expect(s.limitMB).toBe(458);
    expect(s.notes.join('\n')).toMatch(/not its PowerVR Rogue GE8300 GPU/);
    expect(s.notes.join('\n')).toMatch(/firelab fit/);
    expect(s.notes.join('\n')).toMatch(/x86 image/);
  });

  test('AFTMA08C15 (4K Plus) on Apple Silicon: Android 11, 2 GB, measured density, 32-bit ARM warning', () => {
    const s = labSpec(target('AFTMA08C15'), profiles.get('AFTMA08C15'), { host: 'arm64-v8a' });
    expect(imagePackage(s.image)).toBe('system-images;android-30;google_apis;arm64-v8a');
    expect(s.api.value).toBe(30);
    expect(s.ramMB.value).toBe(2048);
    expect(s.heapMB.value).toBe(256);
    expect(s.density).toMatchObject({ value: 320, source: 'measured' });
    const notes = s.notes.join('\n');
    expect(notes).toMatch(/Phone system image/);
    expect(notes).toMatch(/32-bit ARM/);
  });

  test('overrides win and are labelled', () => {
    const s = labSpec(target('AFTSSS'), profiles.get('AFTSSS'), { host: 'x86_64', name: 'ci', ramMB: 1536, heapMB: 128, density: 240, api: 30 });
    expect(s.name).toBe('ci');
    expect(s.api).toEqual({ value: 30, source: 'override' });
    expect(s.ramMB).toEqual({ value: 1536, source: 'override' });
    expect(s.heapMB.value).toBe(128);
    expect(s.density.value).toBe(240);
  });

  test('--image: parsed, API mismatch noted, bad values rejected', () => {
    const s = labSpec(target('AFTSSS'), profiles.get('AFTSSS'), { host: 'arm64-v8a', image: 'system-images;android-36;google_apis;arm64-v8a' });
    expect(s.image).toEqual({ api: 36, tag: 'google_apis', abi: 'arm64-v8a' });
    expect(s.exactApi).toBe(false);
    expect(s.notes.join('\n')).toMatch(/API 36 but the real AFTSSS runs API 28/);
    expect(s.notes.join('\n')).not.toMatch(/screen and API level/);
    expect(() => labSpec(target('AFTSSS'), undefined, { image: 'android-28' })).toThrow(/--image must look like/);
    const slow = labSpec(target('AFTSSS'), undefined, { host: 'arm64-v8a', image: 'system-images;android-28;android-tv;x86' });
    expect(slow.notes.join('\n')).toMatch(/without hardware acceleration/);
  });

  test('a model without a profile uses the model table', () => {
    const s = labSpec(target('AFTKM'), undefined, { host: 'x86_64' });
    expect(s.api.value).toBe(30);
    expect(s.ramMB).toMatchObject({ value: 2048, source: 'spec' });
    expect(s.width.value).toBeGreaterThan(0);
  });

  test('Vega OS models are refused with a pointer to the Vega Virtual Device', () => {
    const vega = targets.find((t) => t.vega);
    expect(vega).toBeTruthy();
    expect(() => labSpec(vega!, undefined)).toThrow(/Vega OS, not Android/);
  });

  test('AVD names', () => {
    expect(avdNameFor('AFTSSS')).toBe('firelab-AFTSSS');
    expect(validAvdName('firelab-AFTSSS_1.2')).toBe(true);
    expect(validAvdName('bad name')).toBe(false);
    expect(validAvdName('-x')).toBe(false);
    expect(() => labSpec(target('AFTSSS'), undefined, { name: 'no spaces' })).toThrow(/not a valid AVD name/);
  });
});

describe('avdConfig', () => {
  const spec = labSpec(target('AFTSSS'), profiles.get('AFTSSS'), { host: 'x86_64' });

  test('TV hardware, RAM, heap, screen and image paths', () => {
    const c = cfg(avdConfig(spec));
    expect(c).toMatchObject({
      AvdId: 'firelab-AFTSSS',
      'abi.type': 'x86',
      'hw.cpu.arch': 'x86',
      'image.sysdir.1': 'system-images/android-28/android-tv/x86/',
      'tag.id': 'android-tv',
      'tag.display': 'Android TV',
      target: 'android-28',
      'hw.ramSize': '1024',
      'vm.heapSize': '192',
      'hw.lcd.width': '1920',
      'hw.lcd.height': '1080',
      'hw.lcd.density': '320',
      'hw.dPad': 'yes',
      'hw.keyboard': 'yes',
      'hw.screen': 'no-touch',
      'hw.device.name': 'tv_1080p',
      'hw.initialOrientation': 'landscape',
      'hw.camera.back': 'none',
      'hw.gps': 'no',
      'PlayStore.enabled': 'false',
      'hw.gpu.mode': 'auto',
      'disk.dataPartition.size': '4096M',
      'skin.name': '1920x1080',
    });
  });

  test('headless uses SwiftShader; arm64 images get the arm64 CPU', () => {
    expect(cfg(avdConfig(spec, { headless: true }))['hw.gpu.mode']).toBe('swiftshader_indirect');
    const arm = labSpec(target('AFTSSS'), profiles.get('AFTSSS'), { host: 'arm64-v8a' });
    expect(cfg(avdConfig(arm))).toMatchObject({ 'abi.type': 'arm64-v8a', 'hw.cpu.arch': 'arm64', 'tag.id': 'google_apis' });
  });

  test('no duplicate keys; ini round-trips', () => {
    const entries = avdConfig(spec);
    expect(new Set(entries.map(([k]) => k)).size).toBe(entries.length);
    const text = renderIni(entries);
    expect(text.endsWith('\n')).toBe(true);
    expect(Object.fromEntries(parseIni(text))).toEqual(cfg(entries));
    // The emulator rewrites config.ini as "key = value"; parseIni reads that too.
    expect(parseIni('hw.ramSize = 2560\n# comment\n\nbad line').get('hw.ramSize')).toBe('2560');
  });

  test('pointer ini', () => {
    expect(cfg(avdPointerIni(spec, '/home/u/.android/avd/firelab-AFTSSS.avd'))).toEqual({
      'avd.ini.encoding': 'UTF-8',
      path: '/home/u/.android/avd/firelab-AFTSSS.avd',
      'path.rel': 'avd/firelab-AFTSSS.avd',
      target: 'android-28',
    });
  });
});

describe('emulator arguments', () => {
  test('desktop: window, quick-boot snapshot loaded but not saved', () => {
    expect(emulatorArgs('firelab-AFTSSS', { port: 5554, ramMB: 1024 })).toEqual([
      '-avd', 'firelab-AFTSSS', '-port', '5554', '-no-boot-anim', '-netdelay', 'none', '-netspeed', 'full', '-memory', '1024', '-no-snapshot-save', '-no-metrics',
    ]);
  });

  test('CI: headless, SwiftShader, cold boot, wiped', () => {
    const a = emulatorArgs('ci', { port: 5556, headless: true, coldBoot: true, wipe: true, noMetrics: false });
    expect(a).toEqual(['-avd', 'ci', '-port', '5556', '-no-boot-anim', '-netdelay', 'none', '-netspeed', 'full', '-no-window', '-no-audio', '-gpu', 'swiftshader_indirect', '-no-snapshot', '-wipe-data']);
  });

  test('explicit GPU and extra args', () => {
    const a = emulatorArgs('x', { port: 5554, headless: true, gpu: 'host', extra: ['-verbose'] });
    expect(a.slice(a.indexOf('-gpu'), a.indexOf('-gpu') + 2)).toEqual(['-gpu', 'host']);
    expect(a.at(-1)).toBe('-verbose');
  });

  test('ports and serials', () => {
    expect(freePort([])).toBe(5554);
    expect(freePort([5554, 5556])).toBe(5558);
    expect(freePort(Array.from({ length: 16 }, (_, i) => 5554 + 2 * i))).toBeNull();
    expect(serialFor(5556)).toBe('emulator-5556');
    expect(portOf('emulator-5556')).toBe(5556);
    expect(portOf('192.168.1.5:5555')).toBeNull();
  });

  test('sdkmanager packages', () => {
    const img = { api: 28, tag: 'android-tv' as const, abi: 'x86' as const };
    expect(sdkPackages(img, { emulator: false, platformTools: false })).toEqual(['emulator', 'platform-tools', 'system-images;android-28;android-tv;x86']);
    expect(sdkPackages(img, { emulator: true, platformTools: true })).toEqual(['system-images;android-28;android-tv;x86']);
  });
});
