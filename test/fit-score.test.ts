import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scoreFit, scoreModel, speedRefFor } from '../src/fit/score.js';
import { checkFrames, checkMemory, checkPressure, checkWebgl, pickRun, PASS_MEDIAN, WARN_MEDIAN } from '../src/fit/checks.js';
import { buildTargets } from '../src/fit/targets.js';
import { readMeasurement, emptyMeasurement } from '../src/fit/measurement.js';
import { loadProfiles } from '../src/profile/load.js';
import { parseNeedsFlag } from '../src/fit/needs.js';
import type { FitRun, FitTarget, FrameStats, ModelFit } from '../src/fit/types.js';

const profiles = loadProfiles().profiles;
const targets = buildTargets(profiles);
const t = (model: string) => targets.find((x) => x.model === model) as FitTarget;
const sample = readMeasurement(path.join(import.meta.dirname, 'fixtures', 'fit', 'sample-measurement.json'));
const report = scoreFit(sample, profiles, { now: () => new Date('2026-10-16T00:00:00Z') });
const model = (id: string) => report.models.find((m) => m.model === id) as ModelFit;
const check = (m: ModelFit, id: string) => m.checks.find((c) => c.id === id);
const GE9215 = { factor: 2.2, source: 'measured' as const, name: 'Fire TV Stick 4K Plus', gpu: 'PowerVR Rogue GE9215' };
const frames = (p50: number, p95: number, extra: Partial<FrameStats> = {}): FrameStats => ({ fpsMedian: Math.round((1000 / p50) * 10) / 10, fpsP10: Math.round((1000 / p95) * 10) / 10, frameMsP50: p50, frameMsP95: p95, samples: 15, source: 'page', frameMsFrom: 'page', capped: false, ...extra });

