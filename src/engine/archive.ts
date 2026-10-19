/**
 * The Go-Explore archive [20]: one cell per abstract state, with the shortest
 * known path from a fresh launch and the statistics selection needs (6.2).
 */
import type { RemoteKey } from './driver.js';
import type { Rng } from './rng.js';
import type { Action, Cell, State } from './types.js';

/** Depth that earns the full depth term: the engine is meant to reach states 100+ actions deep. */
export const DEPTH_HORIZON = 100;

/**
 * weight(c) from 6.2: count-based novelty [20, 21] (not a score: many game
 * bugs sit where no objective points [22]), plus Wuji-style terms for progress
 * and for being near a bug signal [19], plus:
 * - frontier: the share of keys never tried in this state. Model-based
 *   explorers (Stoat, APE) go to states with unexplored actions first, and
 *   Go-Explore's selection favours cells that still lead somewhere [5, 20];
 * - depth on a log scale up to DEPTH_HORIZON, so a state 60 actions deep still
 *   counts for more than one 20 deep (deep bugs need deep starts [19]).
 */
export function cellWeight(c: Pick<Cell, 'chosen' | 'discovered' | 'depth' | 'suspicion' | 'failedReturns'>, bonus = 0, frontier = 0, deep = true): number {
  return (
    1 / Math.sqrt(1 + c.chosen) +
    (0.5 * c.discovered) / (1 + c.chosen) +
    (deep ? (0.4 * Math.log2(1 + Math.min(c.depth, DEPTH_HORIZON))) / Math.log2(1 + DEPTH_HORIZON) : (0.3 * Math.min(c.depth, 20)) / 20) +
    0.8 * frontier +
    1.0 * c.suspicion -
    0.5 * Math.min(c.failedReturns, 4) +
    bonus
  );
}

export class Archive {
  readonly cells = new Map<string, Cell>();
  /** Cells added, in order (for the coverage curve and the report). */
  readonly order: string[] = [];
  /** Extra selection weight for a number of choices (human-trace seeds, 6.4). */
  private bonus = new Map<string, { w: number; left: number }>();

  get size(): number {
    return this.cells.size;
  }

  get(id: string): Cell | undefined {
    return this.cells.get(id);
  }

  has(id: string): boolean {
    return this.cells.has(id);
  }

  /** Adds a state; returns the cell and whether it was new. A known state gets a visit and, maybe, a shorter path. */
  observe(s: State, path: Action[]): { cell: Cell; isNew: boolean } {
    const known = this.cells.get(s.id);
    if (known) {
      known.visits++;
      if (path.length < known.path.length) {
        known.path = path.slice();
        known.depth = path.length;
      }
      return { cell: known, isNew: false };
    }
    const cell: Cell = { ...s, visits: 1, chosen: 0, discovered: 0, failedReturns: 0, depth: path.length, path: path.slice(), suspicion: 0, actionStats: {} };
    this.cells.set(s.id, cell);
    this.order.push(s.id);
    return { cell, isNew: true };
  }

  addBonus(id: string, w: number, choices: number): void {
    this.bonus.set(id, { w, left: choices });
  }

  /** selectCell: sample with probability proportional to max(weight, 0.01). `frontier(c)` is the share of untried actions (0..1). */
  select(rng: Rng, eligible: (c: Cell) => boolean = () => true, frontier?: (c: Cell) => number): Cell | undefined {
    const cells = [...this.cells.values()].filter(eligible);
    if (!cells.length) return undefined;
    const weights = cells.map((c) => Math.max(cellWeight(c, this.bonus.get(c.id)?.w ?? 0, frontier?.(c) ?? 0, !!frontier), 0.01));
    const c = cells[rng.weighted(weights)] as Cell;
    const b = this.bonus.get(c.id);
    if (b && --b.left <= 0) this.bonus.delete(c.id);
    return c;
  }

  /** The deepest cell (longest shortest-path from launch) and the depth histogram, for the report and the benchmark. */
  depthStats(): { max: number; maxCell?: string; mean: number; histogram: Record<string, number> } {
    let max = 0;
    let maxCell: string | undefined;
    let sum = 0;
    const histogram: Record<string, number> = {};
    for (const c of this.cells.values()) {
      sum += c.depth;
      if (c.depth > max || maxCell === undefined) {
        max = c.depth;
        maxCell = c.id;
      }
      const b = c.depth <= 5 ? '0-5' : c.depth <= 10 ? '6-10' : c.depth <= 25 ? '11-25' : c.depth <= 50 ? '26-50' : c.depth <= 100 ? '51-100' : '100+';
      histogram[b] = (histogram[b] ?? 0) + 1;
    }
    return { max, ...(maxCell ? { maxCell } : {}), mean: this.cells.size ? Math.round((sum / this.cells.size) * 10) / 10 : 0, histogram };
  }

  recordReward(c: Cell, key: RemoteKey, reward: number): void {
    const st = (c.actionStats[key] ??= { n: 0, reward: 0 });
    st.n++;
    st.reward += reward;
  }
}
