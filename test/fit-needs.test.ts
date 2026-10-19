import { describe, expect, it } from 'vitest';
import { parseNeedsFlag, needsFromDeclaration, needsFromUsage, mergeNeeds, isHard } from '../src/fit/needs.js';
import { budgetFromRun, budgetFromAvail, estimateBudget, memoryBudget, RATIOS } from '../src/fit/memory.js';
import { GPU_FAMILIES, gpuFamily, CPU_FACTORS } from '../src/fit/gpus.js';
import { FIRE_TV_MODELS } from '../src/adb/models.js';
import { fact } from '../src/profile/types.js';

describe('--needs', () => {
  it('parses every kind of need', () => {
    expect(parseNeedsFlag('webgl2, astc,etc2 max-texture=4096,max-renderbuffer:2048,float-render,webview>=110,ext:EXT_disjoint_timer_query,WEBGL_multi_draw,wasm-simd')).toEqual({
      webgl: 2,
      compressed: ['astc', 'etc2'],
      maxTextureSize: 4096,
      maxRenderbufferSize: 2048,
      floatRender: true,
      minWebView: 110,
      extensions: ['EXT_disjoint_timer_query', 'WEBGL_multi_draw'],
      features: ['wasm-simd'],
      sources: { webgl: 'flag', compressed: 'flag', maxTextureSize: 'flag', maxRenderbufferSize: 'flag', floatRender: 'flag', minWebView: 'flag', extensions: 'flag', features: 'flag' },
    });
    expect(() => parseNeedsFlag('webgl3')).toThrow(/Unknown need "webgl3"/);
  });

  it("reads the page's own declaration (window.firelab.needs)", () => {
    expect(needsFromDeclaration({ webgl: 2, compressed: ['ASTC', 'nope'], maxTextureSize: 4096, minWebView: 100, features: ['WASM'], floatRender: true })).toEqual({
      webgl: 2,
      compressed: ['astc'],
      maxTextureSize: 4096,
      minWebView: 100,
      features: ['wasm'],
      floatRender: true,
      sources: { webgl: 'page', compressed: 'page', maxTextureSize: 'page', minWebView: 'page', features: 'page', floatRender: 'page' },
    });
    expect(needsFromDeclaration({ webgl2: true })?.webgl).toBe(2);
    expect(needsFromDeclaration({})).toBeUndefined();
    expect(needsFromDeclaration('webgl2')).toBeUndefined();
  });

  it('infers WebGL2 for three.js r163+, otherwise treats usage as soft', () => {
    const three = needsFromUsage({ threeRevision: '170', canvasContexts: ['webgl2'] });
    expect(three).toMatchObject({ webgl: 2, sources: { webgl: 'inferred' } });
    expect(isHard(three!, 'webgl')).toBe(true);
    const old = needsFromUsage({ threeRevision: '150', contexts: { webgl2: true }, compressedFormats: [0x93b0, 0x9274, 0x1234], maxTexture: 4096, maxRenderbuffer: 1024, floatRender: true });
    expect(old).toMatchObject({ webgl: 2, compressed: ['astc', 'etc2'], maxTextureSize: 4096, floatRender: true, sources: { webgl: 'detected', compressed: 'detected' } });
    expect(old?.maxRenderbufferSize).toBeUndefined(); // small sizes are not a need
    expect(isHard(old!, 'webgl')).toBe(false);
    expect(needsFromUsage({ canvasContexts: ['webgl'] })).toMatchObject({ webgl: 1 });
    expect(needsFromUsage({ canvasContexts: ['2d'] })).toBeUndefined();
  });

  it('merges with flag > page > inferred > detected', () => {
    const m = mergeNeeds(needsFromUsage({ contexts: { webgl2: true }, maxTexture: 8192 }), needsFromDeclaration({ webgl: 1 }), parseNeedsFlag('max-texture=4096'));
    expect(m).toMatchObject({ webgl: 1, maxTextureSize: 4096, sources: { webgl: 'page', maxTextureSize: 'flag' } });
    expect(mergeNeeds(undefined, undefined)).toBeUndefined();
  });
});

describe('memory budgets', () => {
  it('reproduces the calibration runs', () => {
    expect(budgetFromRun(415, 83)).toEqual({ budget: 415, limit: 458 }); // AFTSSS
    expect(budgetFromRun(561, 360)).toEqual({ budget: 821, limit: 881 }); // AFTMA08C15
    expect(budgetFromAvail(400)).toEqual({ budget: 420, limit: 480 });
  });

  it('estimates from RAM between the 1 GB and 2 GB calibrations', () => {
    expect(estimateBudget(1024)).toEqual({ total: 901, budget: 414, limit: 460 });
    expect(estimateBudget(2048)).toEqual({ total: 1669, budget: 818, limit: 885 });
    const mid = estimateBudget(1536);
    expect(mid.budget).toBeGreaterThan(414);
    expect(mid.budget).toBeLessThan(818);
    expect(RATIOS['1GB'].budget).toBe(0.46);
  });

  it('prefers explicit budgets, then a known-good run, then a WebView reading, then RAM', () => {
    expect(memoryBudget({ appBudgetMB: fact(300, 'measured'), appLimitMB: fact(350, 'estimated'), knownGoodMB: fact(999, 'measured'), lowestAvailMB: fact(1, 'measured') }).budgetMB.value).toBe(300);
    expect(memoryBudget({ knownGoodMB: fact(415, 'measured'), lowestAvailMB: fact(83, 'measured') }).budgetMB).toMatchObject({ value: 415, source: 'measured' });
    expect(memoryBudget({ knownGoodMB: fact(561, 'measured'), lowestAvailMB: fact(360, 'measured') }).budgetMB).toMatchObject({ value: 821, source: 'estimated' });
    expect(memoryBudget({ availWebViewMB: fact(400, 'measured') }).limitMB.value).toBe(480);
    expect(memoryBudget({ ramMB: 2048 }).budgetMB).toMatchObject({ value: 818, source: 'estimated' });
    expect(memoryBudget({}).budgetMB.note).toMatch(/assumed 1 GB/);
  });
});

describe('speed table', () => {
  it('GE8300 is the measured baseline and GE9215 is 2-2.3x; the rest are estimates', () => {
    expect(gpuFamily('PowerVR Rogue GE8300')).toMatchObject({ factor: 1, source: 'measured' });
    expect(gpuFamily('PowerVR Rogue GE9215')).toMatchObject({ factor: 2.2, range: [2, 2.3], source: 'measured' });
    expect(GPU_FAMILIES.filter((g) => g.source === 'measured').map((g) => g.id)).toEqual(['ge8300', 'ge9215']);
    expect(gpuFamily('Mali-450 MP4')).toMatchObject({ id: 'mali-450-mp4', webgl2: false, glEs: 2 });
    expect(gpuFamily('Mali-G52 MP8')?.id).toBe('mali-g52-big');
    expect(gpuFamily('Mali-G52 2EE')?.id).toBe('mali-g52-1');
    expect(gpuFamily('Something Else')).toBeUndefined();
  });

  it('every Fire OS GPU in the model table has a speed entry, and every stick a CPU entry', () => {
    const fireOs = FIRE_TV_MODELS.filter((m) => !/vega/i.test(m.platform ?? ''));
    expect(fireOs.filter((m) => !gpuFamily(m.gpu)).map((m) => `${m.model} ${m.gpu}`)).toEqual([]);
    expect(fireOs.filter((m) => m.kind !== 'tv' && !CPU_FACTORS[m.model]).map((m) => m.model)).toEqual([]);
  });
});
