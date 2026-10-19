/**
 * Compares a probed video against one model's decoder limits and the
 * streaming bitrates seen to work on it.
 */
import type { DecoderLimit } from '../profile/types.js';
import type { MediaInfo } from './types.js';

export type MediaLimits = {
  name: string;
  decoders?: DecoderLimit[];
  /**
   * Where the decoder list came from: a measured profile, the per-model estimate
   * (known SoC), a generic guess for the class of device (most smart TVs), or nothing.
   */
  decodersFrom: 'measured' | 'estimated' | 'generic' | 'unknown';
  streamOkMbps?: number;
  streamStallMbps?: number;
  streamFrom?: 'measured' | 'estimated';
};

export type MediaIssue = {
  /** Stable key, so the same problem on several models groups together. */
  key: string;
  status: 'warn' | 'fail';
  /** `file` = a property of the file itself (same on every model); `model` = this model's decoder or Wi-Fi. */
  scope: 'file' | 'model';
  /** A few words for a matrix cell. */
  short: string;
  reason: string;
  fix?: string;
  confidence: 'high' | 'medium' | 'low';
};

const CODEC_NAME: Record<string, string> = { avc: 'H.264', hevc: 'HEVC (H.265)', vp9: 'VP9', av1: 'AV1' };
const mbps = (kbps: number) => Math.round(kbps / 100) / 10;
const FASTSTART_FIX = 'Move the index to the front without re-encoding: ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4';
const REENCODE_H264 = 'Re-encode at 2.5-4.5 Mbps H.264 High, e.g. ffmpeg -i in.mp4 -c:v libx264 -profile:v high -b:v 4M -maxrate 4.5M -bufsize 9M -movflags +faststart out.mp4';

