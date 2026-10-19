/**
 * The minimiser (docs/ENGINE.md 8). Every finding gets a reproduction rate
 * first, then a shrink: loop cutting (drop detours that come back to the same
 * state), delta debugging [45] adapted to nondeterministic GUI traces by
 * accepting a candidate that reproduces in at least one of m replays [46], and
 * a gap shrink, because timing is part of the input [47]. Results are cached
 * by the candidate's steps; the whole thing stops when its budget is used up
 * and keeps the best trace so far.
 */
import type { Clock } from './clock.js';
import { realClock } from './clock.js';
import type { Finding, Trace, TraceStep } from './types.js';
import { actionKey } from './actions.js';
import { sha1 } from './abstraction.js';

/**
 * ddmin(c, test) [45]: test(c) true means "still fails". Returns a 1-minimal
 * subsequence (when the budget allows). `stop()` ends early with the best so far.
 */
export async function ddmin<T>(items: readonly T[], test: (c: T[]) => Promise<boolean>, stop: () => boolean = () => false): Promise<T[]> {
  let c = items.slice();
  let n = 2;
  while (c.length >= 2 && !stop()) {
    const chunks = split(c, n);
    let reduced = false;
    for (const d of chunks) {
      if (stop()) return c;
      if (d.length < c.length && (await test(d))) {
        c = d;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (n > 2 || chunks.length > 2) {
      for (let i = 0; i < chunks.length; i++) {
        if (stop()) return c;
        const comp = chunks.filter((_, j) => j !== i).flat();
        if (comp.length < c.length && (await test(comp))) {
          c = comp;
          n = Math.max(n - 1, 2);
          reduced = true;
          break;
        }
      }
    }
    if (reduced) continue;
    if (n >= c.length) break;
    n = Math.min(2 * n, c.length);
  }
  return c;
}

/** n roughly equal consecutive chunks. */
export function split<T>(c: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = Math.round(((i + 1) * c.length) / n);
    if (end > start) out.push(c.slice(start, end));
    start = end;
  }
  return out;
}

/**
 * Detours: (i, j) where the state after step i equals the state after step j > i,
 * so steps i+1..j can go. Index -1 is the state right after launch. Longest first.
 */
export function loopCuts(startState: string | undefined, steps: readonly Pick<TraceStep, 'stateId'>[]): [number, number][] {
  const ids = [startState, ...steps.map((s) => s.stateId)];
  const out: [number, number][] = [];
  for (let a = 0; a < ids.length; a++) {
    if (!ids[a]) continue;
    for (let b = ids.length - 1; b > a; b--) if (ids[b] === ids[a]) out.push([a - 1, b - 1]);
  }
  return out.sort((x, y) => y[1] - y[0] - (x[1] - x[0]));
}

export type Reproducer = (trace: Trace) => Promise<boolean>;

export type ShrinkOptions = {
  /** One replay from a fresh launch: true when the finding shows again. */
  replay: Reproducer;
  budgetMs?: number;
  clock?: Clock;
  /** Replays for the initial rate (default 3) and the final rate (default 5). */
  initialRuns?: number;
  finalRuns?: number;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
};

export type ShrinkResult = {
  status: Finding['status'];
  before: number;
  after: number;
  tests: number;
  ms: number;
  rate0: { hits: number; runs: number };
  repro: { hits: number; runs: number };
  trace: Trace;
};

const stepsKey = (steps: readonly TraceStep[]) => sha1(JSON.stringify(steps.map((s) => [actionKey(s.action), s.gapMs])));
const renumber = (steps: readonly TraceStep[]): TraceStep[] => steps.map((s, i) => ({ ...s, i }));

export async function shrinkTrace(trace: Trace, o: ShrinkOptions): Promise<ShrinkResult> {
  const clock = o.clock ?? realClock;
  const t0 = clock.now();
  const budget = o.budgetMs ?? 20 * 60_000;
  const log = o.onProgress ?? (() => {});
  let tests = 0;
  const cache = new Map<string, boolean>();
  const stop = () => !!o.signal?.aborted || clock.now() - t0 >= budget;
  const withSteps = (steps: readonly TraceStep[]): Trace => {
    const { shortcuts: _s, ...rest } = trace;
    return { ...rest, steps: renumber(steps) };
  };
  const once = async (steps: readonly TraceStep[]) => {
    tests++;
    return o.replay(withSteps(steps));
  };
  const rate = async (steps: readonly TraceStep[], k: number) => {
    let hits = 0;
    let runs = 0;
    for (let i = 0; i < k && !o.signal?.aborted; i++) {
      runs++;
      if (await once(steps)) hits++;
    }
    return { hits, runs };
  };

  const before = trace.steps.length;
  let steps = trace.steps.slice();
  let ids: (string | undefined)[] = steps.map((s) => s.stateId);

  // 0. Shortcuts the explorer knows (its shortest path to the state before the
  // finding): tried once before anything else, because measuring the full
  // trace's rate first can cost more than the whole budget.
  let shortcutHit = false;
  for (const sc of trace.shortcuts ?? []) {
    if (stop() || sc.length >= steps.length) continue;
    if (await once(sc)) {
      log(`shortcut: ${steps.length} -> ${sc.length} steps`);
      steps = sc.slice();
      ids = steps.map((s) => s.stateId);
      shortcutHit = true;
      break;
    }
  }
  const k0 = o.initialRuns ?? 3;
  let rate0: { hits: number; runs: number };
  if (shortcutHit) {
    const more = await rate(steps, k0 - 1);
    rate0 = { hits: more.hits + 1, runs: more.runs + 1 };
  } else rate0 = await rate(steps, k0);
  log(`reproduced ${rate0.hits}/${rate0.runs} before shrinking`);
  if (rate0.hits === 0) return { status: 'not-reproduced', before, after: before, tests, ms: clock.now() - t0, rate0, repro: rate0, trace };
  const m = rate0.hits === rate0.runs ? 1 : 2;
  const reproduces = async (cand: readonly TraceStep[]): Promise<boolean> => {
    const key = stepsKey(cand);
    const known = cache.get(key);
    if (known !== undefined) return known;
    let ok = false;
    for (let r = 0; r < m && !ok && !o.signal?.aborted; r++) ok = await once(cand);
    cache.set(key, ok);
    return ok;
  };
  cache.set(stepsKey(steps), true);

  // 1. Cut loops (cheap: few tests remove long detours).
  for (let pass = 0; pass < 3 && !stop(); pass++) {
    let cut = false;
    for (const [i, j] of loopCuts(trace.startStateId, steps.map((s, k) => ({ stateId: ids[k] })))) {
      if (stop()) break;
      const cand = [...steps.slice(0, i + 1), ...steps.slice(j + 1)];
      if (await reproduces(cand)) {
        log(`loop cut: ${steps.length} -> ${cand.length} steps`);
        ids = [...ids.slice(0, i + 1), ...ids.slice(j + 1)];
        steps = cand;
        cut = true;
        break;
      }
    }
    if (!cut) break;
  }

  // 1b. Drop the steps that left the state as it was (keys the screen ignored): one test that often halves a
  // random walk before ddmin starts. A cause that needs those presses (a counter, a timing race) makes the test fail
  // and costs nothing more.
  if (!stop() && steps.length > 2) {
    const keep = steps.map((_, k) => ids[k] !== (k === 0 ? trace.startStateId : ids[k - 1]) || k === steps.length - 1);
    const cand = steps.filter((_, k) => keep[k]);
    if (cand.length < steps.length && (await reproduces(cand))) {
      log(`no-op cut: ${steps.length} -> ${cand.length} steps`);
      ids = ids.filter((_, k) => keep[k]);
      steps = cand;
    }
  }

  // 2. ddmin over the remaining actions.
  if (!stop() && steps.length > 1) {
    const n0 = steps.length;
    steps = await ddmin(steps, (c) => reproduces(c), stop);
    if (steps.length < n0) log(`ddmin: ${n0} -> ${steps.length} steps`);
  } else if (!stop() && steps.length === 1 && (await reproduces([]))) steps = [];

  // 3. Shrink gaps: try the default settle gap (0 = as fast as observation allows), all at once, then in chunks.
  if (!stop() && steps.some((s) => s.gapMs > 0)) {
    const zero = (xs: TraceStep[], from: number, to: number) => xs.map((s, i) => (i >= from && i < to ? { ...s, gapMs: 0 } : s));
    const all = zero(steps, 0, steps.length);
    if (await reproduces(all)) steps = all;
    else
      for (let i = 0; i < steps.length && !stop(); i += 4) {
        const cand = zero(steps, i, i + 4);
        if (cand.some((s, k) => s.gapMs !== steps[k]?.gapMs) && (await reproduces(cand))) steps = cand;
      }
  }

  // 4. Measure the result.
  // Over budget already: a 3-replay rate instead of 5, so the shrink doesn't overrun by much.
  const repro = await rate(steps, stop() ? Math.min(3, o.finalRuns ?? 5) : (o.finalRuns ?? 5));
  const status: Finding['status'] = repro.hits === 0 ? 'not-reproduced' : repro.hits / repro.runs >= 0.6 ? 'confirmed' : 'flaky';
  log(`${before} -> ${steps.length} steps, reproduced ${repro.hits}/${repro.runs}`);
  return { status, before, after: steps.length, tests, ms: clock.now() - t0, rate0, repro, trace: withSteps(steps) };
}
