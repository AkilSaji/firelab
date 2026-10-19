/**
 * Scores a measurement against every model: runs each check per model,
 * folds the results into a verdict (✅ runs / ⚠️ risky / ❌ won't run) with
 * reasons, fixes, a basis and a confidence, and writes the summary.
 */
import { firelabVersion } from '../lib/paths.js';
import { lookupModel } from '../adb/models.js';
import type { DeviceProfile } from '../profile/types.js';
import { gpuFamily } from './gpus.js';
import { buildTarget, buildTargets } from './targets.js';
import { checkAbi, checkFeatures, checkFrames, checkGles, checkLeanback, checkMediaOn, checkMemory, checkPressure, checkSdk, checkWebgl, worstStatus, type SpeedRef } from './checks.js';
import { ONE_GB_STICKS, VERDICT_LABEL, type Basis, type CheckResult, type CheckStatus, type Confidence, type FitMeasurement, type FitReport, type FitTarget, type MediaFinding, type ModelFit, type Verdict } from './types.js';

export const DISCLAIMER =
  'These verdicts are estimates built from one device, community device profiles and published specs. The real device is the final word: before you ship, test on the slowest model you plan to support.';

const BASIS_RANK: Record<Basis, number> = { estimated: 0, profile: 1, measured: 2 };
const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const strongest = <T extends string>(xs: T[], rank: Record<T, number>): T => xs.reduce((a, b) => (rank[b] > rank[a] ? b : a));
const weakest = <T extends string>(xs: T[], rank: Record<T, number>): T => xs.reduce((a, b) => (rank[b] < rank[a] ? b : a));

export type ScoreOptions = {
  /** Only these models (default: every model in src/adb/models.ts plus profiled ones). */
  models?: string[];
  /** The models the summary focuses on (default: the 1 GB sticks AFTSSS, AFTSS). */
  focus?: string[];
  targetFps?: number;
  now?: () => Date;
};

/** The device the runs came from, as a speed reference for scaling. */
export function speedRefFor(m: FitMeasurement, targets: FitTarget[], profiles: Map<string, DeviceProfile>): SpeedRef | undefined {
  const d = m.device;
  if (!d) return undefined;
  const t = targets.find((x) => x.model.toUpperCase() === d.model?.toUpperCase()) ?? (d.model && lookupModel(d.model) ? buildTarget(lookupModel(d.model) as NonNullable<ReturnType<typeof lookupModel>>, profiles.get(d.model.toUpperCase())) : undefined);
  if (t && t.speed.value !== null) return { factor: t.speed.value, source: t.speed.source, name: d.name ?? t.name, ...(t.gpu ? { gpu: t.gpu } : {}) };
  const fam = gpuFamily(d.gpu);
  if (fam) return { factor: fam.factor, source: fam.source, name: d.name ?? d.model ?? 'the measured device', gpu: d.gpu };
  return undefined;
}

function verdictOf(checks: CheckResult[]): Verdict {
  const s = worstStatus(checks.map((c) => c.status));
  return s === 'fail' ? 'wont-run' : s === 'warn' ? 'risky' : 'runs';
}

