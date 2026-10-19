import zlib from 'node:zlib';
import type { Adb } from './client.js';
import { FireLabError } from '../lib/errors.js';
import { PNG_SIGNATURE, crc32, decodePng, encodePng, pngChunks, pngSize, type Rgba } from './png.js';
import { encodeJpeg, resizeRgba } from './image.js';

/**
 * Finds the PNG inside `screencap -p` output.
 *
 * Some Fire OS builds print warnings before the image (e.g. "WARNING: linker:
 * ..." or SurfaceFlinger notices) and old adb/shell paths turn "\n" into
 * "\r\n". Both corrupt the file for naive callers. This strips everything
 * before the PNG signature and after IEND, undoes CRLF translation when the
 * signature shows it, and checks the header so a broken capture fails loudly.
 */
export function extractPng(buf: Buffer): Buffer {
  let start = buf.indexOf(PNG_SIGNATURE);
  let data = buf;
  if (start < 0) {
    // "\x89PNG\r\r\n\x1a\r\n": every \n was written as \r\n.
    const crlfSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0d, 0x0a, 0x1a, 0x0d, 0x0a]);
    const s = buf.indexOf(crlfSig);
    if (s < 0) {
      const head = buf.subarray(0, 160).toString('utf8').replace(/[^\x20-\x7e\n]/g, '').trim();
      throw new FireLabError('adb-failed', `screencap returned no PNG${head ? `: "${head.slice(0, 120)}"` : ' (empty output)'}`, {
        hint: 'The screen may be protected (DRM video), or the device is asleep: wake it and retry',
      });
    }
    data = undoCrlf(buf.subarray(s));
    start = 0;
  }
  const png = data.subarray(start);
  pngSize(png); // throws if IHDR isn't first
  const ihdrCrc = png.readUInt32BE(8 + 8 + 13);
  if (crc32(png, 12, 12 + 4 + 13) !== ihdrCrc) throw new FireLabError('adb-failed', 'screencap PNG header is corrupt (CRC mismatch)');
  let end = -1;
  for (const c of pngChunks(png)) if (c.type === 'IEND') end = c.offset + 12;
  if (end < 0) throw new FireLabError('adb-failed', 'screencap PNG is truncated (no IEND)');
  return png.subarray(0, end);
}

function undoCrlf(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[j++] = buf[i] as number;
  }
  return out.subarray(0, j);
}

/** PixelFormat ids `screencap` writes in its raw header. */
const RAW_FORMATS: Record<number, { bpp: number; name: string }> = {
  1: { bpp: 4, name: 'RGBA_8888' },
  2: { bpp: 4, name: 'RGBX_8888' },
  3: { bpp: 3, name: 'RGB_888' },
  4: { bpp: 2, name: 'RGB_565' },
  5: { bpp: 4, name: 'BGRA_8888' },
};

/**
 * Parses raw `screencap` output: a 12-byte (Android <= 8: width, height,
 * format) or 16-byte (Android 9+: plus color space) header, then pixels.
 */
