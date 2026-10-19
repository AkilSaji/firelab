// Type declarations for @firelab/perf (hand-written; the sources are plain
// JavaScript with JSDoc).

// ---------------------------------------------------------------- tiers

/** Quality tiers from lightest to richest (the shared FireLab vocabulary). */
export type TierId = 'low' | 'tv' | 'tv-hd' | 'high';

export interface TierPreset {
  id: TierId;
  /** 0 for low … 3 for high */
  rank: number;
  label: string;
  /** Tallest drawing buffer worth rendering at scale 1, in device pixels (540, 720, 1080, 1440). */
  maxHeight: number;
  summary: string;
}

export const TIER_IDS: readonly TierId[];
export const TIERS: Readonly<Record<TierId, TierPreset>>;
/** Friendly spellings accepted wherever a tier id is read ("hd" → "tv-hd", "max" → "high", …). */
export const TIER_ALIASES: Readonly<Record<string, string>>;
export function isTier(value: unknown): value is TierId;
/** "HD", " tv-hd ", "max" → a tier id, or null. */
export function normalizeTier(value: unknown): TierId | null;
export function lighterTier(tier: TierId): TierId | null;
export function richerTier(tier: TierId): TierId | null;
/** The lighter of two tiers. */
export function capTier(tier: TierId, cap: TierId): TierId;
/** The value for `tier` from a partial map, falling back to the nearest lighter tier, then the nearest richer one. */
export function pick<T>(tier: TierId, map: Partial<Record<TierId, T>>): T | undefined;

// ---------------------------------------------------------------- chips

export interface ChipEntry {
  id: string;
  match: RegExp;
  tier: TierId;
  family: string;
  why: string;
  devices?: string[];
  measured?: string;
}

/** The chip table: first match wins. */
export const CHIPS: readonly ChipEntry[];
/** Fire TV model codes (from the user agent), used when the GPU name is hidden. */
export const FIRE_TV_MODELS: Readonly<Record<string, { name: string; gpu: string; tier: TierId }>>;

export type Platform = 'firetv' | 'androidtv' | 'tv' | 'mobile' | 'desktop';

export interface UaInfo {
  platform: Platform;
  isTv: boolean;
  model: string | null;
  device: string | null;
  /** Inside an app WebView ("; wv)") or FireLab's wrapper. */
  wrapped: boolean;
}

export interface GpuInfo {
  renderer: string;
  vendor: string;
  /** True when WEBGL_debug_renderer_info was unavailable. */
  masked: boolean;
  webgl: 0 | 1 | 2;
}

export interface Detection {
  tier: TierId;
  reason: string;
  platform: Platform;
  isTv: boolean;
  model: string | null;
  device: string | null;
  /** Display name of the GPU ('' when unknown). */
  gpu: string;
  renderer: string;
  vendor: string;
  masked: boolean;
  webgl: 0 | 1 | 2;
  /** Id of the matching chip table entry. */
  chip: string | null;
}

export function parseUserAgent(ua?: string, hints?: { maxTouchPoints?: number }): UaInfo;
export function classifyGpu(renderer: string | null | undefined): ChipEntry | null;
export function cleanGpuName(renderer: string | null | undefined): string;
export function classifyDevice(info: {
  renderer?: string;
  vendor?: string;
  masked?: boolean;
  webgl?: 0 | 1 | 2;
  ua?: string;
  maxTouchPoints?: number;
}): Detection;
type GL = WebGLRenderingContext | WebGL2RenderingContext;
export function readGpu(opts?: { gl?: GL | null; document?: Document }): GpuInfo;
export function detectDevice(opts?: { gl?: GL | null; document?: Document; navigator?: Navigator }): Detection;

// ---------------------------------------------------------------- tier choice

export type TierSource = 'url' | 'code' | 'saved' | 'fallback' | 'auto';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FallbackRecord {
  tier: TierId;
  from: TierId;
  gpu: string;
  at: number;
}

export interface TierChoice {
  tier: TierId;
  source: TierSource;
  auto: TierId;
  fallback: FallbackRecord | null;
}

