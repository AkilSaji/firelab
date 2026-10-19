/**
 * Stuck and no-progress (docs/ENGINE.md 7.6), part of the explorer.
 * TimeMachine jumps away when progress stalls [8]; the engine does the same,
 * and reports the stall, because a screen the remote cannot get out of is a bug.
 */
import type { RemoteKey } from '../driver.js';
import type { Cell, Observation, Oracle } from '../types.js';
import { EXIT, type Graph } from '../graph.js';
import { draft } from './common.js';

export const PLATEAU_STEPS = 300;

export class StuckDetector {
  private lastNew = 0;
  private plateauReported = false;
  constructor(
    private readonly keys: readonly RemoteKey[],
    private readonly plateauSteps = PLATEAU_STEPS,
  ) {}

  onNewCell(step: number): void {
    this.lastNew = step;
  }

  /** Every key tried at least twice from here, and each one self-loops or leaves the app. */
  isDeadEnd(cell: Cell, graph: Graph): boolean {
    let selfLoops = 0;
    for (const k of this.keys) {
      if (k === 'home') continue;
      if (graph.tried(cell.id, k) < 2) return false;
      for (const to of graph.successors(cell.id, k).keys()) {
        if (to !== cell.id && to !== EXIT) return false;
        if (to === cell.id) selfLoops++;
      }
    }
    return selfLoops > 0;
  }

  deadEndFinding(cell: Cell, obs: Observation) {
    const keys = this.keys.filter((k) => k !== 'home');
    return draft(
      { oracle: 'stuck', kind: 'dead-end', severity: 'major', title: 'Dead end: no remote key leaves this screen', detail: `Each of ${keys.join(', ')} was pressed at least twice here; every press stayed on the same screen (or left the app). A viewer with a remote is stuck.`, signature: `dead-end|${cell.id}` },
      obs,
      cell,
    );
  }

  /** No new cell for `plateauSteps` steps: jump elsewhere. Returns the info finding the first time. */
  plateau(step: number, obs: Observation, cell: Cell): { stuck: boolean; finding?: ReturnType<typeof draft> } {
    if (step - this.lastNew < this.plateauSteps) return { stuck: false };
    this.lastNew = step; // jump, then give the new region its own window
    if (this.plateauReported) return { stuck: true };
    this.plateauReported = true;
    return {
      stuck: true,
      finding: draft({ oracle: 'stuck', kind: 'plateau', severity: 'info', title: `No new screen in ${this.plateauSteps} steps`, detail: 'Exploration stopped finding new states; the explorer jumped to another part of the app. If big parts of the app are missing from the state map, seed the run with a human session (--from-session).', signature: 'plateau' }, obs, cell),
    };
  }
}

/** The stuck oracle as replay sees it: being back in the dead-end state reproduces it. */
export const stuckOracle: Oracle = {
  id: 'stuck',
  cost: 'free',
  needs: [],
  check() {},
  matches(signature, obs) {
    const [kind, state] = signature.split('|');
    return kind === 'dead-end' && obs.stateId === state;
  },
};
