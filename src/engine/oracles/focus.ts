/**
 * Focus oracle (docs/ENGINE.md 7.3), specific to TVs. It builds a model of
 * focus transitions by driving the remote, as Ahmed et al. do for smart TV
 * apps [52], and checks it against the platform rules: no keyboard traps [53],
 * spatial navigation geometry [54], every control reachable and focus never
 * lost [55].
 *
 * One change from the design: the focus BFS runs in two passes. Apps change
 * their navigation as a side effect of being navigated (Firefly Lake's `trap`
 * bug activates on the first visit to an item), so the second pass re-tests
 * every edge, and the analysis uses the latest behaviour of each edge.
 */
import type { RemoteKey } from '../driver.js';
import type { Action, ExploreConfig, FocusInfo, Observation, Oracle, OracleContext, State, TraceStep } from '../types.js';
import { focusOf, screenIdOf } from '../abstraction.js';
import { meanAbsDiff } from '../frame.js';
import { draft } from './common.js';

type Dir = 'up' | 'down' | 'left' | 'right';
type Rect = FocusInfo['rect'];
export const DIRS: readonly Dir[] = ['up', 'down', 'left', 'right'];
const OPP: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
const EXIT_EDGE = '(left screen)';
const LOST = '(no focus)';
export const PRESS_BUDGET = 80;
const MAX_INVESTIGATIONS = 12;

// ---------- geometry (W3C CSS Spatial Navigation, simplified [54]) ----------

/** Is h strictly in the dir half-plane of f? */
export function inHalfPlane(f: Rect, h: Rect, dir: Dir): boolean {
  const [fx, fy, fw, fh] = f;
  const [hx, hy, hw, hh] = h;
  switch (dir) {
    case 'down':
      return hy >= fy + fh - 1;
    case 'up':
      return hy + hh <= fy + 1;
    case 'right':
      return hx >= fx + fw - 1;
    case 'left':
      return hx + hw <= fx + 1;
  }
}

const intervalGap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

/** Primary-axis gap + 2 x orthogonal offset between the edges: a simplified form of the spec's distance [54]. */
export function navDistance(f: Rect, h: Rect, dir: Dir): number {
  const [fx, fy, fw, fh] = f;
  const [hx, hy, hw, hh] = h;
  const vertical = dir === 'up' || dir === 'down';
  const primary = dir === 'down' ? hy - (fy + fh) : dir === 'up' ? fy - (hy + hh) : dir === 'right' ? hx - (fx + fw) : fx - (hx + hw);
  const orth = vertical ? intervalGap(fx, fx + fw, hx, hx + hw) : intervalGap(fy, fy + fh, hy, hy + hh);
  return Math.max(0, primary) + 2 * orth;
}

const aligned = (f: Rect, h: Rect, dir: Dir): boolean =>
  dir === 'up' || dir === 'down' ? intervalGap(f[0], f[0] + f[2], h[0], h[0] + h[2]) === 0 : intervalGap(f[1], f[1] + f[3], h[1], h[1] + h[3]) === 0;

export type FocusGraph = Map<string, Map<Dir, string>>;

export type SpatialProblem = { from: string; dir: Dir; got: string; expected?: string; why: 'wrong-direction' | 'skipped-closer' };

/** Edges whose target disagrees with the geometry. Wrap-around at the edge of a row or column is allowed. */
export function spatialProblems(G: FocusGraph, rects: Map<string, Rect>, F: readonly FocusInfo[]): SpatialProblem[] {
  const out: SpatialProblem[] = [];
  for (const [f, edges] of G) {
    const rf = rects.get(f);
    if (!rf) continue;
    for (const [dir, g] of edges) {
      if (g === f || g === EXIT_EDGE || g === LOST) continue;
      const rg = rects.get(g);
      if (!rg) continue;
      const cand = F.filter((h) => h.id !== f && inHalfPlane(rf, h.rect, dir));
      let best: FocusInfo | undefined;
      let bestD = Infinity;
      for (const h of cand) {
        const d = navDistance(rf, h.rect, dir);
        if (d < bestD) (bestD = d), (best = h);
      }
      if (!inHalfPlane(rf, rg, dir)) {
        const wrap = !cand.length && inHalfPlane(rf, rg, OPP[dir]) && aligned(rf, rg, dir);
        if (!wrap) out.push({ from: f, dir, got: g, expected: best?.id, why: 'wrong-direction' });
      } else if (best && g !== best.id && navDistance(rf, rg, dir) > 1.5 * bestD + 24) {
        out.push({ from: f, dir, got: g, expected: best.id, why: 'skipped-closer' });
      }
    }
  }
  return out;
}

