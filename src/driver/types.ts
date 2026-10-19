/**
 * The DeviceDriver contract (docs/ENGINE.md section 3, docs/DRIVERS.md).
 *
 * Everything that drives a TV for the exploration engine, `firelab fit` and
 * other higher-level tools goes through this interface, so a new platform
 * (Vega OS via `vda`, a simulator) only needs a new driver. The types below
 * are exactly the ones in ENGINE.md section 3; the additions are optional and
 * marked "Addition", so code written against the original contract (and
 * drivers implementing it, like the engine's MockDriver) still type-checks.
 */

export type RemoteKey =
  | 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'home' | 'menu'
  | 'playpause' | 'rewind' | 'fastforward' | 'volup' | 'voldown' | 'mute' | 'search' | 'wake';

/** One press. Same meaning as src/adb/keys.ts KeyPress, without the Android key code. */
export type KeySpec = { key: RemoteKey; mode?: 'press' | 'long' | 'hold'; holdMs?: number };

export type AppRef = { package: string; url?: string }; // url: for wrapped web apps (launch intent extra)

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

/** Addition: the driver kinds. 'vda' is Vega OS (src/vega; not yet tested on a real Vega device, see docs/VEGA.md). */
export type DriverKind = 'adb' | 'vda' | 'mock' | 'browser';

/** Addition: what `info()` returns. */
export type DriverInfo = { model?: string; name?: string; os?: string; ramMB?: number; gpu?: string; tier?: string; resolution?: { width: number; height: number } };

/**
 * Addition: options for `reset`. `confirm: true` is always required.
 * Drivers refuse apps FireLab didn't install unless `allowAnyPackage` is set.
 */
export type ResetOptions = { confirm: true; allowAnyPackage?: boolean };

export interface DeviceDriver {
  readonly kind: 'adb' | 'vda' | 'mock' | 'browser';
  readonly serial: string;
  /**
   * What works on this device (and, for eval/console/cdp/reset, for the
   * current app: the last one launched or probed). The object is updated in
   * place as the driver learns more, so a reference kept by the caller stays
   * current. Drivers never claim a capability they haven't established.
   */
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
  reset?(app: AppRef, opts: ResetOptions): Promise<void>;                   // caps.reset (ResetOptions = { confirm: true } plus an optional override)
  install?(path: string): Promise<{ package: string }>;                     // caps.install

  evaluate?<T = unknown>(expression: string, opts?: { app?: AppRef; timeoutMs?: number }): Promise<T>;  // caps.eval
  onConsole?(app: AppRef, fn: (e: ConsoleEntry) => void): () => void;       // caps.console
  cdp?(method: string, params?: Record<string, unknown>): Promise<unknown>; // caps.cdp

  logs(opts: { app?: AppRef; sinceTs?: number; minLevel?: LogLine['level'] }): Promise<LogLine[]>;
  memory?(app: AppRef): Promise<MemorySample>;                              // caps.memory
  measure?(app: AppRef, seconds: number): Promise<{ fps?: { median: number; p10: number }; memMB?: number; cpuPct?: number; page?: Record<string, unknown> }>;  // caps.measure
  recordKeys?(): { stop(): Promise<RecordedKey[]> };                        // caps.recordKeys

  /**
   * Addition: the window in front as `uiautomator dump` XML (focused view,
   * focusable views, bounds, text, resource ids). The engine reads native
   * focus from it for apps without a WebView. Slow (1-3 s on a Fire TV).
   */
  uiDump?(opts?: { timeoutMs?: number }): Promise<string>;

  /**
   * Addition: find out what works, now. Without `app`, device-level caps
   * (holds, recordKeys...); with `app`, also the app-level ones (eval,
   * console, cdp, reset). Returns `caps` after the update.
   */
  probe?(app?: AppRef): Promise<DriverCaps>;

  close(): Promise<void>;
}

/** Addition: every capability name, for loops and reports. */
export const CAP_NAMES = ['keys', 'holds', 'text', 'screenshot', 'rgbaThumb', 'launch', 'reset', 'install', 'eval', 'console', 'cdp', 'logs', 'memory', 'measure', 'recordKeys'] as const satisfies readonly (keyof DriverCaps)[];

/** Addition: the remote keys, in a stable order. */
export const DRIVER_KEYS = ['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'playpause', 'rewind', 'fastforward', 'volup', 'voldown', 'mute', 'search', 'wake'] as const satisfies readonly RemoteKey[];

/** Addition: the most a driver may promise before it has looked at anything (the required caps only). */
export function minimalCaps(): DriverCaps {
  return { keys: true, holds: false, text: false, screenshot: true, rgbaThumb: false, launch: true, reset: false, install: false, eval: false, console: false, cdp: false, logs: true, memory: false, measure: false, recordKeys: false };
}
