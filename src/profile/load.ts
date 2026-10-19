import fs from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../lib/paths.js';
import { validateProfile, type SchemaError } from './schema.js';
import type { DeviceProfile, Fact } from './types.js';
import { memoryBudget } from '../fit/memory.js';

/** profiles/ next to package.json (the bundled community profiles). */
export function defaultProfilesDir(): string {
  return path.join(packageRoot(), 'profiles');
}

export function profileFileName(model: string): string {
  const safe = model.trim().replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!safe) throw new Error('Profile needs a model name');
  return `${safe}.json`;
}

export type LoadedProfiles = { profiles: Map<string, DeviceProfile>; errors: { file: string; errors: SchemaError[] }[]; files: string[] };

/**
 * Loads every <MODEL>.json in the given folders (later folders override
 * earlier ones, so a user folder beats the bundled one). Invalid files are
 * reported, not thrown.
 */
export function loadProfiles(dirs: string | string[] = defaultProfilesDir()): LoadedProfiles {
  const out: LoadedProfiles = { profiles: new Map(), errors: [], files: [] };
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'schema.json').sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      let data: unknown;
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        out.errors.push({ file, errors: [{ path: '$', message: `not JSON: ${(e as Error).message}` }] });
        continue;
      }
      const errs = validateProfile(data);
      if (errs.length) {
        out.errors.push({ file, errors: errs });
        continue;
      }
      const p = data as DeviceProfile;
      out.profiles.set(p.model.toUpperCase(), p);
      out.files.push(file);
    }
  }
  return out;
}

export function saveProfile(profile: DeviceProfile, dir: string = defaultProfilesDir()): string {
  const errs = validateProfile(profile);
  if (errs.length) throw new Error(`Refusing to save an invalid profile: ${errs.slice(0, 5).map((e) => `${e.path} ${e.message}`).join('; ')}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, profileFileName(profile.model));
  fs.writeFileSync(file, `${JSON.stringify({ $schema: './schema.json', ...profile }, null, 2)}\n`);
  return file;
}

const isFact = (x: unknown): x is Fact<unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x) && 'source' in x && 'value' in x && Object.keys(x).every((k) => k === 'value' || k === 'source' || k === 'note');

const RANK: Record<string, number> = { unknown: 0, estimated: 1, spec: 2, measured: 3 };

function mergeNode(base: unknown, update: unknown): unknown {
  if (isFact(update)) {
    // A fresh value wins unless it is weaker evidence than what we had.
    if (isFact(base) && (RANK[update.source] ?? 0) < (RANK[base.source] ?? 0)) return base;
    return update;
  }
  if (update && typeof update === 'object' && !Array.isArray(update) && base && typeof base === 'object' && !Array.isArray(base)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(update as Record<string, unknown>)) out[k] = k in out ? mergeNode(out[k], v) : v;
    return out;
  }
  return update === undefined ? base : update;
}

/**
 * Merges a fresh capture into an existing profile: known values in `update`
 * win, unknown ones keep what `base` had (e.g. a hand-entered known-good
 * memory run), and references and notes are kept and appended.
 */
export function mergeProfile(base: DeviceProfile, update: DeviceProfile): DeviceProfile {
  const merged = mergeNode(base, update) as DeviceProfile;
  const refs = [...(base.references ?? []), ...(update.references ?? [])];
  const notes = [...new Set([...(base.notes ?? []), ...(update.notes ?? [])])];
  if (refs.length) merged.references = refs;
  if (notes.length) merged.notes = notes;
  // A real app run that fit in memory is the strongest budget evidence there is.
  const kg = merged.memory.knownGoodMB;
  const low = merged.memory.lowestAvailMB;
  if (kg?.value != null && low?.value != null && kg.source !== 'unknown' && low.source !== 'unknown') {
    const mb = memoryBudget({ knownGoodMB: kg, lowestAvailMB: low });
    merged.memory.appBudgetMB = mb.budgetMB;
    merged.memory.appLimitMB = mb.limitMB;
  }
  if (base.source === 'manual' && update.source === 'measured') merged.notes = [...(merged.notes ?? []), `Merged a measured capture (${update.capturedAt}) into a hand-entered profile (${base.capturedAt}).`];
  return merged;
}
