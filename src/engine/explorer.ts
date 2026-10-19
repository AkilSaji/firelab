/**
 * The explorer (docs/ENGINE.md section 6): Go-Explore [20] on a TV.
 *
 * Keep an archive of cells, pick a promising one, *return* to it (over the
 * learned transition graph, or relaunch + replay its shortest path, because a
 * TV has no snapshots [8]), then *explore* from it with count-based key choice
 * [9, 21]. Oracles watch every step; the focus oracle gets to investigate each
 * new screen. `strategy: 'random'` is the monkey baseline (6.6): same keys,
 * same pace, same passive oracles, no archive, no return, no investigation.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceDriver, RemoteKey } from './driver.js';
import { realClock, type Clock } from './clock.js';
import type { FocusInfo } from './types.js';
import type { Action, Cell, EmitOptions, ExploreConfig, Finding, FindingDraft, InvestigateTools, Observation, Oracle, OracleContext, State, Trace, TraceStep, Transition } from './types.js';
import { Observer, type SettleOptions } from './observe.js';
import { Abstraction, focusOf, screenIdOf, sha1, stateLabel } from './abstraction.js';
import { Archive } from './archive.js';
import { EXIT, Graph, pathReliability } from './graph.js';
import { actionKey, baseKey, extraCostMs, parseActionKey } from './actions.js';
import { meanAbsDiff } from './frame.js';
import { createRng, type Rng } from './rng.js';
import { createOracles } from './oracles/index.js';
import { gpuShimScript } from '../fit/gpu-shim.js';
import { JsCoverage, type CoverageSummary } from './coverage.js';
import { focusGraphsOf, type FocusGraphRecord } from './oracles/focus.js';
import { StuckDetector } from './oracles/stuck.js';
import { assertAllowed, perform, relaunchApp } from './session.js';

/** Steps per exploration episode from a selected cell (K in 6.1). */
export const EPISODE_STEPS = 20;
/**
 * An episode that keeps finding new states keeps going, up to this many times
 * K: a return costs a relaunch plus the whole path on a TV, so a productive
 * run of discoveries is worth more than a fresh start (Go-Explore's
 * exploration phase, adapted to devices without snapshots [8, 20]).
 */
export const EPISODE_STRETCH = 4;
/**
 * At most this share of the run's key presses goes to oracle investigations
 * (the focus walk presses every arrow on every new screen). An app with a
 * dialog behind every button would otherwise spend the whole budget walking
 * focus and never go deep; screens over the cap are walked once the share
 * drops again.
 */
export const INVESTIGATE_SHARE = 0.3;
/**
 * Widget-level actions: on a screen with focusable controls the engine works
 * through them, moving the focus to the next control nobody pressed OK on yet
 * and pressing OK, like DroidBot and APE fire every clickable widget [5, 6].
 * A button opens a dialog, its buttons are next, and so on down. Plain key
 * choice still gets the rest of the presses.
 */
export const WIDGET_P = 0.7;
/** Arrow presses towards a control before giving up on reaching it greedily (the focus oracle judges reachability). */
const WIDGET_TRIES = 6;

/** Chance to try a learned bug pattern on a screen the run sees for the first time. */
export const PATTERN_P = 0.35;

type ScreenWidgets = { list: FocusInfo[]; activated: Set<string>; tries: Map<string, number>; target?: string };
/** Probability of a macro (repeat or long press) once every key was tried (6.2). */
export const MACRO_P = 0.1;
const HISTORY = 200;

export type ExploreEvent =
  | { type: 'start'; runId: string; dir: string; strategy: ExploreConfig['strategy'] }
  | { type: 'step'; step: number; states: number; findings: number; stateId: string; action: string }
  | { type: 'state'; step: number; stateId: string; label: string; thumb?: string }
  | { type: 'finding'; finding: Finding }
  | { type: 'relaunch'; reason: string }
  | { type: 'phase'; phase: 'explore' | 'minimize' | 'report' | 'done'; detail?: string };

/** blocks: distinct JS blocks covered so far (with --coverage). */
export type CoveragePoint = { t: number; step: number; states: number; blocks?: number };

export type ExploreCounters = {
  probes: number;
  frames: number;
  thumbs: number;
  relaunches: number;
  returnsGraph: number;
  returnsReplay: number;
  returnsFailed: number;
  investigations: number;
  macros: number;
  /** extension: uiautomator dumps for native focus, and steps that reused a cached one. */
  dumps?: number;
  dumpHits?: number;
};

export type RunDevice = Finding['device'] & { os?: string; ramMB?: number; kind?: string };

export type ExploreResult = {
  runId: string;
  dir: string;
  config: ExploreConfig;
  device: RunDevice;
  strategy: ExploreConfig['strategy'];
  startedAt: number;
  endedAt: number;
  durationMs: number;
  steps: number;
  states: number;
  findings: Finding[];
  coverage: CoveragePoint[];
  notes: string[];
  counters: ExploreCounters;
  cells: Cell[];
  transitions: Transition[];
  focusGraphs: FocusGraphRecord[];
  stopped: 'budget' | 'aborted' | 'error';
  error?: string;
  /** Median ms per step, for the report. */
  stepMs?: number;
  /** extension: how deep the archive reaches (shortest path from launch, in actions). */
  depth?: { max: number; maxCell?: string; mean: number; histogram: Record<string, number> };
  /** extension: JS block coverage of the page (--coverage). */
  jsCoverage?: CoverageSummary;
  /** extension: how the shared knowledge was used: patterns tried, and the findings they led to. */
  knowledge?: { files: number; patterns: number; tried: number; hits: { pattern: string; keys: string[]; kind: string; finding: string }[] };
};