/** URL parameter > code > saved choice > stored fallback > detection. `?q=auto` ignores every override. */
export function resolveTier(opts: {
  auto: TierId;
  search?: string;
  param?: string;
  code?: unknown;
  storage?: StorageLike | null;
  storageKey?: string;
  gpu?: string;
  now?: number;
  fallbackTtlMs?: number;
}): TierChoice;
export function readFallback(storage: StorageLike, key: string, opts?: { gpu?: string; now?: number; ttlMs?: number }): FallbackRecord | null;
/** Wraps a storage so that no call ever throws. */
export function safeStorage(storage: StorageLike | null | undefined): StorageLike;

// ---------------------------------------------------------------- adaptive resolution

export type ScaleReason = 'down' | 'up' | 'reset';

export interface WindowResult {
  /** Trimmed frames per second of the window. */
  fps: number;
  /** Scale after the decision. */
  scale: number;
  action: 'down' | 'up' | 'hold' | 'floor' | 'ceiling' | 'blocked' | 'cooldown';
}

export interface AdaptiveOptions {
  /** Default 30. */
  targetFps?: number;
  /** Floor, as a share of the tier's resolution budget. Default 0.6. */
  minScale?: number;
  /** Ceiling. Default 1. */
  maxScale?: number;
  /** Default 0.75. */
  initialScale?: number;
  /** Default 0.1. */
  stepDown?: number;
  /** Default 0.1. */
  stepUp?: number;
  /** Length of one measurement window. Default 2000 ms. */
  windowMs?: number;
  /** Ignored at the start (shader compiles, uploads). Default 3000 ms. */
  warmupMs?: number;
  /** Ignored after each change or resume. Default 1000 ms. */
  settleMs?: number;
  /** Step down below this. Default 0.9 × target. */
  dropBelow?: number;
  /** Step down twice below this. Default 0.67 × target. */
  fastDropBelow?: number;
  /** Count a window as good above this. Default 0.95 × target. */
  raiseAbove?: number;
  /** Good windows in a row before a raise. Default 3. */
  raiseAfter?: number;
  /** Minimum time from any change to a raise. Default 10000 ms. */
  cooldownMs?: number;
  /** A drop this soon after a raise blocks that level. Default 8000 ms. */
  retreatMs?: number;
  /** How long a failed level stays blocked (doubles on each repeat, up to 30 min). Default 180000 ms. */
  blockMs?: number;
  /** Share of the slowest frames ignored in each window. Default 0.05. */
  trim?: number;
  /** Fire onFallback when the floor cannot hold the target. Default true. */
  fallback?: boolean;
  /** Default 0.75 × target. */
  fallbackBelow?: number;
  /** Default 4. */
  fallbackWindows?: number;
  onChange?(scale: number, prev: number, why: ScaleReason): void;
  onFallback?(info: { fps: number; scale: number; windows: number }): void;
  onWindow?(result: WindowResult): void;
}

export interface AdaptiveState {
  t: number;
  scale: number;
  paused: boolean;
  goodWindows: number;
  slowWindows: number;
  fallbackFired: boolean;
  measuring: boolean;
  blocked: { level: number; until: number; strikes: number }[];
}

export interface AdaptiveController {
  readonly scale: number;
  readonly paused: boolean;
  readonly options: Required<Omit<AdaptiveOptions, 'onChange' | 'onFallback' | 'onWindow'>>;
  /** Feed one frame's duration in ms. Returns the decision when a window closes. */
  frame(dtMs: number): WindowResult | null;
  setPaused(paused: boolean): void;
  /** Forget history (e.g. after a tier change) and go back to `scale` or the initial scale. */
  reset(scale?: number): void;
  setRange(range: { minScale?: number; maxScale?: number }): void;
  state(): AdaptiveState;
}

export function createAdaptiveResolution(options?: AdaptiveOptions): AdaptiveController;

// ---------------------------------------------------------------- stats

/** Percentile with linear interpolation between closest ranks; NaN when empty. */
export function percentile(values: ArrayLike<number>, p: number): number;
export function sortedPercentile(sorted: ArrayLike<number>, p: number, n?: number): number;
export function median(values: ArrayLike<number>): number;