/** Problems with one file on one model (empty = fine). */
export function checkMedia(info: MediaInfo, lim: MediaLimits): MediaIssue[] {
  const out: MediaIssue[] = [];
  if (info.error) return [{ key: 'unreadable', status: 'warn', scope: 'file', short: 'unreadable', reason: `Couldn't read the file: ${info.error}.`, confidence: 'high' }];
  const v = info.video;
  if (info.fastStart === false) {
    out.push({ key: 'faststart', status: 'warn', scope: 'file', short: 'moov at the end', reason: 'Not fast-start: the moov index sits after the media data, so playback waits until the player has fetched the end of the file (a full download on servers without Range support).', fix: FASTSTART_FIX, confidence: 'high' });
  }
  if (!v) return out;
  if (v.encrypted) out.push({ key: 'encrypted', status: 'warn', scope: 'file', short: 'encrypted', reason: 'The video track is encrypted (CENC): it needs a DRM license path (Widevine/PlayReady) on the device.', confidence: 'medium' });
  const codecLabel = v.codec ? (CODEC_NAME[v.codec] ?? v.codec) : v.fourcc;
  if (!v.codec) {
    out.push({ key: `codec-unknown:${v.fourcc}`, status: 'warn', scope: 'file', short: `codec ${v.fourcc}`, reason: `Video codec "${v.fourcc}" is not one Fire TV decoders are known for.`, fix: 'Encode to H.264 High (widest support) or HEVC.', confidence: 'medium' });
    return out;
  }
  const dec = lim.decoders?.find((d) => d.codec === v.codec);
  const decConf = lim.decodersFrom === 'measured' ? 'high' : lim.decodersFrom === 'generic' ? 'low' : 'medium';
  // A generic guess can't prove a file won't play: it only warns.
  const hardFail = lim.decodersFrom === 'generic' ? 'warn' : 'fail';
  if (!dec || dec.supported === null) {
    out.push({ key: `codec-unknown-support:${v.codec}`, status: 'warn', scope: 'model', short: `${codecLabel} support unknown`, reason: `Whether this model hardware-decodes ${codecLabel} isn't known yet.`, fix: v.codec === 'avc' ? undefined : `Offer an H.264 fallback, or capture this model's profile (firelab profile).`, confidence: 'low' });
  } else if (dec.supported === false) {
    out.push({ key: `codec-unsupported:${v.codec}`, status: hardFail, scope: 'model', short: `no ${codecLabel} decoder`, reason: `No hardware ${codecLabel} decoder.`, fix: 'Offer an H.264 High rendition (every Fire TV decodes it).', confidence: decConf });
  } else {
    const w = v.width ?? 0;
    const h = v.height ?? 0;
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    const tooBig = !!(dec.maxWidth && dec.maxHeight && (long > dec.maxWidth + 16 || short > dec.maxHeight + 16));
    if (tooBig && dec.maxWidth && dec.maxHeight) {
      out.push({
        key: `resolution:${v.codec}:${dec.maxWidth}x${dec.maxHeight}`,
        status: hardFail,
        scope: 'model',
        short: `${w}x${h} > ${dec.maxWidth}x${dec.maxHeight}`,
        reason: `${w}x${h} is above the ${dec.maxWidth}x${dec.maxHeight} its ${codecLabel} decoder handles.`,
        fix: `Offer a ${dec.maxHeight >= 2160 ? '4K' : '1080p'} rendition (adaptive streaming picks it per device).`,
        confidence: decConf,
      });
    } else if (dec.maxWidth && dec.maxHeight && dec.maxFps && v.fps && w && h) {
      const rate = w * h * v.fps;
      const cap = dec.maxWidth * dec.maxHeight * dec.maxFps;
      if (rate > cap * 1.05) {
        out.push({ key: `framerate:${v.codec}:${dec.maxFps}`, status: 'warn', scope: 'model', short: `${Math.round(v.fps)} fps over rating`, reason: `${Math.round(v.fps)} fps at ${w}x${h} is more than its ${codecLabel} decoder is rated for (${dec.maxWidth}x${dec.maxHeight} at ${dec.maxFps} fps).`, fix: 'Offer a 30 fps rendition.', confidence: decConf });
      }
    }
    if (dec.profiles && v.profile && !dec.profiles.includes(v.profile)) {
      const hard = v.codec === 'avc' && /high10|high422|high444|cavlc444/.test(v.profile);
      out.push({
        key: `profile:${v.codec}:${v.profile}`,
        status: hard ? hardFail : 'warn',
        scope: 'model',
        short: `${v.profile} not decoded`,
        reason: hard ? `H.264 ${v.profile} isn't hardware-decoded on TV chips (8-bit 4:2:0 only).` : `${codecLabel} profile "${v.profile}" is outside what its decoder lists (${dec.profiles.join(', ')}).`,
        fix: v.codec === 'avc' ? 'Encode 8-bit 4:2:0 H.264 High: -pix_fmt yuv420p -profile:v high' : undefined,
        confidence: decConf,
      });
    }
    // A level above the decoder's follows from a too-big picture; only report it on its own.
    if (!tooBig && dec.maxLevel && v.level && Number(v.level) > Number(dec.maxLevel) + 1e-6) {
      out.push({ key: `level:${v.codec}:${dec.maxLevel}`, status: 'warn', scope: 'model', short: `level ${v.level} > ${dec.maxLevel}`, reason: `${codecLabel} level ${v.level} is above the ${dec.maxLevel} its decoder supports.`, ...(v.codec === 'avc' ? { fix: `Re-encode with -level ${dec.maxLevel}.` } : {}), confidence: decConf });
    }
  }
  const kbps = v.bitrateKbps ?? info.bitrateKbps;
  if (kbps) {
    const rate = mbps(kbps);
    if (lim.streamStallMbps && rate >= lim.streamStallMbps * 0.95) {
      const tested = lim.streamFrom === 'measured' ? 'on this model' : 'on GE8300 sticks (same hardware)';
      out.push({
        key: 'bitrate-stall',
        status: 'warn',
        scope: 'model',
        short: `${rate} Mbps stalls`,
        reason: `${rate} Mbps average. ${lim.streamStallMbps} Mbps H.264 stalled ${tested} over Wi-Fi in our tests; ${lim.streamOkMbps ? `up to ${lim.streamOkMbps} Mbps played fine` : 'lower bitrates played fine'}.`,
        fix: REENCODE_H264,
        confidence: lim.streamFrom === 'measured' ? 'high' : 'medium',
      });
    } else if (lim.streamOkMbps && rate > lim.streamOkMbps) {
      out.push({ key: 'bitrate-high', status: 'warn', scope: 'model', short: `${rate} Mbps high`, reason: `${rate} Mbps average is above the ${lim.streamOkMbps} Mbps seen to stream smoothly over Wi-Fi on this hardware.`, fix: REENCODE_H264, confidence: 'low' });
    } else if (!lim.streamStallMbps && !lim.streamOkMbps && rate > 20) {
      out.push({ key: 'bitrate-very-high', status: 'warn', scope: 'model', short: `${rate} Mbps high`, reason: `${rate} Mbps average is a lot for Wi-Fi streaming to a TV.`, fix: 'Offer lower-bitrate renditions (adaptive streaming).', confidence: 'low' });
    }
  }
  return out;
}

/** One-line description of a file, e.g. "H.264 High 4.0, 1920x1080, 30 fps, 6.7 Mbps, 12.0 s, fast start". */
export function describeMedia(info: MediaInfo): string {
  if (info.error) return `unreadable: ${info.error}`;
  const v = info.video;
  const parts: string[] = [];
  if (v) {
    parts.push(`${v.codec ? CODEC_NAME[v.codec] : v.fourcc}${v.profile ? ` ${v.profile}` : ''}${v.level ? ` ${v.level}` : ''}`);
    if (v.width && v.height) parts.push(`${v.width}x${v.height}`);
    if (v.fps) parts.push(`${Math.round(v.fps * 100) / 100} fps`);
    if (v.bitDepth && v.bitDepth > 8) parts.push(`${v.bitDepth}-bit`);
  } else parts.push('no video track');
  const kbps = v?.bitrateKbps ?? info.bitrateKbps;
  if (kbps) parts.push(`${mbps(kbps)} Mbps`);
  if (info.durationS) parts.push(`${info.durationS.toFixed(1)} s`);
  if (info.audio) parts.push(`audio ${info.audio.fourcc}`);
  parts.push(info.fastStart === false ? 'moov at the end' : info.fastStart ? 'fast start' : 'index position unknown');
  if (info.fragmented) parts.push('fragmented');
  return parts.join(', ');
}
