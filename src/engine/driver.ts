/**
 * The DeviceDriver contract (docs/ENGINE.md section 3).
 *
 * The FireLab core session owns `src/driver/`. Until it lands, the engine keeps
 * this copy of the interface, word for word from the design, so `src/driver/types.ts`
 * can later re-export it (or this file can re-export that one). The engine
 * imports device code only through this file: never `src/adb/` or `src/cdp/`.
 */

export type RemoteKey =
  | 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'home' | 'menu'
  | 'playpause' | 'rewind' | 'fastforward' | 'volup' | 'voldown' | 'mute' | 'search' | 'wake';

export const REMOTE_KEYS: readonly RemoteKey[] = [
  'up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu',
  'playpause', 'rewind', 'fastforward', 'volup', 'voldown', 'mute', 'search', 'wake',
];

/** One press. Same meaning as src/adb/keys.ts KeyPress, without the Android key code. */
export type KeySpec = { key: RemoteKey; mode?: 'press' | 'long' | 'hold'; holdMs?: number };

export type AppRef = { package: string; url?: string }; // url: for wrapped web apps (launch intent extra)

export type Frame = {
  width: number;
  height: number;
  /** Small RGBA buffer when format 'rgba' was asked (for hashing; no image decoding in the engine). */
  rgba?: Uint8Array;
  /** JPEG/PNG bytes when asked (for thumbnails in reports). */
  data?: Buffer;
  mime?: 'image/jpeg' | 'image/png';
  captureMs: number;
};

export type LogLine = { ts: number; level: 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'; tag?: string; pid?: number; text: string };
export type ConsoleEntry = { ts: number; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string; source: 'console' | 'exception' | 'browser'; url?: string; line?: number };
export type MemorySample = { ts: number; pssMB?: number; jsHeapMB?: number; graphicsMB?: number; availMB?: number };
export type RecordedKey = { ts: number; key: string; action: 'down' | 'up'; holdMs?: number };

export type DriverCaps = {
  keys: true; // required
  /**
   * Real key-down/up with any hold time. False when holds arrive as repeated
   * key-downs (Fire OS 8 over adb): the engine then treats a hold as a burst of
   * presses and budgets for it.
   */
  holds: boolean;
  text: boolean;
  screenshot: true; // required
  rgbaThumb: boolean; // screenshot({ format: 'rgba', width: 64 }) without a JPEG round trip
  launch: true; // required
  reset: boolean; // clear app data (FireLab-installed apps only)
  install: boolean;
  eval: boolean; // JS evaluation in the app (CDP Runtime.evaluate, or an in-app bridge)
  console: boolean; // console + uncaught exceptions stream
  cdp: boolean; // raw CDP passthrough (HeapProfiler, Profiler, Page)
  logs: true; // required: device log since a time
  memory: boolean;
  measure: boolean; // FireLab's measure(): fps + memory + cpu over N seconds
  recordKeys: boolean; // a human's remote presses (getevent)
};

export interface DeviceDriver {
  readonly kind: 'adb' | 'vda' | 'mock' | 'browser';
  readonly serial: string;
  readonly caps: DriverCaps;

  info(): Promise<{ model?: string; name?: string; os?: string; ramMB?: number; gpu?: string; tier?: string; resolution?: { width: number; height: number } }>;
  wake(): Promise<void>;

  press(keys: KeySpec[], opts?: { gapMs?: number }): Promise<void>;
  typeText?(text: string): Promise<void>; // caps.text

  screenshot(opts?: { width?: number; quality?: number; format?: 'jpeg' | 'png' | 'rgba' }): Promise<Frame>;

  foreground(): Promise<{ package: string; activity?: string } | null>;
  launch(app: AppRef): Promise<{ pid?: number; launchMs?: number }>;
  stop(app: AppRef): Promise<void>;
  pid(app: AppRef): Promise<number | undefined>;
  reset?(app: AppRef, opts: { confirm: true }): Promise<void>; // caps.reset
  install?(path: string): Promise<{ package: string }>; // caps.install

  evaluate?<T = unknown>(expression: string, opts?: { app?: AppRef; timeoutMs?: number }): Promise<T>; // caps.eval
  onConsole?(app: AppRef, fn: (e: ConsoleEntry) => void): () => void; // caps.console
  cdp?(method: string, params?: Record<string, unknown>): Promise<unknown>; // caps.cdp

  logs(opts: { app?: AppRef; sinceTs?: number; minLevel?: LogLine['level'] }): Promise<LogLine[]>;
  memory?(app: AppRef): Promise<MemorySample>; // caps.memory
  measure?(app: AppRef, seconds: number): Promise<{ fps?: { median: number; p10: number }; memMB?: number; cpuPct?: number; page?: Record<string, unknown> }>; // caps.measure
  recordKeys?(): { stop(): Promise<RecordedKey[]> }; // caps.recordKeys
  /** extension: the window hierarchy as `uiautomator dump` XML, for native focus (src/engine/uidump.ts). 1-3 s on a Fire TV. */
  uiDump?(opts?: { timeoutMs?: number }): Promise<string>;

  close(): Promise<void>;
}
