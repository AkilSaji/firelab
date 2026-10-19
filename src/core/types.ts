import type { Tier } from '../adb/models.js';

/** The device shape of the dashboard API (docs/CONTRACT.md), plus a few extras. */
export type Device = {
  id: string;
  ip?: string;
  state: 'device' | 'offline' | 'unauthorized' | 'connecting';
  model?: string;
  name?: string;
  os?: string;
  abi?: string;
  ramMB?: number;
  gpu?: string;
  tier?: Tier;
  resolution?: { width: number; height: number };
  /** Extras */
  transport?: 'tcp' | 'usb' | 'mdns' | 'emulator';
  gpuSource?: 'spec' | 'webgl';
  fireOs?: boolean;
};

export type SweepRequest = {
  package?: string;
  url: string;
  tiers?: string[];
  param?: string;
  warmupS?: number;
  sampleS?: number;
  action?: { keys?: string[]; eval?: string };
  targetFps?: number;
  minP10?: number;
};

export type Job = {
  id: string;
  kind: 'sweep';
  status: 'running' | 'done' | 'error';
  progress: number;
  device: string;
  rows: import('../perf/sweep.js').SweepRow[];
  recommendation?: { tier: string; reason: string };
  error?: string;
  /** Extras */
  message?: string;
  /** What the sweep is doing right now (while running). */
  current?: { tier: string; index: number; phase: 'launching' | 'warming up' | 'sampling'; fps?: number };
  /** The request as the server understood it (defaults filled in). */
  request?: { url: string; tiers: string[]; param: string; targetFps: number; package?: string; warmupS: number; sampleS: number };
  /** The pass rule the server applied to each row's `ok`. */
  criteria?: { targetFps: number; minP10: number; tolerance: number; minSamples: number };
  startedAt: number;
  endedAt?: number;
  markdown?: string;
  resultPath?: string;
};