describe('the sample measurement (Fire TV Stick 4K Plus, tiers tv + tv-hd, a simulated AFTSSS run)', () => {
  it('covers every Fire OS model and skips Vega OS', () => {
    expect(report.models).toHaveLength(66);
    expect(report.summary.runs + report.summary.risky + report.summary.wontRun + report.summary.notCovered).toBe(66);
    expect(report.summary.notCovered).toBe(3);
    expect(model('AFTCA002')).toMatchObject({ verdict: 'not-covered', headline: 'Not covered: Vega OS', checks: [] });
    expect(report.evidence).toEqual({ static: false, web: true, measured: true, simulated: true, pressure: true, media: true });
    expect(report.disclaimer).toMatch(/real device is the final word/);
  });

  it('the device it was measured on: measured basis, judged at its own tier', () => {
    const m = model('AFTMA08C15');
    expect(m).toMatchObject({ verdict: 'runs', measuredHere: true });
    expect(check(m, 'memory')).toMatchObject({ status: 'pass', basis: 'measured', confidence: 'high', summary: '545 / 821 MB' });
    expect(check(m, 'memory')?.reason).toMatch(/MemAvailable went down to 362 MB/);
    expect(check(m, 'frames')).toMatchObject({ status: 'pass', basis: 'measured', summary: '27.2 fps' });
    expect(check(m, 'webgl')).toMatchObject({ status: 'pass', basis: 'measured' });
  });

  it('the 1 GB sticks: risky on memory (tv run, 435 MB against 415/458), frames from the simulation', () => {
    const sss = model('AFTSSS');
    expect(sss).toMatchObject({ verdict: 'risky', headline: 'Memory: 435 / 415 MB', basis: 'profile' });
    expect(check(sss, 'memory')).toMatchObject({ status: 'warn', basis: 'profile', confidence: 'medium' });
    expect(check(sss, 'frames')).toMatchObject({ status: 'pass', simulated: true, basis: 'estimated', confidence: 'medium', summary: '~25 fps (sim)' });
    expect(check(sss, 'frames')?.reason).toMatch(/CPU throttled 1\.6x and 2\.2x the pixels to imitate this model/);
    expect(check(sss, 'pressure')).toMatchObject({ status: 'pass', simulated: true });
    expect(check(sss, 'media')).toMatchObject({ status: 'warn', summary: '6.7 Mbps stalls +1', basis: 'profile' });
    expect(sss.fixes.some((f) => /under 415 MB/.test(f))).toBe(true);
    // Same GPU, no profile: the simulation still applies, and says it imitated the AFTSSS.
    const lite = model('AFTSS');
    expect(check(lite, 'frames')?.reason).toMatch(/imitate the AFTSSS \(same GPU\)/);
    expect(check(lite, 'memory')).toMatchObject({ status: 'warn', basis: 'estimated', summary: '435 / 414 MB' });
    expect(report.summary.focus).toEqual({ models: ['AFTSSS', 'AFTSS'], verdict: 'risky', line: 'On the 1 GB sticks, Fire TV Stick (3rd gen), Fire TV Stick Lite (2020): risky (Memory: 435 / 415 MB).' });
  });

  it("ES 2 GPUs can't run a three.js r170 page; memory and frames are then not judged", () => {
    const aftt = model('AFTT');
    expect(aftt).toMatchObject({ verdict: 'wont-run', headline: 'WebGL: no WebGL2', confidence: 'high' });
    expect(check(aftt, 'webgl')?.reason).toMatch(/Mali-450 MP4 is OpenGL ES 2 hardware/);
    expect(check(aftt, 'memory')).toMatchObject({ status: 'skip', summary: 'n/a' });
    expect(check(aftt, 'frames')).toMatchObject({ status: 'skip', reason: "Not judged: it can't start on this model (WebGL)." });
  });

  it('AV1 on models without an AV1 decoder', () => {
    expect(model('AFTMM')).toMatchObject({ verdict: 'wont-run', headline: 'Media: no AV1 decoder' });
    expect(model('AFTR').verdict).toBe('wont-run');
    expect(model('AFTKRT').verdict).toBe('runs');
  });

  it('smart TVs with unpublished RAM: at most risky on memory, low confidence', () => {
    const tvm = model('AFTTI43');
    const mem = check(tvm, 'memory');
    expect(mem).toMatchObject({ status: 'warn', confidence: 'low' });
    expect(mem?.reason).toMatch(/doesn't publish this model's RAM/);
    expect(report.models.filter((m) => m.kind === 'tv').every((m) => check(m, 'memory')?.status !== 'fail')).toBe(true);
  });

  it('media findings list file-level issues once, with the models each problem hits', () => {
    const intro = report.mediaFindings.find((f) => f.source.endsWith('intro.mp4'));
    const faststart = intro?.issues.find((i) => /Not fast-start/.test(i.reason));
    expect(faststart?.models.length).toBe(63);
    const stall = intro?.issues.find((i) => /stalled on this model/.test(i.reason));
    expect(stall?.models).toEqual(['AFTSSS']);
    const finale = report.mediaFindings.find((f) => f.source.endsWith('finale.mp4'));
    expect(finale?.status).toBe('fail');
    expect(finale?.issues.find((i) => i.reason === 'No hardware AV1 decoder.')?.models).toEqual(expect.arrayContaining(['AFTMM', 'AFTR', 'AFTS', 'AFTB']));
  });

  it('picks the measured device as the speed reference', () => {
    expect(speedRefFor(sample, targets, profiles)).toEqual(GE9215);
  });
});