export interface FrameStats {
  /** Record one frame: its duration and when it ended. */
  push(dtMs: number, now: number): void;
  /** Frames per second over the last ~1 s. */
  fps(now: number): number;
  /** Median of the per-second rates over the last ~10 s. */
  fpsMedian(): number;
  /** Frame-time percentiles over the last ~2 s. */
  frameMs(now: number): { p50: number; p95: number };
  count(): number;
  reset(): void;
}

export function createFrameStats(opts?: { capacity?: number; fpsWindowMs?: number; statsWindowMs?: number; medianSeconds?: number }): FrameStats;

// ---------------------------------------------------------------- frame limiter

export interface FrameLimiter {
  /** True when this requestAnimationFrame callback should render. */
  ready(now: number): boolean;
  readonly fps: number;
  setFps(fps: number): void;
}

/** Render at a steady `fps` (e.g. 30 on a 60 Hz TV). 0 disables the limit. */
export function createFrameLimiter(fps: number, opts?: { slackMs?: number }): FrameLimiter;

// ---------------------------------------------------------------- window.firelab

export const HOOK_VERSION: '1';

/** The page hook read by the FireLab tester over DevTools. Plain data, updated in place ~4×/s. */
export interface FirelabHook {
  version: '1';
  tier: TierId;
  autoTier: TierId;
  gpu: string;
  /** Last ~1 s. */
  fps: number;
  /** Last ~10 s. */
  fpsMedian: number;
  /** Last ~2 s. */
  frameMs: { p50: number; p95: number };
  /** Render scale chosen by adaptive resolution (share of the tier's resolution budget). */
  scale: number;
  /** Drawing buffer size. */
  canvas: { width: number; height: number };
  drawCalls?: number;
  triangles?: number;
  heapMB?: number;
  /** Free-form app state. */
  marks: Record<string, string | number | boolean | null>;
  /** The app says frames are not representative right now (video, menu, hidden tab). */
  paused: boolean;
  targetFps: number;
}

export interface HookUpdate {
  tier?: TierId;
  autoTier?: TierId;
  gpu?: string;
  fps?: number;
  fpsMedian?: number;
  p50?: number;
  p95?: number;
  scale?: number;
  width?: number;
  height?: number;
  drawCalls?: number | null;
  triangles?: number | null;
  heapMB?: number | null;
  paused?: boolean;
  targetFps?: number;
}

export function createHookObject(init: { tier: TierId; autoTier: TierId; gpu?: string; targetFps?: number }): FirelabHook;
export function updateHook(hook: FirelabHook, update: HookUpdate): FirelabHook;
/** Problems with a hook read from a page; empty when valid. */
export function validateHook(hook: unknown): string[];

declare global {
  interface Window {
    firelab?: FirelabHook;
  }
}

// ---------------------------------------------------------------- meter and keys

export type MeterPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface MeterData {
  fps: number;
  fpsMedian: number;
  targetFps: number;
  p50: number;
  p95: number;
  scale: number;
  width: number;
  height: number;
  tier: string;
  tierSource: string;
  gpu: string;
  drawCalls?: number;
  triangles?: number;
  heapMB?: number;
  paused: boolean;
  pauseReason?: string;
  adaptive?: boolean;
}

export interface Meter {
  show(): void;
  hide(): void;
  /** Returns the new visibility. */
  toggle(): boolean;
  readonly visible: boolean;
  update(data: MeterData): void;
  destroy(): void;
}

export function createMeter(opts?: { document?: Document; devicePixelRatio?: number; position?: MeterPosition; history?: number; inset?: number }): Meter;

/** Keys that toggle the meter by default: the remote's rewind button, or ` on a keyboard (tap twice). */
export const DEFAULT_TOGGLE_KEYS: readonly string[];
export function keyNames(e: { key?: string; code?: string; keyCode?: number }): string[];

