/**
 * Shared knowledge: what FireLab learns from runs on many games, in a form
 * developers can contribute back (a pull request adding a JSON file to
 * knowledge/), so the engine starts every new game knowing more.
 *
 * Reuse across runs and apps is how industrial explorers improve over time
 * (Fastbot2 keeps its learned model between runs [9]; Humanoid learns key
 * choices from human traces [7]). FireLab shares only game-independent
 * knowledge, never the game:
 * - bug patterns: the last few remote keys of each *confirmed, shrunk* finding,
 *   with the finding's kind (e.g. "ok*3 → black-screen"), tried early on new
 *   screens of other games;
 * - key priors: how often each remote key changed the app's state, so keys TV
 *   games usually ignore cost fewer presses on a new game;
 * - developer feedback: findings marked "not a bug" lower a pattern's weight.
 * No URLs, package names, screen names, text, screenshots or code.
 *
 * Nothing is uploaded: `firelab learn export` writes a file and the developer
 * decides to open a pull request (FireLab has no telemetry).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RemoteKey } from './driver.js';
import { REMOTE_KEYS } from './driver.js';
import { parseActionKey } from './actions.js';
import type { Action, Finding, Trace } from './types.js';

export type BugPattern = {
  /** sha1 of kind + keys (stable across packs, so merges add up). */
  id: string;
  /** Finding kind the keys led to: black-screen, js-exception, focus-trap, ... */
  kind: string;
  /** The trigger: the last keys of the shrunk trace, as action keys ('ok*3', 'back', 'right:long'). */
  keys: string[];
  /** Times it was confirmed (shrunk and reproduced) across runs and games. */
  confirmed: number;
  /** Distinct games it was confirmed on (hashed hosts/packages, counted not stored). */
  games: number;
  /** Times a developer marked a finding from it as not a bug. */
  rejected: number;
};

export type KeyPrior = { n: number; changed: number };

export type KnowledgePack = {
  kind: 'firelab-knowledge';
  version: 1;
  createdAt: string;
  firelabVersion?: string;
  /** How much went into it (counts only). */
  source: { runs: number; games: number; steps: number };
  keyPriors: Partial<Record<RemoteKey, KeyPrior>>;
  patterns: BugPattern[];
  /** Hashes of the games in it (sha1 of the package/host, truncated), so merging packs counts games once. */
  gameHashes: string[];
};

/** At most this many keys per pattern: a trigger, not a walkthrough. */
export const PATTERN_KEYS = 6;
const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
const gameHash = (pkg: string) => sha1(`firelab-game:${pkg}`).slice(0, 12);

export function emptyPack(): KnowledgePack {
  return { kind: 'firelab-knowledge', version: 1, createdAt: new Date().toISOString(), source: { runs: 0, games: 0, steps: 0 }, keyPriors: {}, patterns: [], gameHashes: [] };
}

/** The trigger keys of a shrunk trace: its last PATTERN_KEYS key actions (macros kept, waits and relaunches dropped). */
export function patternKeys(trace: Pick<Trace, 'steps'>): string[] {
  const keys = trace.steps.map((s) => s.action).filter((a): a is Extract<Action, { kind: 'key' }> => a.kind === 'key');
  return keys.slice(-PATTERN_KEYS).map((a) => {
    let s: string = a.key;
    if (a.mode === 'long') s += ':long';
    else if (a.mode === 'hold') s += `:${a.holdMs ?? 800}`;
    if (a.repeat && a.repeat > 1) s += `*${a.repeat}`;
    return s;
  });
}

export function patternId(kind: string, keys: string[]): string {
  return sha1(`${kind}|${keys.join(' ')}`).slice(0, 12);
}

export type RunInput = {
  /** The app's package (or web.<host>): hashed, never stored. */
  package: string;
  steps: number;
  findings: Pick<Finding, 'id' | 'kind' | 'status' | 'severity'>[];
  /** finding id -> its shrunk (or full) trace. */
  traces: Map<string, Pick<Trace, 'steps'>>;
  /** timeline: action key and whether the state changed. */
  presses: { key: string; changed: boolean }[];
};

