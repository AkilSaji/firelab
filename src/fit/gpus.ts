/**
 * GPU families on Fire OS devices: relative speed and what WebGL they offer.
 *
 * Speed factors are relative to the PowerVR GE8300 (Fire TV Stick 3rd gen,
 * Fire TV Stick Lite) = 1.0. Only the GE8300 baseline and the GE9215 factor
 * come from measurements (Sunset Villa, a three.js game, on AFTSSS and
 * AFTMA08C15). Everything marked `estimated` is derived from core counts,
 * clocks and published fill rates; treat it as a starting point and send a
 * measured profile (`firelab profile`) to replace it.
 *
 * WebGL capabilities here are what the GPU family allows; a device profile
 * with measured values always wins.
 */
import type { FactSource } from '../profile/types.js';

export type GpuFamily = {
  id: string;
  match: RegExp;
  family: string;
  /** Relative GPU speed (GE8300 = 1.0). */
  factor: number;
  /** Measured spread, when known. */
  range?: [number, number];
  source: Extract<FactSource, 'measured' | 'estimated'>;
  why: string;
  /** Highest OpenGL ES version the hardware supports (2, 3, 3.1, 3.2). */
  glEs: number;
  /** WebGL2 in the Amazon WebView: false = impossible (ES 2 hardware); null = depends on the WebView's GPU blocklist. */
  webgl2: boolean | null;
  maxTextureSize?: number;
  /** Compressed texture families the hardware decodes. */
  compressed: string[];
};

