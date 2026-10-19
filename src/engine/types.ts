/**
 * Core engine types (docs/ENGINE.md section 4).
 *
 * Fields marked "extension" are small, optional additions to the design that
 * the MVP needed; everything else is as written in the design.
 */
import type { DeviceDriver, DriverCaps, RemoteKey, LogLine, ConsoleEntry } from './driver.js';
import type { GpuEmulation, GpuFailure } from '../fit/gpu-shim.js';

/** What the engine can do. Exploration only uses 'key' (and 'text' when a text field has focus). */
export type Action =
  | { kind: 'key'; key: RemoteKey; mode?: 'press' | 'long' | 'hold'; holdMs?: number; repeat?: number }
  | { kind: 'text'; text: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'relaunch' }; // stop + launch (used by return and replay)

/** Result of one in-page probe (one CDP evaluate). Discrete fields feed the state; continuous ones feed oracles. */
export type Probe = {
  url?: string;
  title?: string;
  hook?: boolean; // window.firelab present
  paused?: boolean;
  targetFps?: number;
  fps?: number;
  frameMs?: { p50: number; p95: number };
  scene?: string; // window.firelab.marks.scene
  marks?: Record<string, string | number | boolean>;
  app?: unknown; // result of the user's --state-expr, e.g. demo.state
  focus?: FocusInfo | null; // document.activeElement, --focus-selector, or marks.focus
  modal?: string; // topmost open dialog/overlay id, if any
  raf: number; // monotonically increasing frame counter (FireLab probe)
  errors: number; // count of uncaught errors + unhandled rejections so far
  heapMB?: number;
  video?: VideoInfo[];
  invariants?: Record<string, true | string>; // window.firelab.invariants results (section 9)
  /** extension: the last uncaught error, `message@file:line`, so a probe-counted error has a signature. */
  lastError?: string;
  /** extension: webglcontextlost events seen so far (7.2). */
  glLost?: number;
  /** extension: CSS viewport, for snapping focus rects to the 12x8 grid (5.3). */
  viewport?: [w: number, h: number];
  /** extension: 'draws' when raf counts frames that issued draw calls, 'raf' for plain rAF callbacks. */
  rafSource?: 'draws' | 'raf';
  /** extension: the GPU shim (--emulate-gpu) is in the page: its model and the contexts the page got. */
  gpu?: { model: string; webgl: number; webgl2: number; refused: number; drew1?: boolean };
  /** extension: WebGL calls the GPU shim failed since the page loaded. */
  gpuFails?: GpuFailure[];
};
export type FocusInfo = { id: string; rect: [x: number, y: number, w: number, h: number]; text?: string; role?: string };
export type VideoInfo = { id: string; t: number; paused: boolean; readyState: number; dropped?: number; total?: number };

export type Observation = {
  ts: number;
  step: number;
  foreground: string | null;
  probe?: Probe;
  frame?: { hash: string; luma: { mean: number; std: number }; thumb64?: Uint8Array; jpeg?: Buffer };
  logs: LogLine[]; // since the previous step
  console: ConsoleEntry[]; // since the previous step
  settleMs: number;
  /** extension: the foreground activity (L1 of the state key). */
  activity?: string;
  /** extension: the action that led to this observation (undefined right after a launch). */
  action?: Action;
  /** extension: the app's pid when observed. */
  pid?: number;
  /** extension: true when the app was (re)launched since the previous observation. */
  relaunched?: boolean;
  /** extension: thumb64 width and height. */
  thumbSize?: [w: number, h: number];
  /** extension: the abstract state of this observation (set by the explorer after abstraction). */
  stateId?: string;
  /** extension: native focus from a uiautomator dump, for apps without the in-page probe (null: nothing focused; absent: unknown). */
  focus?: FocusInfo | null;
  /** extension: the screen size the native focus rects are in. */
  viewport?: [w: number, h: number];
};

/** Abstract state. id = hash(key). */
export type State = {
  id: string;
  level: 1 | 2 | 3 | 4;
  /** `path` (URL path + hash) is an extension: the design lists the URL path under L2 but the key had no slot for it. */
  key: { pkg: string; activity?: string; path?: string; scene?: string; modal?: string; app?: string; focus?: string; vis?: string };
  firstSeenStep: number;
  thumb?: string; // file name of a representative thumbnail
};