export function parseRawScreencap(buf: Buffer): Rgba {
  for (const headerLen of [16, 12]) {
    if (buf.length < headerLen) continue;
    const width = buf.readUInt32LE(0);
    const height = buf.readUInt32LE(4);
    const format = buf.readUInt32LE(8);
    const f = RAW_FORMATS[format];
    if (!f || width < 1 || height < 1 || width > 8192 || height > 8192) continue;
    const need = headerLen + width * height * f.bpp;
    if (buf.length < need || buf.length - need > 4096) continue;
    const px = buf.subarray(headerLen, need);
    const out = new Uint8Array(width * height * 4);
    const n = width * height;
    if (format === 1 || format === 2) {
      out.set(px);
      if (format === 2) for (let i = 3; i < out.length; i += 4) out[i] = 255;
    } else if (format === 5) {
      for (let i = 0; i < n; i++) {
        out[i * 4] = px[i * 4 + 2] as number;
        out[i * 4 + 1] = px[i * 4 + 1] as number;
        out[i * 4 + 2] = px[i * 4] as number;
        out[i * 4 + 3] = px[i * 4 + 3] as number;
      }
    } else if (format === 3) {
      for (let i = 0; i < n; i++) {
        out[i * 4] = px[i * 3] as number;
        out[i * 4 + 1] = px[i * 3 + 1] as number;
        out[i * 4 + 2] = px[i * 3 + 2] as number;
        out[i * 4 + 3] = 255;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = px.readUInt16LE(i * 2);
        out[i * 4] = ((v >> 11) & 31) * 255 / 31;
        out[i * 4 + 1] = ((v >> 5) & 63) * 255 / 63;
        out[i * 4 + 2] = (v & 31) * 255 / 31;
        out[i * 4 + 3] = 255;
      }
    }
    return { width, height, data: out };
  }
  throw new FireLabError('adb-failed', `Raw screencap output has an unexpected size (${buf.length} bytes)`);
}

/** Strips text before a gzip stream (stderr noise) and inflates it. */
export function gunzipAfterJunk(buf: Buffer): Buffer {
  const start = buf.indexOf(Buffer.from([0x1f, 0x8b, 0x08]));
  if (start < 0) throw new FireLabError('adb-failed', 'No gzip data in screencap output');
  return zlib.gunzipSync(buf.subarray(start));
}

export type ScreenMethod = 'auto' | 'png' | 'raw';

export type Screen = {
  width: number;
  height: number;
  method: 'png' | 'raw-gzip';
  /** Capture time, ms. */
  ms: number;
  png?: Buffer;
  rgba?: Rgba;
};

const gzipWorks = new Map<string, boolean>();

/**
 * Captures the screen. 'png' is `exec-out screencap -p`; 'raw' pipes the raw
 * framebuffer through the device's gzip, which skips the slow on-device PNG
 * encoder (2.5 s -> 1.1 s for 1080p on a Fire TV Stick 4K Plus). 'auto' tries
 * raw first and remembers per device if it doesn't work.
 */
export async function captureScreen(adb: Adb, serial: string, method: ScreenMethod = 'auto'): Promise<Screen> {
  const t0 = Date.now();
  if (method !== 'png' && gzipWorks.get(serial) !== false) {
    try {
      const out = await adb.execOut(serial, 'screencap 2>/dev/null | gzip -1', { timeoutMs: 20000 });
      const rgba = parseRawScreencap(gunzipAfterJunk(out));
      gzipWorks.set(serial, true);
      return { width: rgba.width, height: rgba.height, method: 'raw-gzip', ms: Date.now() - t0, rgba };
    } catch (e) {
      if (method === 'raw') throw e;
      if (e instanceof FireLabError && (e.code === 'offline' || e.code === 'device-not-found' || e.code === 'unauthorized' || e.code === 'timeout')) throw e;
      gzipWorks.set(serial, false);
    }
  }
  const png = extractPng(await adb.execOut(serial, 'screencap -p', { timeoutMs: 20000 }));
  const { width, height } = pngSize(png);
  return { width, height, method: 'png', ms: Date.now() - t0, png };
}

export function screenRgba(s: Screen): Rgba {
  if (s.rgba) return s.rgba;
  if (s.png) return decodePng(s.png);
  throw new FireLabError('adb-failed', 'Empty screen capture');
}

export function screenPng(s: Screen): Buffer {
  return s.png ?? encodePng(screenRgba(s));
}

/** Downscaled JPEG for agents and the dashboard (default 960 px wide, quality 70). */
export function screenJpeg(s: Screen, opts: { width?: number; quality?: number } = {}): Buffer {
  const width = Math.max(64, Math.min(opts.width ?? 960, 3840));
  return encodeJpeg(resizeRgba(screenRgba(s), width), opts.quality ?? 70);
}
