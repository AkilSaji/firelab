# FireLab Engine: design

The FireLab Engine explores a TV app or game on its own, with no human at the
remote. It watches for bugs while it goes, shrinks every failing key sequence
to a short one that reproduces, and writes a report someone can act on. It runs
on real devices:
- Fire OS (Android), over adb and the Chrome DevTools Protocol (CDP) into the WebView;
- later, Vega OS over `vda`.

Bracketed numbers such as [8] refer to the reference list in
[RESEARCH.md](RESEARCH.md).

Status, 2026-10-16: the MVP (section 11) is built in `src/engine/`: explorer
(Go-Explore + the random baseline), the health/screen/focus/stuck oracles, the
minimiser, traces and replay, report.html/report.md, `firelab
explore|replay|shrink|report` and the `explore_*` MCP tools. Tests run on a
simulated game in `test/engine/`. Measured results on a Fire TV are in the
README ("Game testing engine"). Tier A and B items are not built. Small
additions to the design are marked "extension" in `src/engine/types.ts`
(for example trace `shortcuts`, which the minimiser tries first).

Ownership (agreed with the session that owns FireLab core):

| Path | Owner |
|---|---|
| `src/engine/`, `test/engine/` | engine (this design) |
| `examples/web-game/bugs.js` (seeded bugs, loaded only with `?bugs=`) | engine |
| `src/driver/` (the `DeviceDriver` interface, `AdbDriver`, later `VdaDriver`) | FireLab core session |
| `src/mcp/server.ts`, `src/http/`, `src/cli.ts` wiring | FireLab core session (the engine exports functions they call) |
| `window.firelab` hook additions in `packages/perf` | perf/examples agent (proposals in section 9) |

The engine is written against `DeviceDriver` only. It never imports `src/adb/`
or `src/cdp/`. It may import `src/lib/` (stats, errors, paths, logging).

---

## 1. Goals and constraints

**Goal:** find more real bugs per hour of device time than a random monkey
[1, 2], and hand each one over as a short trace that reproduces, with a measured
reproduction rate.

**What makes a TV different from the phones in the literature:**

