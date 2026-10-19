/** Defaults and validation for ExploreConfig (docs/ENGINE.md 4, 10.1). */
import { FireLabError } from '../lib/errors.js';
import path from 'node:path';
import type { RemoteKey } from './driver.js';
import { REMOTE_KEYS } from './driver.js';
import type { ExploreConfig } from './types.js';
import { MVP_ORACLES } from './oracles/index.js';
import { dataDir } from '../lib/paths.js';

/** up down left right ok back menu playpause, with rewind/fastforward at a low prior; home off. */
export const DEFAULT_KEYS: readonly RemoteKey[] = ['up', 'down', 'left', 'right', 'ok', 'back', 'menu', 'playpause', 'rewind', 'fastforward'];

export function exploreDir(): string {
  return path.join(dataDir(), 'explore');
}

export function parseKeyList(s: string | readonly string[] | undefined): RemoteKey[] | undefined {
  if (s === undefined) return undefined;
  const parts = (typeof s === 'string' ? s.split(/[\s,]+/) : s).map((x) => x.trim()).filter(Boolean);
  for (const k of parts) if (!REMOTE_KEYS.includes(k as RemoteKey)) throw new FireLabError('bad-request', `Unknown remote key "${k}" (keys: ${REMOTE_KEYS.join(' ')})`);
  return parts as RemoteKey[];
}

export type ConfigInput = Partial<Omit<ExploreConfig, 'app' | 'keys'>> & { app: ExploreConfig['app']; keys?: readonly string[] | string; runId?: string };

export function buildConfig(i: ConfigInput, runId: string): ExploreConfig {
  const keys = parseKeyList(i.keys) ?? DEFAULT_KEYS.slice();
  if (!keys.length) throw new FireLabError('bad-request', 'No keys to explore with');
  if (i.minutes !== undefined && !(i.minutes > 0 && i.minutes <= 24 * 60)) throw new FireLabError('bad-request', '--minutes must be between 0 and 1440');
  if (i.steps !== undefined && !(Number.isInteger(i.steps) && i.steps > 0)) throw new FireLabError('bad-request', '--steps must be a positive integer');
  return {
    app: i.app,
    ...(i.minutes !== undefined ? { minutes: i.minutes } : {}),
    ...(i.steps !== undefined ? { steps: i.steps } : {}),
    ...(i.minutes === undefined && i.steps === undefined ? { minutes: 10 } : {}),
    seed: i.seed ?? 1,
    keys,
    oracles: [...new Set([...(i.oracles?.length ? i.oracles : MVP_ORACLES), ...(i.emulateGpu ? ['gpu'] : [])])],
    ...(i.stateExpr ? { stateExpr: i.stateExpr } : {}),
    ...(i.focusSelector ? { focusSelector: i.focusSelector } : {}),
    ...(i.setupEval ? { setupEval: i.setupEval } : {}),
    reset: i.reset ?? 'relaunch',
    ...(i.fromSessions?.length ? { fromSessions: i.fromSessions } : {}),
    strategy: i.strategy ?? 'explore',
    minimize: i.minimize ?? true,
    outDir: i.outDir ?? path.join(exploreDir(), runId),
    ...(i.minimizeBudgetMin !== undefined ? { minimizeBudgetMin: i.minimizeBudgetMin } : {}),
    ...(i.visualState ? { visualState: true } : {}),
    ...(i.lowPriorKeys ? { lowPriorKeys: i.lowPriorKeys } : {}),
    ...(i.allowPackages?.length ? { allowPackages: i.allowPackages } : {}),
    ...(i.emulateGpu ? { emulateGpu: i.emulateGpu } : {}),
    ...(i.coverage ? { coverage: i.coverage } : {}),
    ...(i.deep === false ? { deep: false } : {}),
    ...(i.knowledge ? { knowledge: i.knowledge } : {}),
  };
}

/**
 * --fail-on categories (CI gating). A word is a category below, a severity
 * (critical, major, minor), "any", or an exact finding kind.
 */
export const FAIL_CATEGORIES: Record<string, readonly string[]> = {
  crash: ['crash', 'anr', 'webview-renderer-gone', 'process-restarted'],
  exit: ['unexpected-exit'],
  js: ['js-exception'],
  exception: ['js-exception'],
  error: ['js-exception', 'console-error'],
  black: ['black-screen'],
  frozen: ['frozen-screen', 'render-loop-stopped'],
  freeze: ['frozen-screen', 'render-loop-stopped'],
  webgl: ['webgl-context-lost'],
  'focus-trap': ['focus-trap'],
  trap: ['focus-trap'],
  unreachable: ['unreachable-control'],
  'non-spatial': ['non-spatial-move'],
  focus: ['focus-trap', 'unreachable-control', 'non-spatial-move', 'focus-lost'],
  'dead-end': ['dead-end'],
  gpu: ['gpu-unsupported'],
  stuck: ['dead-end'],
};

export const DEFAULT_FAIL_ON = ['critical', 'major'];

export function failMatcher(words: readonly string[]): (f: { kind: string; severity: string }) => boolean {
  const ws = words.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (ws.includes('none')) return () => false;
  return (f) =>
    ws.some((w) => w === 'any' || w === f.severity || w === f.kind || (FAIL_CATEGORIES[w]?.includes(f.kind) ?? false));
}
