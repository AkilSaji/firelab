import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIRE_TV_MODELS, friendlyName, lookupModel, osLabel, tierForGpu, tierForModel, fireOsForSdk, isFireTv } from '../src/adb/models.js';
import { parseGetprop, parseWmSize, parseWmDensity, parseMemTotalMB, splitSections } from '../src/adb/getprop.js';
import { parseDeviceInfo } from '../src/adb/info.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

describe('getprop', () => {
  it('parses the real property dump of an AFTMA08C15', () => {
    const p = parseGetprop(fx('getprop-AFTMA08C15.txt'));
    expect(p['ro.product.model']).toBe('AFTMA08C15');
    expect(p['ro.build.mktg.fireos']).toBe('Fire OS 8.1.8.2');
    expect(p['ro.product.cpu.abilist64']).toBe('');
    expect(p['ro.build.version.sdk']).toBe('30');
  });
  it('reads wm size/density, override first', () => {
    expect(parseWmSize('Physical size: 1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseWmSize('Physical size: 1920x1080\nOverride size: 1280x720')).toEqual({ width: 1280, height: 720, physical: { width: 1920, height: 1080 } });
    expect(parseWmDensity('Physical density: 320\nOverride density: 240')).toBe(240);
    expect(parseMemTotalMB('MemTotal:        1710032 kB')).toBe(1670);
  });
  it('splits @@ sections', () => {
    expect(splitSections('a\n@@one\nb\nc\n@@two\n')).toEqual({ _: 'a', one: 'b\nc', two: '' });
  });
});

describe('device info', () => {
  it('builds a full DeviceInfo from one shell round trip (real fixture)', () => {
    const info = parseDeviceInfo('192.168.1.194:5555', fx('deviceinfo-AFTMA08C15.txt'));
    expect(info).toMatchObject({
      model: 'AFTMA08C15',
      manufacturer: 'Amazon',
      name: 'Fire TV Stick 4K Plus',
      os: 'Fire OS 8.1.8.2 (Android 11)',
      sdk: 30,
      abi: 'armeabi-v7a',
      abis: ['armeabi-v7a', 'armeabi'],
      ramMB: 1670,
      resolution: { width: 1920, height: 1080 },
      density: 320,
      codename: 'karat',
      soc: 'mt8696',
      gpu: 'PowerVR GE9215',
      gpuSource: 'spec',
      tier: 'tv-hd',
      fireOs: true,
    });
  });

  it('labels a Fire OS 7 Stick from ro.build.version.name', () => {
    const props = { 'ro.product.model': 'AFTSSS', 'ro.product.manufacturer': 'Amazon', 'ro.build.version.sdk': '28', 'ro.build.version.release': '9', 'ro.build.version.name': 'Fire OS 7.7.1.7 (PS7717/5741)' };
    expect(osLabel(props)).toBe('Fire OS 7.7.1.7 (Android 9)');
  });

  it('falls back to the SDK level for old Fire OS builds, and plain Android elsewhere', () => {
    expect(osLabel({ 'ro.product.model': 'AFTT', 'ro.product.manufacturer': 'Amazon', 'ro.build.version.sdk': '22', 'ro.build.version.release': '5.1.1' })).toBe('Fire OS 5 (Android 5.1.1)');
    expect(osLabel({ 'ro.product.model': 'MiTV-AXSO0', 'ro.product.manufacturer': 'Xiaomi', 'ro.build.version.sdk': '30', 'ro.build.version.release': '11' })).toBe('Android 11');
    expect(fireOsForSdk(25)).toBe('Fire OS 6');
    expect(fireOsForSdk(19)).toBeUndefined();
  });
});

describe('Fire TV model table', () => {
  it('names models from Amazon\'s spec pages', () => {
    expect(friendlyName('AFTSSS')).toBe('Fire TV Stick (3rd gen)');
    expect(friendlyName('AFTKRT')).toBe('Fire TV Stick 4K Max (2nd gen)');
    expect(friendlyName('AFTKA')).toBe('Fire TV Stick 4K Max (1st gen)');
    expect(friendlyName('AFTKM')).toBe('Fire TV Stick 4K (2nd gen)');
    expect(friendlyName('AFTMA08C15')).toBe('Fire TV Stick 4K Plus');
    expect(friendlyName('AFTGAZL')).toBe('Fire TV Cube (3rd gen)');
    expect(friendlyName('aftmm')).toBe('Fire TV Stick 4K (1st gen)');
  });
  it('degrades gracefully for unknown models', () => {
    expect(friendlyName('AFTZZZ99', 'Toshiba')).toBe('Toshiba Fire TV device (AFTZZZ99)');
    expect(friendlyName('AFTZZZ99', 'Amazon')).toBe('Fire TV device (AFTZZZ99)');
    expect(friendlyName('MiTV-AXSO0', 'Xiaomi')).toBe('Xiaomi MiTV-AXSO0');
    expect(isFireTv('KFTRWI', 'Amazon')).toBe(false); // a Fire tablet
  });
  it('has unique model ids and a tier for every Android-based entry', () => {
    const ids = FIRE_TV_MODELS.map((m) => m.model);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of FIRE_TV_MODELS) {
      if (m.platform?.startsWith('Vega')) continue;
      expect(tierForModel(m.model), m.model).toBeDefined();
    }
    expect(lookupModel('AFTSS')?.name).toMatch(/Lite/);
  });
});

describe('tierForGpu (shared tier vocabulary)', () => {
  it.each([
    ['Mali-450 MP', 'low'],
    ['Mali-T720', 'low'],
    ['VideoCore IV', 'low'],
    ['PowerVR Rogue GE8300', 'tv'],
    ['Mali-G31 MP2', 'tv'],
    ['Adreno (TM) 506', 'tv'],
    ['Adreno (TM) 306', 'low'],
    ['Mali-T820 MP3', 'low'],
    ['PowerVR Rogue GE9215', 'tv-hd'],
    ['PowerVR GE9215', 'tv-hd'],
    ['Mali-G52 MC2', 'tv-hd'],
    ['Adreno (TM) 650', 'tv-hd'],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'high'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ])('%s -> %s', (gpu, tier) => {
    expect(tierForGpu(gpu)).toBe(tier);
  });
  it('returns undefined when it cannot tell', () => {
    expect(tierForGpu('Some Future GPU 9000')).toBeUndefined();
    expect(tierForGpu(undefined)).toBeUndefined();
  });
});
