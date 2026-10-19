# FireLab build contract (internal, for the people building it)

FireLab is an open-source toolkit for testing and tuning apps and games on
Amazon Fire TV (Fire OS) and other Android TV devices, with AI agents and with a
dashboard for humans. MIT licensed. npm name: `firelab` (free as of 2026-10-15).

Three parts, one repo:

1. **The tester**: an MCP server plus CLI that drives real devices over adb: find
   and connect devices on the Wi-Fi, install, launch and reset apps, press remote
   buttons, take screenshots, look inside WebViews over the Chrome DevTools
   Protocol, measure performance, and watch a human play.
2. **The performance library** (`@firelab/perf`, in `packages/perf`): a small,
   dependency-free browser library for TV web apps and games. It covers GPU/chip
   detection mapped to quality tiers, adaptive resolution that holds a target
   fps, and an on-screen meter. It also publishes its numbers on
   `window.firelab` so the tester can read them.
3. **The sweep**: runs an app on a real device at each quality tier, measures
   it, and recommends the best tier per device.

Plus a **dashboard** (`firelab ui`): a live screen mirror, a virtual remote,
performance charts, the WebView console, sweep results and the session timeline.

## Repo layout and who owns what

```
firelab/
  package.json            root: name "firelab", bin "firelab", npm workspaces ["packages/*", "examples/*"]   (core agent)
  tsconfig.json           (core agent)
  src/
    cli.ts                `firelab <command>`: mcp | ui | devices | doctor | sweep | watch | wrap   (core agent)
    adb/                  adb client, discovery, reconnect, keys, screenshots, apps, input recording (core agent)
    cdp/                  WebView DevTools over adb forward, eval, console, fps sampling (core agent)
    perf/                 device sampling (meminfo, cpu, gfxinfo) and the sweep runner (core agent)
    mcp/                  MCP server: tools, prompts, stdio + Streamable HTTP transports (core agent)
    http/                 the dashboard's HTTP API + static file server for ui/ (core agent)
    wrap/                 `firelab wrap`: turn a web URL into a Fire TV APK (perf/examples agent)
  android-template/       the WebView wrapper app sources used by wrap (perf/examples agent)
  ui/                     the dashboard: static HTML/CSS/JS, no build step (ui agent)
  packages/perf/          @firelab/perf browser library (perf/examples agent)
  examples/
    web-game/             small WebGL demo that uses @firelab/perf (perf/examples agent)
  test/                   tests for src/ (core agent); packages/perf has its own tests
  docs/                   CONTRACT.md (this file), plus guides
  README.md, LICENSE (MIT)   (core agent writes them; others send their sections in their reports)
```

Language: TypeScript (strict) for `src/` and `packages/perf`, compiled with `tsc`
to `dist/`, ESM, Node >= 20. `ui/` is plain modern JS + CSS so it ships without a
build step. Tests use Vitest. Keep dependencies few and well known
(`@modelcontextprotocol/sdk`, `zod`; `sharp` only if image resizing really needs
it; no frameworks in `ui/`).

## Quality tiers (shared vocabulary)

The tier ids, from lightest to richest, are `low`, `tv`, `tv-hd`, `high`.
- **low**: very old or very weak GPUs (Mali-450/470, Mali-T720/T820, Adreno 302–308, VideoCore). Minimal effects, 540p.
- **tv**: PowerVR GE8300 (Fire TV Stick 3rd gen, Lite), Mali-G31/G51, Adreno 320–5xx. 720p cap, no shadows.
- **tv-hd**: PowerVR GE9215 / GE9xxx (Fire TV Stick 4K Max 1st/2nd gen, 4K 2nd gen, 4K Plus), Mali-G52+, Adreno 6xx+. Up to 1080p, sun shadows.
- **high**: desktop and laptop GPUs.