/**
 * Learns from runs: confirmed findings become patterns, presses become key
 * priors. `rejected` = finding ids a developer marked as not a bug.
 */
export function learnFromRuns(runs: RunInput[], rejected: Set<string> = new Set()): KnowledgePack {
  const pack = emptyPack();
  const games = new Set<string>();
  const byId = new Map<string, BugPattern & { gamesSet: Set<string> }>();
  for (const r of runs) {
    const g = gameHash(r.package);
    games.add(g);
    pack.source.runs++;
    pack.source.steps += r.steps;
    for (const p of r.presses) {
      const a = parseActionKey(p.key);
      if (!a || a.kind !== 'key' || a.repeat || a.mode) continue;
      const kp = (pack.keyPriors[a.key] ??= { n: 0, changed: 0 });
      kp.n++;
      if (p.changed) kp.changed++;
    }
    for (const f of r.findings) {
      const isRejected = rejected.has(f.id);
      if (f.severity === 'info' || (!isRejected && f.status !== 'confirmed')) continue;
      const t = r.traces.get(f.id);
      if (!t) continue;
      const keys = patternKeys(t);
      if (!keys.length) continue;
      const id = patternId(f.kind, keys);
      const p = byId.get(id) ?? { id, kind: f.kind, keys, confirmed: 0, games: 0, rejected: 0, gamesSet: new Set<string>() };
      if (isRejected) p.rejected++;
      else {
        p.confirmed++;
        p.gamesSet.add(g);
      }
      byId.set(id, p);
    }
  }
  pack.patterns = [...byId.values()].map(({ gamesSet, ...p }) => ({ ...p, games: gamesSet.size }));
  pack.gameHashes = [...games].sort();
  pack.source.games = games.size;
  return pack;
}

/** Merges packs: priors and pattern counts add up; games are counted once per hash. */
export function mergePacks(packs: KnowledgePack[]): KnowledgePack {
  const out = emptyPack();
  const games = new Set<string>();
  const byId = new Map<string, BugPattern>();
  for (const p of packs) {
    out.source.runs += p.source.runs;
    out.source.steps += p.source.steps;
    for (const g of p.gameHashes ?? []) games.add(g);
    for (const [k, v] of Object.entries(p.keyPriors) as [RemoteKey, KeyPrior][]) {
      const o = (out.keyPriors[k] ??= { n: 0, changed: 0 });
      o.n += v.n;
      o.changed += v.changed;
    }
    for (const pat of p.patterns) {
      const o = byId.get(pat.id);
      if (o) {
        o.confirmed += pat.confirmed;
        o.games += pat.games;
        o.rejected += pat.rejected;
      } else byId.set(pat.id, { ...pat });
    }
  }
  out.patterns = [...byId.values()].sort((a, b) => patternWeight(b) - patternWeight(a));
  out.gameHashes = [...games].sort();
  out.source.games = games.size;
  return out;
}

/** How much to trust a pattern: confirmations on more games count more; rejections count against it. */
export function patternWeight(p: Pick<BugPattern, 'confirmed' | 'games' | 'rejected'>): number {
  return Math.max(0, Math.log2(1 + p.confirmed) + p.games - 2 * p.rejected);
}