export function scoreModel(m: FitMeasurement, t: FitTarget, device: SpeedRef | undefined, targetFps: number): { fit: ModelFit; mediaPerFile: { source: string; issues: { key: string; status: 'warn' | 'fail'; reason: string; fix?: string }[] }[] } {
  const base = {
    model: t.model,
    name: t.name,
    kind: t.kind,
    ...(t.year ? { year: t.year } : {}),
    ...(t.gpu ? { gpu: t.gpu } : {}),
    ...(t.platform ? { platform: t.platform } : {}),
    ...(t.ramMB ? { ramMB: t.ramMB } : {}),
    ...(t.tier ? { tier: t.tier } : {}),
    ...(t.profile ? { profile: t.profile } : {}),
  };
  const here = !!m.device?.model && m.device.model.toUpperCase() === t.model.toUpperCase();
  if (t.vega) {
    return {
      fit: { ...base, verdict: 'not-covered', headline: 'Not covered: Vega OS', reasons: ['Vega OS is not Android: APKs, WebView apps and adb tooling do not apply. Vega support is on the roadmap (help wanted).'], fixes: [], basis: 'estimated', confidence: 'high', checks: [], measuredHere: false },
      mediaPerFile: [],
    };
  }
  const checks: CheckResult[] = [];
  const apk = m.app.apk;
  if (apk) {
    checks.push(checkAbi(apk, t, here), checkSdk(apk, t, here), checkFeatures(apk, t), checkLeanback(apk, t));
    const gl = checkGles(apk, t);
    if (gl) checks.push(gl);
  }
  if (m.needs) checks.push(checkWebgl(m.needs, t, here, m.webCaps));
  // When the app can't even start here (wrong ABI, Android too old, no WebGL2...), memory and
  // frame-rate estimates are noise: they are shown as not judged.
  const blocker = checks.find((c) => c.status === 'fail' && ['abi', 'sdk', 'gles', 'webgl'].includes(c.id));
  const runtime = [checkMemory(m.runs, t, here)];
  runtime.push(checkFrames(m.runs, t, here, device, targetFps), checkPressure(m.pressure, t, (runtime[0] as CheckResult).status));
  for (const c of runtime) {
    if (blocker && c.status !== 'skip') checks.push({ ...c, status: 'skip', summary: 'n/a', reason: `Not judged: it can't start on this model (${LABEL[blocker.id]}).`, fix: undefined } as CheckResult);
    else checks.push(c);
  }
  const media = checkMediaOn(m.media, t);
  checks.push(media.result);

  const active = checks.filter((c) => c.status !== 'skip');
  const verdict = active.length ? verdictOf(active) : 'runs';
  const worst: CheckStatus = verdict === 'wont-run' ? 'fail' : verdict === 'risky' ? 'warn' : 'pass';
  const deciding = active.filter((c) => c.status === worst);
  const measured = active.some((c) => c.id === 'memory' || c.id === 'frames');
  let basis: Basis = 'estimated';
  let confidence: Confidence = 'low';
  if (deciding.length) {
    if (verdict === 'runs') {
      basis = weakest(active.map((c) => c.basis), BASIS_RANK);
      confidence = weakest(active.map((c) => c.confidence), CONF_RANK);
    } else {
      basis = strongest(deciding.map((c) => c.basis), BASIS_RANK);
      confidence = strongest(deciding.map((c) => c.confidence), CONF_RANK);
    }
  }
  const reasons = [...active.filter((c) => c.status === 'fail'), ...active.filter((c) => c.status === 'warn')].map((c) => c.reason);
  if (verdict === 'runs') {
    for (const c of active) if (c.id === 'memory' || c.id === 'frames' || c.id === 'webgl' || c.id === 'abi') reasons.push(c.reason);
    if (!measured) {
      reasons.push('Static checks only: memory and frame rate were not measured, so this says it installs and starts, not that it runs well.');
      confidence = CONF_RANK[confidence] > CONF_RANK.low ? 'low' : confidence;
    }
  }
  if (!active.length) reasons.push('Nothing to check: pass an APK, a URL with a device, or a measurement.');
  // One fix per line: a check may carry several (newline-separated).
  const fixes = [...new Set(deciding.filter((c) => c.status !== 'pass').flatMap((c) => (c.fix ? c.fix.split('\n') : [])).filter(Boolean))];
  const headCheck = deciding.filter((c) => c.status !== 'pass').sort((a, b) => PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id) || CONF_RANK[b.confidence] - CONF_RANK[a.confidence])[0];
  const headline = headCheck ? `${LABEL[headCheck.id]}: ${headCheck.summary}` : measured ? 'All checks pass' : 'Static checks pass';
  const budget = t.memory.budgetMB.value ?? undefined;
  const limit = t.memory.limitMB.value ?? undefined;
  return {
    fit: { ...base, verdict, headline, reasons, fixes, basis, confidence, checks, measuredHere: here, memory: { ...(budget ? { budgetMB: budget } : {}), ...(limit ? { limitMB: limit } : {}) } },
    mediaPerFile: media.perFile,
  };
}

export const LABEL: Record<CheckResult['id'], string> = {
  abi: 'CPU ABI',
  sdk: 'Android version',
  features: 'TV hardware',
  leanback: 'TV launcher',
  gles: 'OpenGL ES',
  webgl: 'WebGL',
  memory: 'Memory',
  frames: 'Frame rate',
  pressure: 'Memory pressure',
  media: 'Media',
};