Measured on Sunset Villa (a three.js game):
- **GE8300:** `tv` gives 27 fps standing and 24 walking at 768x432; `tv-hd` drops to 13–17 fps.
- **GE9215:** `tv-hd` is used at up to 1080p.

Apps can pick a tier with a URL parameter (default name `q`, e.g. `?q=tv-hd`). The sweep uses the same parameter.

The GPU-to-tier table lives in `@firelab/perf` (`packages/perf/src/chips.js`,
importable as `@firelab/perf/chips`). The tester uses the same table for
`Device.tier`, so the server and the in-page library always agree.

## Page hook: `window.firelab`

`@firelab/perf` keeps this object up to date (about 4 times a second), and the
tester reads it over CDP when it exists. Without it, the tester falls back to
counting `requestAnimationFrame` callbacks.

```js
window.firelab = {
  version: '1',
  tier: 'tv',              // current tier id
  autoTier: 'tv',          // what chip detection picked
  gpu: 'PowerVR Rogue GE8300',
  fps: 27.4,               // last ~1 s
  fpsMedian: 26.9,         // last ~10 s
  frameMs: { p50: 36.1, p95: 52.0 },
  scale: 0.8,              // render scale chosen by adaptive resolution
  canvas: { width: 768, height: 432 },
  drawCalls: 175,          // optional, if the app reports it
  triangles: 249360,       // optional
  heapMB: 54,              // optional (performance.memory)
  paused: false,           // true while the app isn't rendering (menu, video, hidden): the tester skips those samples
  targetFps: 30,           // the frame rate the app aims for
  marks: { scene: 'explore' } // free-form app state the app wants to expose
};
```

## Dashboard HTTP API (served by `firelab ui`, default http://localhost:7300)

