import type { ApkInfo } from '../adb/apk.js';
import type { Fact, DecoderLimit } from '../profile/types.js';
import type { WebCaps } from '../profile/webcaps.js';
import type { MediaInfo } from '../media/types.js';

export type Verdict = 'runs' | 'risky' | 'wont-run' | 'not-covered';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
/** measured = on this very model, now; profile = from profiles/<MODEL>.json; estimated = tables, scaling or simulation. */
export type Basis = 'measured' | 'profile' | 'estimated';
export type Confidence = 'high' | 'medium' | 'low';
export type CheckId = 'abi' | 'sdk' | 'features' | 'leanback' | 'gles' | 'webgl' | 'memory' | 'frames' | 'pressure' | 'media';

// ---------- inputs ----------

export type ManifestFeature = { name: string; required: boolean };

/** What `fit` needs from an APK (readApk plus the manifest's uses-feature entries). */
export type ApkFacts = ApkInfo & {
  file?: string;
  sizeBytes?: number;
  features: ManifestFeature[];
  /** Required OpenGL ES version from <uses-feature android:glEsVersion>, e.g. 3.1. */
  glEsVersion?: number;
};

export type NeedSource = 'flag' | 'page' | 'inferred' | 'detected';

/**
 * What a web app needs. From `--needs`, from `window.firelab.needs` (the page
 * declares it), inferred with certainty (three.js r163+ needs WebGL2) or
 * detected from what the page did (soft: it may have a fallback).
 */
export type WebNeeds = {
  /** Minimum WebGL version. */
  webgl?: 1 | 2;
  /** WebGL extensions the app cannot run without. */
  extensions?: string[];
  /** Compressed texture families the app uploads (any one available is enough). */
  compressed?: string[];
  maxTextureSize?: number;
  maxRenderbufferSize?: number;
  /** Renders to float / half-float color buffers. */
  floatRender?: boolean;
  /** Minimum WebView (Chromium) major version. */
  minWebView?: number;
  /** Web platform features: wasm, wasm-simd, wasm-threads, offscreen-canvas, webgpu, shared-array-buffer, web-audio, gamepad. */
  features?: string[];
  /** Where each need came from. */
  sources?: Partial<Record<Exclude<keyof WebNeeds, 'sources' | 'notes'>, NeedSource>>;
  notes?: string[];
};

export type FitDeviceInfo = {
  id?: string;
  model?: string;
  name?: string;
  gpu?: string;
  sdk?: number;
  os?: string;
  abis?: string[];
  ramMB?: number;
  resolution?: { width: number; height: number };
  webviewMajor?: number;
};

export type FrameStats = {
  fpsMedian: number;
  fpsP10: number;
  frameMsP50: number;
  frameMsP95: number;
  samples: number;
  /** page = window.firelab, raf = injected probe, expr = app meter, surface = SurfaceFlinger. */
  source: string;
  /** frameMs came from window.firelab (true frame times) or was derived from per-second fps. */
  frameMsFrom: 'page' | 'fps';
  /** Holding the app's frame cap: the true headroom is unknown, so scaling down is pessimistic. */
  capped: boolean;
};

export type RunMemory = {
  appPssMB?: number;
  rendererPssMB?: number;
  /** app + renderer */
  totalMB?: number;
  memAvailableMinMB?: number;
  samples: number;
};

/** One measured run on the device you own: the app as is, or at one tier, or a simulation. */
export type FitRun = {
  label: string;
  tier?: string;
  url?: string;
  seconds: number;
  canvas?: { width: number; height: number };
  scale?: number;
  frames?: FrameStats;
  memory?: RunMemory;
  cpuPct?: number;
  /** Set when this run imitates a slower model. */
  simulated?: { forModel: string; forGpu?: string; kinds: ('cpu' | 'gpu')[]; cpuRate?: number; pixelFactor?: number; scale?: number; note?: string };
  notes?: string[];
};

export type PressureResult = {
  level: string;
  outcome: 'survived' | 'reloaded' | 'crashed' | 'unknown';
  detail: string;
  memAvailableAfterMB?: number;
};

/** firelab-measurement.json: everything `fit` learned, portable, re-scorable offline. */
export type FitMeasurement = {
  kind: 'firelab-measurement';
  version: 1;
  createdAt: string;
  firelabVersion: string;
  app: { package?: string; url?: string; name?: string; apk?: ApkFacts };
  /** The device the runs were measured on. */
  device?: FitDeviceInfo;
  webCaps?: WebCaps;
  needs?: WebNeeds;
  targetFps: number;
  runs: FitRun[];
  pressure?: PressureResult;
  media: MediaInfo[];
  notes: string[];
};