/** Validates a pack (pull requests are reviewed, but the engine also refuses junk). */
export function validatePack(v: unknown, file = 'pack'): KnowledgePack {
  const bad = (m: string) => new Error(`${file}: not a FireLab knowledge pack (${m})`);
  if (!v || typeof v !== 'object') throw bad('not an object');
  const p = v as Partial<KnowledgePack>;
  if (p.kind !== 'firelab-knowledge' || p.version !== 1) throw bad('kind/version');
  if (!Array.isArray(p.patterns) || typeof p.keyPriors !== 'object' || !p.keyPriors) throw bad('patterns/keyPriors');
  const patterns: BugPattern[] = [];
  for (const x of p.patterns) {
    if (!x || typeof x.kind !== 'string' || !Array.isArray(x.keys) || x.keys.length === 0 || x.keys.length > PATTERN_KEYS) continue;
    const keys = x.keys.filter((k): k is string => typeof k === 'string' && parseActionKey(k)?.kind === 'key');
    if (keys.length !== x.keys.length || !/^[a-z-]{2,40}$/.test(x.kind)) continue;
    const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(n, 1e6) : 0);
    patterns.push({ id: patternId(x.kind, keys), kind: x.kind, keys, confirmed: num(x.confirmed), games: num(x.games), rejected: num(x.rejected) });
  }
  const keyPriors: KnowledgePack['keyPriors'] = {};
  for (const [k, kp] of Object.entries(p.keyPriors)) {
    if (!REMOTE_KEYS.includes(k as RemoteKey) || !kp || typeof kp !== 'object') continue;
    const n = Number((kp as KeyPrior).n);
    const changed = Number((kp as KeyPrior).changed);
    if (Number.isFinite(n) && Number.isFinite(changed) && n >= 0 && changed >= 0 && changed <= n) keyPriors[k as RemoteKey] = { n, changed };
  }
  return {
    kind: 'firelab-knowledge',
    version: 1,
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date(0).toISOString(),
    ...(typeof p.firelabVersion === 'string' ? { firelabVersion: p.firelabVersion } : {}),
    source: { runs: Number(p.source?.runs) || 0, games: Number(p.source?.games) || 0, steps: Number(p.source?.steps) || 0 },
    keyPriors,
    patterns,
    gameHashes: Array.isArray(p.gameHashes) ? p.gameHashes.filter((g): g is string => typeof g === 'string' && /^[0-9a-f]{12}$/.test(g)) : [],
  };
}

/** Loads every *.json pack in the folders (or files) given, merged. Invalid files are skipped and listed. */
export function loadKnowledge(paths: string[]): { pack: KnowledgePack; files: string[]; errors: string[] } {
  const packs: KnowledgePack[] = [];
  const files: string[] = [];
  const errors: string[] = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const list = fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => path.join(p, f)) : [p];
    for (const f of list) {
      try {
        packs.push(validatePack(JSON.parse(fs.readFileSync(f, 'utf8')), f));
        files.push(f);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }
  return { pack: mergePacks(packs), files, errors };
}

/** Pseudo-counts a key prior is worth in the explorer: knowledge nudges, the run's own presses decide. */
export const PRIOR_CAP = 4;

/** Key priors scaled to at most PRIOR_CAP presses each, keeping the changed ratio. */
export function scaledPriors(pack: KnowledgePack): Map<RemoteKey, KeyPrior> {
  const out = new Map<RemoteKey, KeyPrior>();
  for (const [k, v] of Object.entries(pack.keyPriors) as [RemoteKey, KeyPrior][]) {
    if (!v.n) continue;
    const n = Math.min(PRIOR_CAP, v.n);
    out.set(k, { n, changed: Math.round((v.changed / v.n) * n * 100) / 100 });
  }
  return out;
}

/** Patterns worth trying, best first, as actions. */
export function usablePatterns(pack: KnowledgePack, keys: readonly RemoteKey[]): { pattern: BugPattern; actions: Action[] }[] {
  const allowed = new Set(keys);
  return pack.patterns
    .filter((p) => patternWeight(p) > 0)
    .map((pattern) => ({ pattern, actions: pattern.keys.map((k) => parseActionKey(k)).filter((a): a is Action => !!a) }))
    .filter((x) => x.actions.length === x.pattern.keys.length && x.actions.every((a) => a.kind === 'key' && allowed.has(a.key)))
    .sort((a, b) => patternWeight(b.pattern) - patternWeight(a.pattern));
}
