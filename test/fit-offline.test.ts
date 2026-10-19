import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fitOffline, ciGate, ciSummary } from '../src/fit/offline.js';
import { readMeasurement, writeMeasurement, parseMeasurement, measurementProblems, emptyMeasurement } from '../src/fit/measurement.js';
import { fitMarkdown, fitText } from '../src/fit/markdown.js';
import { runFitCli, type FitIo } from '../src/fit/cli.js';
import type { FitMeasurement } from '../src/fit/types.js';

const SAMPLE = path.join(import.meta.dirname, 'fixtures', 'fit', 'sample-measurement.json');
const APK_PHONE = path.join(import.meta.dirname, 'fixtures', 'fit', 'fixture-phone.apk');
const APK_TV = path.join(import.meta.dirname, 'fixtures', 'fit', 'fixture-tv.apk');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-offline-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sample = readMeasurement(SAMPLE);

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const x: FitIo = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    lab: () => {
      throw new Error('the offline tests must not touch a device');
    },
  };
  return { io: x, out, err };
}

describe('measurement files', () => {
  it('round-trip and validate', () => {
    const file = path.join(tmp, 'm.json');
    writeMeasurement(sample, file);
    expect(readMeasurement(file)).toEqual(sample);
    expect(measurementProblems({ kind: 'nope', version: 2, runs: [{ frames: { fpsMedian: 'x' } }] })).toEqual([
      'kind must be "firelab-measurement"',
      'unsupported version 2 (this FireLab reads version 1)',
      'app is missing',
      'runs[0].label is missing',
      'runs[0].frames needs fpsMedian, frameMsP50 and frameMsP95',
    ]);
    expect(() => parseMeasurement('{', 'x.json')).toThrow(/x\.json is not JSON/);
    expect(() => parseMeasurement('{"kind":"firelab-fit"}')).toThrow(/not a FireLab measurement/);
    // Missing optional arrays are filled in.
    expect(parseMeasurement(JSON.stringify({ kind: 'firelab-measurement', version: 1, app: {}, runs: [] }))).toMatchObject({ media: [], notes: [], targetFps: 30 });
  });
});

describe('fitOffline and the CI gate', () => {
  const report = fitOffline(sample);

  it('re-scores with the bundled profiles, no device', () => {
    expect(report.models.find((m) => m.model === 'AFTSSS')?.verdict).toBe('risky');
  });

  it('default gate: the 1 GB sticks, fails only on ❌', () => {
    const g = ciGate(report);
    expect(g).toMatchObject({ failed: false, models: ['AFTSSS', 'AFTSS'], offenders: [], unknown: [] });
    expect(g.message).toBe('FireLab fit: no ❌ verdicts on AFTSSS, AFTSS.');
  });

  it('--strict counts ⚠️, "all" checks every model, "none" never fails, unknown ids are reported', () => {
    expect(ciGate(report, undefined, { strict: true }).offenders.map((m) => m.model)).toEqual(['AFTSSS', 'AFTSS']);
    const all = ciGate(report, 'all');
    expect(all.failed).toBe(true);
    expect(all.offenders.map((m) => m.model)).toContain('AFTT');
    expect(ciGate(report, 'none').failed).toBe(false);
    expect(ciGate(report, ['aftmm', 'NOPE'])).toMatchObject({ failed: true, unknown: ['NOPE'] });
  });

  it('writes a Markdown step summary with the gate result on top', () => {
    const md = ciSummary(report, ciGate(report, ['AFTMM']));
    expect(md.startsWith('> **❌ Gate failed.** FireLab fit: Fire TV Stick 4K (1st gen) (AFTMM): Media: no AV1 decoder.')).toBe(true);
    expect(md).toContain('## FireLab fit: Example three.js game (synthetic)');
    expect(md).toContain('| **Fire TV Stick (3rd gen)** `AFTSSS` 1 GB | ⚠️ risky |');
    expect(md).toContain('### Media');
    expect(md).toContain('<details><summary>All 66 models</summary>');
    expect(md).toMatch(/> These verdicts are estimates/);
  });

  it('plain text lists problems and the focus models', () => {
    const txt = fitText(report);
    expect(txt.split('\n')[0]).toBe(report.summary.headline);
    expect(txt).toMatch(/⚠️ {2}Fire TV Stick \(3rd gen\) \(AFTSSS\)/);
    expect(txt).toMatch(/more models that run \(--all to list them\)/);
    expect(fitMarkdown(report, { full: false })).not.toContain('All 66 models');
  });
});