| Constraint | Number (measured on FireLab's devices, or noted as an estimate) | Consequence |
|---|---|---|
| Tiny discrete action space | 11 remote keys (+ holds, + text). The engine's default set is up/down/left/right/ok/back/menu/playpause, with rewind/fastforward at a low prior and home off | Exhaustive per-state action trials are affordable; deep RL is not needed [16, 17] |
| Slow key injection | `input keyevent` starts a JVM: about 1 s per call (batched runs are faster); the HID remote in `src/adb/hid.ts` is much faster | Replays batch keys; exploration uses HID where available |
| Slow screenshots | raw framebuffer capture: about 1.1 s at 1080p on a 4K Plus (2.5 s as PNG) | Do not screenshot every poll. Use the cheap CDP state probe for most decisions and the screen only at the end of a step |
| Cheap app state over CDP | one `Runtime.evaluate` per probe (estimate: tens of ms over the adb forward; **measure**) | The JS probe drives state abstraction and settle detection |
| No state snapshots | there is no emulator snapshot or restore on a real TV | Go-Explore's "return" [20] and TimeMachine's state pool [8] become "navigate there over the graph, or relaunch and replay the shortest known path" |
| 1–2 GB of RAM | Fire TV Stick 3rd gen / Lite have 1 GB; the 4K Max/Plus have 2 GB | No full heap snapshots on the device [42]; memory probes use counters; the engine's own probe must allocate almost nothing |
| Relaunch cost | a cold start takes several seconds (`launchMs` from `apps/launch`) | Minimise relaunches: return over the graph when possible, and spend the ddmin budget carefully [45, 46] |

**Expected throughput:** about 1–2 s per exploration step (key, settle, probe,
one low-resolution frame). That gives roughly 1,800–3,600 steps per hour. Steps
are faster when the probe alone is informative and screenshots are taken only
on state changes.

**Non-goals for now:**
- deep RL training [16, 17];
- touch input;
- testing apps the user doesn't own.

The device safety rules in CONTRACT.md apply. In particular, the engine refuses
to drive `com.sunsetvilla.tv` (the owner's real progress) unless
`--allow-package` names it. Test Sunset Villa through a separate test build or
package id.

---

## 2. Architecture

```
            +-------------------------------- FireLab Engine (src/engine) ---------------------------------+
            |                                                                                               |
 trace /    |  +-----------+   Observation   +-------------+   State id    +-----------------------------+  |
 watch  --->|  | Observer  |---------------->| Abstraction |-------------->| Explorer                    |  |
 sessions   |  | probe+frame|                | (levels L1-4)|              |  archive (Go-Explore cells) |  |
            |  +-----------+                 +-------------+               |  graph (state x key -> state)|  |
            |       ^                                |                       |  select / return / explore  |  |
            |       |                                v                       |  optional: LLM goal agent,  |  |
            |       |                         +-------------+   Verdicts    |  human-trace seeds          |  |
            |       |                         |  Oracles    |-------------->+-----------------------------+  |
            |       |                         | health,screen,focus,        |              | Action           |
            |       |                         | perf,memory,invariant,media |              v                  |
            |       |                         +-------------+         +----------+   Findings   +---------+ |
            |       +-----------------------------------------------  |  Driver  |  ----------> |Minimiser| |
            |                                                         |  calls   |              | ddmin   | |
            |                                                         +----------+              +---------+ |
            |                                                              |                        |       |
            |                                                              |                   +---------+  |
            |                                                              |                   |Reporter |  |
            |                                                              |                   |trace,html| |
            +--------------------------------------------------------------|-------------------+---------+--+
                                                                           v
                                                  DeviceDriver (src/driver): AdbDriver | VdaDriver | MockDriver
```

One exploration step:
1. The explorer picks an `Action`.
2. The driver sends it.
3. The observer waits for the screen to settle, then reads the probe and one frame.
4. The abstraction maps the observation to a `State`.
5. The oracles check the step and may emit `Finding`s.
6. The explorer updates the archive and the graph.

Findings go to the minimiser, which needs the device, so it runs after
exploration or between exploration rounds. Then the reporter writes the trace,
thumbnails and the HTML report.

---

## 3. DeviceDriver interface

This section is the contract with the FireLab core session, which owns
`src/driver/`. Every method maps onto something `src/core/firelab.ts` already
does. That keeps `AdbDriver` a thin adapter over the existing code, not a
rewrite. The engine checks `caps` before using an optional method, and turns
oracles off, with a note in the report, when a capability is missing.

```ts
// src/driver/types.ts (owned by the FireLab core session)

export type RemoteKey =
  | 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'home' | 'menu'
  | 'playpause' | 'rewind' | 'fastforward' | 'volup' | 'voldown' | 'mute' | 'search' | 'wake';

/** One press. Same meaning as src/adb/keys.ts KeyPress, without the Android key code. */
export type KeySpec = { key: RemoteKey; mode?: 'press' | 'long' | 'hold'; holdMs?: number };

export type AppRef = { package: string; url?: string };   // url: for wrapped web apps (launch intent extra)

export type Frame = {
  width: number; height: number;
  /** Small RGBA buffer when format 'rgba' was asked (for hashing; no image decoding in the engine). */
  rgba?: Uint8Array;
  /** JPEG/PNG bytes when asked (for thumbnails in reports). */
  data?: Buffer; mime?: 'image/jpeg' | 'image/png';
  captureMs: number;
};

export type LogLine = { ts: number; level: 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'; tag?: string; pid?: number; text: string };
export type ConsoleEntry = { ts: number; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string; source: 'console' | 'exception' | 'browser'; url?: string; line?: number };
export type MemorySample = { ts: number; pssMB?: number; jsHeapMB?: number; graphicsMB?: number; availMB?: number };
export type RecordedKey = { ts: number; key: string; action: 'down' | 'up'; holdMs?: number };

export type DriverCaps = {
  keys: true;                 // required
  holds: boolean;             // real key-down/up with any hold time
  text: boolean;
  screenshot: true;           // required
  rgbaThumb: boolean;         // screenshot({ format: 'rgba', width: 64 }) without a JPEG round trip
  launch: true;               // required
  reset: boolean;             // clear app data (FireLab-installed apps only)
  install: boolean;
  eval: boolean;              // JS evaluation in the app (CDP Runtime.evaluate, or an in-app bridge)
  console: boolean;           // console + uncaught exceptions stream
  cdp: boolean;               // raw CDP passthrough (HeapProfiler, Profiler, Page)
  logs: true;                 // required: device log since a time
  memory: boolean;
  measure: boolean;           // FireLab's measure(): fps + memory + cpu over N seconds
  recordKeys: boolean;        // a human's remote presses (getevent)
};

export interface DeviceDriver {
  readonly kind: 'adb' | 'vda' | 'mock';
  readonly serial: string;
  readonly caps: DriverCaps;

  info(): Promise<{ model?: string; name?: string; os?: string; ramMB?: number; gpu?: string; tier?: string; resolution?: { width: number; height: number } }>;
  wake(): Promise<void>;

  press(keys: KeySpec[], opts?: { gapMs?: number }): Promise<void>;
  typeText?(text: string): Promise<void>;                                   // caps.text

  screenshot(opts?: { width?: number; quality?: number; format?: 'jpeg' | 'png' | 'rgba' }): Promise<Frame>;

  foreground(): Promise<{ package: string; activity?: string } | null>;
  launch(app: AppRef): Promise<{ pid?: number; launchMs?: number }>;
  stop(app: AppRef): Promise<void>;
  pid(app: AppRef): Promise<number | undefined>;
  reset?(app: AppRef, opts: { confirm: true }): Promise<void>;              // caps.reset
  install?(path: string): Promise<{ package: string }>;                     // caps.install

  evaluate?<T = unknown>(expression: string, opts?: { app?: AppRef; timeoutMs?: number }): Promise<T>;  // caps.eval
  onConsole?(app: AppRef, fn: (e: ConsoleEntry) => void): () => void;       // caps.console
  cdp?(method: string, params?: Record<string, unknown>): Promise<unknown>; // caps.cdp

  logs(opts: { app?: AppRef; sinceTs?: number; minLevel?: LogLine['level'] }): Promise<LogLine[]>;
  memory?(app: AppRef): Promise<MemorySample>;                              // caps.memory
  measure?(app: AppRef, seconds: number): Promise<{ fps?: { median: number; p10: number }; memMB?: number; cpuPct?: number; page?: Record<string, unknown> }>;  // caps.measure
  recordKeys?(): { stop(): Promise<RecordedKey[]> };                        // caps.recordKeys

  close(): Promise<void>;
}
```

**Mapping to existing FireLab code (AdbDriver) and to Vega (VdaDriver):**

| Method | AdbDriver: existing FireLab call | VdaDriver: Vega equivalent | Vega status |
|---|---|---|---|
| `info` | `FireLab.deviceInfo` | `vda devices -l` plus device props | likely |
| `wake` | `FireLab.wake` | unknown | optional |
| `press` | `FireLab.pressKeys` (SmartRemote: `input keyevent`, HID for holds) | `vega exec inputd-cli button_press KEY_UP` etc.; holds via console mode `button_hold`/`button_release` [57] | **supported** (documented) |
| `typeText` | `FireLab.typeText` | `inputd-cli send_text` [57] | supported (documented) |
| `screenshot` | `FireLab.screenshot` (raw-gzip capture; for `format: 'rgba'` the adapter returns `resizeRgba(screenRgba(...), 64)` and skips JPEG) | `vda shell gwsi-tool-screenshooter <file>` then `vda pull` [56] | **supported**, likely slower (PNG + pull) |
| `foreground` | `FireLab.foreground` | `vlcm` (exact query syntax not documented on the VDA page) | likely, unverified |
| `launch` / `stop` | `FireLab.launch` / `FireLab.stop` | `vlcm` (launch syntax not on the VDA page; see Vega's app management docs) | likely, unverified |
| `pid` | `pidOf` (`src/adb/apps.ts`, already used by `FireLab`) | unknown | optional |
| `reset` | `FireLab.reset` (confirm required) | unknown | optional |
| `install` | `FireLab.install` | `vpm` / the Vega CLI [56] | likely |
| `evaluate` | `FireLab.evaluate` (CDP `Runtime.evaluate` in the WebView) | no Android WebView. Needs an in-app bridge: `@firelab/perf` opens a WebSocket to FireLab and answers probe requests | **optional capability** (bridge to build) |
| `onConsole` | `FireLab.webview(...).on('console')` | the same bridge forwards `console.*` and `onerror` | optional |
| `cdp` | the `WebViewSession` CDP client | none | Fire OS only |
| `logs` | `FireLab.logcat` (`dumpLogcat`) | `vda shell loggingctl log` [56] | **supported** |
| `memory` | `NativeSampler` (`dumpsys meminfo`: app + renderer PSS) | `ace_memusage` [56] (output format unverified) | likely |
| `measure` | `FireLab.measure` | fps via the in-app bridge; memory via `ace_memusage` | optional |
| `recordKeys` | `KeyRecorder` (getevent) | unknown | optional |

Until `src/driver/` lands, the engine's tests use a `MockDriver` in
`test/engine/mock-driver.ts`, which simulates a state machine with focus, menus,
a canvas, and injectable bugs. The engine has no other fallback path to the
device.

---

## 4. Core types

```ts
// src/engine/types.ts

import type { DeviceDriver, KeySpec, RemoteKey, Frame, LogLine, ConsoleEntry } from '../driver/types.js';

/** What the engine can do. Exploration only uses 'key' (and 'text' when a text field has focus). */
export type Action =
  | { kind: 'key'; key: RemoteKey; mode?: 'press' | 'long' | 'hold'; holdMs?: number; repeat?: number }
  | { kind: 'text'; text: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'relaunch' };                       // stop + launch (used by return and replay)

/** Result of one in-page probe (one CDP evaluate). Discrete fields feed the state; continuous ones feed oracles. */
export type Probe = {
  url?: string;
  title?: string;
  hook?: boolean;                                // window.firelab present
  paused?: boolean; targetFps?: number; fps?: number; frameMs?: { p50: number; p95: number };
  scene?: string;                                // window.firelab.marks.scene
  marks?: Record<string, string | number | boolean>;
  app?: unknown;                                 // result of the user's --state-expr, e.g. demo.state
  focus?: FocusInfo | null;                      // document.activeElement, --focus-selector, or marks.focus
  modal?: string;                                // topmost open dialog/overlay id, if any
  raf: number;                                   // monotonically increasing frame counter (FireLab probe)
  errors: number;                                // count of uncaught errors + unhandled rejections so far
  heapMB?: number;
  video?: VideoInfo[];
  invariants?: Record<string, true | string>;    // window.firelab.invariants results (section 9)
};
export type FocusInfo = { id: string; rect: [x: number, y: number, w: number, h: number]; text?: string; role?: string };
export type VideoInfo = { id: string; t: number; paused: boolean; readyState: number; dropped?: number; total?: number };

export type Observation = {
  ts: number; step: number;
  foreground: string | null;
  probe?: Probe;
  frame?: { hash: string; luma: { mean: number; std: number }; thumb64?: Uint8Array; jpeg?: Buffer };
  logs: LogLine[];                               // since the previous step
  console: ConsoleEntry[];                       // since the previous step
  settleMs: number;
};

/** Abstract state. id = hash(key). */
export type State = {
  id: string;
  level: 1 | 2 | 3 | 4;
  key: { pkg: string; activity?: string; scene?: string; modal?: string; app?: string; focus?: string; vis?: string };
  firstSeenStep: number;
  thumb?: string;                                // file name of a representative thumbnail
};

/** Go-Explore cell = a State plus archive statistics. */
export type Cell = State & {
  visits: number;          // times observed
  chosen: number;          // times selected as an exploration start
  discovered: number;      // new cells found while exploring from here
  failedReturns: number;
  depth: number;           // length of the shortest known path from launch
  path: Action[];          // shortest known path from a fresh launch
  suspicion: number;       // 0..1, from oracle "near misses" (fps dips, warnings)
  actionStats: Partial<Record<RemoteKey, { n: number; reward: number }>>;
};

export type Transition = { from: string; action: string; to: string; count: number; total: number };   // total = times (from, action) was tried

export type Severity = 'critical' | 'major' | 'minor' | 'info';

export type Finding = {
  id: string;                         // short id, e.g. f-3k9x
  oracle: string;                     // 'health' | 'screen' | 'focus' | 'perf' | 'memory' | 'invariant' | 'media' | 'stuck'
  kind: string;                       // e.g. 'js-exception', 'black-screen', 'focus-trap', 'non-spatial-move'
  severity: Severity;
  title: string;                      // one line people can act on
  detail: string;
  signature: string;                  // for de-duplication and for re-checking during replay/shrink
  stateId: string; step: number; ts: number;
  evidence: { thumbs: string[]; logs: string[]; probe?: Partial<Probe>; numbers?: Record<string, number> };
  trace: string;                      // file name of the full trace up to the finding
  minimized?: string;                 // file name of the shrunk trace
  repro?: { hits: number; runs: number };
  device: { serial: string; model?: string; name?: string; tier?: string };
  status: 'new' | 'confirmed' | 'flaky' | 'not-reproduced';
};

export type TraceStep = { i: number; action: Action; gapMs: number; stateId?: string; frameHash?: string };
export type Trace = {
  version: 1;
  app: { package: string; url?: string; build?: string };
  device: Finding['device'];
  createdAt: number;
  seed: number;
  setup: Action[];                    // what runs after launch before step 0 (e.g. relaunch, wait 3000)
  steps: TraceStep[];
  expect?: { oracle: string; signature: string };   // what a replay checks for
};

export type OracleContext = {
  driver: DeviceDriver;
  config: ExploreConfig;
  graph: { cells: Map<string, Cell>; transitions: Map<string, Transition> };
  history: Observation[];             // ring buffer, last ~200 observations
  emit(f: Omit<Finding, 'id' | 'trace' | 'device' | 'status'>): void;
};

export interface Oracle {
  id: string;
  cost: 'free' | 'cheap' | 'probe' | 'expensive';   // 'probe' = may press keys to investigate (focus BFS, leak cycles)
  needs: (keyof import('../driver/types.js').DriverCaps)[];
  start?(ctx: OracleContext): Promise<void>;
  /** Called after every step. Must be fast and must not press keys. */
  check(ctx: OracleContext, obs: Observation, prev: Observation | undefined, state: State): void | Promise<void>;
  /** Optional deeper investigation the explorer schedules (presses keys; explorer re-syncs afterwards). */
  investigate?(ctx: OracleContext, state: State): Promise<void>;
  /** Used by replay and shrink: does this observation sequence show the finding again? */
  matches(signature: string, obs: Observation, prev?: Observation): boolean;
}

export type ExploreConfig = {
  app: { package: string; url?: string };
  minutes?: number; steps?: number; seed: number;
  keys: RemoteKey[];                           // default: up down left right ok back menu playpause (+ rewind fastforward at low prior)
  oracles: string[];                           // default MVP: health, screen, focus
  stateExpr?: string;                          // JS expression returning small JSON, e.g. "demo.state"
  focusSelector?: string;                      // e.g. ".focused" for apps that draw focus with a class
  setupEval?: string;                          // e.g. "localStorage.clear()" for a clean start (only with --setup)
  reset: 'relaunch' | 'clear-data';            // clear-data only for FireLab-installed apps (CONTRACT safety rules)
  fromSessions?: string[];                     // watch session ids to seed from
  strategy: 'explore' | 'random';              // 'random' = the monkey baseline, same driver and keys
  minimize: boolean;
  outDir: string;
};
```

---

## 5. Observer and state abstraction

### 5.1 The probe

One small script is injected once, then called each step. It reads discrete UI
facts and the FireLab hook without allocating much:
- the `window.firelab` hook (CONTRACT.md);
- the result of `--state-expr`;
- the focused element (`document.activeElement`, else `--focus-selector`, else `window.firelab.marks.focus`);
- the topmost modal (`dialog[open]`, `[role=dialog]`, or `[aria-modal=true]` that is visible);
- a frame counter;
- the uncaught-error count.

On first install the probe also adds:
- `error` and `unhandledrejection` listeners;
- a `requestAnimationFrame` counter;
- `webglcontextlost` listeners on canvases.

The probe is one CDP `Runtime.evaluate` returning JSON. It is the main state
signal because it is about 10–50× cheaper than a screenshot on a Fire TV
(section 1). The probe borrows from:
- DroidBot and APE, which use UI structure rather than pixels as the primary state [5, 6];
- EA's agents and Wuji, which read game state directly [16, 19].

**Native apps (no WebView).** Most Fire TV apps are native (Leanback, plain
views, Compose, Flutter), so there is no page to probe. When the driver has
`uiDump()` (the adb driver runs `uiautomator dump`), the Observer reads focus
from the window hierarchy instead (`src/engine/uidump.ts`): the deepest
`focused="true"` node is the focus (a FlutterView or Compose host also says
focused), and focusables are the visible, enabled focusable nodes with no
focusable descendant (a RecyclerView or Leanback row hands focus to its
cards). A view's id is its resource id plus its label (own text,
content-desc, else the first child texts, as for a card title); only an
ambiguous name gets its tree path added. The result goes into
`Observation.focus` / `viewport`, so the L3 key and the focus oracle work
unchanged. A dump costs 1-3 s, so it is read only for a picture not seen
before: snapshots are cached under activity + the exact 64 px thumbnail, and a
step that lands on a known picture costs nothing. After 4 failed dumps with
none working (uiautomator never sees an animated screen idle) native focus
turns off with a note. Limitation: a native app's L2 screen is its activity,
so a single-activity app with many fragments gets one focus walk.

### 5.2 Settle detection

Asynchronous waits are the main cause of flaky UI tests [48, 49], so every
observation waits for the UI to settle:

```
settle(maxMs = 2000, minMs = 250):
  t0 = now; last = digest(probe())          // digest = hash of discrete fields only (no fps, no positions)
  loop:
    sleep(150)
    d = digest(probe())
    if d == last and now - t0 >= minMs: return now - t0
    last = d
    if now - t0 > maxMs: return maxMs        // animated scenes never settle fully; that's fine
```

After the screen settles, the observer takes one frame:
`screenshot({ format: 'rgba', width: 64 })` for hashing, plus a 480 px JPEG
thumbnail when the state is new or an oracle asks for evidence.

### 5.3 State abstraction (layered)

Tools differ a lot depending on how coarse "the same state" is [10]. APE showed
that the right level depends on the app and can be refined during the run [5].
The engine builds the state key in levels:

| Level | Adds to the key | When it is used |
|---|---|---|
| L1 | foreground package + activity | always |
| L2 | `scene` mark, modal id, URL path, `--state-expr` result (strings kept, numbers bucketed to 1 significant digit) | always when there is a probe |
| L3 | focus descriptor: `id`, else `role:text`, else rect snapped to a 12×8 grid. On a TV, focus *is* the screen state that a remote changes [52] | when focus is known |
| L4 | visual bucket: 64-bit dHash of a 9×8 grey downscale [27]; two frames share a bucket when Hamming distance ≤ 6 | when L1–L3 are uninformative (canvas games without a hook) or for apps that ask for it |

`stateId = sha1(JSON of the key).slice(0, 12)`

**Refinement** (later tier, after APE [5]): a pair (state, action) whose
successors are spread out is a sign the state lumps together screens that differ
inside. The test is at least 3 distinct successors over at least 6 tries, with
no successor above 60%. When it fires, the engine refines that state to the next
level. This matters for canvas games, where L2 alone can hide sub-screens.

### 5.4 The visual hash

```
dhash(rgba64x36):
  g = to_grey(resize(rgba, 9, 8))           // block-mean downscale [27]
  bits = for y in 0..7, x in 0..7: g[y][x] < g[y][x+1]
  return hex(bits)                           // 64 bits
luma(rgba64x36) = mean and std of grey values (0..255)
```

dHash is cheap and robust to small rendering noise. It is not robust to
flipping or big animated regions [27], which is why it is only the last
abstraction level.

---

## 6. Explorer

### 6.1 The loop (Go-Explore on a TV)

The explorer is Go-Explore [20]: keep an archive of cells, pick a promising one,
**return** to it without exploring, then **explore** from it. There are two
changes for real devices:
1. **Return** cannot restore a snapshot. It either walks the known transition graph from the current state, as model-based tools do [3, 5, 6], or relaunches and replays the cell's shortest path, a replay version of TimeMachine's state pool [8]. It picks whichever is cheaper.
2. **Explore** picks keys with a count-based bonus per state [21] and learned per-state key rewards, as in Fastbot2's RL-guided model [9]. It does not use a neural policy.

```
explore(config):
  driver.launch(app); setup(); obs = observe(); s0 = abstract(obs)
  archive.add(s0, path = [], depth = 0)
  seedFromHumanTraces(config.fromSessions)              // 6.4
  cur = s0
  while budget remains:
    c = selectCell(archive)                             // 6.2
    if not returnTo(c): c.failedReturns++; continue     // 6.3
    cur = c
    repeat K = 20 times:
      a = chooseAction(cur)                             // 6.2
      obs = act(a)                                      // press, settle, probe, frame
      s = abstract(obs)
      graph.record(cur, a, s)
      runOracles(obs, s)                                // section 7; may emit findings
      if s is new:
        archive.add(s, path = cur.path ++ [a], depth = cur.depth + 1)
        reward = 1; c.discovered++
      else:
        if len(cur.path) + 1 < len(archive[s].path): archive[s].path = cur.path ++ [a]   // keep shortest
        reward = 0
      cur.actionStats[a.key].n++; cur.actionStats[a.key].reward += reward
      if obs.foreground != app.package: handleExit(cur, a); break     // learned edge -> EXIT, relaunch
      if stuck(): emit stuck finding (7.6); break
      if oracle asked to investigate s: run oracle.investigate(s); resync()
      cur = s
    c.chosen++
  minimizeFindings()                                    // section 8, if config.minimize
  writeReport()
```

### 6.2 Selection rules

Cell selection follows Go-Explore's count-based weights [20, 21]. It rewards novelty, not a score, because many game bugs sit where no objective points [22]. Wuji's
multi-objective idea [19] adds terms for progress (depth) and for being near a
bug signal (suspicion):

```
weight(c) = 1/sqrt(1 + c.chosen)
          + 0.5 * c.discovered / (1 + c.chosen)              // productive cells stay attractive
          + 0.3 * min(c.depth, 20) / 20                      // progress: deep states hide game bugs [19]
          + 1.0 * c.suspicion                                // fps dip, warning log, near-violation
          - 0.5 * min(c.failedReturns, 4)
selectCell = sample a cell with probability proportional to max(weight, 0.01)
```

Action selection inside a cell tries every untried key first. After that it
uses a count bonus [21] over that cell's key statistics:

```
chooseAction(s):
  untried = config.keys where s.actionStats[k] is undefined and k is not a known EXIT edge
  if untried: return random(untried)                        // tiny action space: try everything once
  score(k) = s.actionStats[k].reward / s.actionStats[k].n + 0.7 / sqrt(1 + s.actionStats[k].n)
  with probability 0.1 return a macro: { key: k, repeat: 3..8 } or { key: k, mode: 'long' }   // reach far grid cells, hold-to-run
  return argmax score (ties random, seeded)
```

The macros matter on a TV. Many states are only reachable by holding a
direction or by pressing it several times quickly, and timing is part of the
input [47].

### 6.3 Returning to a cell

```
returnTo(c):
  if cur == c: return true
  p = shortestPath(graph, cur, c, edges with count/total >= 0.8)    // reliable edges only
  costGraph   = len(p) * stepMs / reliability(p)                    // Infinity if no path
  costReplay  = relaunchMs + len(c.path) * fastStepMs               // replay batches keys with recorded gaps [47]
  if costGraph <= costReplay: follow p, observing each step
  else: driver.stop; driver.launch; setup(); replay(c.path) with fast batching; observe()
  return abstract(observe()) == c.id
```

A return that lands somewhere else is not an error. The app is
nondeterministic, which Clapp et al. had to handle too [46]. The explorer
records it, lowers the reliability of that path, and explores from wherever it
landed.

### 6.4 Human traces (`firelab watch`)

Humanoid [7] and CCPT [18] show that human play points exploration at the parts
of an app people actually use, and CCPT explores *near* those trajectories. The
watch recorder already writes remote presses with timing to
`timeline.jsonl`:

```
seedFromHumanTraces(sessions):
  for each session: keys = key-down events with gaps (cap gaps at 3 s)
    relaunch; replay keys one at a time, observing and adding every new state to the archive
    give those cells +0.5 weight bonus for the first 10 choices (explore near the demo)
```

### 6.5 Optional LLM goal agent (later tier)

GPTDroid and DroidAgent show that an LLM setting *goals* finds functionality
that coverage-driven tools miss [11, 12]. AutoDroid shows that giving the LLM
the explored graph as memory makes it far more reliable [13]. FireLab is already
an MCP server, so the LLM is the MCP *client* (Claude, for example), and
FireLab needs no API key:

```
MCP explore_step(runId):
  -> returns the current state thumbnail, the list of frontier cells (thumbs + paths),
     what has never been reached (e.g. "pause menu > Quality never opened"), recent findings
<- the client sends { goal: "start a game and reach score 10", keys?: [...] }
   the engine treats the goal's key list as a macro action, runs it, reports new cells and findings
```

The engine calls on the agent only when the archive stagnates (no new cell in
the last 150 steps). It caps agent calls per hour, since they are slow and cost
money.

### 6.6 Random baseline (for evaluation)

`strategy: 'random'` presses uniformly random keys from the same key set at the
same pace, through the same driver and oracles. It uses no archive and no
return; it relaunches only on exit. This matches Monkey on navigation keys
[1, 2]. Any engine win must beat this baseline [37].

`strategy: 'monkey'` sends Android Monkey's D-pad event mix instead: arrows 60%,
the major navigation keys (OK, Back, Menu) 35%, system keys 5% (Home, Back,
volume), as `adb shell monkey --pct-nav 60 --pct-majornav 35 --pct-syskeys 5`
does. Leaving the app relaunches it, as Monkey keeps to its package.

### 6.7 Going deep (extension, on by default; `deep: false` turns it off for ablations)

The MVP explorer reached every screen of a small game but stalled on apps with a
dialog behind every button and progress gated behind many choices. Six changes,
each from the literature, take it 100+ presses deep:

| Change | What it does | Source |
|---|---|---|
| Widget-level actions | On each new screen the observer reads the focusable controls once; 70% of the time the explorer moves focus to the next control nobody pressed OK on and presses OK. A button opens a dialog, its buttons come next, and so on down. | DroidBot, APE fire every clickable widget [5, 6] |
| Frontier term | `cellWeight` adds 0.8 × the share of never-tried keys in the cell. | Stoat, APE: go where actions are unexplored [3, 5] |
| Depth on a log scale | The depth term grows as log₂(1 + depth) up to 100 instead of stopping at 20. | Wuji's progress objective [19] |
| Episode stretch and stall stop | An episode that keeps finding states (or new JS code) runs up to 4K steps; one that finds nothing for K steps ends early. | Go-Explore's exploration phase [20]; TimeMachine's stall trigger [8] |
| Dive order, Back last | Among untried keys OK goes first half the time; Back waits until the rest of the state was tried. | DroidBot's depth-first order [6] |
| Learned no-ops | A key that was a self-loop on 2+ focus positions of a screen and never did anything there is tried last on its other positions; a key that never changes the *state* (with the probe; pixels lie in animated games) is a dead key after 6 presses. | APE/Fastbot screen-level action models [5, 9] |

Plus: fast repeats of OK in screens visited 3+ times (timing races), and
oracle investigations capped at 30% of the presses so the focus walk can't eat
the budget. With `--coverage`, V8 block coverage of the page is collected over
CDP; a press that runs new code earns half a discovery's reward, and the run
reports the blocks covered. On the simulated games (16 seeds × 10 device
minutes) the deep explorer finds the timing bugs more often than the MVP one
(black screen 10/16 vs 7/16 on Lantern Lake, 14/16 vs 11/16 on the sim game)
and as often otherwise; `firelab bench` measures the rest (docs/BENCHMARK.md).

### 6.8 Shared knowledge (extension; `--knowledge`, `--no-knowledge`)

Runs on other games teach the explorer (`src/engine/knowledge.ts`), the way
Fastbot2 reuses its model across runs [9] and Humanoid learns from traces [7].
A pack holds *bug patterns* (the last ≤ 6 keys of each confirmed, shrunk finding,
with its kind) and *key priors* (how often each key changed the state). The
explorer seeds its dead-key statistics with the priors, worth at most 4 presses
each so the run's own evidence decides, and on a screen seen for the first time
(or at the start of an episode) it sometimes sends a pattern's keys first, best
weight first: weight = log₂(1 + confirmations) + games − 2 × rejections. A
finding during a pattern is credited to it in the run's notes. Only strategy
`explore` loads knowledge; `FIRELAB_NO_KNOWLEDGE=1` turns off the default packs.
Packs are made by `firelab learn export`, contributed by pull request
(knowledge/README.md), validated on load, and contain no URLs, names, text,
screenshots or code.

---

## 7. Oracles

They are ordered by cost. The MVP builds 7.1–7.3 plus the stuck detector (7.6),
which is part of the explorer loop. A finding is de-duplicated by `signature`
within a run, and only the first occurrence keeps its full trace.

### 7.1 Health: crash, ANR, exit, JS exception (MVP, free)

Crashes and exceptions are the oracle behind most of the Android testing
literature [1, 4, 5, 8, 9]. This oracle reads only things the step already
collected.

```
health.check(obs, prev, s):
  for line in obs.logs:
    if matches(line, /FATAL EXCEPTION/ and pid==appPid) -> emit critical 'crash' (stack = following lines)
    if matches(line, /ANR in <pkg>/)                    -> emit critical 'anr'
    if matches(line, renderer-crash patterns)            -> emit critical 'webview-renderer-gone'   // patterns kept in one table, tested
  if obs.foreground != pkg and lastAction not in {home} and not (lastAction == back and s was a known EXIT state):
       emit major 'unexpected-exit' (foreground = obs.foreground)
  if pid changed since prev without a relaunch          -> emit critical 'process-restarted'
  for e in obs.console where e.source == 'exception' or (e.level == 'error'):
       sig = normalize(e.text) + '@' + (e.url basename) + ':' + e.line   // strip numbers/ids from text
       emit (exception ? major : minor) 'js-error' signature sig
  if obs.probe.errors > prev.probe.errors and no console entry explains it -> emit major 'js-error' (from probe counter)
```

`matches(signature, ...)` for replays checks the same signature. A crash during
a replay counts only if the stack's top frame matches.

### 7.2 Screen: black, frozen, render loop stopped (MVP, cheap)

These are perceptual bugs that show on the screen only [25]. Android vitals
calls frames over 700 ms "frozen" [35]; here that idea applies to the whole
screen, in seconds.

```
screen.check(obs, prev, s):
  if not obs.frame: return
  black = obs.frame.luma.mean < 10 and obs.frame.luma.std < 3                  // 0..255 scale
  if black and obs.foreground == pkg and not videoStarting(obs):
       blackRun += 1 else blackRun = 0
  if blackRun >= 2 and timeSince(firstBlack) >= 1500 ms:                        // two settled steps, so a fade doesn't count
       emit critical 'black-screen'   (evidence: last 3 thumbs, probe.scene, last 5 keys)

  // the app says it is rendering, but the frame counter stopped
  if obs.probe and obs.probe.paused == false and obs.probe.targetFps > 0:
       if obs.probe.raf == prev.probe.raf for >= 2000 ms: emit critical 'render-loop-stopped'

  // pixels stopped changing although input used to change them
  d = meanAbsDiff(obs.frame.thumb64, prev.frame.thumb64)
  if d < 0.5 and (expectAnimation(s) or lastActionUsuallyChangesScreen(s)):
       frozenFor += dt else frozenFor = 0
  if frozenFor >= 3000 ms and actionsDuringFreeze >= 3: emit major 'frozen-screen'
```

`expectAnimation(s)` is true when earlier visits to `s` (or its scene) showed
frame-to-frame change. `lastActionUsuallyChangesScreen` comes from the
transition graph. Together they keep static menus from being reported. The
`webglcontextlost` listener from the probe raises a critical
`webgl-context-lost` here as well. That one is cheap and worth having on 1 GB
devices, where the GPU process gets killed under memory pressure.

### 7.3 Focus: D-pad reachability, traps, non-spatial moves, lost focus (MVP, probe)

This oracle is specific to TVs. It builds a model of focus transitions by driving the remote, as Ahmed et al. do for smart TV apps [52], and turns the platform rules [53, 54, 55] into checks.
It runs `investigate(s)` once per new L2 screen that has focus information
(DOM focus, `--focus-selector`, `marks.focus`, or for native apps a
`uiautomator dump`, 5.1). It presses keys, so the
explorer re-syncs afterwards.

```
focus.investigate(screen):
  F = probe.focusables()           // visible, enabled, focusable or matching focusSelector; with rects
  start = probe.focus
  G = {}                           // focus graph: (f, dir) -> g
  queue = [start]; seen = {start}; presses = 0
  while queue and presses < 80:
    f = queue.pop()
    navigate focus to f (by known edges; give up on f if unreachable now)
    for dir in [up, down, left, right]:
      press dir; settle; g = probe.focus; presses++
      if leftScreen(): G[f,dir] = EXIT; return to screen (back, or replay); continue
      G[f,dir] = g
      if g not in seen: seen.add(g); queue.push(g)
      if g is new to this pass: press opposite(dir) at once (g owes that test anyway; it is usually the only way back to f)
      if no known path back to f: put f back on the queue once, test only its untested dirs later
  // checks
  for f in F not in seen and visible(f):
      emit major 'unreachable-control' (element, rect, screen thumb)                        [55]
  for each SCC C of G (restricted to this screen):
      if C has no edge to outside C, and back does not leave C (tested once), and |F| > |C|:
          emit critical 'focus-trap' (members of C)                                          [53]
  for each edge (f, dir) -> g with g != f:
      cand = [h in F visible: h is strictly in the dir half-plane of f]                      [54]
      best = argmin over cand of dist(f, h, dir)    // primary-axis gap + 2 * orthogonal offset between edges, a simplified form of the spec's distance
      if best exists and g != best and dist(f, g, dir) > 1.5 * dist(f, best, dir) + 24px:
          emit major 'non-spatial-move' (from f, dir, got g, expected best)
      if g not in the dir half-plane at all: emit major 'non-spatial-move' (wrong direction)
  for each step where probe.focus is null/body while F is non-empty:
      emit minor 'focus-lost'                                                                [55]
```

This is exactly the Sunset Villa grid bug, where arrow keys moved through a
list order and not across the grid: the oracle reports the expected and the
actual target. Canvas UIs without any focus information skip this oracle. The
report says so, and suggests publishing `window.firelab.marks.focus` (section 9).

### 7.4 Performance: jank and regressions with proper statistics (later tier A)

This oracle follows the research on what players feel and on statistics:
- frame-time variation matters more than average fps, and the 95% frame-rate floor predicts experience well [34];
- slow and frozen frame thresholds come from Android vitals [35];
- the launch is the unit of replication, not the frame [29, 30];
- warm-up is detected, not assumed [31, 33].

During exploration (cheap):

```
perf.check(obs, prev, s):
  if probe.paused: return
  ft = probe frame times since last read (window.firelab.frameTimes(), section 9; else derive from raf/time)
  cellPerf[s].add(ft, launchId)
  if cellPerf[s] has >= 10 s of frames:
     floor95 = percentile_5(fps over 1 s windows)                 [34]
     slow    = count(ft > 1.5 * 1000/targetFps)                   [35]
     frozen  = count(ft > 700)                                    [35]
     if floor95 < 0.8 * targetFps or frozen > 0: s.suspicion = 1; schedule confirm(s)
```

Confirmation (expensive, scheduled, at most 3 states per run):

```
confirm(s):
  for L in 1..5:                                   // 5 launches minimum [29, 30, 36]
    relaunch; returnTo(s); sample 20 s of frame times
    cut = PELT(frame times, mean-change cost, penalty = 2 * log(n) * var)   [33]
    keep the segment after the last changepoint if it is >= 8 s long, else mark 'no steady state' [31]
    m[L] = { floor95, p95FrameMs, slowPerMin } of the kept segment
  ci = bootstrapCI(median, m.floor95, B = 2000)    [39]
  if ci.high < 0.8 * targetFps: emit major 'jank' with numbers, ci, tier, device
  if any launch had 'no steady state': add a note (performance drifts; don't trust a single number) [31]
```

Comparing builds, tiers or devices (`firelab bench --compare`), on per-launch
values A and B:

```
compare(A, B):                                       // n >= 5 each
  U, p   = mannWhitney(A, B)                         [36]
  delta  = cliffsDelta(A, B)                         [38]   // A12 = (delta + 1) / 2 [36]
  ci     = bootstrapCI(median(B) - median(A))        [39]
  regression if p < 0.05 and |delta| >= 0.33 (A12 >= 0.67 or <= 0.33) and ci excludes 0
```

Across a build history (CI), use changepoint detection over per-build medians,
not thresholds [32, 33].

### 7.5 Memory: leak trends over neutral cycles (later tier A)

The explorer's graph already contains *neutral cycles* [44]: key paths that
leave a state and come back to it, such as menu then back, opening and closing
a dialog, or entering and leaving a scene. BLeak's insight is that growth across
returns to the same state is a strong leak signal [41]. LeakCanary forces a GC
before it trusts a retained object [43].

```
memory.investigate():
  cycles = simple cycles c -> ... -> c in the graph, length <= 6, reliable edges, ranked by
           (passes through a modal or scene change) then (short)
  for cycle in top 3:
    returnTo(c); cdp('HeapProfiler.collectGarbage'); h0 = heapMB(); p0 = driver.memory().pssMB
    for i in 1..10:
      run cycle; require abstract(observe()) == c (else abort this cycle)
      cdp('HeapProfiler.collectGarbage'); wait 500 ms
      h[i] = jsHeapMB (Runtime.getHeapUsage); p[i] = pssMB
    slope, ci = theilSen(i, h) with bootstrap CI over cycles     [39, 40]
    if ci.low > 0.1 MB/cycle and h[10] - h0 > 2 MB:
       cyclesToBudget = (budgetMB(device) - p[10]) / slopePss
       emit major 'memory-leak' (cycle keys, slope, ci, projected cycles until the device's budget)
  also: if pssMB > budgetMB(device) at any step: emit major 'over-memory-budget'   // budgets from `firelab fit`
```

No heap snapshots on the TV. When a leak is flagged, the report suggests
`firelab replay --desktop`, which replays the trace in desktop Chromium and
diffs heap snapshots MemLab-style [42] to name the retainers.

### 7.6 Stuck and no-progress (MVP, part of the explorer)

TimeMachine jumps away when progress stalls [8]. The engine does the same, and
also reports the stall, because a TV app the remote cannot get out of is a bug.

```
stuck():
  if current cell has all keys tried >= 2 times and every key self-loops (or only EXIT/home leaves):
       emit major 'dead-end' (state, keys tried)          // the screen-level cousin of a focus trap
  if no new cell for 300 steps: return true (explorer jumps to another cell; info finding 'plateau' once)
```

### 7.7 App invariants and event order (later tier A, cheap)

Property-based testing [28] lets the app declare what must hold, while the
engine supplies the random inputs and the shrinking. The app sets
`window.firelab.invariants = { name: () => true | 'message' }` (section 9). The
probe evaluates the invariants every step, and any non-`true` value is a
`major 'invariant'` finding signed by the name. This is the cheapest strong
oracle for the Sunset Villa bugs that crash checks never see (section 10.3).

### 7.8 Media stalls (later tier A, cheap)

```
media.check(obs, prev):
  for v in obs.probe.video:
    if not v.paused and v.t - prevV.t < 0.1 over >= 2 s and v.readyState < 3: emit major 'video-stall'
    if v.total > 300 and v.dropped / v.total > 0.1: emit minor 'video-dropped-frames'
```

The probe reads `currentTime`, `paused`, `readyState` and
`getVideoPlaybackQuality()`. This catches the Sunset Villa bitrate stalls.

### 7.9 Visual glitches (later tier B)

The heuristics come first:
- WebGL context lost (in 7.2);
- NaN or Infinity in a camera matrix, when the app exposes it;
- a frame that is mostly one flat colour outside menus.

A learned detector [23, 24] needs training frames in the game's own art style,
so it waits until there is a corpus. An LMM review of the filmstrip around
suspicious states can mark findings as *suspected*, never confirmed, because
current models are unreliable at this [14, 26].

### 7.10 GPU capabilities (extension, `--emulate-gpu`, free)

With `--emulate-gpu <model>` the observer adds the GPU shim
(`src/fit/gpu-shim.ts`) over CDP after every launch and reloads the page once,
so WebGL reports only that model's GPU features and limits before the game's
scripts run. The probe read carries the shim's failed calls; the `gpu` oracle
emits each new one per page load as `gpu-unsupported` (major; minor when
WebGL2 was refused and the page went on drawing with WebGL1; a WebGL1 context
that never draws, such as a chip-detection probe, doesn't count). Capability checks that came back
empty (`getExtension` = null) go into the run's notes, not findings. The GPU
profile is saved in the trace (`probe.emulateGpu`) so replay and shrink run
under the same GPU. Needs eval and cdp. Features and limits only, not speed:
see [GPU.md](GPU.md).

---

## 8. Minimiser

Every finding gets a reproduction rate first, then a shrink. Delta debugging
[45] gives 1-minimal inputs. Clapp et al. [46] adapted it to nondeterministic
GUI traces by accepting a candidate when it reproduces with high probability.
RERAN [47] showed that timing is part of the input, so the gaps between keys are
kept, then shrunk as their own step.

```
reproduces(steps, finding, m):                     // true if >= 1 of m replays shows the finding
  for r in 1..m:
    relaunch; setup(); replay(steps) with recorded gaps, observing only at the end and at each recorded stateId
    if oracle(finding).matches(finding.signature, obs) at any observation: return true
  return false

shrink(finding, budgetMin = 20):
  steps = trace(finding).steps up to finding.step
  rate0 = repro(steps, k = 3)                      // hits/3
  if rate0 == 0: finding.status = 'not-reproduced'; return     // reported, labelled, not hidden [48, 49]
  m = rate0 == 1 ? 1 : 2                           // replays per test; flaky failures need more [46]

  // 1. cut loops: if the state path visits X at i and again at j > i, try dropping steps i+1..j
  for (i, j) in repeated-state pairs, longest first:
    cand = steps without (i+1..j); if reproduces(cand, finding, m): steps = cand

  // 2. ddmin over the remaining actions [45]
  steps = ddmin(steps, s => reproduces(s, finding, m))

  // 3. shrink gaps: try gap -> default settle gap for each step (in chunks); keep if it still reproduces
  // 4. measure: rate = repro(steps, k = 5); status = rate >= 0.6 ? 'confirmed' : 'flaky'
  stop at any point when budgetMin is used up; keep the best so far

ddmin(c, test):                                    // test(c) == true means "still fails" [45]
  n = 2
  while len(c) >= 2:
    chunks = split(c, n)
    if some chunk d has test(d): c = d; n = 2; continue                   // reduce to subset
    if some complement c \ d has test(c \ d): c = c \ d; n = max(n - 1, 2); continue   // reduce to complement
    if n >= len(c): break
    n = min(2n, len(c))                                                   // increase granularity
  return c
```

Each test costs a relaunch plus the replay, roughly 5–15 s on a Fire TV Stick.
Loop cutting runs first because it removes long detours for a few tests. A
20-minute budget therefore covers about 80–200 tests, enough for traces of a
few hundred steps after loop cutting. Results are cached by the hash of the
candidate's steps.

---

## 9. Proposed `window.firelab` additions (for the perf/examples agent)

All fields are optional and `version` stays `'1'`. The engine works without
them and gets sharper with them.

```js
window.firelab.marks.focus = { id: 'grid-2-3', rect: [x, y, w, h], text: 'Episode 3' };  // canvas/custom focus (7.3)
window.firelab.focusables = () => [{ id, rect, text }];        // what could take focus on this screen (7.3)
window.firelab.invariants = {                                  // 7.7: return true, or a message
  oneEpisodeActive: () => game.activeEpisodes.length <= 1 || `${game.activeEpisodes.length} episodes active`,
};
window.firelab.events = [];                                    // ring of the last 50 { ts, type, data } app events
window.firelab.frameTimes = () => Float32Array;                // frame durations (ms) since the last call (7.4)
// and honour ?seed=<n> for Math.random-driven content, so replays are deterministic
```

---

## 10. Interfaces

### 10.1 CLI (wired by the core session; implemented in `src/engine/cli.ts` as plain functions)

```
firelab explore --package <pkg> [--url <url>] [--device <id>]
                [--minutes 30 | --steps 2000] [--seed 1]
                [--keys up,down,left,right,ok,back,menu,playpause]
                [--oracles health,screen,focus]          # MVP default; later: perf,memory,invariant,media
                [--state-expr "demo.state"] [--focus-selector ".focused"]
                [--from-session <watchSessionId>]...     # seed from human play
                [--setup "localStorage.clear()"] [--reset relaunch|clear-data]
                [--strategy explore|random] [--no-minimize] [--allow-package <pkg>]
                [--out <dir>] [--json]
   -> prints a live line per new state/finding; at the end: run dir, findings table, report path

firelab replay <trace.json> [--device <id>] [--times 5] [--check] [--desktop]
   -> replays with recorded timing; with --check, reports reproduced k/n for trace.expect

firelab shrink <trace.json | runId:findingId> [--budget-min 20] [--device <id>]
   -> writes <name>.min.trace.json, prints before/after length and reproduction rate

firelab report <runId | dir> [--open]
   -> regenerates report.html / report.md from the run directory

firelab bench --package <pkg> --url <url> [--strategies explore,random] [--runs 3] [--minutes 20]
              [--bugs freeze,black,throw,trap,grid] [--compare <runIdA> <runIdB>]
   -> runs the evaluation protocol in section 12 and prints the stats table
```

Exit code is 0 when no `critical` or `major` finding was confirmed and 1
otherwise, so `explore` can gate CI.

### 10.2 MCP tools (registered by the core session; same style as CONTRACT.md)

| Tool | Annotation | Input (zod) | Returns |
|---|---|---|---|
| `explore_start` | changes the device (presses keys, relaunches the app) | `{ device?, package, url?, minutes?, steps?, oracles?, stateExpr?, focusSelector?, seed?, fromSessions? }` | `{ runId, jobId }` |
| `explore_status` | read-only | `{ runId }` | `{ status, step, states, findings: { critical, major, minor }, coverageCurve, current: { stateId, thumb } }` + image content (current thumb) |
| `explore_stop` | changes the device (stops) | `{ runId }` | `{ ok, summary }` |
| `explore_findings` | read-only | `{ runId, minSeverity? }` | `Finding[]` (+ first evidence thumb per finding as image content) |
| `explore_step` (later) | changes the device | `{ runId, goal, keys? }` | `{ newStates, findings, frontier: [{ stateId, path, thumb }] }` |
| `replay_trace` | changes the device | `{ device?, trace \| runId+findingId, times? }` | `{ hits, runs, findings }` |
| `shrink_finding` | changes the device | `{ runId, findingId, budgetMin? }` | `{ jobId }` -> `{ before, after, repro }` |

A prompt, `explore_app`, walks an agent through it: start a run, poll the
status, read the findings, shrink the top ones, summarise them for the
developer.

### 10.3 HTTP routes (dashboard API; errors use the CONTRACT `{ error, code?, hint? }` shape)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/devices/:id/explore | `ExploreRequest` (the CLI flags as JSON) | `{ jobId, runId }`; 409 `busy` if a sweep or explore runs on the device |
| GET | /api/jobs/:jobId | | `Job` with `kind: 'explore' \| 'replay' \| 'shrink'` and `explore?: { step, states, findings, current }` |
| GET | /api/jobs/:jobId/stream | | **SSE**: `progress` (Job), `state` ({ stateId, thumb }), `finding` (Finding), `done` |
| POST | /api/jobs/:jobId/cancel | | `{ ok }` |
| GET | /api/explore | | `ExploreRunSummary[]` (newest first) |
| GET | /api/explore/:runId | | `ExploreRun` (config, device, summary, coverage curve) |
| GET | /api/explore/:runId/findings | | `Finding[]` |
| GET | /api/explore/:runId/graph | | `{ cells: Cell[], transitions: Transition[] }` |
| GET | /api/explore/:runId/report.html | | the HTML report |
| GET | /api/explore/:runId/files/:file | | a thumbnail or a trace file |
| POST | /api/devices/:id/replay | `{ trace } \| { runId, findingId }`, `times?` | `{ jobId }` |
| POST | /api/explore/:runId/findings/:findingId/shrink | `{ budgetMin? }` | `{ jobId }` |

### 10.4 Run directory

```
~/.firelab/explore/<runId>/
  run.json            config, device, timing, coverage curve, oracle notes ("focus oracle off: no focus info")
  timeline.jsonl      one line per step: action, gap, stateId, frame hash, settleMs, verdicts
  graph.json          cells + transitions (reused by the next run on the same app, later tier [9])
  findings.json
  traces/<findingId>.trace.json, traces/<findingId>.min.trace.json
  thumbs/s-<stateId>.jpg, thumbs/f-<findingId>-<n>.jpg
  report.html         one self-contained file (thumbnails inlined; capped at ~10 MB, older thumbs dropped)
  report.md           short summary for PRs and chat
```

### 10.5 The HTML report

The report contains:
- **Header:** app, build, device (model, RAM, tier), duration, steps, and the states-over-time curve (and the baseline's curve when this is a `bench` run).
- **Findings**, grouped by severity. Each finding has:
  - its title, oracle and reproduction rate;
  - the minimised key list with a copy-paste `firelab replay` command;
  - a filmstrip of the last frames before it;
  - the log excerpt and the probe values.
- **State map:** a grid of state thumbnails sized by visits, with unexplored frontier states outlined, plus the focus graph per screen when the focus oracle ran.
- **Notes:** which oracles were off and why, and what to add (`window.firelab` fields) to switch them on.

---

## 11. Scope tiers

The MVP is about 1.5 days (12–14 focused hours). The rest of the 8 days goes
to the main game's hackathon blockers. The MVP is the explorer, three
high-value oracles, ddmin and one HTML report.

### MVP (build first, in this order)

| # | Item | Hours | Why first |
|---|---|---|---|
| 1 | `src/engine/types.ts`, `MockDriver` + tests harness in `test/engine/` | 1.5 | lets everything else be tested without a TV |
| 2 | Observer: probe script, settle, `rgba` frame → dHash + luma, L1–L3 (+L4 fallback) abstraction | 2 | everything depends on state ids |
| 3 | Explorer: archive, `selectCell`, `chooseAction`, `returnTo` (graph or relaunch+replay), exit handling, stuck/plateau, budget, `random` strategy | 3 | the core loop and its baseline |
| 4 | Oracles: **health** (7.1), **screen** (7.2), **focus** (7.3) | 3 | crashes and exceptions are free; black/frozen and focus are the TV-specific wins and match real Sunset Villa bugs |
| 5 | Minimiser: repro rate, loop cut, ddmin, gap shrink, result cache | 1.5 | makes findings usable |
| 6 | Trace format, `replay`, single-file `report.html` + `report.md`, CLI functions for `explore` / `replay` / `shrink` | 2 | the deliverable people see |
| 7 | `examples/web-game/bugs.js` with 5 seeded bugs (freeze, black, throw, trap, grid) and one `bench` run: explore vs random, 3 × 20 min | 1 (+2 h device time, unattended) | evidence for the pitch |

Hand-offs to the core session (small, after 6): register `explore_start`,
`explore_status`, `explore_stop` and `explore_findings` in the MCP server, and
add `firelab explore|replay|shrink` to `cli.ts`.

The MVP depends on `src/driver/` with `AdbDriver` supporting `press`,
`screenshot({ format: 'rgba' })`, `evaluate`, `onConsole`, `logs`, `launch`,
`stop`, `pid` and `foreground`. Until it lands, development and tests run on
`MockDriver`.

### Later tier A (only if the main game is in good shape before Oct 23)

These are ordered by impact per effort:
1. App invariants + `firelab.events` (7.7), 2 h. This is the cheapest oracle for half of the Sunset Villa bugs.
2. Media stall oracle (7.8), 1 h.
3. Human-trace seeding from `watch` (6.4), 1.5 h.
4. Perf oracle with confirmation statistics (7.4) and `bench --compare`, 4 h. It shares the stats module with the evaluation.
5. Memory leak oracle over neutral cycles (7.5), 3 h.
6. HTTP routes + dashboard panel (10.3), 3 h (core/ui sessions).
7. `explore_step` for an LLM client (6.5), 2 h.

### Later tier B (after the hackathon)

- `VdaDriver` for Vega [56, 57], plus the in-app probe bridge.
- State refinement (5.3) [5].
- Reusing `graph.json` across runs [9].
- Differential replays across devices, fed into `firelab fit` [50, 51].
- Changepoint regression tracking over builds [32, 33].
- Desktop MemLab-style heap diffing on replay [42].
- Learned and LMM-assisted glitch detection [23, 24, 26].
- V8 precise coverage (`Profiler.startPreciseCoverage`) as an extra exploration reward, the way search-based tools use code coverage [4, 8].

---

## 12. Evaluation plan

The question: does the engine find more distinct states and more real bugs per
hour than a random monkey on the same device, and are its findings reproducible
and short? The protocol follows Klees et al. [37] and Arcuri and Briand [36]:
- repeated independent runs;
- the same device and time budget for every strategy;
- non-parametric tests with effect sizes;
- ground-truth bugs instead of only coverage, as in Themis [15].

### 12.1 Strategies

| Id | What | Notes |
|---|---|---|
| R | `--strategy random`: uniform keys, same key set, same pace, same oracles | the fair baseline [1, 2] (section 6.6) |
| M | `adb shell monkey -p <pkg> --throttle 500 --pct-touch 0 --pct-motion 0 --pct-trackball 0 --pct-appswitch 0 --pct-anyevent 0 --pct-nav 60 --pct-majornav 35 --pct-syskeys 5` with FireLab oracles watching; `--strategy monkey` sends the same event mix through any driver | real Monkey, Fire OS only, for credibility. (`--pct-nav 100` alone sends only arrows: Enter, Back and Menu are *majornav*, so it could never press OK.) |
| E | the engine, MVP configuration | |
| E−ret | the engine without return (explore from the current state only) | ablation: is the Go-Explore return worth its relaunch cost? [8, 20] |

### 12.2 Metrics

- **State coverage over time:** distinct L3 states. The engine defines these states itself, which could flatter it, so two engine-independent measures are also reported:
  - **App-state coverage:** distinct values of `demo.state.mode` × menu item × quality tier for Firefly Lake, read through the probe;
  - **JS block coverage:** V8 precise coverage over `game.js` and `world.js` through CDP, when the WebView allows it (verify on the device first).
- **Bugs found per hour**, and **time to first detection** for each seeded bug, censored at the budget.
- **False findings per hour:** findings a human marks as not-a-bug.
- **Minimiser:** trace length before/after (%), reproduction rate of the minimised trace over 5 replays, and minimiser wall time.

### 12.3 Statistics

- Per strategy, run n = 5 runs (n = 3 for the deadline cut) × 30 min (20 min for the deadline cut). Each run starts from a fresh launch with its own seed.
- Report the median and IQR of each metric.
- For continuous metrics (coverage, time to detection), use Mann–Whitney U with Vargha–Delaney Â12 [36], and a bootstrap CI of the median difference [39].
- For "did this run find bug X" (yes/no), use Fisher's exact test across runs [36].
- Only claim "E beats R" when p < 0.05 and Â12 ≥ 0.71 (large) on state coverage at 30 min. With n = 3, report effect sizes and CIs and say the result is preliminary [37].

### 12.4 Seeded-bug benchmark: Firefly Lake (`examples/web-game`, `?bugs=a,b,c`)

The bugs live in a separate `bugs.js` that loads only when `?bugs=` is present,
so the demo stays clean. They are written and committed *before* the engine is
tuned on them, to limit tuning bias.

| Bug id | What it does | Depth (keys from title) | Expected oracle | MVP? |
|---|---|---|---|---|
| `freeze` | after the 5th lantern, the rAF loop is not rescheduled | deep (must survive and collect) | screen: render-loop-stopped / frozen | yes |
| `black` | pressing OK on Resume twice within 300 ms hides the canvas (mirrors Sunset Villa's double start) | medium (menu) | screen: black-screen | yes |
| `throw` | `left` on the Quality item at tier `low` throws a TypeError | medium | health: js-error | yes |
| `trap` | after visiting Quality, up/down skip Resume/Title and back does nothing | medium | focus: focus-trap / stuck: dead-end | yes |
| `grid` | the menu renders in 2 columns but left/right move ±1 in list order | shallow | focus: non-spatial-move | yes |
| `hidden` | a 5th menu item is drawn but down wraps before it | shallow | focus: unreachable-control | yes (cheap to add) |
| `leak` | each menu open adds a 2 MB geometry that is never disposed | shallow, repeated | memory: memory-leak | tier A |
| `jank` | every 10th rock spawn runs a 250 ms busy loop | deep | perf: jank | tier A |
| `stall` | a looping intro video with a 25 Mbps source on the title screen | shallow | media: video-stall | tier A |
| `invariant` | two boats spawn when `ok` is pressed during the game-over fade | medium | invariant (`oneBoat`) | tier A |

Firefly Lake's menu marks focus with the `focused` class, so runs use
`--focus-selector ".focused"` and `--state-expr "demo.state"`.

### 12.5 Real-world bugs: Sunset Villa

These run only on a **test build with its own package id**, never on
`com.sunsetvilla.tv` (CONTRACT safety rules). Each bug is reintroduced on a
branch by reverting its fix, or behind a test flag.

| Real bug | How the engine can see it | Oracle | Tier |
|---|---|---|---|
| Black screen when two episodes started at once | rapid repeated OK/menu macros (6.2) reach the race; the screen goes black | screen: black-screen; invariant `oneEpisodeActive` | MVP (screen), A (invariant) |
| Dialogues cut short by popups | the dialogue ends without its `dialogue-complete` event while a popup opened | invariant over `firelab.events` order | A |
| Grid navigation picks the wrong item (arrow keys not spatial) | the focus graph disagrees with geometry | focus: non-spatial-move | MVP (needs `marks.focus` or DOM focus) |
| Characters sinking into benches | the app exposes seat height vs hip height; invariant `|hipY − seatY| < ε` | invariant | A (visual detection: tier B [25]) |
| fps drops in crowded scenes | per-state frame times; confirmation over 5 launches | perf: jank | A |
| Video stalls from a too-high bitrate | `currentTime` stops while not paused | media: video-stall | A |
| Marker pointing through walls | the app checks the line of sight from marker to target every frame | invariant | A |
| NPCs walking away before you can interact | invariant: an interact prompt was visible for less than 1.5 s before the target left range | invariant | A |
| Memory-tight 1 GB devices | PSS against the device budget; leak slope over neutral cycles; replay on the Stick 3rd gen | memory | A (budget check is cheap) |

Success for the MVP is three things:
- E finds all 5 MVP seeded bugs in at least 2 of 3 runs within 20 minutes;
- R finds fewer, or finds them later (Fisher test and time to detection);
- the minimised traces for the shallow and medium bugs are 15 keys or fewer, with a reproduction rate of at least 0.8.

### 12.6 Threats to validity

- One device model.
- A small demo game.
- We wrote the seeded bugs ourselves, which is mitigated by mirroring real Sunset Villa bugs and committing them before tuning.
- The engine-defined coverage could flatter the engine, which is mitigated by the app-state and JS-coverage metrics.
- A short n for the deadline, so the effect sizes are reported as preliminary [37].

---

## 13. Module layout (`src/engine/`)

```
src/engine/
  types.ts          section 4
  probe.ts          the injected probe script + parser (5.1)
  observe.ts        settle, frame hash, Observation (5.2, 5.4)
  abstraction.ts    state keys, levels, refinement hook (5.3)
  archive.ts        cells, selection weights (6.2)
  graph.ts          transitions, reliable shortest paths, cycles (6.3, 7.5)
  explorer.ts       the loop, return, action choice, random strategy (6)
  oracles/
    health.ts screen.ts focus.ts           (MVP)
    perf.ts memory.ts invariant.ts media.ts (tier A)
  minimize.ts       repro, loop cut, ddmin, gap shrink (8)
  stats.ts          bootstrapCI, mannWhitney, cliffsDelta, a12, theilSen, pelt, fisherExact
  trace.ts          Trace read/write, replay (10.4)
  report.ts         report.html / report.md (10.5)
  bench.ts          evaluation protocol (12)
  index.ts          explore(), replay(), shrink(), report(), bench() for CLI / MCP / HTTP wiring
test/engine/
  mock-driver.ts    simulated TV app: screens, focus grid, canvas frames, injectable bugs, nondeterminism knob
  *.test.ts         ddmin (classic examples [45]), stats against known values, abstraction, focus geometry, explorer beats random on the mock
```

### 13.1 Statistics reference implementations (`stats.ts`)

```
bootstrapCI(stat, xs, B = 2000, alpha = 0.05, rng):                [39]
  reps = for b in 1..B: stat(resample_with_replacement(xs, rng))
  return [percentile(reps, alpha/2), percentile(reps, 1 - alpha/2)]

mannWhitney(A, B):                                                 [36]
  ranks = average ranks of A ∪ B (ties get mean rank)
  U_A = sum(ranks of A) - nA(nA+1)/2
  mu = nA*nB/2; sigma = sqrt(nA*nB/12 * ((n+1) - sum(t^3 - t)/(n(n-1))))   // tie-corrected
  z = (|U_A - mu| - 0.5) / sigma; p = 2 * (1 - Phi(z))            // use exact distribution when nA, nB <= 8

cliffsDelta(A, B) = (#{a > b} - #{a < b}) / (nA * nB)             [38]
a12(A, B) = (cliffsDelta(A, B) + 1) / 2                            [36]

theilSen(x, y):                                                    [40]
  slope = median over i < j of (y_j - y_i) / (x_j - x_i)

pelt(y, penalty):                                                  [33]
  F[0] = -penalty; R = {0}; cp[0] = []
  for t in 1..n:
    F[t] = min over s in R of F[s] + cost(y[s+1..t]) + penalty      // cost = segment SSE around its mean
    s* = argmin; cp[t] = cp[s*] ++ [s*]
    R = { s in R : F[s] + cost(y[s+1..t]) <= F[t] } ∪ {t}           // pruning keeps it linear in expectation
  return cp[n]

fisherExact(a, b, c, d): two-sided p from the hypergeometric distribution over 2x2 tables   [36]
```
