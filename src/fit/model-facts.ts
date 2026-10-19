/**
 * Per-model facts that src/adb/models.ts doesn't carry: CPU ABIs, video
 * decoders and the WebView generation. All estimated from the SoC unless a
 * device profile measured them; correct them by sending a profile.
 */
import type { DecoderLimit } from '../profile/types.js';

/** Fire OS major -> Android API level (Fire OS 5 = Android 5.1, 6 = 7.1, 7 = 9, 8 = 11). */
export const FIRE_OS_SDK: Readonly<Record<number, { sdk: number; android: string }>> = {
  5: { sdk: 22, android: '5.1' },
  6: { sdk: 25, android: '7.1' },
  7: { sdk: 28, android: '9' },
  8: { sdk: 30, android: '11' },
};

/** Models that run a 64-bit (arm64-v8a) userspace. Everything else on Fire OS is 32-bit ARM. */
export const ARM64_MODELS = new Set(['AFTS', 'AFTR', 'AFTGAZL']);
export const ABIS_32 = ['armeabi-v7a', 'armeabi'];
export const ABIS_64 = ['arm64-v8a', 'armeabi-v7a', 'armeabi'];

const AVC = ['baseline', 'main', 'high'];
const HEVC = ['main', 'main10'];
const VP9 = ['profile0', 'profile2'];
const dec = (codec: DecoderLimit['codec'], supported: boolean | null, w?: number, h?: number, fps?: number, profiles?: string[], maxLevel?: string): DecoderLimit => {
  const d: DecoderLimit = { codec, supported };
  if (supported) {
    if (w) d.maxWidth = w;
    if (h) d.maxHeight = h;
    if (fps) d.maxFps = fps;
    if (profiles) d.profiles = profiles;
    if (maxLevel) d.maxLevel = maxLevel;
  }
  return d;
};

const HD_STICK: DecoderLimit[] = [dec('avc', true, 1920, 1080, 60, AVC, '4.2'), dec('hevc', true, 1920, 1080, 60, HEVC, '4.1'), dec('vp9', true, 1920, 1080, 60, VP9, '4.1'), dec('av1', null)];
const UHD_MT8696: DecoderLimit[] = [dec('avc', true, 3840, 2160, 30, AVC, '5.1'), dec('hevc', true, 3840, 2160, 60, HEVC, '5.1'), dec('vp9', true, 3840, 2160, 60, VP9, '5.1'), dec('av1', true, 3840, 2160, 60, ['main'], '5.1')];
const UHD_NO_AV1: DecoderLimit[] = [dec('avc', true, 3840, 2160, 30, AVC, '5.1'), dec('hevc', true, 3840, 2160, 60, HEVC, '5.1'), dec('vp9', true, 3840, 2160, 60, VP9, '5.1'), dec('av1', false)];
const UHD_TV: DecoderLimit[] = [dec('avc', true, 3840, 2160, 30, AVC, '5.1'), dec('hevc', true, 3840, 2160, 60, HEVC, '5.1'), dec('vp9', true, 3840, 2160, 60, VP9, '5.1'), dec('av1', null)];
const HD_TV: DecoderLimit[] = [dec('avc', true, 1920, 1080, 60, AVC, '4.2'), dec('hevc', true, 1920, 1080, 60, HEVC, '4.1'), dec('vp9', null), dec('av1', null)];

/** Estimated hardware decoders per model (Amazon's spec pages plus the SoC's datasheet). */
export const DECODERS: Readonly<Record<string, DecoderLimit[]>> = {
  AFTSSS: HD_STICK,
  AFTSS: HD_STICK,
  AFTMM: UHD_NO_AV1,
  AFTKA: UHD_MT8696,
  AFTKM: UHD_MT8696,
  AFTKRT: UHD_MT8696,
  AFTMA08C15: UHD_MT8696,
  AFTT: [dec('avc', true, 1920, 1080, 60, AVC, '4.2'), dec('hevc', true, 1920, 1080, 30, ['main'], '4.1'), dec('vp9', false), dec('av1', false)],
  AFTM: [dec('avc', true, 1920, 1080, 30, AVC, '4.1'), dec('hevc', false), dec('vp9', false), dec('av1', false)],
  AFTB: [dec('avc', true, 1920, 1080, 60, AVC, '4.2'), dec('hevc', false), dec('vp9', false), dec('av1', false)],
  AFTS: [dec('avc', true, 3840, 2160, 30, AVC, '5.1'), dec('hevc', true, 3840, 2160, 60, ['main'], '5.1'), dec('vp9', null), dec('av1', false)],
  AFTN: UHD_NO_AV1,
  AFTA: UHD_NO_AV1,
  AFTR: UHD_NO_AV1,
  AFTGAZL: UHD_MT8696,
};

/** True when the decoders come from DECODERS (a known SoC), not a guess for the class of device. */
export const hasModelDecoders = (model: string): boolean => model in DECODERS;

export function estimatedDecoders(model: string, name: string, kind: string): DecoderLimit[] {
  const known = DECODERS[model];
  if (known) return known;
  if (kind === 'tv') return /\b4K\b|UHD|OLED|QLED|Omni|Ember|4-Series/i.test(name) ? UHD_TV : HD_TV;
  return UHD_TV;
}

/**
 * The WebView major version a model most likely runs. Fire OS 7 and 8 get
 * Amazon WebView updates through the Appstore (138 measured on a Fire TV
 * Stick 3rd gen, Oct 2026); Fire OS 5 and 6 builds are frozen on older,
 * unrecorded versions.
 */
export function estimatedWebViewMajor(fireOsMajor: number | undefined): number | undefined {
  return fireOsMajor !== undefined && fireOsMajor >= 7 ? 138 : undefined;
}

/** The UI resolution the WebView renders at (Fire OS draws its UI at 1080p even on 4K sticks; HD TVs use 720p). */
export function estimatedDisplay(name: string, kind: string): { width: number; height: number } {
  if (kind === 'tv' && /\bHD\b/.test(name) && !/FHD|4K|UHD/.test(name)) return { width: 1280, height: 720 };
  return { width: 1920, height: 1080 };
}