export const GPU_FAMILIES: readonly GpuFamily[] = [
  {
    id: 'ge8300',
    match: /GE8300/i,
    family: 'PowerVR Rogue GE8300',
    factor: 1,
    source: 'measured',
    why: 'Baseline. Sunset Villa (three.js) at tier tv: 27 fps standing, 24 walking at 768x432 on a Fire TV Stick (3rd gen).',
    glEs: 3.2,
    webgl2: true,
    maxTextureSize: 8192,
    compressed: ['etc1', 'etc2', 'astc', 'pvrtc'],
  },
  {
    id: 'ge9215',
    match: /GE9215/i,
    family: 'PowerVR Rogue GE9215',
    factor: 2.2,
    range: [2, 2.3],
    source: 'measured',
    why: 'Sunset Villa runs tier tv-hd at 25-30 fps walking (up to 1080p) on a Fire TV Stick 4K Plus, against tier tv at 24-27 fps (768x432) on the GE8300: 2-2.3x the GE8300 in our measurements.',
    glEs: 3.2,
    webgl2: true,
    maxTextureSize: 8192,
    compressed: ['etc1', 'etc2', 'astc', 'pvrtc'],
  },
  {
    id: 'ge9xxx',
    match: /GE9\d{3}/i,
    family: 'PowerVR Rogue GE9xxx',
    factor: 2,
    source: 'estimated',
    why: 'Same 9XE family as the GE9215.',
    glEs: 3.2,
    webgl2: true,
    compressed: ['etc1', 'etc2', 'astc', 'pvrtc'],
  },
  {
    id: 'ge83xx',
    match: /GE8[2-4]\d\d/i,
    family: 'PowerVR Rogue GE8320 / GE8322',
    factor: 1.1,
    source: 'estimated',
    why: 'Same 8XE family as the GE8300 with a slightly higher clock.',
    glEs: 3.2,
    webgl2: true,
    compressed: ['etc1', 'etc2', 'astc', 'pvrtc'],
  },
  {
    id: 'ge8100',
    match: /GE8100/i,
    family: 'PowerVR Rogue GE8100',
    factor: 0.5,
    source: 'estimated',
    why: 'Half the pixel pipelines of a GE8300.',
    glEs: 3.2,
    webgl2: true,
    compressed: ['etc1', 'etc2', 'astc', 'pvrtc'],
  },
  {
    id: 'gx6250',
    match: /GX6250/i,
    family: 'PowerVR Rogue GX6250',
    factor: 1.2,
    source: 'estimated',
    why: 'Two Series6XT clusters at 700 MHz (Fire TV 2nd gen, 2015); an old driver and Fire OS 5 WebView hold it back.',
    glEs: 3.1,
    webgl2: null,
    compressed: ['etc1', 'etc2', 'pvrtc'],
  },
  {
    id: 'mali-g52-big',
    match: /Mali-?G52 ?MP[6-9]/i,
    family: 'Mali-G52 MP6-MP8',
    factor: 3.5,
    source: 'estimated',
    why: 'Six to eight Bifrost cores (Fire TV Cube 2nd/3rd gen class).',
    glEs: 3.2,
    webgl2: true,
    maxTextureSize: 8192,
    compressed: ['etc1', 'etc2', 'astc'],
  },
  {
    id: 'mali-g52-mp2',
    match: /Mali-?G52 ?MP2/i,
    family: 'Mali-G52 MP2',
    factor: 2,
    source: 'estimated',
    why: 'Two Bifrost cores with two execution engines each.',
    glEs: 3.2,
    webgl2: true,
    maxTextureSize: 8192,
    compressed: ['etc1', 'etc2', 'astc'],
  },
  {
    id: 'mali-g52-1',
    match: /Mali-?G52/i,
    family: 'Mali-G52 MC1 / MP1 / 2EE',
    factor: 1.3,
    source: 'estimated',
    why: 'One Bifrost core: smart-TV class, rendering a 4K panel at 1080p.',
    glEs: 3.2,
    webgl2: true,
    maxTextureSize: 8192,
    compressed: ['etc1', 'etc2', 'astc'],
  },
  {
    id: 'mali-g57',
    match: /Mali-?G57/i,
    family: 'Mali-G57 MC1',
    factor: 1.5,
    source: 'estimated',
    why: 'One Valhall core, about 1.2x a single-core G52.',
    glEs: 3.2,
    webgl2: true,
    maxTextureSize: 8192,
    compressed: ['etc1', 'etc2', 'astc'],
  },
  {
    id: 'mali-g310',
    match: /Mali-?G310/i,
    family: 'Mali-G310',
    factor: 1.6,
    source: 'estimated',
    why: 'Entry Valhall (Vega OS sticks; not covered by fit).',
    glEs: 3.2,
    webgl2: true,
    compressed: ['etc1', 'etc2', 'astc'],
  },
  {
    id: 'mali-g31',
    match: /Mali-?G31/i,
    family: 'Mali-G31 MP2',
    factor: 0.9,
    source: 'estimated',
    why: 'Entry Bifrost, about GE8300 speed (same tier in @firelab/perf).',
    glEs: 3.2,
    webgl2: true,
    maxTextureSize: 8192,
    compressed: ['etc1', 'etc2', 'astc'],
  },
  {
    id: 'mali-t820',
    match: /Mali-?T8[23]0/i,
    family: 'Mali-T820 / T830',
    factor: 0.6,
    source: 'estimated',
    why: 'Midgard in 2017-2018 TVs: Mali-450-class fill rate with ES 3.2 features.',
    glEs: 3.2,
    webgl2: true,
    maxTextureSize: 8192,
    compressed: ['etc1', 'etc2', 'astc'],
  },
  {
    id: 'mali-470',
    match: /Mali-?470/i,
    family: 'Mali-470 MP3',
    factor: 0.4,
    source: 'estimated',
    why: 'Utgard (OpenGL ES 2 only): no WebGL2.',
    glEs: 2,
    webgl2: false,
    maxTextureSize: 4096,
    compressed: ['etc1'],
  },
  {
    id: 'mali-450-mp4',
    match: /Mali-?450 ?MP4/i,
    family: 'Mali-450 MP4',
    factor: 0.45,
    source: 'estimated',
    why: 'Utgard (OpenGL ES 2 only): no WebGL2.',
    glEs: 2,
    webgl2: false,
    maxTextureSize: 4096,
    compressed: ['etc1'],
  },
  {
    id: 'mali-450',
    match: /Mali-?450/i,
    family: 'Mali-450 MP3',
    factor: 0.35,
    source: 'estimated',
    why: 'Utgard (OpenGL ES 2 only): no WebGL2.',
    glEs: 2,
    webgl2: false,
    maxTextureSize: 4096,
    compressed: ['etc1'],
  },
  {
    id: 'adreno-320',
    match: /Adreno.{0,12}3[0-3]\d/i,
    family: 'Adreno 320',
    factor: 0.6,
    source: 'estimated',
    why: '2013 Snapdragon 600 GPU (Fire TV 1st gen); Chromium often blocklists WebGL2 on Adreno 3xx drivers.',
    glEs: 3,
    webgl2: null,
    compressed: ['etc1', 'etc2', 'atc'],
  },
  {
    id: 'videocore-iv',
    match: /VideoCore/i,
    family: 'Broadcom VideoCore IV',
    factor: 0.2,
    source: 'estimated',
    why: 'OpenGL ES 2 only, very little fill rate (Fire TV Stick 1st gen).',
    glEs: 2,
    webgl2: false,
    maxTextureSize: 2048,
    compressed: ['etc1'],
  },
];