describe('frame-rate scaling', () => {
  const run = (f: FrameStats, extra: Partial<FitRun> = {}): FitRun => ({ label: 'tv', tier: 'tv', seconds: 15, frames: f, ...extra });

  it('thresholds: playable at 80% of target, unplayable below half', () => {
    expect([PASS_MEDIAN, WARN_MEDIAN]).toEqual([0.8, 0.5]);
  });

  it('scales frame times by the GPU speed ratio (GE9215 2.2 -> GE8300 1.0)', () => {
    const c = checkFrames([run(frames(20, 25))], t('AFTSSS'), false, GE9215, 30);
    expect(c.data).toMatchObject({ fps: 22.7, frameMsP50: 44, frameMsP95: 55, ratio: 2.2 });
    expect(c).toMatchObject({ status: 'warn', confidence: 'medium', summary: '~23 fps', basis: 'estimated' });
    expect(checkFrames([run(frames(40, 50))], t('AFTSSS'), false, GE9215, 30)).toMatchObject({ status: 'fail', summary: '~11 fps' });
    expect(checkFrames([run(frames(12, 14))], t('AFTSSS'), false, GE9215, 30).status).toBe('pass');
  });

  it("a run held at the app's frame cap can't prove a failure on a slower model", () => {
    const c = checkFrames([run(frames(33.3, 36, { capped: true, fpsMedian: 30 }))], t('AFTSSS'), false, GE9215, 30);
    expect(c).toMatchObject({ status: 'warn', confidence: 'low' });
    expect(c.reason).toMatch(/between 14 and 30 fps.*--simulate cpu,gpu/);
  });

  it('a run at a richer tier than the model would use is a worst case, not a failure', () => {
    const c = checkFrames([run(frames(36.8, 49.5), { label: 'tv-hd', tier: 'tv-hd' })], t('AFTSSS'), false, GE9215, 30);
    expect(c.status).toBe('warn');
    expect(c.reason).toMatch(/Measured at tv-hd; this model would use tv.*--tiers tv,tv-hd/);
  });

  it('faster models are capped at the frame cap', () => {
    const slow = { factor: 1, source: 'measured' as const, name: 'Fire TV Stick (3rd gen)' };
    const c = checkFrames([run(frames(40, 50))], t('AFTKRT'), false, slow, 30);
    expect(c.data?.fps).toBe(30);
    expect(c.status).toBe('pass');
  });

  it('pickRun prefers the same tier, then richer, then lighter', () => {
    const runs: FitRun[] = [run(frames(30, 40), { label: 'tv-hd', tier: 'tv-hd' }), run(frames(20, 25), { label: 'low', tier: 'low' })];
    expect(pickRun(runs, 'tv', 'frames')).toMatchObject({ match: 'richer', run: { label: 'tv-hd' } });
    expect(pickRun(runs, 'high', 'frames')).toMatchObject({ match: 'lighter', run: { label: 'tv-hd' } });
    expect(pickRun(runs, 'low', 'frames')).toMatchObject({ match: 'tier', run: { label: 'low' } });
    expect(pickRun([run(frames(30, 40), { tier: undefined })], 'tv', 'frames')?.match).toBe('untiered');
    expect(pickRun(runs, 'tv', 'memory')).toBeUndefined();
  });
});