export interface TapDetector {
  /** Feed a keydown/keyup; true when this event completed the combo. */
  handle(e: { type: string; key?: string; code?: string; keyCode?: number; repeat?: boolean; target?: unknown }, now: number): boolean;
}

export function createTapDetector(opts?: { keys?: readonly string[]; taps?: number; withinMs?: number; maxPressMs?: number }): TapDetector;
export function listenForToggle(opts: {
  target?: EventTarget;
  keys?: readonly string[];
  taps?: number;
  withinMs?: number;
  now?: () => number;
  onToggle: () => void;
}): () => void;

// ---------------------------------------------------------------- adapters

export interface ScaleInfo {
  /** Device pixels per CSS pixel to render at. */
  pixelRatio: number;
  width: number;
  height: number;
  /** The pixel ratio at scale 1 (the tier's resolution budget). */
  maxPixelRatio: number;
  cssWidth: number;
  cssHeight: number;
  tier: TierId;
}

export interface RenderAdapter {
  setScale(scale: number, info: ScaleInfo): void;
  stats?(): { drawCalls?: number; triangles?: number };
  canvas?: HTMLCanvasElement | null;
  gl?: GL | null;
  name?: string;
}

export function computeScaleInfo(
  scale: number,
  view: { maxHeight: number; cssWidth: number; cssHeight: number; devicePixelRatio?: number; maxPixelRatio?: number; tier?: TierId },
): ScaleInfo;

/** Structural types, so that no engine typings are required. */
export interface ThreeRendererLike {
  setPixelRatio(ratio: number): void;
  domElement?: HTMLCanvasElement;
  info?: { render?: { calls?: number; triangles?: number } };
  getContext?(): any;
}
export interface BabylonEngineLike {
  setHardwareScalingLevel(level: number): void;
  resize(): void;
  getRenderingCanvas?(): HTMLCanvasElement | null;
}
export interface PixiAppLike {
  renderer: { resolution: number; resize(width: number, height: number): void; gl?: any };
  screen: { width: number; height: number };
  canvas?: HTMLCanvasElement;
  view?: HTMLCanvasElement;
}

export function threeAdapter(renderer: ThreeRendererLike): RenderAdapter;
export function babylonAdapter(engine: BabylonEngineLike, opts?: { scene?: { getActiveIndices?(): number } }): RenderAdapter;
export function pixiAdapter(app: PixiAppLike): RenderAdapter;
export function canvasAdapter(
  canvas: HTMLCanvasElement,
  opts?: { onResize?(width: number, height: number, pixelRatio: number): void; gl?: GL | null; stats?(): { drawCalls?: number; triangles?: number } },
): RenderAdapter;
/** Wraps a three.js renderer, Babylon engine, Pixi app or canvas; null when unrecognised. */
export function autoAdapter(target: unknown): RenderAdapter | null;

// ---------------------------------------------------------------- createPerf

export interface PerfEnv {
  window: EventTarget | null;
  document: Document | null;
  navigator?: Navigator;
  search(): string;
  storage: StorageLike | null;
  now(): number;
  requestAnimationFrame(cb: (t: number) => void): number;
  cancelAnimationFrame(id: number): void;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  devicePixelRatio(): number;
  viewport(): { width: number; height: number };
  heapMB(): number | undefined;
  hidden(): boolean;
  reload?(): void;
}

export function browserEnv(): PerfEnv;

export interface TierOverrides {
  maxHeight?: number;
  minScale?: number;
  maxScale?: number;
}