/** Which problem leads a model's headline when several tie. */
const PRIORITY: CheckResult['id'][] = ['abi', 'sdk', 'gles', 'webgl', 'memory', 'frames', 'pressure', 'media', 'features', 'leanback'];

const KIND_ORDER: Record<FitTarget['kind'], number> = { stick: 0, cube: 1, box: 2, tv: 3 };

/** Scores a measurement against every model. Pure: pass the profiles in. */
export function scoreFit(m: FitMeasurement, profiles: Map<string, DeviceProfile> = new Map(), opts: ScoreOptions = {}): FitReport {
  const targetFps = opts.targetFps ?? m.targetFps ?? 30;
  const targets = buildTargets(profiles, opts.models).sort((a, b) => Number(a.vega) - Number(b.vega) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.year ?? 0) - (a.year ?? 0));
  const device = speedRefFor(m, targets, profiles);
  const findings = new Map<string, MediaFinding>();
  const models: ModelFit[] = [];
  for (const t of targets) {
    const { fit, mediaPerFile } = scoreModel(m, t, device, targetFps);
    models.push(fit);
    for (const f of mediaPerFile) {
      const mf = findings.get(f.source) ?? { source: f.source, status: 'pass' as CheckStatus, issues: [] };
      for (const i of f.issues) {
        let row = mf.issues.find((x) => x.reason === i.reason && x.status === i.status);
        if (!row) mf.issues.push((row = { status: i.status, reason: i.reason, ...(i.fix ? { fix: i.fix } : {}), models: [] }));
        row.models.push(t.model);
      }
      mf.status = worstStatus([mf.status, ...mf.issues.map((x) => x.status)]);
      findings.set(f.source, mf);
    }
  }
  const covered = models.filter((x) => x.verdict !== 'not-covered');
  const count = (v: Verdict) => models.filter((x) => x.verdict === v).length;
  const focusIds = (opts.focus ?? ONE_GB_STICKS).map((x) => x.toUpperCase());
  const focus = models.filter((x) => focusIds.includes(x.model.toUpperCase()));
  const focusVerdict: Verdict = focus.some((x) => x.verdict === 'wont-run') ? 'wont-run' : focus.some((x) => x.verdict === 'risky') ? 'risky' : focus.length ? 'runs' : 'not-covered';
  const focusNames = focus.map((x) => x.name.replace(/ \/ .*$/, '')).join(', ');
  const focusWhy = focus.find((x) => x.verdict === focusVerdict && x.verdict !== 'runs')?.headline;
  const evidence = {
    static: !!m.app.apk,
    web: !!m.needs,
    measured: m.runs.some((r) => !r.simulated),
    simulated: m.runs.some((r) => !!r.simulated) || !!m.pressure,
    pressure: !!m.pressure,
    media: m.media.length > 0,
  };
  const parts = [`runs on ${count('runs')}`, `risky on ${count('risky')}`, `won't run on ${count('wont-run')}`];
  const headline = `Of ${covered.length} Fire OS models, it ${parts.join(', ')}${count('not-covered') ? ` (${count('not-covered')} Vega OS models not covered)` : ''}.`;
  return {
    kind: 'firelab-fit',
    version: 1,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    firelabVersion: firelabVersion(),
    app: m.app,
    ...(m.device ? { measuredOn: m.device } : {}),
    targetFps,
    ...(m.needs ? { needs: m.needs } : {}),
    evidence,
    summary: {
      runs: count('runs'),
      risky: count('risky'),
      wontRun: count('wont-run'),
      notCovered: count('not-covered'),
      headline,
      focus: {
        models: focus.map((x) => x.model),
        verdict: focusVerdict,
        line: focus.length ? `On ${opts.focus ? '' : 'the 1 GB sticks, '}${focusNames}: ${VERDICT_LABEL[focusVerdict]}${focusWhy ? ` (${focusWhy})` : ''}.` : 'No focus models in this report.',
      },
    },
    models,
    media: m.media,
    mediaFindings: [...findings.values()],
    runs: m.runs,
    ...(m.pressure ? { pressure: m.pressure } : {}),
    notes: [...m.notes, ...(m.needs?.notes ?? [])],
    disclaimer: DISCLAIMER,
  };
}
