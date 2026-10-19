import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../lib/paths.js';
import { log } from '../lib/log.js';

/**
 * Which packages FireLab installed on which device, kept in
 * `<home>/installed.json`. Destructive operations that are only safe on test
 * builds (clearing app data) check this list, so FireLab never wipes the saves
 * of an app a person installed from the Appstore.
 */
type Registry = Record<string, Record<string, { at: number; apk?: string }>>;

/** Apps built by `firelab wrap` use this application id prefix by default. */
export const FIRELAB_PACKAGE_PREFIX = 'dev.firelab.';

const file = (home: string) => path.join(home, 'installed.json');

function read(home: string): Registry {
  try {
    const r = JSON.parse(fs.readFileSync(file(home), 'utf8')) as unknown;
    return r && typeof r === 'object' ? (r as Registry) : {};
  } catch {
    return {};
  }
}

/** Notes that FireLab installed `pkg` on `serial`. Never throws: losing the note only makes reset stricter. */
export function recordInstall(home: string, serial: string, pkg: string, apk?: string): void {
  try {
    const r = read(home);
    (r[serial] ??= {})[pkg] = { at: Date.now(), ...(apk ? { apk } : {}) };
    ensureDir(home);
    fs.writeFileSync(file(home), `${JSON.stringify(r, null, 2)}\n`);
  } catch (e) {
    log.debug('could not record install', e);
  }
}

/** True when FireLab installed `pkg` on `serial` (or on any device, with no serial), or it is a `firelab wrap` app. */
export function installedByFireLab(home: string, pkg: string, serial?: string): boolean {
  if (pkg.startsWith(FIRELAB_PACKAGE_PREFIX)) return true;
  const r = read(home);
  if (serial) return !!r[serial]?.[pkg];
  return Object.values(r).some((pkgs) => !!pkgs[pkg]);
}
