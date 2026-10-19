import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILE_SCHEMA, validateProfile, validateSchema, assertProfile } from '../src/profile/schema.js';
import { loadProfiles, defaultProfilesDir } from '../src/profile/load.js';
import { factSummary } from '../src/profile/capture.js';
import type { DeviceProfile } from '../src/profile/types.js';

const dir = path.join(import.meta.dirname, '..', 'profiles');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as DeviceProfile;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('profiles/schema.json', () => {
  it('is generated from PROFILE_SCHEMA (run the snippet in profiles/README.md after changing it)', () => {
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'schema.json'), 'utf8'))).toEqual(PROFILE_SCHEMA);
  });

  it('every bundled profile is valid', () => {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'schema.json');
    expect(files.sort()).toEqual(['AFTMA08C15.json', 'AFTSSS.json']);
    for (const f of files) expect(validateProfile(read(f)), f).toEqual([]);
    expect(defaultProfilesDir()).toBe(dir);
    const loaded = loadProfiles();
    expect(loaded.errors).toEqual([]);
    expect([...loaded.profiles.keys()].sort()).toEqual(['AFTMA08C15', 'AFTSSS']);
  });
});

describe('seed profiles carry the real measurements, and say which fields are measured', () => {
  it('AFTSSS (Fire TV Stick 3rd gen)', () => {
    const p = read('AFTSSS.json');
    expect(p).toMatchObject({ model: 'AFTSSS', name: 'Fire TV Stick (3rd gen)', source: 'manual' });
    expect(p.os.fireOs).toMatchObject({ value: '7.7.1.7', source: 'measured' });
    expect(p.os.sdk).toMatchObject({ value: 28, source: 'measured' });
    expect(p.cpu.abis).toMatchObject({ value: ['armeabi-v7a', 'armeabi'], source: 'measured' });
    expect(p.cpu.maxGHz).toMatchObject({ value: 1.69, source: 'measured' });
    expect(p.memory.totalMB).toMatchObject({ value: 900.7, source: 'measured' });
    expect(p.memory.knownGoodMB).toMatchObject({ value: 415, source: 'measured' });
    expect(p.memory.lowestAvailMB).toMatchObject({ value: 83, source: 'measured' });
    expect(p.memory.appBudgetMB).toMatchObject({ value: 415, source: 'measured' });
    expect(p.memory.appLimitMB).toMatchObject({ value: 458, source: 'estimated' });
    expect(p.gpu.renderer).toMatchObject({ value: 'PowerVR Rogue GE8300', source: 'measured' });
    expect(p.gpu.speedFactor.value).toBe(1);
    expect(p.webgl.webgl2).toMatchObject({ value: true, source: 'measured' });
    expect(p.webgl.mediumpFp16).toMatchObject({ value: true, source: 'measured' });
    expect(p.webgl.maxTextureSize).toEqual({ value: null, source: 'unknown' });
    expect(p.webview.major).toMatchObject({ value: 138, source: 'measured' });
    expect(p.media.streamStallMbps).toMatchObject({ value: 6.7, source: 'measured' });
    expect(p.media.streamOkMbps).toMatchObject({ value: 4.5, source: 'measured' });
    expect(p.references?.find((r) => r.tier === 'tv' && r.fps === 27)).toMatchObject({ resolution: '768x432', drawCalls: 175, triangles: 250000 });
    expect(p.references?.find((r) => r.tier === 'tv-hd')?.fps).toEqual([13, 17]);
    expect(p.notes?.join(' ')).toMatch(/keepalive fetches after about 11/);
    const s = factSummary(p);
    expect(s.measured.length).toBeGreaterThan(15);
    expect(s.unknown).toContain('webgl.extensions');
  });

  it('AFTMA08C15 is the Fire TV Stick 4K Plus; unmeasured fields are unknown', () => {
    const p = read('AFTMA08C15.json');
    expect(p.name).toBe('Fire TV Stick 4K Plus');
    expect(p.os.fireOs.value).toMatch(/^8\.1/);
    expect(p.gpu.renderer.value).toBe('PowerVR Rogue GE9215');
    expect(p.gpu.speedFactor).toMatchObject({ value: 2.2, source: 'measured' });
    expect(p.memory.totalMB.value).toBe(1670);
    expect(p.memory.knownGoodMB?.value).toBe(561);
    expect(p.memory.lowestAvailMB?.value).toBe(360);
    expect(p.memory.appBudgetMB).toMatchObject({ value: 821, source: 'estimated' });
    expect(p.memory.appLimitMB).toMatchObject({ value: 881, source: 'estimated' });
    expect(p.webview.major).toEqual({ value: null, source: 'unknown' });
    expect(p.media.decoders.source).toBe('unknown');
    expect(p.references?.[0]).toMatchObject({ fps: [25, 30], appPssMB: [270, 295], rendererPssMB: [210, 266], memAvailableMB: [360, 390] });
  });
});

describe('the validator', () => {
  const good = read('AFTSSS.json');

  it('reports missing fields, bad enums, unknown fields and wrong types', () => {
    const p = clone(good) as unknown as Record<string, unknown>;
    delete p.memory;
    (p as { source: string }).source = 'guessed';
    (p as { extra: number }).extra = 1;
    (p.os as { sdk: unknown }).sdk = { value: '28', source: 'measured' };
    const errs = validateProfile(p).map((e) => `${e.path} ${e.message}`);
    expect(errs).toContain('$.memory is required');
    expect(errs.some((e) => e.startsWith('$.source must be one of'))).toBe(true);
    expect(errs).toContain('$.extra is not a known field');
    expect(errs.some((e) => e.startsWith('$.os.sdk.value'))).toBe(true);
  });

  it('enforces unknown <=> null and budget <= limit', () => {
    const a = clone(good);
    a.webgl.maxTextureSize = { value: 4096, source: 'unknown' };
    expect(validateProfile(a).map((e) => e.path)).toContain('$.webgl.maxTextureSize');
    const b = clone(good);
    b.os.build = { value: null, source: 'measured' };
    expect(validateProfile(b)[0]?.message).toMatch(/use "unknown"/);
    const c = clone(good);
    c.memory.appBudgetMB = { value: 900, source: 'estimated' };
    expect(validateProfile(c)[0]?.message).toMatch(/above the limit/);
    expect(() => assertProfile(c, 'c.json')).toThrow(/c\.json is not a valid FireLab device profile/);
  });

  it('checks patterns, ranges and $refs in decoders and references', () => {
    const p = clone(good);
    p.media.decoders = { value: [{ codec: 'avc', supported: true, maxLevel: 'four' }, { codec: 'mpeg4' as 'avc', supported: null }], source: 'measured' };
    p.references = [{ app: 'x', fps: [1, 2, 3] as unknown as [number, number] }];
    const errs = validateProfile(p).map((e) => e.path);
    expect(errs.some((e) => e.includes('maxLevel'))).toBe(true);
    expect(errs.some((e) => e.includes('decoders.value[1].codec'))).toBe(true);
    expect(errs.some((e) => e.includes('references[0].fps'))).toBe(true);
  });

  it('validateSchema basics', () => {
    expect(validateSchema({ type: 'integer', minimum: 1 }, 0)[0]?.message).toBe('must be >= 1');
    expect(validateSchema({ type: ['boolean', 'null'] }, null)).toEqual([]);
    expect(validateSchema({ $ref: '#/$defs/nope' }, 1)[0]?.message).toMatch(/unresolvable/);
    expect(validateSchema({ const: 1 }, 2)[0]?.message).toBe('must be 1');
  });
});