/** Go-Explore cell = a State plus archive statistics. */
export type Cell = State & {
  visits: number; // times observed
  chosen: number; // times selected as an exploration start
  discovered: number; // new cells found while exploring from here
  failedReturns: number;
  depth: number; // length of the shortest known path from launch
  path: Action[]; // shortest known path from a fresh launch
  suspicion: number; // 0..1, from oracle "near misses" (fps dips, warnings)
  actionStats: Partial<Record<RemoteKey, { n: number; reward: number }>>;
};

export type Transition = { from: string; action: string; to: string; count: number; total: number }; // total = times (from, action) was tried

export type Severity = 'critical' | 'major' | 'minor' | 'info';

export type Finding = {
  id: string; // short id, e.g. f-3k9x
  oracle: string; // 'health' | 'screen' | 'focus' | 'perf' | 'memory' | 'invariant' | 'media' | 'stuck'
  kind: string; // e.g. 'js-exception', 'black-screen', 'focus-trap', 'non-spatial-move'
  severity: Severity;
  title: string; // one line people can act on
  detail: string;
  signature: string; // for de-duplication and for re-checking during replay/shrink
  stateId: string;
  step: number;
  ts: number;
  evidence: { thumbs: string[]; logs: string[]; probe?: Partial<Probe>; numbers?: Record<string, number> };
  trace: string; // file name of the full trace up to the finding
  minimized?: string; // file name of the shrunk trace
  repro?: { hits: number; runs: number };
  device: { serial: string; model?: string; name?: string; tier?: string };
  status: 'new' | 'confirmed' | 'flaky' | 'not-reproduced';
  /** extension: how often the signature fired during the run (first occurrence keeps the trace). */
  count?: number;
  /** extension: trace lengths before/after shrinking. */
  shrink?: { before: number; after: number; tests: number; ms: number };
};

export type TraceStep = { i: number; action: Action; gapMs: number; stateId?: string; frameHash?: string };
export type Trace = {
  version: 1;
  app: { package: string; url?: string; build?: string };
  device: Finding['device'];
  createdAt: number;
  seed: number;
  setup: Action[]; // what runs after launch before step 0 (e.g. relaunch, wait 3000)
  steps: TraceStep[];
  /** `investigate` (extension): the finding needs the oracle's investigation at the end (focus traps, unreachable controls). */
  expect?: { oracle: string; signature: string; investigate?: boolean };
  /** extension: how the run probed the app, so a replay computes the same states and signatures. */
  probe?: { stateExpr?: string; focusSelector?: string; setupEval?: string; visualState?: boolean; emulateGpu?: GpuEmulation };
  /** extension: the state right after setup, so loop cutting can drop a detour that starts at step 0. */
  startStateId?: string;
  /** extension: shorter step lists that may reach the same place (the archive's shortest path to the state before the finding); the minimiser tries them first. */
  shortcuts?: TraceStep[][];
};

/** A request from an oracle to record a finding (the explorer fills in id, trace, device and status). */
export type FindingDraft = Omit<Finding, 'id' | 'trace' | 'device' | 'status'>;

/** extension: what `emit` may say about the trace to keep. */
export type EmitOptions = {
  /** Steps to save as the finding's trace instead of the current episode (focus findings: path to screen + focus moves). */
  steps?: TraceStep[];
  /** The replay must run the oracle's investigation at the end to see the finding again. */
  investigate?: boolean;
};

/** extension: what an oracle's investigation may do (it presses keys; the explorer re-syncs afterwards). */
export type InvestigateTools = {
  /** Send an action, settle, and observe (light: probe + foreground, frame included). */
  act(action: Action): Promise<Observation>;
  /** Everything that could take focus on this screen right now. */
  focusables(): Promise<FocusInfo[]>;
  /** The screen id of an observation: L1 + L2 without app state or focus. */
  screenOf(obs: Observation): string;
  /** Back to a state by the explorer's return (graph or relaunch + replay). False when not possible here (replay). */
  returnTo(stateId: string): Promise<boolean>;
  /** The latest observation. */
  current(): Observation | undefined;
  /** Copy of the trace since the last launch. */
  traceSoFar(): TraceStep[];
};

