/**
 * The transition graph: (state, action) -> state with counts, as model-based
 * tools keep it [3, 5, 6]. Returns walk its reliable edges (6.3).
 */
import type { Transition } from './types.js';

/** The pseudo-state for "the app left the foreground". */
export const EXIT = 'EXIT';

const tkey = (from: string, action: string, to: string) => `${from}\u0000${action}\u0000${to}`;
const pkey = (from: string, action: string) => `${from}\u0000${action}`;

export type PathEdge = { from: string; action: string; to: string; p: number };

export class Graph {
  readonly transitions = new Map<string, Transition>();
  /** (from, action) -> times tried. */
  private tries = new Map<string, number>();
  /** from -> action -> to -> count. */
  private out = new Map<string, Map<string, Map<string, number>>>();

  record(from: string, action: string, to: string): void {
    const pk = pkey(from, action);
    const total = (this.tries.get(pk) ?? 0) + 1;
    this.tries.set(pk, total);
    let byAction = this.out.get(from);
    if (!byAction) this.out.set(from, (byAction = new Map()));
    let succ = byAction.get(action);
    if (!succ) byAction.set(action, (succ = new Map()));
    succ.set(to, (succ.get(to) ?? 0) + 1);
    for (const [t, count] of succ) {
      const k = tkey(from, action, t);
      const tr = this.transitions.get(k);
      if (tr) (tr.count = count), (tr.total = total);
      else this.transitions.set(k, { from, action, to: t, count, total });
    }
  }

  /** Successors of (from, action) with their counts. */
  successors(from: string, action: string): Map<string, number> {
    return this.out.get(from)?.get(action) ?? new Map();
  }

  actions(from: string): string[] {
    return [...(this.out.get(from)?.keys() ?? [])];
  }

  tried(from: string, action: string): number {
    return this.tries.get(pkey(from, action)) ?? 0;
  }

  /** count/total of the edge. */
  reliability(from: string, action: string, to: string): number {
    const total = this.tried(from, action);
    return total ? (this.successors(from, action).get(to) ?? 0) / total : 0;
  }

  /** True once (from, action) led out of the app. */
  isExit(from: string, action: string): boolean {
    return (this.successors(from, action).get(EXIT) ?? 0) > 0;
  }

  /**
   * Shortest path over edges with count/total >= minReliability (BFS; ties go to
   * the more reliable edge). Undefined when there is none.
   */
  shortestPath(from: string, to: string, minReliability = 0.8): PathEdge[] | undefined {
    if (from === to) return [];
    const prev = new Map<string, PathEdge>();
    const seen = new Set([from]);
    let frontier = [from];
    while (frontier.length) {
      const next: string[] = [];
      for (const s of frontier) {
        const byAction = this.out.get(s);
        if (!byAction) continue;
        const edges: PathEdge[] = [];
        for (const [action, succ] of byAction) {
          const total = this.tried(s, action);
          for (const [t, count] of succ) if (t !== EXIT && count / total >= minReliability) edges.push({ from: s, action, to: t, p: count / total });
        }
        edges.sort((a, b) => b.p - a.p || a.action.localeCompare(b.action));
        for (const e of edges) {
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          prev.set(e.to, e);
          if (e.to === to) {
            const path: PathEdge[] = [];
            for (let cur = to; cur !== from; ) {
              const pe = prev.get(cur) as PathEdge;
              path.unshift(pe);
              cur = pe.from;
            }
            return path;
          }
          next.push(e.to);
        }
      }
      frontier = next;
    }
    return undefined;
  }

  toJSON(): Transition[] {
    return [...this.transitions.values()];
  }
}

/** Product of the edge probabilities of a path. */
export const pathReliability = (p: PathEdge[]): number => p.reduce((r, e) => r * e.p, 1);
