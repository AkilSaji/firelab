/** Helpers shared by the oracles. */
import type { FindingDraft, Observation, Probe, Severity, State } from '../types.js';

/** Strips numbers, hex ids and quoted values so the same bug gives the same signature [48]. */
export function normalizeText(text: string): string {
  return text
    .replace(/^Uncaught\s+/i, '')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/(["'`]).*?\1/g, '$1…$1')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export const basename = (url: string | undefined): string => (url ? (url.split(/[?#]/)[0] ?? '').split('/').pop() || url : '');

/** The scene of an observation for signatures: the app's scene mark, else the state id. */
export const sceneOf = (obs: Observation, state?: Pick<State, 'id'>): string => obs.probe?.scene ?? obs.probe?.modal ?? state?.id ?? obs.stateId ?? '?';

/** The handful of probe values worth keeping as evidence. */
export function probeEvidence(p: Probe | undefined): Partial<Probe> | undefined {
  if (!p) return undefined;
  const out: Partial<Probe> = { raf: p.raf, errors: p.errors };
  for (const k of ['scene', 'modal', 'paused', 'targetFps', 'fps', 'url', 'lastError', 'glLost', 'heapMB'] as const) if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  if (p.focus !== undefined) out.focus = p.focus;
  if (p.app !== undefined) out.app = p.app;
  return out;
}

export function draft(
  o: { oracle: string; kind: string; severity: Severity; title: string; detail: string; signature: string },
  obs: Observation,
  state: Pick<State, 'id'> | undefined,
  evidence: Partial<FindingDraft['evidence']> = {},
): FindingDraft {
  const ev: FindingDraft['evidence'] = { thumbs: evidence.thumbs ?? [], logs: evidence.logs ?? [] };
  const probe = evidence.probe ?? probeEvidence(obs.probe) ?? (obs.focus !== undefined ? { focus: obs.focus } : undefined);
  if (probe) ev.probe = probe;
  if (evidence.numbers) ev.numbers = evidence.numbers;
  return { ...o, stateId: state?.id ?? obs.stateId ?? '?', step: obs.step, ts: obs.ts, evidence: ev };
}
