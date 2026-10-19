/**
 * Benchmark subjects: web games with seeded bugs and ground truth.
 *
 * Each seeded bug records when it fires in the page (window.firelabBugsHit),
 * whoever drives the game, so every strategy is scored on the same yardstick:
 * a bug is *triggered* when the game says it fired, and *detected* when the
 * tester also reported it (a finding of a matching kind). Ground truth by
 * seeded faults follows the mutation-analysis tradition (Just et al., FSE
 * 2014) and Themis's reproducible real bugs (Su et al., FSE 2021).
 */
import type { Finding } from '../engine/types.js';

export type SeededBug = {
  id: string;
  /** What the bug is, for the report. */
  what: string;
  /** Rough key presses from launch to trigger it. */
  depth: number;
  /** Does this finding report the bug? */
  matches(f: Pick<Finding, 'kind' | 'title' | 'detail'>): boolean;
};

export type BenchSubject = {
  id: string;
  name: string;
  /** Path under the repository's examples/ folder (served by the benchmark), or a full URL. */
  path?: string;
  url?: string;
  /** Regex over script URLs counted for JS coverage (the game's own code, not libraries). */
  coverageInclude?: string;
  stateExpr?: string;
  focusSelector?: string;
  bugs: SeededBug[];
  /** An expression returning the deepest progress the game reached (a number), for an engine-independent depth. */
  progressExpr?: string;
  progressLabel?: string;
  notes?: string;
};

const kind = (...kinds: string[]) => (f: Pick<Finding, 'kind'>) => kinds.includes(f.kind);
const text = (k: string[], re: RegExp) => (f: Pick<Finding, 'kind' | 'title' | 'detail'>) => k.includes(f.kind) && re.test(`${f.title}\n${f.detail}`);

export const SUBJECTS: Record<string, BenchSubject> = {
  firefly: {
    id: 'firefly',
    name: 'Firefly Lake (three.js arcade game, 5 seeded bugs)',
    path: 'web-game/?bugs=all',
    coverageInclude: 'examples/web-game/',
    focusSelector: '.focused',
    stateExpr: '({ mode: demo.state.mode })',
    bugs: [
      { id: 'grid', what: 'menu drawn in 2 columns: ▲▼ ignore the layout and a "Credits" cell is unreachable', depth: 3, matches: kind('unreachable-control', 'non-spatial-move') },
      { id: 'trap', what: 'after visiting Quality, ▲▼ cycle 3 items and Back does nothing (focus trap)', depth: 5, matches: kind('focus-trap', 'dead-end') },
      { id: 'throw', what: '◀ on Quality after ▶ throws a TypeError', depth: 6, matches: text(['js-exception'], /label|TypeError/) },
      { id: 'black', what: 'OK within 300 ms of Resume blanks the screen', depth: 6, matches: kind('black-screen') },
      { id: 'freeze', what: 'after the 2nd lantern the render loop stops', depth: 8, matches: kind('render-loop-stopped', 'frozen-screen') },
    ],
    notes: 'three.js loads from jsDelivr: the machine needs internet access.',
  },
  'deep-quest': {
    id: 'deep-quest',
    name: 'Deep Quest (TV RPG with nested dialogs and a 30-floor dungeon, 6 seeded bugs)',
    path: 'deep-quest/?bugs=all',
    coverageInclude: 'examples/deep-quest/',
    // What a developer would expose with --state-expr: which items are in the bag (a set: order and count don't
    // matter), the video quality, the used save slots and the camp floor. Not gold: every purchase would be a new state.
    stateExpr: "(() => { const g = deepQuest.game; return { bag: [...new Set(g.inventory.map((i) => i.id))].sort().join(','), q: g.quality, saves: Object.keys(g.saves).sort().join(''), camp: g.camp }; })()",
    progressExpr: 'window.firelabDepth ? window.firelabDepth.floor : 0',
    progressLabel: 'deepest dungeon floor',
    bugs: [
      { id: 'options', what: 'Options › Video › High › Apply, then Controls › Remap › OK throws', depth: 9, matches: text(['js-exception'], /'ok'|reading 'ok'|TypeError/) },
      { id: 'shop', what: 'buying the Key, then resting at the inn blanks the screen', depth: 12, matches: kind('black-screen') },
      { id: 'inn', what: 'saving to slot 3 twice traps the focus (Back does nothing)', depth: 16, matches: kind('focus-trap', 'dead-end') },
      { id: 'chest', what: "taking the floor-10 chest's loot while carrying the Key throws", depth: 40, matches: text(['js-exception'], /count|TypeError/) },
      { id: 'freeze', what: 'the middle door on floor 20 stops the render loop', depth: 70, matches: kind('render-loop-stopped', 'frozen-screen') },
      { id: 'boss', what: 'defending three times against the floor-30 boss throws on every frame', depth: 100, matches: text(['js-exception', 'black-screen'], /shield|black|blank/i) },
    ],
  },
};

/** "name=url" for a custom subject (no seeded bugs: coverage, states and findings only). */
export function customSubject(spec: string): BenchSubject {
  const i = spec.indexOf('=');
  const id = i > 0 ? spec.slice(0, i) : `web-${Math.random().toString(36).slice(2, 6)}`;
  const url = i > 0 ? spec.slice(i + 1) : spec;
  if (!/^https?:\/\//.test(url)) throw new Error(`--subject needs name=http(s)://url (got ${spec})`);
  return { id, name: id, url, bugs: [] };
}