export function gpuFamily(gpu: string | undefined | null): GpuFamily | undefined {
  if (!gpu) return undefined;
  return GPU_FAMILIES.find((g) => g.match.test(gpu));
}

/**
 * CPU speed per model, relative to the Fire TV Stick (3rd gen)'s 4x Cortex-A35
 * at 1.7 GHz = 1.0 (its clock, 1.69 GHz, is measured; the ratios are
 * estimates from core type and clock). Used for CPU throttling in
 * simulations, where the rate = owned device / target.
 */
export const CPU_FACTORS: Readonly<Record<string, { factor: number; cpu: string }>> = {
  AFTSSS: { factor: 1, cpu: '4x Cortex-A35 @ 1.7 GHz (MT8695D)' },
  AFTSS: { factor: 1, cpu: '4x Cortex-A35 @ 1.7 GHz (MT8695D)' },
  AFTMM: { factor: 1.25, cpu: '4x Cortex-A53 @ 1.7 GHz (MT8695)' },
  AFTKA: { factor: 1.5, cpu: '4x Cortex-A55 @ 1.8 GHz (MT8696)' },
  AFTKM: { factor: 1.6, cpu: '4x Cortex-A55 @ 1.7-2.0 GHz (MT8696T)' },
  AFTKRT: { factor: 1.7, cpu: '4x Cortex-A55 @ 2.0 GHz (MT8696T)' },
  AFTMA08C15: { factor: 1.6, cpu: '4x Cortex-A55 (mt8696)' },
  AFTT: { factor: 0.45, cpu: '4x Cortex-A7 @ 1.3 GHz (MT8127)' },
  AFTM: { factor: 0.3, cpu: '2x Cortex-A9 @ 1 GHz (BCM28155)' },
  AFTB: { factor: 0.9, cpu: '4x Krait 300 @ 1.7 GHz (Snapdragon 600)' },
  AFTS: { factor: 1.8, cpu: '2x Cortex-A72 + 2x Cortex-A53 (MT8173)' },
  AFTN: { factor: 1.1, cpu: '4x Cortex-A53 @ 1.5 GHz (Amlogic S905Z)' },
  AFTA: { factor: 1.1, cpu: '4x Cortex-A53 @ 1.5 GHz (Amlogic S905Z)' },
  AFTR: { factor: 2.8, cpu: '4x Cortex-A73 @ 2.2 GHz + 2x Cortex-A53 (Amlogic S922Z)' },
  AFTGAZL: { factor: 3, cpu: '4x Cortex-A73 @ 2.2 GHz + 4x Cortex-A53 (Amlogic POP1-G)' },
};
/** Smart TVs without a row above: typical 4x Cortex-A53/A55 TV SoC. */
export const DEFAULT_TV_CPU = { factor: 1.2, cpu: 'typical 4x Cortex-A53/A55 TV SoC' };
