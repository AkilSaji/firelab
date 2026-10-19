/**
 * `firelab learn`: turn explore runs into a knowledge pack to contribute,
 * show what FireLab already knows, merge packs (maintainers).
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, firelabVersion, packageRoot } from '../lib/paths.js';
import { readRunDir } from './explorer.js';
import { readTrace } from './trace.js';
import { learnFromRuns, loadKnowledge, mergePacks, patternWeight, validatePack, type KnowledgePack, type RunInput } from './knowledge.js';
import type { Trace } from './types.js';

/** Bundled packs (knowledge/ in the package), then ~/.firelab/knowledge. */
export function knowledgeDirs(extra: string[] = []): string[] {
  return [path.join(packageRoot(), 'knowledge'), path.join(dataDir(), 'knowledge'), ...extra.map((p) => path.resolve(p))];
}

/** What a run directory teaches: confirmed findings with their shrunk traces, and per-press state changes. */
export function runInputFromDir(dir: string): RunInput {
  const r = readRunDir(dir);
  const traces = new Map<string, Pick<Trace, 'steps'>>();
  for (const f of r.findings) {
    const file = path.join(dir, 'traces', f.minimized ?? f.trace);
    try {
      traces.set(f.id, readTrace(file));
    } catch {
      /* a missing trace teaches nothing */
    }
  }
  const presses: RunInput['presses'] = [];
  const tl = path.join(dir, 'timeline.jsonl');
  if (fs.existsSync(tl)) {
    let prev: string | undefined;
    for (const line of fs.readFileSync(tl, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { action: string; stateId?: string; inv?: boolean };
        if (e.action !== 'launch' && !e.inv && prev !== undefined) presses.push({ key: e.action, changed: e.stateId !== prev });
        prev = e.stateId;
      } catch {
        /* skip */
      }
    }
  }
  return { package: r.config.app.package, steps: r.steps, findings: r.findings, traces, presses };
}

export function exportKnowledge(dirs: string[], rejected: string[] = []): KnowledgePack {
  const pack = learnFromRuns(dirs.map(runInputFromDir), new Set(rejected));
  pack.firelabVersion = firelabVersion();
  return pack;
}

/** One-screen summary, so a developer sees exactly what would be shared. */
export function describePack(p: KnowledgePack): string {
  const lines = [`FireLab knowledge: ${p.source.runs} run(s), ${p.source.games} game(s), ${p.source.steps} key presses`];
  const keys = Object.entries(p.keyPriors).map(([k, v]) => `${k} ${v!.n ? Math.round((100 * v!.changed) / v!.n) : 0}%`);
  if (keys.length) lines.push(`  keys that changed the state: ${keys.join(', ')}`);
  if (!p.patterns.length) lines.push('  bug patterns: none (only confirmed, shrunk findings become patterns)');
  for (const pat of p.patterns.slice(0, 20)) lines.push(`  pattern ${pat.id}: ${pat.keys.join(' ')} -> ${pat.kind} (confirmed ${pat.confirmed}x on ${pat.games} game(s)${pat.rejected ? `, rejected ${pat.rejected}x` : ''}, weight ${patternWeight(pat).toFixed(1)})`);
  if (p.patterns.length > 20) lines.push(`  ... and ${p.patterns.length - 20} more`);
  lines.push('  Shared: key names, finding kinds and counts. Not shared: URLs, package names, screen names, text, screenshots, code.');
  return lines.join('\n');
}

export function writePack(p: KnowledgePack, out?: string): string {
  const file = path.resolve(out ?? path.join(dataDir(), 'knowledge', `firelab-knowledge-${new Date().toISOString().slice(0, 10)}-${p.patterns.map((x) => x.id).join('').slice(0, 8) || 'keys'}.json`));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(p, null, 1)}\n`);
  return file;
}

export function mergeFiles(files: string[]): KnowledgePack {
  return mergePacks(files.map((f) => validatePack(JSON.parse(fs.readFileSync(f, 'utf8')), f)));
}

export { loadKnowledge };