describe('memory against budgets', () => {
  const mem = (totalMB: number, extra: Partial<FitRun> = {}): FitRun => ({ label: 'x', tier: 'tv', seconds: 15, memory: { totalMB, appPssMB: totalMB / 2, rendererPssMB: totalMB / 2, samples: 3 }, ...extra });

  it('pass / warn / fail on the 3rd gen stick (budget 415, limit 458, both from its profile)', () => {
    expect(checkMemory([mem(400)], t('AFTSSS'), false)).toMatchObject({ status: 'pass', basis: 'profile' });
    expect(checkMemory([mem(440)], t('AFTSSS'), false).status).toBe('warn');
    const f = checkMemory([mem(500)], t('AFTSSS'), false);
    expect(f).toMatchObject({ status: 'fail' });
    expect(f.reason).toMatch(/above this model's 458 MB limit/);
  });

  it('a richer-tier run is scaled down by canvas megapixels (60 MB per megapixel, estimated)', () => {
    const c = checkMemory([mem(545, { tier: 'tv-hd', canvas: { width: 1920, height: 1080 } })], t('AFTSSS'), false);
    // 2.07 MP at tv-hd -> 0.92 MP at tv: 69 MB less
    expect(c.data).toMatchObject({ measuredMB: 545, totalMB: 475.9, match: 'richer' });
    expect(c).toMatchObject({ status: 'fail', confidence: 'medium' });
    expect(c.reason).toMatch(/about 69 MB less/);
  });

  it('on the measured device, low MemAvailable during the run is a warning', () => {
    const c = checkMemory([mem(500, { tier: 'tv-hd', memory: { totalMB: 500, memAvailableMinMB: 42, samples: 4 } })], t('AFTMA08C15'), true);
    expect(c).toMatchObject({ status: 'warn', basis: 'measured', confidence: 'high' });
    expect(c.reason).toMatch(/down to 42 MB.*close to the low-memory killer/);
  });

  it('no measurement: not checked', () => {
    expect(checkMemory([], t('AFTSSS'), false).status).toBe('skip');
  });
});

describe('WebGL needs', () => {
  it('a declared WebGL2 need fails on Mali-450; a detected one only warns', () => {
    expect(checkWebgl({ webgl: 2, sources: { webgl: 'page' } }, t('AFTN'), false)).toMatchObject({ status: 'fail', summary: 'no WebGL2', confidence: 'high' });
    expect(checkWebgl({ webgl: 2, sources: { webgl: 'detected' } }, t('AFTN'), false).status).toBe('warn');
    expect(checkWebgl({ webgl: 2, sources: { webgl: 'page' } }, t('AFTS'), false)).toMatchObject({ status: 'warn', summary: 'WebGL2 unknown' });
  });

  it('limits, compressed formats, WebView version and platform features', () => {
    const n = parseNeedsFlag('webgl2,max-texture=8192,etc1,webview>=140,wasm-simd,webgpu');
    const sss = checkWebgl(n, t('AFTSSS'), false);
    expect(sss.status).toBe('fail');
    expect(sss.reason).toMatch(/Needs WebView 140\+; this model has 138/);
    expect(sss.reason).toMatch(/Needs webgpu, which Fire TV WebViews don't offer/);
    const old = checkWebgl(parseNeedsFlag('webgl1,webview>=100'), t('AFTT'), false);
    expect(old).toMatchObject({ status: 'warn', summary: 'WebView version unknown' });
    expect(checkWebgl(parseNeedsFlag('max-texture=8192'), t('AFTT'), false)).toMatchObject({ status: 'fail', summary: 'texture 8192 > 4096' });
    expect(checkWebgl(parseNeedsFlag('s3tc'), t('AFTSSS'), false)).toMatchObject({ status: 'fail', summary: 'no S3TC' });
    expect(checkWebgl(undefined, t('AFTSSS'), false).status).toBe('skip');
  });

  it('uses the live caps on the measured device', () => {
    const c = checkWebgl(parseNeedsFlag('ext:OES_texture_float_linear,float-render'), t('AFTMA08C15'), true, sample.webCaps);
    expect(c).toMatchObject({ status: 'pass', basis: 'measured', confidence: 'high' });
  });
});

describe('memory pressure (simulated)', () => {
  it('crash on a model where memory is already tight fails; elsewhere it warns', () => {
    const p = { level: 'RUNNING_CRITICAL', outcome: 'crashed' as const, detail: 'The app process is gone.' };
    expect(checkPressure(p, t('AFTSSS'), 'warn')).toMatchObject({ status: 'fail', simulated: true });
    expect(checkPressure(p, t('AFTKRT'), 'pass')).toMatchObject({ status: 'warn' });
    expect(checkPressure({ ...p, outcome: 'reloaded' }, t('AFTSSS'), 'pass').summary).toBe('reloaded under pressure');
    expect(checkPressure({ ...p, outcome: 'unknown', detail: 'no shell' }, t('AFTSSS'), 'pass').status).toBe('skip');
    expect(checkPressure(undefined, t('AFTSSS'), 'pass').status).toBe('skip');
  });
});

describe('verdict rules', () => {
  it('runs = weakest basis and confidence; a failure = the strongest failing check', () => {
    const m = emptyMeasurement({ device: { model: 'AFTMA08C15', gpu: 'PowerVR Rogue GE9215' }, runs: [{ label: 'tv', tier: 'tv', seconds: 15, frames: frames(20, 24), memory: { totalMB: 520, samples: 3 } }] });
    const { fit } = scoreModel(m, t('AFTSSS'), GE9215, 30);
    expect(fit.verdict).toBe('wont-run'); // 520 MB > 458 limit and ~23 fps
    expect(fit).toMatchObject({ headline: 'Memory: 520 / 415 MB', basis: 'profile' });
    const { fit: ok } = scoreModel(m, t('AFTKRT'), GE9215, 30);
    expect(ok).toMatchObject({ verdict: 'runs', basis: 'estimated' });
  });
});
