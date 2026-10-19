/** The oracle registry. MVP: health (7.1), screen (7.2), focus (7.3); stuck (7.6) is part of the explorer. */
import type { DriverCaps } from '../driver.js';
import type { ExploreConfig, Oracle } from '../types.js';
import { createHealthOracle } from './health.js';
import { createScreenOracle } from './screen.js';
import { createFocusOracle } from './focus.js';
import { stuckOracle } from './stuck.js';
import { createGpuOracle } from './gpu.js';

export const MVP_ORACLES = ['health', 'screen', 'focus'] as const;
/** Designed, not built yet (later tier A). */
export const LATER_ORACLES = ['perf', 'memory', 'invariant', 'media'] as const;

export function createOracle(id: string, config: ExploreConfig): Oracle | undefined {
  switch (id) {
    case 'health':
      return createHealthOracle(config);
    case 'screen':
      return createScreenOracle(config);
    case 'focus':
      return createFocusOracle(config);
    case 'stuck':
      return stuckOracle;
    case 'gpu':
      return createGpuOracle(config);
    default:
      return undefined;
  }
}

/** Builds the requested oracles; the ones the driver can't serve are left out with a note (section 3). */
export function createOracles(ids: readonly string[], config: ExploreConfig, caps: DriverCaps, opts: { nativeFocus?: boolean } = {}): { oracles: Oracle[]; notes: string[] } {
  const oracles: Oracle[] = [];
  const notes: string[] = [];
  for (const id of ids) {
    const o = createOracle(id, config);
    if (!o && id === 'gpu') {
      notes.push('gpu oracle off: it needs --emulate-gpu <model>');
      continue;
    }
    if (!o) {
      notes.push((LATER_ORACLES as readonly string[]).includes(id) ? `${id} oracle: designed (docs/ENGINE.md section 7) but not built yet` : `unknown oracle "${id}" ignored`);
      continue;
    }
    if (id === 'focus' && !caps.eval && !opts.nativeFocus) {
      notes.push('focus oracle off: the driver has neither eval (in-page focus) nor uiDump (native focus)');
      continue;
    }
    const missing = o.needs.filter((n) => !caps[n]);
    if (missing.length) {
      notes.push(`${id} oracle off: the driver lacks ${missing.join(', ')}`);
      continue;
    }
    oracles.push(o);
  }
  return { oracles, notes };
}