All JSON unless noted. `:id` is the adb serial (e.g. `192.168.1.194:5555`).
Errors: `{ "error": "message people can act on" }` with a 4xx/5xx status.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/health | | `{ ok, adb: { path, version } \| null, version }` |
| GET | /api/devices | | `Device[]` |
| POST | /api/scan | `{ subnet? }` | `{ found: [{ ip, port }] }` (scans the LAN for adb port 5555) |
| POST | /api/devices/:id/connect | | `Device` |
| POST | /api/devices/:id/disconnect | | `{ ok }` |
| GET | /api/devices/:id/screen.jpg?w=960 | | JPEG of the current screen (cache-busted by the client) |
| POST | /api/devices/:id/keys | `{ keys: ["up","ok"], holdMs?, gapMs? }` | `{ ok }` |
| POST | /api/devices/:id/text | `{ text }` | `{ ok }` |
| POST | /api/devices/:id/wake | | `{ ok }` |
| GET | /api/devices/:id/apps | | `{ apps: [{ package, label?, version? }] }` (third-party only) |
| POST | /api/devices/:id/apps/launch | `{ package, url? }` | `{ ok, pid? }` |
| POST | /api/devices/:id/apps/stop | `{ package }` | `{ ok }` |
| POST | /api/devices/:id/apps/reset | `{ package, confirm: true }` | `{ ok }` (clears the app's data: a true first launch) |
| POST | /api/devices/:id/apps/install | `{ path }` (an .apk path on the computer) | `{ ok, package }` |
| POST | /api/devices/:id/webview/eval | `{ package?, expression }` | `{ value }` |
| GET | /api/devices/:id/stream | | **SSE**: events `perf`, `log`, `key`, `state` (below) |
| POST | /api/devices/:id/sweep | `SweepRequest` | `{ jobId }` |
| GET | /api/jobs/:jobId | | `Job` (poll), or `/api/jobs/:jobId/stream` for SSE `progress` / `done` |
| POST | /api/devices/:id/watch/start | `{ package?, intervalMs? }` | `{ sessionId }` |
| POST | /api/devices/:id/watch/stop | | `WatchSummary` |
| GET | /api/sessions | | `WatchSummary[]` |

```ts
type Device = {
  id: string; ip?: string; state: 'device' | 'offline' | 'unauthorized' | 'connecting';
  model?: string;          // e.g. AFTMA08C15
  name?: string;           // friendly, e.g. "Fire TV Stick 4K Max (2nd gen)"
  os?: string;             // e.g. "Fire OS 8 (Android 11)"
  abi?: string;            // e.g. armeabi-v7a
  ramMB?: number;
  gpu?: string;            // from the WebView's WebGL renderer when known
  tier?: 'low' | 'tv' | 'tv-hd' | 'high';
  resolution?: { width: number; height: number };
};
// SSE payloads
type PerfEvent  = { ts: number; fps?: number; fpsMedian?: number; scale?: number; memMB?: number; cpuPct?: number; source: 'page' | 'raf' | 'native' };
type LogEvent   = { ts: number; level: 'log' | 'info' | 'warn' | 'error'; text: string; source: 'console' | 'exception' | 'logcat' };
type KeyEvent   = { ts: number; key: string; action: 'down' | 'up' };    // remote presses, from getevent
type StateEvent = { ts: number; foreground?: string; screenOn?: boolean; connected: boolean };
type SweepRequest = { package?: string; url: string; tiers?: string[]; param?: string; warmupS?: number; sampleS?: number; action?: { keys?: string[]; eval?: string }; targetFps?: number };
type SweepRow = { tier: string; fpsMedian: number; fpsP10: number; memMB?: number; scale?: number; ok: boolean; note?: string };
type Job = { id: string; kind: 'sweep'; status: 'running' | 'done' | 'error'; progress: number; device: string; rows: SweepRow[]; recommendation?: { tier: string; reason: string }; error?: string };
type WatchSummary = { sessionId: string; device: string; startedAt: number; endedAt?: number; keys: number; fps?: { median: number; p10: number }; memMB?: { max: number }; errors: number; thumbnails: string[] };
```

Remote key names (shared by API, CLI and MCP): `up down left right ok back home
menu playpause rewind fastforward volup voldown mute search` plus `wake`.
`ok` = DPAD_CENTER. Fire TV maps: menu = KEYCODE_MENU (82), playpause = 85,
rewind = 89, fastforward = 90.

## MCP tools (core agent)

Concise snake_case names, every tool with a clear description and zod input
schema, images returned as MCP image content (downscaled JPEG):
`list_devices`, `scan_network`, `connect_device`, `device_info`, `wake_device`,
`press_keys`, `type_text`, `screenshot`, `list_apps`, `install_app`,
`launch_app`, `stop_app`, `reset_app` (requires `confirm: true`), `webview_eval`,
`webview_console`, `measure_performance`, `performance_sweep`, `watch_start`,
`watch_stop`, `logcat`. Plus prompts such as `playtest` and `tune_performance`
that walk an agent through a full play-test or a sweep.

Transports: stdio (`firelab mcp`) and Streamable HTTP (`firelab mcp --http 7301`),
on the current MCP spec via the official TypeScript SDK.

## Device safety rules (for everyone building this)

- The test devices on this network: Fire TV Stick 4K Plus (AFTMA08C15, 2025, GE9215;
  Amazon's spec page names it so, the 4K Max 2nd gen is AFTKRT; 192.168.1.194:5555) and possibly a Fire TV Stick 3rd gen (AFTSSS). A Jio/Xiaomi
  box may also have adb open; it is not ours to touch.
- Never clear data of, uninstall, or force-stop apps you didn't install yourself.
  `com.sunsetvilla.tv` holds the owner's game progress: read-only (screenshots,
  WebView eval of read-only expressions) unless the owner asks.
- Only the core agent drives real devices while building. Others use mocks.

## Additions by the core agent (2026-10-15)

All additive; nothing above changed meaning except the device name fix.

**Device** extras: `transport` (`tcp | usb | mdns | emulator`), `gpuSource`
(`spec` = from Amazon's spec table, `webgl` = the real WebGL renderer, learned
the first time FireLab inspects a WebView on the device), `fireOs` (boolean).

**Errors**: `{ error, code?, hint? }`. `code` is stable (`unauthorized`,
`offline`, `no-device`, `device-not-found`, `no-webview`, `not-running`,
`confirm-required`, `bad-request`, `busy`, `timeout`, ...); `hint` says what to
do. Status: 400 bad input, 404 unknown device/job/session, 409 device state
(unauthorized, no WebView, sweep already running), 415 non-JSON body, 403
foreign Host/Origin, 504 adb timeout, 503 adb missing.

**Security**: the server binds to 127.0.0.1 by default, rejects requests whose
Host isn't localhost (DNS rebinding), rejects cross-origin writes (Origin must
match), and requires `Content-Type: application/json` for POST bodies, so a web
page can't drive the TV through a simple form/no-cors request.

