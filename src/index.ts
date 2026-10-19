/**
 * FireLab as a library. Most people use the CLI or the MCP server; this is
 * for scripts and other tools that want the same building blocks.
 */
export { FireLab, type FireLabOptions } from './core/firelab.js';
export type { Device, Job, SweepRequest } from './core/types.js';
export { createMcpServer, TOOL_NAMES } from './mcp/server.js';
export { runStdio, runHttp } from './mcp/transports.js';
export { createDashboardHandler, startDashboard } from './http/server.js';

export { Adb, ProcessRunner, type AdbRunner, type ExecResult } from './adb/client.js';
export { findAdb, adbCandidates } from './adb/locate.js';
export { parseDevices, type AdbDevice } from './adb/devices.js';
export { getDeviceInfo, parseDeviceInfo, type DeviceInfo } from './adb/info.js';
export { FIRE_TV_MODELS, lookupModel, friendlyName, osLabel, tierForGpu, tierForModel, TIERS, type Tier, type FireTvModel } from './adb/models.js';
export { scanNetwork, probeAdb, parseCidr, hostsInCidr, defaultScanRanges } from './adb/discovery.js';
export { Reconnector } from './adb/reconnect.js';
export { REMOTE_KEYS, REMOTE_KEY_NAMES, parseKeys, escapeInputText, InputKeyInjector, type KeyPress, type KeyInjector } from './adb/keys.js';
export { HidRemote, SmartRemote, hidScript, registerCommand, reportCommand, CONSUMER_USAGES } from './adb/hid.js';
export { captureScreen, extractPng, parseRawScreencap, screenJpeg, screenPng } from './adb/screenshot.js';
export { decodePng, encodePng } from './adb/png.js';
export { listApps, launchApp, stopApp, resetApp, foregroundApp, resolveLaunchActivity, pidOf } from './adb/apps.js';
export { readApk, readApkFile, abiProblem, type ApkInfo } from './adb/apk.js';
export { wakeDevice, powerState } from './adb/power.js';
export { KeyRecorder, parseGeteventLine } from './adb/getevent.js';
export { dumpLogcat, LogcatStream, parseLogcatLine } from './adb/logcat.js';

export { WebViewSession, type ConsoleEntry } from './cdp/webview.js';
export { CdpClient } from './cdp/client.js';
export { FpsSampler, PROBE_SOURCE, type FpsSample } from './cdp/fps.js';

export { NativeSampler, type NativeSample } from './perf/native.js';
export { SurfaceFlingerSampler, parseLatency, pickLayer } from './perf/surfaceflinger.js';
export { parseMeminfo, parseTop, parseGfxinfo, parseProcStatTicks } from './perf/parse.js';
export { runSweep, recommend, evaluateRow, criteriaFor, sweepMarkdown, tierUrl, DEFAULT_TIERS, type SweepRow, type SweepResult, type SweepOptions } from './perf/sweep.js';
export { WatchSession, type WatchSummary, type PerfEvent, type LogEvent, type KeyEvent, type StateEvent } from './perf/watch.js';
export { measure, type Measurement } from './perf/measure.js';
export { FireLabError, type ErrorCode } from './lib/errors.js';
export { median, percentile, summarize } from './lib/stats.js';

export {
  createDriver,
  registerDriver,
  driverKinds,
  AdbDriver,
  FakeDriver,
  keySpecString,
  CAP_NAMES,
  DRIVER_KEYS,
  minimalCaps,
  type CreateDriverOptions,
  type DriverFactory,
  type AdbDriverOptions,
  type FakeDriverOptions,
  type FakeReply,
  type FakeCall,
  type DeviceDriver,
  type DriverCaps,
  type DriverKind,
  type DriverInfo,
  type KeySpec,
  type AppRef,
  type Frame,
  type MemorySample,
  type RecordedKey as DriverRecordedKey,
  type LogLine as DriverLogLine,
  type ConsoleEntry as DriverConsoleEntry,
  type RemoteKey as DriverRemoteKey,
  type ResetOptions,
} from './driver/index.js';
export { inputHoldScript } from './adb/keys.js';
export { HID_PROFILES, KEYBOARD_USAGES, hidVerdict, forgetHidVerdicts, isFireOs, type HidVerdict, type HidProfileName, type RemoteMode } from './adb/hid.js';
export { KernelKeyInjector, kernelKeyMap, sendeventScript, KERNEL_KEYS } from './adb/sendevent.js';
export { parseGeteventDevices, type InputDevice } from './adb/getevent.js';
export { installedByFireLab, recordInstall } from './core/installs.js';

// The game-testing engine (docs/ENGINE.md): explore an app with the remote, shrink findings, report.
export {
  explore,
  replay as replayFinding,
  shrink as shrinkFinding,
  report as exploreReport,
  listRuns as exploreRuns,
  startExploreJob,
  getExploreJob,
  Explorer,
  replayTrace,
  shrinkTrace,
  ddmin,
  readTrace,
  failMatcher,
  FAIL_CATEGORIES,
  DEFAULT_KEYS as EXPLORE_DEFAULT_KEYS,
  type ExploreRequest,
  type ExploreSummary,
  type FindingSummary,
  type ExploreResult,
  type ExploreEvent,
  type Finding,
  type Trace,
} from './engine/index.js';

// Vega OS (Fire TV Stick 4K Select and newer) over the Vega SDK's vda + inputd-cli.
// Not yet tested on a real Vega device: see docs/VEGA.md.
export { VdaDriver, VEGA_KEYS, resolveVegaSerial, findVega, type VdaDriverOptions, type VegaRunner, type VegaResult } from './vega/index.js';