export type OracleContext = {
  driver: DeviceDriver;
  config: ExploreConfig;
  graph: { cells: Map<string, Cell>; transitions: Map<string, Transition> };
  history: Observation[]; // ring buffer, last ~200 observations
  emit(f: FindingDraft, opts?: EmitOptions): void;
  /** extension: present while `investigate` runs. */
  tools?: InvestigateTools;
  /** extension: notes for the report ("focus oracle off: no focus info"). */
  note(text: string): void;
  /** extension: true when (stateId, actionKey) is a learned EXIT edge. */
  isExitEdge(stateId: string, action: string): boolean;
};

export interface Oracle {
  id: string;
  cost: 'free' | 'cheap' | 'probe' | 'expensive'; // 'probe' = may press keys to investigate (focus BFS, leak cycles)
  needs: (keyof DriverCaps)[];
  start?(ctx: OracleContext): Promise<void>;
  /** Called after every step. Must be fast and must not press keys. */
  check(ctx: OracleContext, obs: Observation, prev: Observation | undefined, state: State): void | Promise<void>;
  /** Optional deeper investigation the explorer schedules (presses keys; explorer re-syncs afterwards). */
  investigate?(ctx: OracleContext, state: State): Promise<void>;
  /** extension: does the oracle want to investigate this state now? (called by the explorer after `check`). */
  wantsInvestigation?(obs: Observation, state: State): boolean;
  /** Used by replay and shrink: does this observation sequence show the finding again? */
  matches(signature: string, obs: Observation, prev?: Observation): boolean;
  /** extension: end-of-run notes ("focus oracle skipped: no focus info on any screen"). */
  notes?(): string[];
}

export type ExploreConfig = {
  app: { package: string; url?: string };
  minutes?: number;
  steps?: number;
  seed: number;
  keys: RemoteKey[]; // default: up down left right ok back menu playpause (+ rewind fastforward at low prior)
  oracles: string[]; // default MVP: health, screen, focus
  stateExpr?: string; // JS expression returning small JSON, e.g. "demo.state"
  focusSelector?: string; // e.g. ".focused" for apps that draw focus with a class
  setupEval?: string; // e.g. "localStorage.clear()" for a clean start (only with --setup)
  reset: 'relaunch' | 'clear-data'; // clear-data only for FireLab-installed apps (CONTRACT safety rules)
  fromSessions?: string[]; // watch session ids to seed from
  strategy: 'explore' | 'random' | 'monkey'; // 'random' = uniform keys; 'monkey' = Android Monkey's D-pad event mix (6.6)
  minimize: boolean;
  outDir: string;
  /** extension: per-finding shrink budget in minutes (default 20, section 8). */
  minimizeBudgetMin?: number;
  /** extension: always add the visual bucket (L4) to the state key. */
  visualState?: boolean;
  /** extension: keys with a low prior (default rewind, fastforward when they are in `keys`). */
  lowPriorKeys?: RemoteKey[];
  /** extension: packages the run may drive although the safety rules protect them (--allow-package). */
  allowPackages?: string[];
  /** extension: shared knowledge (src/engine/knowledge.ts): community key priors and bug patterns, tried early on new screens. */
  knowledge?: { keyPriors: Partial<Record<RemoteKey, { n: number; changed: number }>>; patterns: { id: string; kind: string; keys: string[]; weight: number }[]; files: number };
  /** extension: false = the MVP explorer (depth term capped at 20, no frontier term, fixed episodes, no dive order), for ablations. Default true. */
  deep?: boolean;
  /** extension: collect V8 JS block coverage of the page (--coverage): a progress reward and an engine-independent metric. `include` is a regex over script URLs. */
  coverage?: { include?: string };
  /** extension: make WebGL report only this Fire TV GPU's features and limits (--emulate-gpu; src/fit/gpu-shim.ts). */
  emulateGpu?: GpuEmulation;
};