describe('the fit CLI, offline and static (no device)', () => {
  it('--offline writes the report, the summary and exits 0 when the gate passes', async () => {
    const { io: x, out, err } = io();
    const html = path.join(tmp, 'fit.html');
    const summary = path.join(tmp, 'summary.md');
    const md = path.join(tmp, 'fit.md');
    const code = await runFitCli('fit', ['--offline', SAMPLE, '--report', html, '--summary', summary, '--markdown', md], x);
    expect(code).toBe(0);
    expect(fs.readFileSync(html, 'utf8')).toMatch(/^<!doctype html>/);
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/^> \*\*✅ Gate passed\.\*\*/);
    expect(fs.readFileSync(md, 'utf8')).toMatch(/^## FireLab fit/);
    expect(out.join('\n')).toMatch(/On the 1 GB sticks/);
    expect(err.join('\n')).toMatch(/Report: .*fit\.html/);
  });

  it('exits 2 when a gated model is ❌, and prints JSON with --json', async () => {
    const { io: x, out } = io();
    const code = await runFitCli('fit', ['--offline', SAMPLE, '--fail-on', 'AFTMM,AFTSSS', '--json'], x);
    expect(code).toBe(2);
    const r = JSON.parse(out.join('\n'));
    expect(r.kind).toBe('firelab-fit');
    expect(r.summary.focus.models).toEqual(['AFTSSS', 'AFTSS']);
  });

  it('--strict makes ⚠️ fail the default gate', async () => {
    const { io: x } = io();
    expect(await runFitCli('fit', ['--offline', SAMPLE, '--strict'], x)).toBe(2);
  });

  it('--offline can add an APK and needs to a saved measurement', async () => {
    const { io: x, out } = io();
    const code = await runFitCli('fit', ['--offline', SAMPLE, '--apk', APK_PHONE, '--needs', 'webgl2', '--json', '--fail-on', 'none'], x);
    expect(code).toBe(0);
    const r = JSON.parse(out.join('\n'));
    const aftmm = r.models.find((m: { model: string }) => m.model === 'AFTMM');
    expect(aftmm.checks.find((c: { id: string }) => c.id === 'sdk').status).toBe('fail');
  });

  it('--static scores an APK without a device', async () => {
    const { io: x, out } = io();
    const code = await runFitCli('fit', ['--static', '--apk', APK_TV, '--models', 'AFTSSS,AFTKRT', '--all'], x);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/Of 2 Fire OS models, it runs on 2/);
  });

  it('bad input is an error with exit 1', async () => {
    const { io: x, err } = io();
    expect(await runFitCli('fit', ['--offline', path.join(tmp, 'missing.json')], x)).toBe(1);
    expect(await runFitCli('fit', ['--static', '--needs', 'webgl9'], x)).toBe(1);
    expect(err.join('\n')).toMatch(/Unknown need "webgl9"/);
    expect(await runFitCli('nope', [], x)).toBe(1);
  });

  it('a saved measurement with a media-free, device-free run still scores', async () => {
    const m: FitMeasurement = emptyMeasurement({ device: { model: 'AFTSSS', name: 'Fire TV Stick (3rd gen)', gpu: 'PowerVR Rogue GE8300' }, runs: [{ label: 'current', tier: 'tv', seconds: 20, frames: { fpsMedian: 26, fpsP10: 23, frameMsP50: 38.5, frameMsP95: 47, samples: 20, source: 'page', frameMsFrom: 'page', capped: false }, memory: { totalMB: 415, appPssMB: 210, rendererPssMB: 205, memAvailableMinMB: 83, samples: 7 } }] });
    const file = path.join(tmp, 'sv-aftsss.json');
    writeMeasurement(m, file);
    const { io: x, out } = io();
    expect(await runFitCli('fit', ['--offline', file, '--json'], x)).toBe(0);
    const r = JSON.parse(out.join('\n'));
    const sss = r.models.find((mm: { model: string }) => mm.model === 'AFTSSS');
    expect(sss).toMatchObject({ verdict: 'runs', measuredHere: true });
    // The same app measured on the 3rd gen stick scales up to the 4K sticks.
    expect(r.models.find((mm: { model: string }) => mm.model === 'AFTKRT').checks.find((c: { id: string }) => c.id === 'frames').data.fps).toBe(30);
  });

  it('media command prints per-file findings', async () => {
    const { io: x, out } = io();
    const { mp4, h264_1080p } = await import('./media-fixtures.js');
    const file = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(file, mp4({ video: h264_1080p() }));
    expect(await runFitCli('media', [file, '--models', 'AFTSSS,AFTKRT'], x)).toBe(0);
    expect(out.join('\n')).toMatch(/6\.7 Mbps H\.264 stalled on this model over Wi-Fi.*\[AFTSSS\]/);
  });
});
