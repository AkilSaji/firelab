/**
 * firelab-measurement.json: the portable record of a fit run (app, device,
 * WebGL needs and caps, runs, memory pressure, media), so `fit --offline`
 * can re-score it later, in CI, without the device.
 */
import fs from 'node:fs';
import { firelabVersion } from '../lib/paths.js';
import type { FitMeasurement } from './types.js';

export const MEASUREMENT_FILE = 'firelab-measurement.json';

export function emptyMeasurement(init: Partial<FitMeasurement> = {}, now: Date = new Date()): FitMeasurement {
  return {
    kind: 'firelab-measurement',
    version: 1,
    createdAt: now.toISOString(),
    firelabVersion: firelabVersion(),
    app: {},
    targetFps: 30,
    runs: [],
    media: [],
    notes: [],
    ...init,
  };
}

/** Checks the shape enough to score it safely; returns problems (empty = fine). */
export function measurementProblems(data: unknown): string[] {
  const p: string[] = [];
  if (!data || typeof data !== 'object') return ['not a JSON object'];
  const m = data as Record<string, unknown>;
  if (m.kind !== 'firelab-measurement') p.push('kind must be "firelab-measurement"');
  if (m.version !== 1) p.push(`unsupported version ${String(m.version)} (this FireLab reads version 1)`);
  if (!m.app || typeof m.app !== 'object') p.push('app is missing');
  if (!Array.isArray(m.runs)) p.push('runs must be an array');
  else
    (m.runs as unknown[]).forEach((r, i) => {
      if (!r || typeof r !== 'object') return p.push(`runs[${i}] is not an object`);
      const run = r as Record<string, unknown>;
      if (typeof run.label !== 'string') p.push(`runs[${i}].label is missing`);
      const f = run.frames as Record<string, unknown> | undefined;
      if (f && (typeof f.fpsMedian !== 'number' || typeof f.frameMsP50 !== 'number' || typeof f.frameMsP95 !== 'number')) p.push(`runs[${i}].frames needs fpsMedian, frameMsP50 and frameMsP95`);
      const mem = run.memory as Record<string, unknown> | undefined;
      if (mem && mem.totalMB !== undefined && typeof mem.totalMB !== 'number') p.push(`runs[${i}].memory.totalMB must be a number`);
    });
  if (m.media !== undefined && !Array.isArray(m.media)) p.push('media must be an array');
  if (m.targetFps !== undefined && typeof m.targetFps !== 'number') p.push('targetFps must be a number');
  return p;
}

export function parseMeasurement(text: string, label = 'measurement'): FitMeasurement {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not JSON: ${(e as Error).message}`);
  }
  const problems = measurementProblems(data);
  if (problems.length) throw new Error(`${label} is not a FireLab measurement: ${problems.join('; ')}`);
  const m = data as FitMeasurement;
  return { ...m, media: m.media ?? [], notes: m.notes ?? [], targetFps: m.targetFps ?? 30 };
}

export function readMeasurement(file: string): FitMeasurement {
  return parseMeasurement(fs.readFileSync(file, 'utf8'), file);
}

export function writeMeasurement(m: FitMeasurement, file: string = MEASUREMENT_FILE): string {
  fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  return file;
}
