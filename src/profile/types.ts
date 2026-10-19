/**
 * Device profiles: what one Fire TV model really has, field by field, with
 * where each number came from. Stored as profiles/<MODEL>.json (see
 * profiles/README.md and profiles/schema.json).
 */

/**
 * Where a value came from:
 * - `measured`: read from a real device (getprop, /proc/meminfo, WebGL, dumpsys, a real app run).
 * - `spec`: Amazon's published device specifications.
 * - `estimated`: derived (from the chip family, a sibling model, or a formula).
 * - `unknown`: nobody has measured it yet (`value` is null).
 */
export type FactSource = 'measured' | 'spec' | 'estimated' | 'unknown';
export const FACT_SOURCES: readonly FactSource[] = ['measured', 'spec', 'estimated', 'unknown'];

export type Fact<T> = { value: T | null; source: FactSource; note?: string };

export const fact = <T>(value: T | null | undefined, source: FactSource, note?: string): Fact<T> =>
  value === null || value === undefined ? { value: null, source: 'unknown', ...(note ? { note } : {}) } : { value, source, ...(note ? { note } : {}) };
export const unknown = <T>(note?: string): Fact<T> => ({ value: null, source: 'unknown', ...(note ? { note } : {}) });
/** The value when known, else undefined. */
export const val = <T>(f: Fact<T> | undefined): T | undefined => (f && f.source !== 'unknown' && f.value !== null ? f.value : undefined);

export type VideoCodec = 'avc' | 'hevc' | 'vp9' | 'av1';
export const VIDEO_CODECS: readonly VideoCodec[] = ['avc', 'hevc', 'vp9', 'av1'];

/** One hardware video decoder (or the absence of one). */
export type DecoderLimit = {
  codec: VideoCodec;
  /** false = no decoder for this codec; null = not known. */
  supported: boolean | null;
  maxWidth?: number;
  maxHeight?: number;
  /** Highest frame rate at maxWidth x maxHeight. */
  maxFps?: number;
  /** Lower-case profile names: avc baseline/main/high; hevc main/main10; vp9 profile0/profile2; av1 main. */
  profiles?: string[];
  /** Highest level, e.g. "4.2" (H.264), "5.1" (HEVC/VP9/AV1). */
  maxLevel?: string;
};

/** A real app measured on this model, kept as a reference point. Ranges are [low, high]. */
export type ProfileReference = {
  app: string;
  scene?: string;
  tier?: string;
  resolution?: string;
  fps?: number | [number, number];
  appPssMB?: number | [number, number];
  rendererPssMB?: number | [number, number];
  memAvailableMB?: number | [number, number];
  drawCalls?: number;
  triangles?: number;
  date?: string;
  note?: string;
};

export type DeviceProfile = {
  $schema?: string;
  schemaVersion: 1;
  /** ro.product.model, e.g. "AFTSSS". */
  model: string;
  name: string;
  /** `measured` = written by `firelab profile`; `manual` = entered by hand from measurements (each field says its source). */
  source: 'measured' | 'manual';
  /** ISO 8601 date or date-time. */
  capturedAt: string;
  firelabVersion: string;
  os: {
    /** e.g. "7.7.1.7" */
    fireOs: Fact<string>;
    /** e.g. "9" */
    android: Fact<string>;
    sdk: Fact<number>;
    build?: Fact<string>;
  };
  cpu: {
    abis: Fact<string[]>;
    soc?: Fact<string>;
    cores?: Fact<number>;
    maxGHz?: Fact<number>;
  };
  memory: {
    /** MemTotal: what Android can use after the GPU/video carve-outs. */
    totalMB: Fact<number>;
    /** MemAvailable on the Home screen. */
    availIdleMB: Fact<number>;
    /** MemAvailable with a blank WebView page open (what a web app has left to grow into). */
    availWebViewMB: Fact<number>;
    /** The largest app + WebView renderer PSS seen running fine on this model. */
    knownGoodMB?: Fact<number>;
    /** The lowest MemAvailable seen while running at knownGoodMB. */
    lowestAvailMB?: Fact<number>;
    /** App + renderer PSS that runs comfortably (leaves about 100 MB available). */
    appBudgetMB: Fact<number>;
    /** Beyond this the low-memory killer or a WebView renderer crash is likely. */
    appLimitMB: Fact<number>;
    lowRam?: Fact<boolean>;
  };
  gpu: {
    renderer: Fact<string>;
    vendor?: Fact<string>;
    /** Relative GPU speed, PowerVR GE8300 = 1.0 (see docs/FIT.md). */
    speedFactor: Fact<number>;
  };
  webgl: {
    webgl1: Fact<boolean>;
    webgl2: Fact<boolean>;
    maxTextureSize: Fact<number>;
    maxRenderbufferSize: Fact<number>;
    /** Supported WebGL extensions (WebGL2 context when available). */
    extensions: Fact<string[]>;
    /** Compressed texture families: etc1, etc2, astc, s3tc, pvrtc, bptc, rgtc, atc. */
    compressed: Fact<string[]>;
    /** Can render to float/half-float color buffers (EXT_color_buffer_float / _half_float). */
    floatRender?: Fact<boolean>;
    /** mediump float is a real 16-bit float (precision artifacts in shaders that assume more). */
    mediumpFp16?: Fact<boolean>;
  };
  webview: {
    /** e.g. "138.0.7204.amazon-webview-v138-7204-tv" */
    version: Fact<string>;
    major: Fact<number>;
    package?: Fact<string>;
  };
  media: {
    decoders: Fact<DecoderLimit[]>;
    /** Streaming over the device's Wi-Fi: bitrates seen to play smoothly and to stall. */
    streamOkMbps?: Fact<number>;
    streamStallMbps?: Fact<number>;
    /** HTMLMediaElement.canPlayType answers, by MIME string. */
    canPlay?: Fact<Record<string, string>>;
  };
  display: {
    width: Fact<number>;
    height: Fact<number>;
    density?: Fact<number>;
  };
  references?: ProfileReference[];
  notes?: string[];
};