export interface PerfOptions {
  /** Default 30. A function is called once with the starting tier: `(tier) => (tier === 'high' ? 60 : 30)`. */
  targetFps?: number | ((tier: TierId, detection: Detection) => number);
  /** Force a tier from code (the URL parameter still wins). */
  tier?: TierId | string;
  /** URL parameter that forces a tier. Default 'q' (?q=tv-hd, ?q=auto). */
  param?: string;
  /** URL parameter that shows the meter. Default 'perf' (?perf=1). */
  meterParam?: string;
  /** URL parameter that pins the render scale. Default 'scale' (?scale=0.8). */
  scaleParam?: string;
  /** localStorage key prefix. Default 'firelab-tier'. */
  storageKey?: string;
  /** Default true. */
  adaptive?: boolean | AdaptiveOptions;
  /** Persist a lighter tier when the auto-picked one cannot hold the target. Default true. */
  fallback?: boolean;
  /** Pin the render scale from code (turns adaptive off). */
  scale?: number;
  /** 'auto' (default) shows it with ?perf=1 or the key combo. */
  meter?: boolean | 'auto' | { position?: MeterPosition; keys?: string[]; visible?: boolean };
  /** Publish window.firelab. Default true. */
  hook?: boolean;
  /** Pause measurement while any <video> plays. Default false. */
  pauseWhileVideo?: boolean;
  /** A three.js renderer, Babylon engine, Pixi app, canvas, or an adapter. */
  renderer?: ThreeRendererLike | BabylonEngineLike | PixiAppLike | HTMLCanvasElement | RenderAdapter;
  adapter?: RenderAdapter;
  /** The simplest adapter: a callback. */
  setScale?(scale: number, info: ScaleInfo): void;
  canvas?: HTMLCanvasElement;
  tiers?: Partial<Record<TierId, TierOverrides>>;
  /** Skip detection (e.g. you already ran detectDevice()). */
  detection?: Detection;
  /** Count requestAnimationFrame callbacks until perf.frame() is called. Default true. */
  autoFrames?: boolean;
  /** How often the hook and the meter refresh. Default 250 ms. */
  updateMs?: number;
  env?: Partial<PerfEnv>;
}

export interface PerfEvents {
  scale: { scale: number; prev: number; reason: ScaleReason; info: ScaleInfo | null };
  tier: { tier: TierId; prev: TierId; source: TierSource };
  fallback: { from: TierId; to: TierId; fps: number; persisted: boolean };
  sample: FirelabHook;
  window: WindowResult;
  pause: { paused: boolean; reasons: string[] };
}

export interface Perf {
  /** Current tier. */
  readonly tier: TierId;
  /** What chip detection picked. */
  readonly autoTier: TierId;
  /** Where the current tier came from. */
  readonly source: TierSource;
  readonly detection: Detection;
  readonly targetFps: number;
  /** The current tier's preset merged with your overrides. */
  readonly preset: TierPreset & TierOverrides;
  /** Current render scale (share of the tier's resolution budget). */
  readonly scale: number;
  /** The pixel ratio and buffer size the last scale produced. */
  readonly scaleInfo: ScaleInfo | null;
  readonly paused: boolean;
  /** The live window.firelab object. */
  readonly hook: FirelabHook;
  readonly meter: { show(): void; hide(): void; toggle(): boolean; readonly visible: boolean };
  /** The value for the current tier from a partial map (nearest lighter tier wins). */
  pick<T>(map: Partial<Record<TierId, T>>): T | undefined;
  /** Call once per rendered frame. Stops the built-in requestAnimationFrame counting. */
  frame(now?: number): void;
  /** Start sending render scales to a renderer (three.js, Babylon, Pixi, canvas, or { setScale }). */
  attach(target: unknown): Perf;
  detach(): void;
  /** Pause measurement (reasons stack). */
  pause(reason?: string): void;
  resume(reason?: string): void;
  /** Expose app state on window.firelab.marks; undefined removes it. */
  mark(key: string, value: string | number | boolean | null | undefined): void;
  /** Report draw calls / triangles yourself. */
  report(stats: { drawCalls?: number; triangles?: number }): void;
  /** Switch tier at run time; 'auto' clears the saved choice. */
  setTier(tier: TierId | 'auto', opts?: { persist?: boolean; reload?: boolean }): TierId;
  /** Forget a stored automatic fallback. */
  clearFallback(): void;
  on<K extends keyof PerfEvents>(type: K, fn: (payload: PerfEvents[K]) => void): () => void;
  /** A JSON copy of window.firelab right now. */
  snapshot(): FirelabHook;
  adaptiveState(): AdaptiveState | null;
  destroy(): void;
}

export function createPerf(options?: PerfOptions): Perf;
