import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureProfile, parseWebViewUpdate, parseCpuMaxGHz, decodersFromCaps, PROFILE_SCRIPT, type CaptureDeps } from '../src/profile/capture.js';
import { WEB_CAPS_SCRIPT, parseWebCaps, compressedFamilies, compressedFamilyForFormat } from '../src/profile/webcaps.js';
import { loadProfiles, saveProfile, mergeProfile, profileFileName } from '../src/profile/load.js';
import { validateProfile } from '../src/profile/schema.js';
import type { DeviceProfile } from '../src/profile/types.js';

const fixture = (f: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', f), 'utf8');
const GETPROP = fixture('getprop-AFTMA08C15.txt');
const MEMINFO = 'MemTotal:        1710032 kB\nMemFree:          301234 kB\nMemAvailable:     905216 kB\n';
const WEBVIEWUPDATE = `Current WebView Update Service state
  Fallback logic enabled: false
  Current WebView package (name, version): (com.amazon.webview.chromium, 138.0.7204.180)
  Minimum WebView version code: 720418000`;

/** What the page answers to WEB_CAPS_SCRIPT on a GE9215 (shape of the script's result; values made up). */
const RAW_CAPS = {
  userAgent: 'Mozilla/5.0 (Linux; Android 11; AFTMA08C15 Build/RS8182.3811N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.180 Mobile Safari/537.36',
  chromeMajor: 138,
  chromeVersion: '138.0.7204.180',
  screen: { width: 1920, height: 1080, dpr: 2 },
  cores: 4,
  webgl2: { renderer: 'PowerVR Rogue GE9215', vendor: 'Imagination Technologies', version: 'WebGL 2.0 (OpenGL ES 3.0 Chromium)', maxTextureSize: 8192, maxRenderbufferSize: 8192, maxViewportDims: [8192, 8192], maxSamples: 4, mediumpPrecision: 10, extensions: ['EXT_color_buffer_float', 'WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1'] },
  webgl1: { renderer: 'PowerVR Rogue GE9215', maxTextureSize: 8192, maxRenderbufferSize: 8192, extensions: ['WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_pvrtc'] },
  canPlay: { 'video/mp4; codecs="avc1.640028"': 'probably' },
  decoding: {
    'avc1.640028@1920x1080p30': { supported: true, smooth: true, powerEfficient: true },
    'avc1.64002A@1920x1080p60': { supported: true, smooth: true, powerEfficient: true },
    'avc1.640033@3840x2160p30': { supported: true, smooth: false, powerEfficient: true },
    'hvc1.2.4.L153.90@3840x2160p60': { supported: true, smooth: true, powerEfficient: true },
    'av01.0.08M.08@1920x1080p30': { supported: true, smooth: true, powerEfficient: true },
  },
  features: { wasm: true, 'wasm-simd': true },
};

function fakeDeps(opts: { page?: boolean } = {}): CaptureDeps & { commands: string[]; evals: string[] } {
  const commands: string[] = [];
  const evals: string[] = [];
  return {
    commands,
    evals,
    shell: async (cmd) => {
      commands.push(cmd);
      if (cmd === PROFILE_SCRIPT) {
        return [GETPROP, '@@meminfo', MEMINFO, '@@wm', 'Physical size: 1920x1080', 'Physical density: 320', '@@cpufreq', '1800000\n1800000\n2000000\n2000000', '@@nproc', '4', '@@webview', WEBVIEWUPDATE].join('\n');
      }
      if (cmd.includes('MemAvailable')) return 'MemTotal:        1710032 kB\nMemAvailable:     620544 kB\n';
      throw new Error(`unexpected command ${cmd}`);
    },
    sleep: async () => {},
    now: () => new Date('2026-10-16T09:00:00Z'),
    ...(opts.page
      ? {
          openPage: async () => ({
            url: async () => 'file:///android_asset/blank.html',
            eval: async <T>(expr: string) => {
              evals.push(expr);
              if (expr === WEB_CAPS_SCRIPT) return RAW_CAPS as T;
              throw new Error('unexpected eval');
            },
          }),
        }
      : {}),
  };
}

describe('captureProfile', () => {
  it('records getprop, memory, screen, CPU and WebView facts as measured, read-only', async () => {
    const deps = fakeDeps({ page: true });
    const { profile: p, warnings } = await captureProfile(deps, { firelabVersion: '0.1.0' });
    expect(warnings).toEqual([]);
    expect(validateProfile(p)).toEqual([]);
    expect(p).toMatchObject({ model: 'AFTMA08C15', name: 'Fire TV Stick 4K Plus', source: 'measured', capturedAt: '2026-10-16T09:00:00.000Z', firelabVersion: '0.1.0' });
    expect(p.os.fireOs).toEqual({ value: '8.1.8.2', source: 'measured', note: 'getprop' });
    expect(p.os.android.value).toBe('11');
    expect(p.os.sdk.value).toBe(30);
    expect(p.os.build?.value).toBe('RS8182/3811');
    expect(p.cpu.abis.value).toEqual(['armeabi-v7a', 'armeabi']);
    expect(p.cpu.soc?.value).toBe('mt8696');
    expect(p.cpu.maxGHz?.value).toBe(2);
    expect(p.cpu.cores?.value).toBe(4);
    expect(p.memory.totalMB.value).toBe(1670);
    expect(p.memory.availIdleMB.value).toBe(884);
    expect(p.memory.availWebViewMB).toMatchObject({ value: 606, source: 'measured', note: 'MemAvailable with file:///android_asset/blank.html open' });
    // budget = blank WebView 120 + (606 - 100), limit = 120 + (606 - 40)
    expect(p.memory.appBudgetMB).toMatchObject({ value: 626, source: 'estimated' });
    expect(p.memory.appLimitMB).toMatchObject({ value: 686, source: 'estimated' });
    expect(p.gpu.renderer.value).toBe('PowerVR Rogue GE9215');
    expect(p.gpu.speedFactor).toMatchObject({ value: 2.2, source: 'measured' });
    expect(p.webgl).toMatchObject({ webgl1: { value: true }, webgl2: { value: true }, maxTextureSize: { value: 8192 }, maxRenderbufferSize: { value: 8192 }, compressed: { value: ['astc', 'etc1', 'etc2', 'pvrtc'] }, floatRender: { value: true }, mediumpFp16: { value: true } });
    expect(p.webview).toMatchObject({ version: { value: '138.0.7204.180' }, major: { value: 138 }, package: { value: 'com.amazon.webview.chromium' } });
    expect(p.media.decoders.value).toEqual([
      { codec: 'avc', supported: true, maxWidth: 3840, maxHeight: 2160, maxFps: 30, profiles: ['high'], maxLevel: '5.1' },
      { codec: 'hevc', supported: true, maxWidth: 3840, maxHeight: 2160, maxFps: 60, profiles: ['main10'], maxLevel: '5.1' },
      { codec: 'vp9', supported: false },
      { codec: 'av1', supported: true, maxWidth: 1920, maxHeight: 1080, maxFps: 30, profiles: ['main'], maxLevel: '4.0' },
    ]);
    expect(p.display).toMatchObject({ width: { value: 1920 }, height: { value: 1080 }, density: { value: 320 } });
    // Only reads: one probe script and one MemAvailable read, nothing else.
    expect(deps.commands).toHaveLength(2);
    expect(deps.commands.join(' ')).not.toMatch(/\b(pm|am|input|settings put|rm)\b/);
  });

  it('without a WebView page, WebGL/WebView-page/media facts stay unknown and the budget comes from MemTotal', async () => {
    const { profile: p, warnings } = await captureProfile(fakeDeps(), { firelabVersion: '0.1.0' });
    expect(warnings[0]).toMatch(/No WebView page/);
    expect(validateProfile(p)).toEqual([]);
    expect(p.webgl.webgl2).toEqual({ value: null, source: 'unknown', note: 'WebGL in the WebView' });
    expect(p.media.decoders.source).toBe('unknown');
    expect(p.webview.major.value).toBe(138); // from dumpsys webviewupdate
    expect(p.memory.appBudgetMB.source).toBe('estimated');
    expect(p.memory.appBudgetMB.value).toBeGreaterThan(700);
    expect(p.gpu.speedFactor.value).toBe(2.2); // from the model's spec GPU
  });

  it('parsers', () => {
    expect(parseWebViewUpdate(WEBVIEWUPDATE)).toEqual({ package: 'com.amazon.webview.chromium', version: '138.0.7204.180', major: 138 });
    expect(parseWebViewUpdate('nothing')).toEqual({});
    expect(parseCpuMaxGHz('1690000\n1690000')).toBe(1.69);
    expect(parseCpuMaxGHz('')).toBeUndefined();
    expect(compressedFamilies(['WEBGL_compressed_texture_s3tc_srgb', 'EXT_texture_compression_bptc', 'WEBKIT_WEBGL_compressed_texture_pvrtc'])).toEqual(['bptc', 's3tc', 'pvrtc'].sort());
    expect([0x8d64, 0x9274, 0x93b0, 0x83f1, 0x8c02, 0x1234].map(compressedFamilyForFormat)).toEqual(['etc1', 'etc2', 'astc', 's3tc', 'pvrtc', undefined]);
    expect(parseWebCaps(null)).toBeUndefined();
    expect(decodersFromCaps({ webgl1: null, webgl2: null, compressed: [], floatRender: false })).toBeUndefined();
  });
});

describe('saving, loading and merging profiles', () => {
  it('round-trips through a folder and reports invalid files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-profiles-'));
    try {
      const { profile } = await captureProfile(fakeDeps({ page: true }), { firelabVersion: '0.1.0' });
      const file = saveProfile(profile, dir);
      expect(path.basename(file)).toBe('AFTMA08C15.json');
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).$schema).toBe('./schema.json');
      fs.writeFileSync(path.join(dir, 'BROKEN.json'), '{"model": "X"}');
      fs.writeFileSync(path.join(dir, 'NOTJSON.json'), '{');
      const loaded = loadProfiles(dir);
      expect([...loaded.profiles.keys()]).toEqual(['AFTMA08C15']);
      expect(loaded.errors.map((e) => path.basename(e.file)).sort()).toEqual(['BROKEN.json', 'NOTJSON.json']);
      expect(() => saveProfile({ ...profile, model: '' } as DeviceProfile, dir)).toThrow();
      expect(profileFileName('AFT/../x')).toBe('AFT_.._x.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fresh capture fills unknowns but keeps the hand-entered known-good run and recomputes the budget from it', async () => {
    const seed = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'profiles', 'AFTMA08C15.json'), 'utf8')) as DeviceProfile;
    const { profile: fresh } = await captureProfile(fakeDeps({ page: true }), { firelabVersion: '0.2.0' });
    const merged = mergeProfile(seed, fresh);
    expect(validateProfile(merged)).toEqual([]);
    expect(merged.source).toBe('measured');
    expect(merged.webview.major.value).toBe(138); // newly measured
    expect(merged.webgl.maxTextureSize.value).toBe(8192); // newly measured
    expect(merged.memory.knownGoodMB?.value).toBe(561); // kept from the seed
    expect(merged.memory.appBudgetMB.value).toBe(821); // known-good run beats the blank-page estimate
    expect(merged.gpu.speedFactor.value).toBe(2.2);
    expect(merged.references).toHaveLength(2);
    expect(merged.notes?.at(-1)).toMatch(/Merged a measured capture/);
    // A weaker (estimated) value never replaces a measured one.
    const weaker = mergeProfile(seed, { ...fresh, display: { width: { value: 1280, source: 'estimated' }, height: { value: 720, source: 'estimated' } } });
    expect(weaker.display.width.value).toBe(1920);
  });
});