export type ExplorerOptions = {
  driver: DeviceDriver;
  config: ExploreConfig;
  clock?: Clock;
  signal?: AbortSignal;
  onEvent?: (e: ExploreEvent) => void;
  settle?: SettleOptions;
  /** K: steps per episode (default 20). */
  episodeSteps?: number;
  /** No new cell for this many steps = plateau (default 300). */
  plateauSteps?: number;
  /** Wait this long for the page after a launch (default 20 s). */
  readyMs?: number;
  /** At most this many 480 px state thumbnails (each is a screenshot; default 150). */
  maxStateThumbs?: number;
  /** Run id (default: generated from the time). */
  runId?: string;
};

const now = () => new Date();
export function newRunId(d = now()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ex-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

type StepResult = { obs: Observation; state: State; cell?: Cell; isNew: boolean; inApp: boolean; newBlocks?: number };

export class Explorer {
  readonly runId: string;
  readonly dir: string;
  private readonly d: DeviceDriver;
  private readonly cfg: ExploreConfig;
  private readonly clock: Clock;
  private readonly signal?: AbortSignal;
  private readonly emitEvent: (e: ExploreEvent) => void;
  private readonly K: number;
  private readonly readyMs: number;
  private readonly maxStateThumbs: number;
  private readonly rng: Rng;
  private readonly observer: Observer;
  private readonly jsCov?: JsCoverage;
  private readonly abstraction: Abstraction;
  readonly archive = new Archive();
  readonly graph = new Graph();
  private oracles: Oracle[] = [];
  private oraclesBuilt = false;
  private readonly notes: string[] = [];
  private readonly stuck: StuckDetector;
  private readonly history: Observation[] = [];
  private readonly findings = new Map<string, Finding>();
  private drafts: { f: FindingDraft; opts?: EmitOptions }[] = [];
  private readonly coverage: CoveragePoint[] = [];
  private readonly counters: ExploreCounters = { probes: 0, frames: 0, thumbs: 0, relaunches: 0, returnsGraph: 0, returnsReplay: 0, returnsFailed: 0, investigations: 0, macros: 0 };
  private readonly ctx: OracleContext;
  private device: RunDevice;
  private startedAt = 0;
  private stepNo = 0;
  private cur?: Cell;
  private curObs?: Observation;
  private episodeCell?: Cell;
  private episode: TraceStep[] = [];
  private startStateId?: string;
  private lastPressTs = 0;
  private stepMsEma = 1500;
  private relaunchMsEma = 5000;
  private readonly stepDurations: number[] = [];
  private investigateSteps = 0;
  /** Per screen: its focusable controls and which ones got an OK. */
  private readonly widgets = new Map<string, ScreenWidgets>();
  /** Actions queued by a learned bug pattern; chooseAction takes them first. */
  private pending: Action[] = [];
  private patternRun?: { id: string; keys: string[]; untilStep: number };
  private patternNext = 0;
  private patternsTried = 0;
  private readonly patternHits: { pattern: string; keys: string[]; kind: string; finding: string }[] = [];
  /** Per screen, per key: how often it was a self-loop and how often it changed the state (for predictedNoops). */
  private readonly screenEffects = new Map<string, Map<RemoteKey, { noop: number; changed: number }>>();
  private investigating = false;
  private stateThumbs = 0;
  /** Per key over the whole run: presses, and presses that changed the picture or the state. */
  private readonly keyEffect = new Map<RemoteKey, { n: number; changed: number }>();
  private timeline?: fs.WriteStream;
  private phase: 'explore' | 'minimize' | 'report' | 'done' = 'explore';

  constructor(o: ExplorerOptions) {
    this.d = o.driver;
    this.cfg = o.config;
    this.clock = o.clock ?? realClock;
    this.signal = o.signal;
    this.emitEvent = o.onEvent ?? (() => {});
    this.K = o.episodeSteps ?? EPISODE_STEPS;
    this.readyMs = o.readyMs ?? 20_000;
    this.maxStateThumbs = o.maxStateThumbs ?? 150;
    this.runId = o.runId ?? newRunId();
    this.dir = o.config.outDir;
    this.rng = createRng(o.config.seed);
    this.observer = new Observer({ driver: o.driver, app: o.config.app, clock: this.clock, probe: { stateExpr: o.config.stateExpr, focusSelector: o.config.focusSelector }, settle: o.settle, ...(o.config.emulateGpu ? { initScripts: [gpuShimScript(o.config.emulateGpu)] } : {}) });
    this.abstraction = new Abstraction({ visualState: o.config.visualState });
    // Shared knowledge: community key priors count as a few presses each, so the run's own presses decide.
    if (o.config.knowledge && o.config.deep !== false)
      for (const [k, v] of Object.entries(o.config.knowledge.keyPriors) as [RemoteKey, { n: number; changed: number }][]) this.keyEffect.set(k, { n: v.n, changed: v.changed });
    if (o.config.coverage) {
      const re = o.config.coverage.include ? new RegExp(o.config.coverage.include) : undefined;
      this.jsCov = new JsCoverage(o.driver, re ? (u) => re.test(u) : undefined);
    }
    this.stuck = new StuckDetector(o.config.keys, o.plateauSteps);
    this.device = { serial: o.driver.serial, kind: o.driver.kind };
    this.ctx = {
      driver: o.driver,
      config: o.config,
      graph: { cells: this.archive.cells, transitions: this.graph.transitions },
      history: this.history,
      emit: (f, opts) => this.drafts.push({ f, opts }),
      note: (t) => this.notes.includes(t) || this.notes.push(t),
      isExitEdge: (s, a) => this.graph.isExit(s, a),
    };
  }

  /** A snapshot for status displays (MCP explore_status, the CLI's live line). */
  progress() {
    const counts = { critical: 0, major: 0, minor: 0, info: 0 };
    for (const f of this.findings.values()) counts[f.severity]++;
    return {
      runId: this.runId,
      dir: this.dir,
      phase: this.phase,
      step: this.stepNo,
      states: this.archive.size,
      elapsedMs: this.startedAt ? this.clock.now() - this.startedAt : 0,
      findings: counts,
      current: this.cur ? { stateId: this.cur.id, label: stateLabel(this.cur), thumb: this.cur.thumb ? path.join(this.dir, 'thumbs', this.cur.thumb) : undefined } : undefined,
      coverage: this.coverage.slice(-50),
    };
  }

  findingsSoFar(): Finding[] {
    return [...this.findings.values()];
  }

  setPhase(p: Explorer['phase'], detail?: string): void {
    this.phase = p;
    this.emitEvent({ type: 'phase', phase: p, detail });
  }

  // ---------- budget ----------

  private outOfBudget(): boolean {
    if (this.signal?.aborted) return true;
    if (this.cfg.steps !== undefined && this.stepNo >= this.cfg.steps) return true;
    if (this.cfg.minutes !== undefined && this.clock.now() - this.startedAt >= this.cfg.minutes * 60_000) return true;
    if (this.cfg.steps === undefined && this.cfg.minutes === undefined && this.stepNo >= 2000) return true;
    return false;
  }

  // ---------- the run ----------

  async run(): Promise<ExploreResult> {
    assertAllowed(this.cfg.app.package, this.cfg.allowPackages);
    fs.mkdirSync(path.join(this.dir, 'thumbs'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'traces'), { recursive: true });
    this.timeline = fs.createWriteStream(path.join(this.dir, 'timeline.jsonl'));
    this.startedAt = this.clock.now();
    this.emitEvent({ type: 'start', runId: this.runId, dir: this.dir, strategy: this.cfg.strategy });
    const info = await this.d.info().catch(() => ({}) as Awaited<ReturnType<DeviceDriver['info']>>);
    this.device = { serial: this.d.serial, kind: this.d.kind, model: info.model, name: info.name, tier: info.tier, os: info.os, ramMB: info.ramMB };
    await this.d.wake().catch(() => undefined);
    if (this.d.kind === 'vda')
      this.ctx.note("Vega OS: the driver can't ask which app is in front, so it reports the last app FireLab launched while that app still runs. Leaving the app while it keeps running (back at the root screen, home) isn't detected: keys after such an exit land in the launcher until the next relaunch, and dead ends or frozen pictures found there may be the launcher. FireLab sees the app go only when its process ends (a crash, or the app quitting itself): that is reported as unexpected-exit, and as crash only when the log has an Android-style FATAL EXCEPTION, which Vega apps may not print. The Vega driver has not run on a real device or the Vega Virtual Device yet (docs/VEGA.md).");
    if (this.cfg.reset === 'clear-data' && !this.d.caps.reset) this.ctx.note("reset clear-data: this driver can't clear app data, so each launch is a plain relaunch");

    let stopped: ExploreResult['stopped'] = 'budget';
    let error: string | undefined;
    try {
      await this.launch('start');
      if (this.cfg.strategy === 'random') await this.randomLoop();
      else if (this.cfg.strategy === 'monkey') await this.monkeyLoop();
      else await this.exploreLoop();
      if (this.signal?.aborted) stopped = 'aborted';
    } catch (e) {
      if (this.signal?.aborted) stopped = 'aborted';
      else {
        stopped = 'error';
        error = (e as Error)?.message ?? String(e);
      }
    } finally {
      this.observer.close();
      await new Promise<void>((r) => (this.timeline ? this.timeline.end(() => r()) : r()));
    }
    for (const o of this.oracles) for (const n of o.notes?.() ?? []) this.ctx.note(n);
    const c = this.observer.counters;
    Object.assign(this.counters, { probes: c.probes, frames: c.frames, thumbs: c.thumbs }, c.dumps || c.dumpHits ? { dumps: c.dumps, dumpHits: c.dumpHits } : {});
    if (this.observer.nativeOff) this.ctx.note(`native focus off: ${this.observer.nativeOffReason ?? 'uiautomator dumps kept failing (an animated screen never goes idle for uiautomator)'}`);
    this.coverage.push({ t: this.clock.now() - this.startedAt, step: this.stepNo, states: this.archive.size, ...(this.jsCov ? { blocks: this.jsCov.size } : {}) });
    if (this.jsCov?.off) this.ctx.note(this.jsCov.off);
    if (this.cfg.knowledge?.patterns.length)
      this.ctx.note(`shared knowledge: ${this.cfg.knowledge.patterns.length} bug patterns from ${this.cfg.knowledge.files} pack(s); tried ${this.patternsTried} on new screens${this.patternHits.length ? `, ${this.patternHits.length} led to findings (${[...new Set(this.patternHits.map((h) => `${h.keys.join(' ')} -> ${h.kind}`))].join('; ')})` : ''}.`);
    else if (this.jsCov && !this.jsCov.available) this.ctx.note('JS coverage off: the driver has no DevTools (cdp) access to the page');
    const sorted = [...this.stepDurations].sort((a, b) => a - b);
    const result: ExploreResult = {
      runId: this.runId,
      dir: this.dir,
      config: this.cfg,
      device: this.device,
      strategy: this.cfg.strategy,
      startedAt: this.startedAt,
      endedAt: this.clock.now(),
      durationMs: this.clock.now() - this.startedAt,
      steps: this.stepNo,
      states: this.archive.size,
      findings: this.findingsSoFar(),
      coverage: this.coverage,
      notes: this.notes,
      counters: this.counters,
      cells: [...this.archive.cells.values()],
      transitions: this.graph.toJSON(),
      focusGraphs: this.oracles.flatMap(focusGraphsOf),
      stopped,
      ...(error ? { error } : {}),
      ...(sorted.length ? { stepMs: Math.round(sorted[Math.floor(sorted.length / 2)] as number) } : {}),
      depth: this.archive.depthStats(),
      ...(this.cfg.knowledge ? { knowledge: { files: this.cfg.knowledge.files, patterns: this.cfg.knowledge.patterns.length, tried: this.patternsTried, hits: this.patternHits } } : {}),
      ...(this.jsCov?.available ? { jsCoverage: this.jsCov.summary() } : {}),
    };
    writeRunFiles(result);
    return result;
  }

  private async exploreLoop(): Promise<void> {
    while (!this.outOfBudget()) {
      const c = this.archive.select(this.rng, (x) => x.failedReturns < 6, this.deep ? (x) => this.frontier(x) : undefined) ?? this.cur;
      if (!c) break;
      if (!(await this.returnTo(c))) {
        c.failedReturns++;
        continue;
      }
      c.chosen++;
      this.episodeCell = c;
      // Known bug patterns also get tried from states the archive picks, not only on new screens.
      if (this.deep && this.rng.next() < 0.5) this.maybeQueuePattern();
      let budget = this.K;
      let lastGain = 0;
      for (let k = 0; k < budget && !this.outOfBudget(); k++) {
        const cur = this.cur as Cell;
        if (this.deep) await this.learnWidgets(cur);
        const a = this.chooseAction(cur);
        const r = await this.step(a);
        if (this.deep && (r.isNew || (r.newBlocks ?? 0) > 0)) {
          budget = Math.min(this.K * EPISODE_STRETCH, Math.max(budget, k + 1 + Math.ceil(this.K / 2)));
          lastGain = k;
        }
        // TimeMachine [8]: when an episode stops making progress, go back to the archive instead of finishing it.
        if (this.deep && k - lastGain >= this.K) break;
        if (!r.inApp) {
          await this.launch(`"${actionKey(a)}" left the app`);
          break;
        }
        const here = this.cur as Cell;
        if (this.stuck.isDeadEnd(here, this.graph)) {
          this.drafts.push({ f: this.stuck.deadEndFinding(here, r.obs) });
          await this.flushDrafts();
          if (this.blindExits) await this.launch('dead end (the app may have been left unseen)');
          break;
        }
        const pl = this.stuck.plateau(this.stepNo, r.obs, here);
        if (pl.finding) this.drafts.push({ f: pl.finding });
        if (pl.stuck) {
          await this.flushDrafts();
          if (this.blindExits) await this.launch('no progress (the app may have been left unseen)');
          break;
        }
        if (await this.maybeInvestigate(r)) {
          if (!this.inApp()) {
            await this.launch('investigation left the app');
            break;
          }
        }
      }
    }
  }

  private async randomLoop(): Promise<void> {
    const keys = this.cfg.keys;
    while (!this.outOfBudget()) {
      const a: Action = { kind: 'key', key: this.rng.pick(keys) };
      const r = await this.step(a);
      if (!r.inApp) await this.launch(`"${actionKey(a)}" left the app`);
    }
  }

  /**
   * Android Monkey's event mix on a remote, as `adb shell monkey --pct-nav 60
   * --pct-majornav 35 --pct-syskeys 5` sends it [N21]: arrows 60%, the major
   * navigation keys (centre/OK, Back, Menu) 35%, system keys 5% (Home, Back,
   * volume; volume does nothing to the app). Monkey keeps to its package, so
   * leaving the app relaunches it. Same passive oracles as 'random'.
   */
  private async monkeyLoop(): Promise<void> {
    const pool: [RemoteKey, number][] = [
      ['up', 15], ['down', 15], ['left', 15], ['right', 15],
      ['ok', 35 / 3], ['back', 35 / 3], ['menu', 35 / 3],
      ['home', 1.25], ['back', 1.25], ['volup', 1.25], ['voldown', 1.25],
    ];
    while (!this.outOfBudget()) {
      const key = pool[this.rng.weighted(pool.map((p) => p[1]))]![0];
      const a: Action = { kind: 'key', key };
      const r = await this.step(a);
      if (!r.inApp) await this.launch(`"${actionKey(a)}" left the app`);
    }
  }

  /** After the first launch, when the driver knows the app-level caps (eval, console). */
  private async buildOracles(): Promise<void> {
    this.oraclesBuilt = true;
    const built = createOracles(this.cfg.oracles, this.cfg, this.d.caps, { nativeFocus: this.observer.canDumpUi });
    this.oracles = built.oracles;
    for (const n of built.notes) this.ctx.note(n);
    if (!this.d.caps.eval && this.observer.canDumpUi) this.ctx.note('no JS evaluation in this app: focus comes from uiautomator dumps (native views), read once per new picture.');
    else if (!this.d.caps.eval) this.ctx.note('no JS evaluation in this app: states come from the screen only (L4 visual buckets). A debuggable WebView build (firelab wrap) gives app-level states and the focus oracle.');
    for (const o of this.oracles) await o.start?.(this.ctx);
  }

  /** The driver can't see the app being left (Vega: foreground() is the last launched app while it runs). */
  private get blindExits(): boolean {
    return this.d.kind === 'vda';
  }

  private inApp(): boolean {
    return this.curObs?.foreground === this.cfg.app.package;
  }

  // ---------- one step ----------

  private async launch(reason: string): Promise<StepResult> {
    if (reason !== 'start') this.emitEvent({ type: 'relaunch', reason });
    const t0 = this.clock.now();
    const { pid } = await relaunchApp(this.d, this.cfg.app, this.observer, this.clock, { reset: this.cfg.reset, setupEval: this.cfg.setupEval, readyMs: this.readyMs, signal: this.signal });
    this.counters.relaunches++;
    if (!this.oraclesBuilt) await this.buildOracles();
    this.episode = [];
    this.lastPressTs = 0;
    this.pending = [];
    this.patternRun = undefined;
    await this.jsCov?.start();
    const obs = await this.observer.observe(++this.stepNo, { relaunched: true, ...(pid !== undefined ? { pid } : {}) });
    await this.jsCov?.sample();
    this.relaunchMsEma = 0.7 * this.relaunchMsEma + 0.3 * (this.clock.now() - t0);
    const r = await this.ingest(obs, undefined);
    this.startStateId = r.inApp ? r.state.id : undefined;
    return r;
  }

  /** Press, settle, observe, abstract, check. */
  private async step(a: Action): Promise<StepResult> {
    if (this.signal?.aborted) throw new Error('aborted'); // also ends an oracle's investigation at once
    const t0 = this.clock.now();
    const gapMs = this.lastPressTs ? Math.round(t0 - this.lastPressTs) : 0;
    if (a.kind === 'key' && ((a.repeat ?? 1) > 1 || a.mode)) this.counters.macros++;
    if (this.investigating) this.investigateSteps++;
    await perform(this.d, a, this.clock, this.signal);
    this.lastPressTs = t0;
    const pidP = this.d.pid(this.cfg.app).catch(() => undefined);
    const obs = await this.observer.observe(++this.stepNo, { action: a });
    const pid = await pidP;
    if (pid !== undefined) obs.pid = pid;
    const newBlocks = (await this.jsCov?.sample()) ?? 0;
    if (this.jsCov && this.stepNo % 10 === 0) this.coverage.push({ t: this.clock.now() - this.startedAt, step: this.stepNo, states: this.archive.size, blocks: this.jsCov.size });
    const r = await this.ingest(obs, a, gapMs, newBlocks);
    const dt = this.clock.now() - t0 - extraCostMs(a, this.d.caps);
    this.stepMsEma = 0.8 * this.stepMsEma + 0.2 * dt;
    this.stepDurations.push(dt);
    if (this.stepDurations.length > 2000) this.stepDurations.splice(0, 1000);
    return r;
  }

  private async ingest(obs: Observation, a: Action | undefined, gapMs = 0, newBlocks = 0): Promise<StepResult> {
    const inApp = obs.foreground === this.cfg.app.package;
    const state = this.abstraction.abstract(obs);
    obs.stateId = inApp ? state.id : EXIT;
    const prev = this.curObs;
    const from = this.cur;
    if (a) {
      this.episode.push({ i: this.episode.length, action: a, gapMs, stateId: obs.stateId, ...(obs.frame ? { frameHash: obs.frame.hash } : {}) });
      if (from) this.graph.record(from.id, actionKey(a), obs.stateId);
    }
    let cell: Cell | undefined;
    let isNew = false;
    if (inApp) {
      const r = this.archive.observe(state, a && from ? [...from.path, a] : []);
      cell = r.cell;
      isNew = r.isNew;
      if (isNew) {
        this.stuck.onNewCell(this.stepNo);
        if (this.episodeCell && a) this.episodeCell.discovered++;
        this.coverage.push({ t: this.clock.now() - this.startedAt, step: this.stepNo, states: this.archive.size, ...(this.jsCov ? { blocks: this.jsCov.size } : {}) });
      }
    }
    if (from && a) {
      const k = baseKey(a);
      // New code counts as half a discovery: the state key may not change while the game reaches new logic.
      if (k) this.archive.recordReward(from, k, (isNew ? 1 : 0) + (newBlocks > 0 ? 0.5 : 0));
      if (newBlocks > 0 && !isNew && this.episodeCell && !this.investigating) this.episodeCell.discovered += 0.25;
      // OK on a focused control: that control was tried (widget-level actions).
      if (k === 'ok' && a.kind === 'key' && !a.mode) {
        const pf = focusOf(prev);
        const w = this.widgets.get(this.screenKey(from));
        if (pf && w) w.activated.add(pf.id);
      }
      if (k && a.kind === 'key' && !a.repeat && !a.mode) {
        const sk = this.screenKey(from);
        const m = this.screenEffects.get(sk) ?? new Map<RemoteKey, { noop: number; changed: number }>();
        this.screenEffects.set(sk, m);
        const e = m.get(k) ?? { noop: 0, changed: 0 };
        // A key that changed the focused control's label (a setting cycling: "Quality: auto" -> "high") did something,
        // even when the state key (focus id, scene) stayed the same.
        const label = (o: Observation | undefined) => focusOf(o)?.text ?? '';
        if (obs.stateId === from.id && label(obs) === label(prev)) e.noop++;
        else e.changed++;
        m.set(k, e);
      }
      if (k && prev?.frame && obs.frame && !this.investigating) {
        const e = this.keyEffect.get(k) ?? { n: 0, changed: 0 };
        e.n++;
        // With the in-page probe the state says whether a key did something; pixels alone can't, in a game that
        // animates every frame (every key would look effective).
        const probed = this.deep && !!obs.probe && !!prev.probe;
        if (obs.stateId !== prev.stateId || (probed && (focusOf(obs)?.text ?? '') !== (focusOf(prev)?.text ?? '')) || (!probed && meanAbsDiff(obs.frame.thumb64, prev.frame.thumb64) >= 0.5)) e.changed++;
        this.keyEffect.set(k, e);
      }
    }
    this.history.push(obs);
    if (this.history.length > HISTORY) this.history.shift();
    for (const o of this.oracles) {
      try {
        await o.check(this.ctx, obs, prev, state);
      } catch (e) {
        this.ctx.note(`${o.id} oracle error: ${(e as Error).message}`);
      }
    }
    this.curObs = obs;
    if (cell) this.cur = cell;
    if (isNew && cell) await this.onNewState(cell);
    await this.flushDrafts();
    this.timeline?.write(
      JSON.stringify({ step: obs.step, t: obs.ts - this.startedAt, action: a ? actionKey(a) : 'launch', gapMs, stateId: obs.stateId, new: isNew || undefined, fg: inApp ? undefined : obs.foreground, frame: obs.frame?.hash, luma: obs.frame ? Math.round(obs.frame.luma.mean) : undefined, settleMs: obs.settleMs, inv: this.investigating || undefined }) + '\n',
    );
    if (a) this.emitEvent({ type: 'step', step: obs.step, states: this.archive.size, findings: this.findings.size, stateId: obs.stateId, action: actionKey(a) });
    return { obs, state, cell, isNew, inApp, newBlocks };
  }

  private async onNewState(cell: Cell): Promise<void> {
    let thumb: string | undefined;
    if (this.stateThumbs < this.maxStateThumbs) {
      const t = await this.observer.thumb();
      if (t) {
        thumb = `s-${cell.id}.${t.mime === 'image/png' ? 'png' : 'jpg'}`;
        fs.writeFileSync(path.join(this.dir, 'thumbs', thumb), t.data);
        cell.thumb = thumb;
        this.stateThumbs++;
      }
    }
    this.emitEvent({ type: 'state', step: this.stepNo, stateId: cell.id, label: stateLabel(cell), thumb });
  }

  // ---------- findings ----------

  private async flushDrafts(): Promise<void> {
    while (this.drafts.length) {
      const { f, opts } = this.drafts.shift() as { f: FindingDraft; opts?: EmitOptions };
      await this.addFinding(f, opts);
    }
  }

  private async addFinding(f: FindingDraft, opts?: EmitOptions): Promise<void> {
    const known = this.findings.get(f.signature);
    // A finding while a learned pattern's keys were going out (or just after) is credited to the pattern.
    if (this.patternRun && this.stepNo <= this.patternRun.untilStep && f.severity !== 'info') {
      const fid = known?.id ?? `f-${sha1(f.signature).slice(0, 6)}`;
      if (!this.patternHits.some((h) => h.pattern === this.patternRun!.id && h.finding === fid)) this.patternHits.push({ pattern: this.patternRun.id, keys: this.patternRun.keys, kind: f.kind, finding: fid });
    }
    if (known) {
      known.count = (known.count ?? 1) + 1;
      return;
    }
    if (this.blindExits && (f.kind === 'dead-end' || f.kind === 'frozen-screen')) {
      // The "screen" may be the launcher after the app was left unseen (keys there change nothing).
      if (f.kind === 'dead-end') f.severity = 'minor';
      f.detail += ' On Vega OS FireLab cannot tell when the app was left, so this may be the launcher or another app: check the screenshot.';
    } else if (this.blindExits && f.kind === 'unexpected-exit') {
      f.detail += " On Vega OS FireLab sees an exit only when the app's process ends, so this is likely a crash: check the device log (`vega exec vda shell loggingctl log`).";
    }
    const id = `f-${sha1(f.signature).slice(0, 6)}`;
    const steps = (opts?.steps ?? this.episode).map((s, i) => ({ ...s, i }));
    const trace: Trace = {
      version: 1,
      app: { ...this.cfg.app },
      device: { serial: this.device.serial, model: this.device.model, name: this.device.name, tier: this.device.tier },
      createdAt: Date.now(),
      seed: this.cfg.seed,
      setup: [{ kind: 'relaunch' }],
      steps,
      expect: { oracle: f.oracle, signature: f.signature, ...(opts?.investigate ? { investigate: true } : {}) },
      probe: { stateExpr: this.cfg.stateExpr, focusSelector: this.cfg.focusSelector, setupEval: this.cfg.setupEval, visualState: this.cfg.visualState, ...(this.cfg.emulateGpu ? { emulateGpu: this.cfg.emulateGpu } : {}) },
      ...(this.startStateId ? { startStateId: this.startStateId } : {}),
    };
    const shortcuts = this.shortcutsFor(f, steps, opts);
    if (shortcuts.length) trace.shortcuts = shortcuts;
    const traceFile = `${id}.trace.json`;
    fs.writeFileSync(path.join(this.dir, 'traces', traceFile), JSON.stringify(trace, null, 1));
    const thumbs: string[] = [];
    if (this.inApp() || f.kind === 'black-screen') {
      const t = await this.observer.thumb();
      if (t) {
        const name = `f-${id.slice(2)}.${t.mime === 'image/png' ? 'png' : 'jpg'}`;
        fs.writeFileSync(path.join(this.dir, 'thumbs', name), t.data);
        thumbs.push(name);
      }
    }
    // Filmstrip: the state thumbnails along the last steps (no extra screenshots).
    const strip: string[] = [];
    for (const o of this.history.slice(-8)) {
      const th = o.stateId ? this.archive.get(o.stateId)?.thumb : undefined;
      if (th && strip[strip.length - 1] !== th) strip.push(th);
    }
    thumbs.push(...strip.slice(-5));
    const finding: Finding = {
      ...f,
      id,
      evidence: { ...f.evidence, thumbs: [...thumbs, ...f.evidence.thumbs] },
      trace: traceFile,
      device: trace.device,
      status: 'new',
      count: 1,
    };
    const cell = this.archive.get(f.stateId);
    if (cell && f.severity !== 'info') cell.suspicion = Math.min(1, cell.suspicion + (f.severity === 'minor' ? 0.3 : 0.6));
    this.findings.set(f.signature, finding);
    this.emitEvent({ type: 'finding', finding });
  }

  /**
   * The archive's shortest path to where the finding started, plus the step
   * that triggered it: often far shorter than the episode (a random walk, or a
   * long detour), and a cheap first test for the minimiser.
   */
  private shortcutsFor(f: FindingDraft, steps: TraceStep[], opts?: EmitOptions): TraceStep[][] {
    const gap = Math.round(Math.min(this.stepMsEma, 3000));
    const mk = (actions: Action[]): TraceStep[] => actions.map((action, i) => ({ i, action, gapMs: gap }));
    const out: TraceStep[][] = [];
    const seen = new Set<string>();
    const add = (c: TraceStep[]) => {
      const k = JSON.stringify(c.map((x) => actionKey(x.action)));
      if (c.length < steps.length && !seen.has(k)) seen.add(k), out.push(c.map((x, i) => ({ ...x, i })));
    };
    if (opts?.investigate) {
      const c = this.archive.get(f.stateId);
      if (c) add(mk(c.path));
    } else if (!opts?.steps) {
      // The cause is often a few keys before the symptom (a freeze shows seconds later): try the last 1..6 steps.
      for (let j = 1; j <= Math.min(6, steps.length - 1); j++) {
        const before = steps[steps.length - j - 1]?.stateId;
        const c = before ? this.archive.get(before) : undefined;
        if (c) add([...mk(c.path), ...steps.slice(-j)]);
      }
    }
    return out.sort((x, y) => x.length - y.length).slice(0, 4);
  }

  // ---------- 6.2 action choice ----------

  /** A key that, over 8+ presses this run, changed the picture less than 10% of the time: this app ignores it. */
  isDeadKey(k: RemoteKey): boolean {
    const e = this.keyEffect.get(k);
    return !!e && e.n >= (this.deep ? 6 : 8) && e.changed / e.n < 0.1;
  }

  /** The screen a cell belongs to: its key without focus, app state and visual bucket. */
  private screenKey(c: Pick<Cell, 'key'>): string {
    const { pkg, activity, path, scene, modal } = c.key;
    return JSON.stringify([pkg, activity, path, scene, modal]);
  }

  /**
   * Keys predicted to do nothing in this state: on two or more other focus
   * positions of the same screen they led back to the same state, and never
   * anywhere else on that screen (a screen-level action model, the way APE and
   * Fastbot share what they learn between similar states [5]). Up/down in a
   * row of buttons, for example. They are tried last, not never.
   */
  predictedNoops(c: Cell): Set<RemoteKey> {
    const out = new Set<RemoteKey>();
    const m = this.screenEffects.get(this.screenKey(c));
    if (!m) return out;
    for (const [k, e] of m) if (e.noop >= 2 && e.changed === 0) out.add(k);
    return out;
  }

  private get deep(): boolean {
    return this.cfg.deep !== false;
  }

  /** The share of this state's keys never tried (exits and keys the app ignores don't count): 1 = untouched frontier. */
  frontier(c: Cell): number {
    const keys = this.cfg.keys.filter((k) => !this.graph.isExit(c.id, k) && !this.isDeadKey(k));
    if (!keys.length) return 0;
    return keys.filter((k) => c.actionStats[k] === undefined).length / keys.length;
  }

  /** Reads a screen's focusable controls the first time the run is on it (one evaluate, or a cached native dump). */
  private async learnWidgets(c: Cell): Promise<void> {
    const sk = this.screenKey(c);
    if (this.widgets.has(sk)) return;
    const list = await this.observer.focusables().catch(() => [] as FocusInfo[]);
    this.widgets.set(sk, { list: list.slice(0, 40), activated: new Set(), tries: new Map() });
    this.maybeQueuePattern();
  }

  /**
   * On a screen seen for the first time, sometimes try a bug pattern other
   * developers' runs confirmed (best first, round robin): its keys go out
   * before anything else. A finding during the pattern is credited to it.
   */
  private maybeQueuePattern(): void {
    const pats = this.cfg.knowledge?.patterns ?? [];
    if (!pats.length || this.pending.length || this.rng.next() >= PATTERN_P) return;
    const p = pats[this.patternNext++ % pats.length]!;
    const actions = p.keys.map((k) => parseActionKey(k)).filter((a): a is Action => !!a && a.kind === 'key' && this.cfg.keys.includes(a.key));
    if (actions.length !== p.keys.length) return;
    this.pending = actions;
    this.patternRun = { id: p.id, keys: p.keys, untilStep: this.stepNo + actions.length + 3 };
    this.patternsTried++;
  }

  /**
   * The next press towards an untried control on this screen: OK when the
   * focus is on it, else the arrow that points at it (from the two rects).
   * Undefined when every control was tried, or the focus can't be read.
   */
  widgetAction(c: Cell): Action | undefined {
    const w = this.widgets.get(this.screenKey(c));
    if (!w || !w.list.length) return undefined;
    const f = focusOf(this.curObs);
    if (!f) return undefined;
    if (w.target && (w.activated.has(w.target) || (w.tries.get(w.target) ?? 0) >= WIDGET_TRIES)) w.target = undefined;
    if (!w.target) {
      const open = w.list.filter((x) => !w.activated.has(x.id) && (w.tries.get(x.id) ?? 0) < WIDGET_TRIES);
      if (!open.length) return undefined;
      // The focused control first, then the nearest one.
      const dist = (x: FocusInfo) => Math.abs(x.rect[0] - f.rect[0]) + Math.abs(x.rect[1] - f.rect[1]);
      w.target = (open.find((x) => x.id === f.id) ?? open.sort((a, b) => dist(a) - dist(b))[0])!.id;
    }
    const t = w.list.find((x) => x.id === w.target)!;
    if (t.id === f.id) return { kind: 'key', key: 'ok' };
    w.tries.set(t.id, (w.tries.get(t.id) ?? 0) + 1);
    const dx = t.rect[0] + t.rect[2] / 2 - (f.rect[0] + f.rect[2] / 2);
    const dy = t.rect[1] + t.rect[3] / 2 - (f.rect[1] + f.rect[3] / 2);
    const key: RemoteKey = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    return { kind: 'key', key };
  }

  chooseAction(c: Cell): Action {
    const queued = this.pending.shift();
    if (queued) return queued;
    if (this.deep && this.rng.next() < WIDGET_P) {
      const w = this.widgetAction(c);
      if (w) return w;
    }
    const keys = this.cfg.keys;
    const low = new Set<RemoteKey>(this.cfg.lowPriorKeys ?? ['rewind', 'fastforward']);
    // Keys the app ignores join the low-prior set: still tried now and then, not on every new screen.
    for (const k of keys) if (this.isDeadKey(k)) low.add(k);
    if (this.deep) for (const k of this.predictedNoops(c)) if (c.actionStats[k] === undefined) low.add(k);
    const notExit = (k: RemoteKey) => !this.graph.isExit(c.id, k);
    const untried = keys.filter((k) => c.actionStats[k] === undefined && notExit(k));
    // Timing bugs (double starts, races) need fast repeats in screens the run keeps coming back to,
    // even before every key there was tried.
    if (this.deep && c.visits >= 3 && this.rng.next() < MACRO_P / 2) return this.macro(keys.filter(notExit).length ? keys.filter(notExit) : keys.slice(), low);
    const untriedMain = untried.filter((k) => !low.has(k));
    if (untriedMain.length && !(untried.length > untriedMain.length && this.rng.next() < 0.15)) {
      // Dive first: OK opens the dialog, menu or level behind the focused control (DroidBot-style depth-first [6]);
      // Back climbs out, so it waits until the rest of this state was tried.
      if (!this.deep) return { kind: 'key', key: this.rng.pick(untriedMain) };
      if (untriedMain.includes('ok') && this.rng.next() < 0.5) return { kind: 'key', key: 'ok' };
      const forward = untriedMain.filter((k) => k !== 'back');
      return { kind: 'key', key: this.rng.pick(forward.length ? forward : untriedMain) };
    }
    if (untried.length) return { kind: 'key', key: this.rng.pick(untried) };
    let cand = keys.filter(notExit);
    if (!cand.length) cand = keys.slice();
    if (this.rng.next() < MACRO_P) return this.macro(cand, low);
    let best: RemoteKey[] = [];
    let bestScore = -Infinity;
    for (const k of cand) {
      const st = c.actionStats[k] ?? { n: 0, reward: 0 };
      let score = (st.n ? st.reward / st.n : 0) + 0.7 / Math.sqrt(1 + st.n);
      if (low.has(k)) score *= 0.5;
      if (score > bestScore + 1e-9) (bestScore = score), (best = [k]);
      else if (Math.abs(score - bestScore) <= 1e-9) best.push(k);
    }
    return { kind: 'key', key: this.rng.pick(best) };
  }

  /** A fast repeat or a long press (6.2). OK weighs 3x: fast repeated OK is where start/resume races hide (Sunset Villa's double start). */
  private macro(cand: RemoteKey[], low: Set<RemoteKey>): Action {
    const main = cand.filter((k) => !low.has(k));
    const pool = main.length ? main : cand;
    const k = pool[this.rng.weighted(pool.map((x) => (x === 'ok' ? 3 : 1)))] as RemoteKey;
    return this.rng.next() < 0.7 ? { kind: 'key', key: k, repeat: this.rng.int(3, 8) } : { kind: 'key', key: k, mode: 'long' };
  }

  // ---------- 6.3 return ----------

  async returnTo(c: Cell): Promise<boolean> {
    if (!this.inApp() || !this.cur) await this.launch('return: the app was not in front');
    if (this.cur?.id === c.id) return true;
    const p = this.graph.shortestPath((this.cur as Cell).id, c.id, 0.8);
    const costGraph = p ? (p.length * this.stepMsEma) / Math.max(pathReliability(p), 0.05) : Infinity;
    const costReplay = this.relaunchMsEma + c.path.length * this.stepMsEma;
    if (p && costGraph <= costReplay) {
      for (const e of p) {
        const a = parseActionKey(e.action);
        if (!a || this.outOfBudget()) break;
        const r = await this.step(a);
        if (!r.inApp || this.cur?.id !== e.to) break;
      }
      if (this.inApp() && this.cur?.id === c.id) {
        this.counters.returnsGraph++;
        return true;
      }
      if (this.outOfBudget()) return false;
    }
    await this.launch('return by replay');
    for (const a of c.path) {
      if (this.outOfBudget()) return false;
      const r = await this.step(a);
      if (!r.inApp) break;
    }
    const ok = this.inApp() && this.cur?.id === c.id;
    if (ok) this.counters.returnsReplay++;
    else this.counters.returnsFailed++;
    // Landing elsewhere is not an error: the app is nondeterministic [46]. Explore from here next time.
    return ok;
  }

  // ---------- oracle investigations ----------

  private async maybeInvestigate(r: StepResult): Promise<boolean> {
    if (this.investigating || !r.inApp) return false;
    if (this.deep && this.stepNo > 50 && this.investigateSteps / this.stepNo > INVESTIGATE_SHARE) return false;
    let ran = false;
    for (const o of this.oracles) {
      if (!o.investigate || !o.wantsInvestigation?.(r.obs, r.state)) continue;
      if (this.outOfBudget()) break;
      this.investigating = true;
      this.ctx.tools = this.tools();
      try {
        await o.investigate(this.ctx, r.state);
      } catch (e) {
        if (!this.signal?.aborted) this.ctx.note(`${o.id} investigation error: ${(e as Error).message}`);
      } finally {
        this.ctx.tools = undefined;
        this.investigating = false;
      }
      this.counters.investigations++;
      ran = true;
      await this.flushDrafts();
    }
    return ran;
  }

  private tools(): InvestigateTools {
    return {
      act: async (a) => (await this.step(a)).obs,
      focusables: () => this.observer.focusables(),
      screenOf: (obs) => screenIdOf(obs),
      returnTo: async (id) => {
        const c = this.archive.get(id);
        return c ? this.returnTo(c) : false;
      },
      current: () => this.curObs,
      traceSoFar: () => this.episode.map((s) => ({ ...s })),
    };
  }
}

/** Writes run.json, graph.json and findings.json (the timeline is written while running). */
export function writeRunFiles(r: ExploreResult): void {
  fs.mkdirSync(r.dir, { recursive: true });
  const { cells, transitions, focusGraphs, findings, ...run } = r;
  fs.writeFileSync(path.join(r.dir, 'run.json'), JSON.stringify(run, null, 1));
  fs.writeFileSync(path.join(r.dir, 'graph.json'), JSON.stringify({ cells, transitions, focusGraphs }));
  fs.writeFileSync(path.join(r.dir, 'findings.json'), JSON.stringify(findings, null, 1));
}

/** Reads a run directory back (for `firelab report`, explore_findings after a restart). */
export function readRunDir(dir: string): ExploreResult {
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as Omit<ExploreResult, 'cells' | 'transitions' | 'focusGraphs' | 'findings'>;
  const g = fs.existsSync(path.join(dir, 'graph.json')) ? (JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8')) as Pick<ExploreResult, 'cells' | 'transitions' | 'focusGraphs'>) : { cells: [], transitions: [], focusGraphs: [] };
  const findings = fs.existsSync(path.join(dir, 'findings.json')) ? (JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8')) as Finding[]) : [];
  return { ...run, dir, cells: g.cells ?? [], transitions: g.transitions ?? [], focusGraphs: g.focusGraphs ?? [], findings };
}
