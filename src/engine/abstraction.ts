/**
 * Layered state abstraction (docs/ENGINE.md 5.3). How coarse "the same state"
 * is changes what a tool finds [10]; APE showed the right level depends on the
 * app [5], so the key is built in levels:
 *   L1 package + activity, L2 scene / modal / URL path / --state-expr,
 *   L3 the focus descriptor (on a TV, focus is the state a remote changes [52]),
 *   L4 a visual dHash bucket [27] when L1-L3 say nothing (canvas games without a hook).
 */
import { createHash } from 'node:crypto';
import type { FocusInfo, Observation, State } from './types.js';
import { canonicalApp } from './probe.js';
import { hamming } from './frame.js';

export const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** Two frames share a visual bucket when their dHashes differ in at most this many bits. */
export const VIS_HAMMING = 6;

/** Assigns dHashes to buckets: the first hash of a bucket is its name. */
export class VisualBuckets {
  private reps: string[] = [];
  assign(hash: string): string {
    for (const r of this.reps) if (hamming(r, hash) <= VIS_HAMMING) return r;
    this.reps.push(hash);
    return hash;
  }
  get size(): number {
    return this.reps.length;
  }
}

/** Focus descriptor: id, else role:text, else the rect snapped to a 12x8 grid of the viewport. */
export function focusDescriptor(f: FocusInfo, viewport?: [number, number]): string {
  if (f.id) return f.id;
  if (f.role || f.text) return `${f.role ?? ''}:${f.text ?? ''}`;
  const [w, h] = viewport ?? [1920, 1080];
  const col = Math.floor((f.rect[0] + f.rect[2] / 2) / (w / 12));
  const row = Math.floor((f.rect[1] + f.rect[3] / 2) / (h / 8));
  return `@${col},${row}`;
}

/** The focus of an observation: the in-page probe's, else native focus from a uiautomator dump (undefined: unknown). */
export function focusOf(obs: Pick<Observation, 'probe' | 'focus'> | undefined): FocusInfo | null | undefined {
  if (!obs) return undefined;
  return obs.probe?.focus !== undefined ? obs.probe.focus : obs.focus;
}

const urlPath = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  const q = url.indexOf('?');
  const hash = url.indexOf('#');
  const path = q >= 0 ? url.slice(0, q) : hash >= 0 ? url.slice(0, hash) : url;
  return hash >= 0 ? path + url.slice(hash) : path;
};

export type AbstractionOptions = { visualState?: boolean };

export class Abstraction {
  readonly buckets = new VisualBuckets();
  constructor(private readonly opts: AbstractionOptions = {}) {}

  /** The State for an observation (firstSeenStep is the observation's step; the archive keeps the first one). */
  abstract(obs: Observation): State {
    const key: State['key'] = { pkg: obs.foreground ?? '(none)' };
    if (obs.activity) key.activity = obs.activity;
    let level: State['level'] = 1;
    const p = obs.probe;
    if (p && obs.foreground) {
      const path = urlPath(p.url);
      if (path) key.path = path;
      if (p.scene) key.scene = p.scene;
      if (p.modal) key.modal = p.modal;
      if ('app' in p && p.app !== undefined) key.app = canonicalApp(p.app);
      if (key.scene || key.modal || key.app) level = 2;
      if (p.focus) {
        key.focus = focusDescriptor(p.focus, p.viewport);
        level = 3;
      }
    } else if (obs.focus && obs.foreground) {
      // Native app: focus from a uiautomator dump (L3 without an L2).
      key.focus = focusDescriptor(obs.focus, obs.viewport);
      level = 3;
    }
    const informative = level > 1;
    if ((!informative || this.opts.visualState) && obs.frame && obs.foreground) {
      key.vis = this.buckets.assign(obs.frame.hash);
      level = 4;
    }
    return { id: stateId(key), level, key, firstSeenStep: obs.step };
  }

  screenOf(obs: Observation): string {
    return screenIdOf(obs);
  }
}

/** The screen id: L1 + L2 without app state or focus (what the focus oracle investigates once). */
export function screenIdOf(obs: Observation): string {
  const p = obs.probe;
  const key = [obs.foreground ?? '(none)', obs.activity, urlPath(p?.url), p?.scene, p?.modal];
  return 'sc-' + sha1(JSON.stringify(key)).slice(0, 10);
}

/** stateId = sha1(JSON of the key).slice(0, 12), with a fixed field order. */
export function stateId(key: State['key']): string {
  const ordered = [key.pkg, key.activity, key.path, key.scene, key.modal, key.app, key.focus, key.vis];
  return sha1(JSON.stringify(ordered)).slice(0, 12);
}

/** A one-line human label for a state, for reports. */
export function stateLabel(s: Pick<State, 'key'>): string {
  const k = s.key;
  const parts: string[] = [];
  if (k.scene) parts.push(k.scene);
  if (k.modal) parts.push(`modal ${k.modal}`);
  if (k.app) parts.push(k.app.length > 60 ? k.app.slice(0, 57) + '…' : k.app);
  if (k.focus) parts.push(`focus ${k.focus.length > 40 ? '…' + k.focus.slice(-39) : k.focus}`);
  if (k.vis) parts.push(`vis ${k.vis.slice(0, 6)}`);
  if (!parts.length) parts.push(k.activity ?? k.pkg);
  return parts.join(' · ');
}
