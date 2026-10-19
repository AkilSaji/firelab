/**
 * Memory budgets: how much app + WebView renderer PSS a model can carry.
 *
 * Two thresholds per model:
 * - budget: runs comfortably, about 100 MB of MemAvailable left over.
 * - limit: about 40 MB left; past it the low-memory killer takes the app or
 *   the WebView renderer crashes (the page reloads or goes white).
 *
 * Calibrated on two real runs of Sunset Villa (a three.js game):
 * - Fire TV Stick (3rd gen, AFTSSS, 1 GB): MemTotal 900.6 MB; app 210 MB +
 *   renderer 205 MB = 415 MB ran with MemAvailable never below 83 MB.
 *   Budget = 415 MB (measured), limit = 415 + 83 - 40 = 458 MB.
 * - Fire TV Stick 4K Plus (AFTMA08C15, 2 GB): MemTotal 1670 MB; app 270-295 +
 *   renderer 210-266 = up to 561 MB with MemAvailable 360-390 MB.
 *   Budget = 561 + 360 - 100 = 821 MB, limit = 561 + 360 - 40 = 881 MB.
 * Models without measurements scale these by MemTotal (ratios below).
 */
import { fact, type Fact } from '../profile/types.js';
import { round1 } from '../lib/util.js';

/** MemAvailable to keep for a comfortable run, and the floor before kills. */
export const RESERVE_COMFORT_MB = 100;
export const RESERVE_HARD_MB = 40;
/** App + renderer PSS of a WebView app showing a blank page (estimated). */
export const BLANK_WEBVIEW_PSS_MB = 120;

/** Budget/limit as a share of MemTotal, from the two calibration runs. */
export const RATIOS = {
  '1GB': { memTotal: 0.88, budget: 0.46, limit: 0.51, from: 'AFTSSS (measured): 415 / 458 MB of 900.6 MB MemTotal' },
  '2GB': { memTotal: 0.815, budget: 0.49, limit: 0.53, from: 'AFTMA08C15 (measured run): 821 / 881 MB of 1670 MB MemTotal' },
} as const;

export type MemoryBudget = { totalMB: Fact<number>; budgetMB: Fact<number>; limitMB: Fact<number> };

/** From a known-good run: the PSS that ran fine and the lowest MemAvailable during it. */
export function budgetFromRun(knownGoodMB: number, lowestAvailMB: number): { budget: number; limit: number } {
  return {
    budget: Math.round(knownGoodMB + Math.max(0, lowestAvailMB - RESERVE_COMFORT_MB)),
    limit: Math.round(knownGoodMB + Math.max(0, lowestAvailMB - RESERVE_HARD_MB)),
  };
}

/** From MemAvailable with a blank WebView page open (what `firelab profile` measures). */
export function budgetFromAvail(availWebViewMB: number): { budget: number; limit: number } {
  return {
    budget: Math.round(BLANK_WEBVIEW_PSS_MB + Math.max(0, availWebViewMB - RESERVE_COMFORT_MB)),
    limit: Math.round(BLANK_WEBVIEW_PSS_MB + Math.max(0, availWebViewMB - RESERVE_HARD_MB)),
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

/** Estimates from installed RAM alone (no profile). */
export function estimateBudget(ramMB: number, memTotalMB?: number): { total: number; budget: number; limit: number } {
  const t = (ramMB - 1024) / 1024;
  const r1 = RATIOS['1GB'];
  const r2 = RATIOS['2GB'];
  const total = memTotalMB ?? Math.round(ramMB * lerp(r1.memTotal, r2.memTotal, t));
  return { total: round1(total), budget: Math.round(total * lerp(r1.budget, r2.budget, t)), limit: Math.round(total * lerp(r1.limit, r2.limit, t)) };
}

/** Builds the budget facts, preferring measured values. */
export function memoryBudget(input: {
  ramMB?: number;
  totalMB?: Fact<number>;
  appBudgetMB?: Fact<number>;
  appLimitMB?: Fact<number>;
  knownGoodMB?: Fact<number>;
  lowestAvailMB?: Fact<number>;
  availWebViewMB?: Fact<number>;
}): MemoryBudget {
  const known = (f?: Fact<number>) => (f && f.source !== 'unknown' && f.value !== null ? f.value : undefined);
  const total = known(input.totalMB);
  const totalFact = input.totalMB && total !== undefined ? input.totalMB : undefined;
  const b = known(input.appBudgetMB);
  const l = known(input.appLimitMB);
  if (b !== undefined && l !== undefined) {
    return { totalMB: totalFact ?? fact(total, 'unknown'), budgetMB: input.appBudgetMB as Fact<number>, limitMB: input.appLimitMB as Fact<number> };
  }
  const kg = known(input.knownGoodMB);
  const low = known(input.lowestAvailMB);
  if (kg !== undefined && low !== undefined) {
    const r = budgetFromRun(kg, low);
    return {
      totalMB: totalFact ?? fact<number>(null, 'unknown'),
      budgetMB: fact(r.budget, low < RESERVE_COMFORT_MB ? 'measured' : 'estimated', `known good ${kg} MB with MemAvailable >= ${low} MB`),
      limitMB: fact(r.limit, 'estimated', `known good ${kg} MB + ${low} MB available - ${RESERVE_HARD_MB} MB floor`),
    };
  }
  const avail = known(input.availWebViewMB);
  if (avail !== undefined) {
    const r = budgetFromAvail(avail);
    return {
      totalMB: totalFact ?? fact<number>(null, 'unknown'),
      budgetMB: fact(r.budget, 'estimated', `blank WebView ~${BLANK_WEBVIEW_PSS_MB} MB + ${avail} MB available (measured) - ${RESERVE_COMFORT_MB} MB`),
      limitMB: fact(r.limit, 'estimated', `blank WebView ~${BLANK_WEBVIEW_PSS_MB} MB + ${avail} MB available (measured) - ${RESERVE_HARD_MB} MB`),
    };
  }
  const ram = input.ramMB;
  const assumed = ram === undefined;
  const e = estimateBudget(ram ?? 1024, total);
  const why = assumed ? 'RAM not published: assumed 1 GB (worst case)' : `${ram} MB RAM, scaled from the measured sticks`;
  return {
    totalMB: totalFact ?? fact(e.total, 'estimated', why),
    budgetMB: fact(e.budget, 'estimated', why),
    limitMB: fact(e.limit, 'estimated', why),
  };
}

/**
 * Extra memory a richer render resolution costs, per megapixel of canvas
 * (color + depth + MSAA + compositor copies). From Sunset Villa: 415 MB at
 * 768x432 (tv) vs about 520 MB at 1920x1080 (tv-hd): ~60 MB per megapixel.
 * Estimated; app-specific.
 */
export const MB_PER_MEGAPIXEL = 60;