/** Strongly connected components (Tarjan), over edges between real focus nodes. */
export function stronglyConnected(G: FocusGraph): string[][] {
  const nodes = new Set<string>();
  for (const [f, e] of G) {
    nodes.add(f);
    for (const g of e.values()) if (g !== EXIT_EDGE && g !== LOST) nodes.add(g);
  }
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of G.get(v)?.values() ?? []) {
      if (w === EXIT_EDGE || w === LOST) continue;
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
    }
    if (low.get(v) === idx.get(v)) {
      const c: string[] = [];
      for (;;) {
        const w = stack.pop() as string;
        on.delete(w);
        c.push(w);
        if (w === v) break;
      }
      out.push(c.sort());
    }
  };
  for (const v of [...nodes].sort()) if (!idx.has(v)) visit(v);
  return out;
}

/** BFS over known focus edges: the directions that lead from a to b. */
export function focusPath(G: FocusGraph, a: string, b: string): Dir[] | undefined {
  if (a === b) return [];
  const prev = new Map<string, [string, Dir]>();
  const seen = new Set([a]);
  let frontier = [a];
  while (frontier.length) {
    const next: string[] = [];
    for (const v of frontier)
      for (const dir of DIRS) {
        const w = G.get(v)?.get(dir);
        if (!w || w === EXIT_EDGE || w === LOST || seen.has(w)) continue;
        seen.add(w);
        prev.set(w, [v, dir]);
        if (w === b) {
          const path: Dir[] = [];
          for (let cur = b; cur !== a; ) {
            const [p, d] = prev.get(cur) as [string, Dir];
            path.unshift(d);
            cur = p;
          }
          return path;
        }
        next.push(w);
      }
    frontier = next;
  }
  return undefined;
}

const keyAction = (key: RemoteKey): Action => ({ kind: 'key', key });

const label = (id: string, rects: Map<string, FocusInfo>): string => {
  const t = rects.get(id)?.text;
  return t ? `"${t}"` : id;
};

export type FocusGraphRecord = { screen: string; nodes: FocusInfo[]; edges: { from: string; dir: Dir; to: string }[] };
export type FocusOracle = Oracle & { readonly graphs: FocusGraphRecord[] };