**Extra routes**

| Method | Path | Returns |
|---|---|---|
| GET | /api/devices/:id | `DeviceInfo` (everything `device_info` knows: abis, sdk, density, soc, power, foreground) |
| GET | /api/devices/:id/screen.png | full-resolution PNG |
| GET | /api/devices/:id/webview/console?package=&since=&limit= | `{ package, url, entries: ConsoleEntry[] }` |
| POST | /api/devices/:id/measure | `{ package?, seconds?, fpsExpr? }` -> `Measurement` |
| GET | /api/devices/:id/logcat?package=&lines=&level= | `{ lines: LogLine[], pid? }` |
| GET | /api/jobs | `Job[]` (newest first) |
| POST | /api/jobs/:jobId/cancel | `{ ok }` |
| GET | /api/sessions/:sessionId/:file | a session thumbnail (JPEG) |

**Response details**: `wake` returns `{ ok, woke, wakefulness, dreaming }`;
`apps/launch` returns `{ ok, package, activity, pid?, launchMs?, launchState? }`
(`launchMs` is Android's own cold/warm start time); `apps/install` returns
`{ ok, package, versionName?, leanback, warnings[] }` and refuses APKs whose
native code doesn't match the device ABI; `watch/start` also accepts
`thumbEveryMs`.

**Device stream backlog**: on connect, `/api/devices/:id/stream` first sends
the current `state`, then the `perf` events of the last 2 minutes and the most
recent `log` (300) and `key` (200) events, then live events. The backlog
survives the last viewer leaving, so a reloaded dashboard keeps its charts.
Clients dedupe by `ts`.

**Sweep jobs**: `Job` also has `request: { url, tiers, param, targetFps,
warmupS, sampleS, package? }` (defaults filled in), `criteria: { targetFps,
minP10, tolerance, minSamples }` (the rule behind each row's `ok`), and, while
running, `current: { tier, index, phase: 'launching' | 'warming up' |
'sampling', fps? }` (`fps` = median so far). `/api/jobs/:id/stream` sends the
full `Job` in every `progress` and `done` event (progress events add an
`event` field with the raw step) and closes after `done`. The dashboard shows
the server's `row.ok`; its live "near target" badge (median >= 0.85 x target)
is a display hint, not the sweep rule.

**Other details**: `POST /api/scan` also returns the `subnet` it scanned.
`webview/eval` page exceptions return 422 `{ error, code: 'eval-failed' }`;
DevTools connection problems return 502 (`cdp-failed`). Failed `screen.jpg`
requests return JSON `{ error }` with a 4xx/5xx status. `GET /api/sessions`
includes the running session (no `endedAt`). The fps sampler skips samples
while `window.firelab.paused` is true.

**SSE extras**: `PerfEvent.counter?: 'draws' | 'raf' | 'surfaceflinger'` says
how fps was counted when `source` is `raf` (frames that issued WebGL draw calls,
or plain rAF callbacks) or `native` (SurfaceFlinger frame timing, for apps
without a WebView). `KeyEvent.holdMs?` on `up` events.

**WatchSummary extras**: `package?`, `topKeys?: { key, count }[]`,
`firstErrors?: string[]`. Over HTTP, `thumbnails` are URLs
(`/api/sessions/<id>/thumb-0001.jpg`); over MCP/CLI they are file names inside
`dir` (an extra field with the session folder).

**Sweep**: a tier "holds the target" when median >= target x 0.95 (frame-capped
30 fps games measure 28.5-30 because pacing jitters a vsync now and then) and
p10 >= `minP10` (default 80% of target) with at least 5 one-second samples.
`SweepRow` extras: `samples`, `cpuPct`, `source`, `counter`, `loadMs`.
Results are also saved to `~/.firelab/sweeps/<jobId>.json` and `.md`.

**Remote keys**: plain presses go through `input keyevent` (one batched call);
holds and long presses go through a virtual HID remote made with Android's
built-in `hid` command (real key-down/up, any hold time). `FIRELAB_REMOTE=hid`
sends everything through HID, `FIRELAB_REMOTE=input` never uses it. Key specs
accept `down*3`, `ok:long`, `right:1500`, numbers and `KEYCODE_*` names.

## Test engine, vitals and reports (dashboard, 2026-10-18)

All additive. The dashboard's Test Engine starts **test jobs**: one shape for
every kind, followed like sweep jobs (poll, or SSE). Finished jobs are kept in
`~/.firelab/tests/<id>.json`, so the Test Results panel survives a restart.
One test (or sweep) runs per device at a time (409 `busy` otherwise). Tests
that relaunch or drive an app refuse `com.sunsetvilla.tv` (400
`confirm-required`).

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/devices/:id/vitals | | `Vitals` (sampled at most every 2 s; also the SSE `vitals` event, every 4 s) |
| GET | /api/gpu/models | | `{ models: GpuModel[], note }` |
| POST | /api/devices/:id/tests/app-launch | `{ package?, url?, settleS?, maxLaunchMs? }` | `TestJob` (lab smoke: launch, launch time, still running, screen, memory vs the model's budget, crash/ANR in logcat) |
| POST | /api/devices/:id/tests/navigation | `ExploreOptions` (default 3 min) | `TestJob` (engine run with oracles health+screen+focus, fails on focus/crash/black/frozen, short shrinking) |
| POST | /api/devices/:id/tests/performance | `{ package?, seconds?, targetFps? }` | `TestJob` (`measure`; pass = median ≥ 95% of target and p10 ≥ 80%, at least 5 samples; `skip` when no frame rate) |
| POST | /api/devices/:id/tests/explore | `ExploreOptions` (default 10 min) | `TestJob` (the full engine) |
| POST | /api/devices/:id/tests/gpu | `{ model, package?, url?, seconds? }` | `TestJob` (`runGpuEmulation`: WebGL features and limits of that model's GPU, not its speed; `skip` when the shim didn't load) |
| POST | /api/devices/:id/tests/replay | `{ runId, trace, times? }` or `{ sessionId, times? }` | `TestJob` (engine replay of a finding trace, or of a watch session's recorded presses) |
| GET | /api/tests?since=&limit= | | `TestJob[]` newest first (memory + disk, step logs trimmed to the last 3) |
| GET | /api/tests/:testId | | `TestJob` |
| GET | /api/tests/:testId/stream | | **SSE** `progress` / `done` (full `TestJob`), closes after `done` |
| POST | /api/tests/:testId/stop | | `{ ok }` |
| GET | /api/tests/:testId/findings | | `{ findings }` (explore/navigation; live while running) |
| GET | /api/tests/:testId/files/:file | | a file the test wrote (`screenshot.jpg`, `logcat.txt`) |
| GET | /api/runs?limit= | | `RunSummary[]`: engine run dirs under `exploreDir()`, newest first |
| GET | /api/runs/:runId | | `RunSummary` + `findingList` (with key sequences), `notes`, `config` |
| GET | /api/runs/:runId/report.html | | the engine report (also `report.md`, `run.json`, `findings.json`) |
| GET | /api/runs/:runId/traces/:file, /thumbs/:file | | trace JSON / thumbnail (what report.html links to) |
| GET | /api/scenarios | | `{ sessions: (WatchSummary & { keySequence, replayable, lastReplay })[], traces: (TraceInfo & { lastReplay })[] }` |
| GET | /api/reports | | `{ engine: [...runs with a report], bench: BenchReport[] }` |
| GET | /api/bench/:benchId/:file (and /:dir/:file) | | benchmark files: `report.html` and what it links to |

```ts
type TestJob = {
  id: string; kind: 'app-launch' | 'navigation' | 'performance' | 'explore' | 'gpu' | 'replay';
  name: string; device: string; package?: string;
  status: 'running' | 'done' | 'failed' | 'stopped';     // failed = the job broke; a test that ran and found problems is done + verdict fail
  verdict?: 'pass' | 'fail' | 'skip';                      // skip = couldn't measure
  progress: number | null; phase?: string; message?: string;
  startedAt: number; endedAt?: number; estimatedMs?: number; // estimatedMs: the budget, or (step budgets) time per step so far x steps
  steps?: number; states?: number; findings?: { critical: number; major: number; minor: number; info: number };
  runId?: string; report?: string;                          // engine run and its report URL
  log: { ts: number; text: string; status?: 'ok' | 'warn' | 'fail' | 'info' }[]; // live step list, last 300
  request: object; result?: unknown; error?: string;
};
type ExploreOptions = { package?, url?, minutes?, steps?, seed?, keys?: string[] | string, oracles?, stateExpr?, focusSelector?,
  strategy?: 'explore' | 'random', emulateGpu?: string /* model id */, failOn?: string[], minimize?: boolean, minimizeMinutes?,
  driver?: 'adb' | 'demo' /* demo = Lantern Lake, the simulated game; no device needed */ };
type Vitals = {
  ts: number; device: string;
  network: { iface: 'wlan0' | 'eth0'; rxBps: number; txBps: number; rxMbps: number; txMbps: number } | null; networkNote?: string;
  temperature: { c: number; sensor: string; source: 'thermalservice' | 'thermal_zone' } | null; temperatureNote?: string;
};  // null + note when not readable (first reading, no sensor, adb failed); never estimated
type GpuModel = { model: string; name: string; gpu?: string; kind: string; year?: number; platform?: string; tier?: string; emulatable: boolean; reason?: string };
type RunSummary = { runId, package, url?, device, strategy, startedAt, endedAt, durationMs, writtenAt, steps, states, stopped, error?,
  findings: { critical, major, minor, info }, failed: boolean /* any critical/major that reproduced, or an engine error */,
  emulateGpu?: string, report?: string, traces: number, demo: boolean };
type TraceInfo = { runId, file, findingId?, title?, severity?, kind?, status?, minimized, keys: string[], length, package, createdAt, demo };
type BenchReport = { id: string; createdAt?: number | string; title: string; subjects: string[]; strategies: string[]; headline?: string; report?: string };
```

Network rates come from `/proc/net/dev` byte counters (two readings, host
time between them). Temperature: `dumpsys thermalservice` (hottest CPU
sensor, else GPU/NPU/skin), else `/sys/class/thermal/thermal_zone*` (the
CPU/SoC zone). `PerfEvent` adds `frameMs?` / `frameP95Ms?` when the page
reports `window.firelab.frameMs`; otherwise there is no measured frame time
(the dashboard shows 1000/fps marked "est.").

Reports (engine and benchmark) are served with `Content-Security-Policy:
sandbox allow-scripts ...` so a report page runs in an opaque origin and
can't call the API. Benchmarks: any `<dataDir>/bench/<id>/bench.json` with
`kind: "firelab-bench"`; missing fields are tolerated (title falls back to
the folder name).