// ---------- targets ----------

/** Everything fit knows about one model, each value with its source. */
export type FitTarget = {
  model: string;
  name: string;
  kind: 'stick' | 'box' | 'cube' | 'tv';
  year?: number;
  ramMB?: number;
  gpu?: string;
  platform?: string;
  fireOsMajor?: number;
  tier?: string;
  vega: boolean;
  /** The profile file used, if any. */
  profile?: { source: 'measured' | 'manual'; capturedAt: string };
  sdk: Fact<number>;
  abis: Fact<string[]>;
  glEs: Fact<number>;
  memory: { totalMB: Fact<number>; budgetMB: Fact<number>; limitMB: Fact<number> };
  speed: Fact<number>;
  cpuSpeed: Fact<number>;
  webgl: { webgl2: Fact<boolean>; maxTextureSize: Fact<number>; maxRenderbufferSize: Fact<number>; compressed: Fact<string[]>; extensions: Fact<string[]>; floatRender: Fact<boolean> };
  webviewMajor: Fact<number>;
  decoders: Fact<DecoderLimit[]>;
  streamOkMbps: Fact<number>;
  streamStallMbps: Fact<number>;
  display: { width: Fact<number>; height: Fact<number> };
  /** Names of the target fields that came from a profile (for the basis). */
  fromProfile: Set<string>;
};

// ---------- results ----------

export type CheckResult = {
  id: CheckId;
  status: CheckStatus;
  /** Short text for a matrix cell, e.g. "451 / 458 MB" or "~14 fps". */
  summary: string;
  /** Plain-English reason. */
  reason: string;
  fix?: string;
  basis: Basis;
  confidence: Confidence;
  /** The number behind it came from a simulation on a stronger device. */
  simulated?: boolean;
  data?: Record<string, unknown>;
};

export type ModelFit = {
  model: string;
  name: string;
  kind: FitTarget['kind'];
  year?: number;
  gpu?: string;
  platform?: string;
  ramMB?: number;
  tier?: string;
  verdict: Verdict;
  /** One line, e.g. "Over the memory limit: 561 MB vs 458 MB". */
  headline: string;
  reasons: string[];
  fixes: string[];
  basis: Basis;
  confidence: Confidence;
  checks: CheckResult[];
  /** This is the model the measurements were taken on. */
  measuredHere: boolean;
  profile?: FitTarget['profile'];
  memory?: { budgetMB?: number; limitMB?: number };
};

export type MediaFinding = {
  source: string;
  status: CheckStatus;
  issues: { status: CheckStatus; reason: string; fix?: string; models: string[] }[];
};

export type FitReport = {
  kind: 'firelab-fit';
  version: 1;
  createdAt: string;
  firelabVersion: string;
  app: FitMeasurement['app'];
  measuredOn?: FitDeviceInfo;
  targetFps: number;
  needs?: WebNeeds;
  /** Which kinds of evidence went in. */
  evidence: { static: boolean; web: boolean; measured: boolean; simulated: boolean; pressure: boolean; media: boolean };
  summary: {
    runs: number;
    risky: number;
    wontRun: number;
    notCovered: number;
    headline: string;
    /** The models the CI gate looks at by default (the 1 GB sticks). */
    focus: { models: string[]; verdict: Verdict; line: string };
  };
  models: ModelFit[];
  media: MediaInfo[];
  mediaFindings: MediaFinding[];
  runs: FitRun[];
  pressure?: PressureResult;
  notes: string[];
  disclaimer: string;
};

export const VERDICT_MARK: Record<Verdict, string> = { runs: '✅', risky: '⚠️', 'wont-run': '❌', 'not-covered': '–' };
export const VERDICT_LABEL: Record<Verdict, string> = { runs: 'runs', risky: 'risky', 'wont-run': "won't run", 'not-covered': 'not covered' };
export const STATUS_MARK: Record<CheckStatus, string> = { pass: '✅', warn: '⚠️', fail: '❌', skip: '–' };

/** The 1 GB Fire OS sticks most people own: the default CI gate. */
export const ONE_GB_STICKS = ['AFTSSS', 'AFTSS'];