export function createFocusOracle(config: ExploreConfig): FocusOracle {
  const pkg = config.app.package;
  const investigated = new Set<string>();
  const screenF = new Map<string, FocusInfo[]>();
  let sawFocus = false;
  let investigations = 0;
  const graphs: FocusGraphRecord[] = [];

  async function investigate(ctx: OracleContext, state: State): Promise<void> {
    const tools = ctx.tools;
    const start = tools?.current();
    const startFocus = focusOf(start);
    if (!tools || !start || !startFocus) return;
    const sc = screenIdOf(start);
    investigated.add(sc);
    investigations++;
    // A "focused" element that covers most of the screen is the game's surface (a canvas or WebView), not a
    // control: the app draws its own highlight, and the focus FireLab can read says nothing about it.
    const vp = start.viewport ?? start.probe?.viewport ?? [1920, 1080];
    if ((startFocus.rect[2] * startFocus.rect[3]) / (vp[0] * vp[1]) >= 0.8) {
      ctx.note('focus checks skipped on a screen: the focused element is the whole screen (the game\'s canvas or WebView), so the app draws its own highlight. Publish window.firelab.marks.focus (web) or use real view focus to enable them.');
      return;
    }
    const F = await tools.focusables();
    screenF.set(sc, F);
    const info = new Map<string, FocusInfo>(F.map((f) => [f.id, f]));
    const rects = new Map<string, Rect>(F.map((f) => [f.id, f.rect]));
    const note = (f: FocusInfo | null | undefined) => {
      if (!f) return;
      rects.set(f.id, f.rect);
      if (!info.has(f.id)) info.set(f.id, f);
    };
    note(startFocus);
    const startId = startFocus.id;
    const base: TraceStep[] = tools.traceSoFar();
    const G: FocusGraph = new Map();
    const setEdge = (f: string, dir: Dir, g: string) => {
      let m = G.get(f);
      if (!m) G.set(f, (m = new Map()));
      m.set(dir, g);
    };
    let cur = startId;
    let presses = 0;
    let budget = PRESS_BUDGET;
    let aborted = false;
    // Arrow presses that changed the picture although the reported focus stayed put (the app draws its own
    // highlight, e.g. a canvas or WebView game read through Android's accessibility tree), and real focus moves.
    let selfDrawn = 0;
    let focusMoves = 0;

    const press = async (dir: RemoteKey): Promise<{ left: boolean; to: string; obs: Observation }> => {
      const before = tools.current();
      const fromId = focusOf(before)?.id;
      const obs = await tools.act(keyAction(dir));
      presses++;
      if (obs.foreground !== pkg || screenIdOf(obs) !== sc) return { left: true, to: EXIT_EDGE, obs };
      const f = focusOf(obs);
      note(f);
      if (f && fromId !== undefined) {
        if (f.id !== fromId) focusMoves++;
        else if (before?.frame && obs.frame && meanAbsDiff(before.frame.thumb64, obs.frame.thumb64) >= 1) selfDrawn++;
      }
      return { left: false, to: f ? f.id : LOST, obs };
    };
    const backToScreen = async (): Promise<boolean> => {
      const obs = await tools.act(keyAction('back'));
      presses++;
      const bf = focusOf(obs);
      if (obs.foreground === pkg && screenIdOf(obs) === sc && bf) {
        cur = bf.id;
        note(bf);
        return true;
      }
      if (await tools.returnTo(state.id)) {
        const now = tools.current();
        const nf = focusOf(now);
        if (now && screenIdOf(now) === sc && nf) {
          cur = nf.id;
          return true;
        }
      }
      aborted = true;
      return false;
    };
    const navigateTo = async (f: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 3 && cur !== f && presses < budget; attempt++) {
        const path = focusPath(G, cur, f);
        if (!path) return false;
        for (const dir of path) {
          const expected = G.get(cur)?.get(dir);
          const r = await press(dir);
          if (r.left) {
            setEdge(cur, dir, EXIT_EDGE);
            await backToScreen();
            return false;
          }
          setEdge(cur, dir, r.to); // the latest behaviour of an edge wins
          cur = r.to;
          if (cur === f) return true;
          if (cur === LOST) return false;
          if (cur !== expected) break; // the app moved somewhere else: plan again from here
        }
      }
      return cur === f;
    };
    /** One BFS over the focus graph from the current focus; returns the nodes reached. */
    const pass = async (): Promise<{ seen: Set<string>; complete: boolean }> => {
      const queue = [cur];
      const seen = new Set([cur]);
      const tested = new Set<string>();
      const requeued = new Set<string>();
      // No known way back to f yet (a grid where only the next row has been seen): finish it later, once.
      const later = (f: string) => {
        if (requeued.has(f)) return;
        requeued.add(f);
        queue.push(f);
      };
      while (queue.length && presses < budget && !aborted) {
        const f = queue.shift() as string;
        if (cur !== f && !(await navigateTo(f))) {
          later(f);
          continue;
        }
        for (const dir of DIRS) {
          if (presses >= budget || aborted) break;
          if (tested.has(`${f}|${dir}`)) continue;
          if (cur !== f && !(await navigateTo(f))) {
            later(f);
            break;
          }
          tested.add(`${f}|${dir}`);
          const r = await press(dir);
          if (r.left) {
            setEdge(f, dir, EXIT_EDGE);
            if (!(await backToScreen())) break;
            continue;
          }
          setEdge(f, dir, r.to);
          cur = r.to;
          if (r.to !== LOST && !seen.has(r.to)) {
            seen.add(r.to);
            queue.push(r.to);
          }
          if (r.to === LOST) {
            // Focus is gone: nothing to navigate from. Try to get it back the way we came.
            const back = await press(OPP[dir]);
            if (back.left) {
              if (!(await backToScreen())) break;
            } else cur = back.to;
            if (cur === LOST) break;
          } else if (r.to !== f && !tested.has(`${r.to}|${OPP[dir]}`) && presses < budget) {
            // Test the way back at once: it is a press the walk owes r.to anyway, and usually the only known path to f.
            const g = r.to;
            tested.add(`${g}|${OPP[dir]}`);
            const back = await press(OPP[dir]);
            if (back.left) {
              setEdge(g, OPP[dir], EXIT_EDGE);
              if (!(await backToScreen())) break;
              continue;
            }
            setEdge(g, OPP[dir], back.to);
            cur = back.to;
            if (back.to !== LOST && !seen.has(back.to)) {
              seen.add(back.to);
              queue.push(back.to);
            }
          }
        }
      }
      return { seen, complete: !queue.length && !aborted };
    };

    const p1 = await pass();
    if (aborted) return;
    budget = presses + PRESS_BUDGET;
    const before = JSON.stringify([...G].map(([k, v]) => [k, [...v]]));
    const p2 = await pass();
    const changed = before !== JSON.stringify([...G].map(([k, v]) => [k, [...v]]));
    const seenAll = new Set([...p1.seen, ...p2.seen]);
    const complete = p1.complete && (p2.complete || aborted);

    const pathFromStart = (f: string): TraceStep[] | undefined => {
      const dirs = focusPath(G, startId, f);
      if (!dirs) return undefined;
      return [...base, ...dirs.map((d, i) => ({ i: base.length + i, action: keyAction(d), gapMs: 400 }))];
    };
    const emitAt = (steps: TraceStep[] | undefined, investigateAgain: boolean, f: Parameters<OracleContext['emit']>[0]) =>
      ctx.emit(f, { steps: steps ?? base, investigate: investigateAgain });
    const anchor = tools.current() ?? start;
    const graphEdges = [...G].flatMap(([from, e]) => [...e].map(([dir, to]) => ({ from, dir, to })));
    graphs.push({ screen: sc, nodes: [...info.values()], edges: graphEdges });
    const changedNote = changed ? ' Focus behaviour changed while it was being explored (the second pass saw different moves).' : '';

    // The app draws its own focus: what FireLab reads as "focus" isn't what the player sees, so findings about
    // reachability, traps and spatial moves would be false. Say so instead.
    if (selfDrawn >= 3 && selfDrawn > focusMoves) {
      ctx.note(`focus checks skipped on a screen: the arrow keys changed the picture ${selfDrawn} times while the focus FireLab can read didn't move, so the app draws its own highlight. Publish window.firelab.marks.focus (web) or use real view focus to enable them.`);
      return;
    }

    // No verdict on reachability or traps unless focus was seen to move at all: a walk where nothing moved
    // (focus read from outside, or lost on the first press) is no evidence that controls are unreachable.
    if (focusMoves === 0) {
      ctx.note('focus checks inconclusive on a screen: focus never moved during the D-pad walk, so FireLab reports no unreachable controls or traps there.');
      return;
    }

    // Unreachable controls [55].
    if (complete)
      for (const f of F)
        if (!seenAll.has(f.id))
          emitAt(base, true, draft({ oracle: 'focus', kind: 'unreachable-control', severity: 'major', title: `${label(f.id, info)} can't be reached with the D-pad`, detail: `It is visible on this screen (rect ${f.rect.join(', ')}) but no sequence of up/down/left/right from ${label(startId, info)} gives it focus. Reached: ${[...seenAll].map((x) => label(x, info)).join(', ')}.${changedNote}`, signature: `unreachable-control|${sc}|${f.id}` }, anchor, state, { numbers: { focusables: F.length, reached: seenAll.size } }));

    // Focus traps [53]: a closed component that is smaller than the screen and that back does not leave.
    const total = Math.max(F.length, seenAll.size);
    for (const C of stronglyConnected(G)) {
      const set = new Set(C);
      const fullyTested = C.every((c) => DIRS.every((d) => G.get(c)?.has(d)));
      const leaves = C.some((c) => [...(G.get(c)?.values() ?? [])].some((g) => !set.has(g)));
      if (!fullyTested || leaves || C.length >= total) continue;
      const member = C[0] as string;
      if (aborted || !(await navigateTo(member))) continue;
      const b = await press('back');
      if (b.left) {
        await backToScreen();
        continue;
      }
      cur = b.to;
      emitAt(pathFromStart(member), true, draft({ oracle: 'focus', kind: 'focus-trap', severity: 'critical', title: `Focus trap: the D-pad and Back can't leave ${C.map((c) => label(c, info)).join(', ')}`, detail: `Once focus reaches this group of ${C.length} of ${total} controls, up/down/left/right only move inside it and Back does nothing. Outside it: ${[...info.keys()].filter((x) => !set.has(x)).map((x) => label(x, info)).join(', ')}.${changedNote}`, signature: `focus-trap|${sc}|${C.join(',')}` }, anchor, state, { numbers: { members: C.length, focusables: total } }));
    }

    // Non-spatial moves [54].
    const problems = spatialProblems(G, rects, [...info.values()]);
    if (problems.length) {
      const p = problems[0] as SpatialProblem;
      const steps = pathFromStart(p.from);
      const desc = (q: SpatialProblem) => `${q.dir} from ${label(q.from, info)} went to ${label(q.got, info)}${q.expected ? `, expected ${label(q.expected, info)}` : ''} (${q.why === 'wrong-direction' ? 'wrong direction' : 'skipped a closer control'})`;
      emitAt(
        steps ? [...steps, { i: steps.length, action: keyAction(p.dir), gapMs: 400 }] : undefined,
        false,
        draft({ oracle: 'focus', kind: 'non-spatial-move', severity: 'major', title: `D-pad ${p.dir} from ${label(p.from, info)} jumps to ${label(p.got, info)}${p.expected ? ` (expected ${label(p.expected, info)})` : ''}`, detail: `${problems.length} move(s) on this screen disagree with the layout:\n${problems.slice(0, 12).map((q) => `- ${desc(q)}`).join('\n')}${changedNote}`, signature: `non-spatial-move|${sc}|${p.from}|${p.dir}|${p.got}` }, anchor, state, { numbers: { badMoves: problems.length } }),
      );
    }

    // Focus lost while navigating [55].
    for (const [f, e] of G)
      for (const [dir, g] of e)
        if (g === LOST) {
          const steps = pathFromStart(f);
          emitAt(steps ? [...steps, { i: steps.length, action: keyAction(dir), gapMs: 400 }] : undefined, false, draft({ oracle: 'focus', kind: 'focus-lost', severity: 'minor', title: `Focus disappears after ${dir} from ${label(f, info)}`, detail: 'Nothing has focus after this move, so the next key press does nothing visible.', signature: `focus-lost|${sc}|${f}|${dir}` }, anchor, state));
        }
  }

  return {
    id: 'focus',
    cost: 'probe',
    needs: [], // the in-page probe (caps.eval) or native focus (driver.uiDump): createOracles checks for either
    check(ctx, obs, _prev, state) {
      if (focusOf(obs) !== undefined) sawFocus = true;
      const sc = screenIdOf(obs);
      const F = screenF.get(sc);
      if (F?.length && focusOf(obs) === null && obs.foreground === pkg)
        ctx.emit(draft({ oracle: 'focus', kind: 'focus-lost', severity: 'minor', title: 'Nothing has focus on a screen with controls', detail: `${F.length} controls could take focus, but none has it after ${obs.action ? JSON.stringify(obs.action) : 'launch'}.`, signature: `focus-lost|${sc}` }, obs, state));
    },
    wantsInvestigation(obs) {
      return !!focusOf(obs) && obs.foreground === pkg && investigations < MAX_INVESTIGATIONS && !investigated.has(screenIdOf(obs));
    },
    investigate,
    matches(signature, obs, prev) {
      const [kind, sc, f, dir, g] = signature.split('|');
      if (screenIdOf(obs) !== sc) return false;
      const key = obs.action?.kind === 'key' ? obs.action.key : undefined;
      if (kind === 'non-spatial-move') return focusOf(prev)?.id === f && key === dir && focusOf(obs)?.id === g;
      if (kind === 'focus-lost') return f ? focusOf(prev)?.id === f && key === dir && focusOf(obs) === null : focusOf(obs) === null;
      return false; // traps and unreachable controls need the investigation again
    },
    notes() {
      if (!sawFocus) return ['focus oracle off: no screen had focus information. Web apps: publish window.firelab.marks.focus (and window.firelab.focusables), or pass --focus-selector for apps that draw focus with a class. Native apps: focus comes from uiautomator dumps, which failed or found no focused view.'];
      return [];
    },
    graphs,
  };
}

/** The focus graphs an oracle built (for the report's per-screen focus map). */
export function focusGraphsOf(o: Oracle): FocusGraphRecord[] {
  return 'graphs' in o && Array.isArray((o as FocusOracle).graphs) ? (o as FocusOracle).graphs : [];
}
