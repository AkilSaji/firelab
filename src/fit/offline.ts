/**
 * Offline / CI mode: re-score a saved measurement with no device, and gate a
 * build on chosen models.
 */
import type { DeviceProfile } from '../profile/types.js';
import { loadProfiles, defaultProfilesDir } from '../profile/load.js';
import { scoreFit, type ScoreOptions } from './score.js';
import { fitMarkdown } from './markdown.js';
import { ONE_GB_STICKS, type FitMeasurement, type FitReport, type ModelFit } from './types.js';

/** Re-scores a saved measurement against profiles (no device needed). */
export function fitOffline(measurement: FitMeasurement, profiles?: Map<string, DeviceProfile>, opts: ScoreOptions = {}): FitReport {
  return scoreFit(measurement, profiles ?? loadProfiles(defaultProfilesDir()).profiles, opts);
}

export type GateResult = {
  failed: boolean;
  /** The models the gate looked at. */
  models: string[];
  /** Models that tripped it. */
  offenders: ModelFit[];
  /** Models asked for that the report doesn't contain. */
  unknown: string[];
  message: string;
};

/**
 * The CI gate: fails when any of `models` (default: the 1 GB sticks AFTSSS
 * and AFTSS) is ❌, or ⚠️ too with `strict`. "all" checks every model;
 * "none" never fails.
 */
export function ciGate(report: FitReport, models: string[] | 'all' | 'none' = ONE_GB_STICKS, opts: { strict?: boolean } = {}): GateResult {
  if (models === 'none') return { failed: false, models: [], offenders: [], unknown: [], message: 'Gate disabled (--fail-on none).' };
  const ids = models === 'all' ? report.models.filter((m) => m.verdict !== 'not-covered').map((m) => m.model) : models.map((m) => m.toUpperCase());
  const pool = report.models.filter((m) => ids.includes(m.model.toUpperCase()));
  const unknown = ids.filter((id) => !report.models.some((m) => m.model.toUpperCase() === id));
  const bad = (m: ModelFit) => m.verdict === 'wont-run' || (opts.strict === true && m.verdict === 'risky');
  const offenders = pool.filter(bad);
  const label = models === 'all' ? 'all Fire OS models' : ids.join(', ');
  const message = offenders.length
    ? `FireLab fit: ${offenders.map((m) => `${m.name} (${m.model}): ${m.headline}`).join('; ')}.`
    : `FireLab fit: no ${opts.strict ? '❌ or ⚠️' : '❌'} verdicts on ${label}.`;
  return { failed: offenders.length > 0, models: ids, offenders, unknown, message };
}

/** Markdown for $GITHUB_STEP_SUMMARY: the report plus the gate's outcome. */
export function ciSummary(report: FitReport, gate: GateResult): string {
  const head = gate.failed ? `> **❌ Gate failed.** ${gate.message}` : `> **✅ Gate passed.** ${gate.message}`;
  const unknown = gate.unknown.length ? `\n>\n> Unknown models in --fail-on: ${gate.unknown.join(', ')}.` : '';
  return `${head}${unknown}\n\n${fitMarkdown(report, { focus: gate.models })}`;
}
