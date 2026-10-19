import zlib from 'node:zlib';
import { FireLabError } from '../lib/errors.js';

/** A minimal PNG codec: enough for screenshots (8/16-bit, non-interlaced). */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type Rgba = { width: number; height: number; data: Uint8Array };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type PngChunk = { type: string; data: Buffer; offset: number };

/** Walks the chunks of a PNG (signature already checked). Stops after IEND. */
export function* pngChunks(png: Buffer): Generator<PngChunk> {
  let off = 8;
  while (off + 12 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > png.length) throw new FireLabError('adb-failed', `PNG is truncated in chunk ${type}`);
    yield { type, data: png.subarray(off + 8, off + 8 + len), offset: off };
    off += 12 + len;
    if (type === 'IEND') return;
  }
}

export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') {
    throw new FireLabError('adb-failed', 'Not a PNG');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(png: Buffer): Rgba {
  const { width, height } = pngSize(png);
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  for (const c of pngChunks(png)) {
    if (c.type === 'IHDR') {
      bitDepth = c.data[8] as number;
      colorType = c.data[9] as number;
      interlace = c.data[12] as number;
    } else if (c.type === 'PLTE') palette = c.data;
    else if (c.type === 'tRNS') trns = c.data;
    else if (c.type === 'IDAT') idat.push(c.data);
  }
  if (interlace !== 0) throw new FireLabError('unsupported', 'Interlaced PNGs are not supported');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels || ![8, 16].includes(bitDepth) || (colorType === 3 && bitDepth !== 8)) {
    throw new FireLabError('unsupported', `PNG color type ${colorType} / bit depth ${bitDepth} is not supported`);
  }
  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new FireLabError('adb-failed', 'PNG image data is truncated');
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart] as number;
    for (let i = 0; i < stride; i++) {
      const x = raw[rowStart + 1 + i] as number;
      const a = i >= bpp ? (cur[i - bpp] as number) : 0;
      const b = prev[i] as number;
      const c = i >= bpp ? (prev[i - bpp] as number) : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new FireLabError('adb-failed', `Bad PNG filter ${filter} in row ${y}`);
      }
      cur[i] = v & 255;
    }
    const o = y * width * 4;
    const step = bitDepth / 8; // 16-bit: keep the high byte
    for (let x = 0; x < width; x++) {
      const p = x * bpp;
      const q = o + x * 4;
      switch (colorType) {
        case 6:
          out[q] = cur[p] as number; out[q + 1] = cur[p + step] as number; out[q + 2] = cur[p + 2 * step] as number; out[q + 3] = cur[p + 3 * step] as number;
          break;
        case 2:
          out[q] = cur[p] as number; out[q + 1] = cur[p + step] as number; out[q + 2] = cur[p + 2 * step] as number; out[q + 3] = 255;
          break;
        case 0:
          out[q] = out[q + 1] = out[q + 2] = cur[p] as number; out[q + 3] = 255;
          break;
        case 4:
          out[q] = out[q + 1] = out[q + 2] = cur[p] as number; out[q + 3] = cur[p + step] as number;
          break;
        case 3: {
          const idx = cur[p] as number;
          out[q] = palette?.[idx * 3] ?? 0; out[q + 1] = palette?.[idx * 3 + 1] ?? 0; out[q + 2] = palette?.[idx * 3 + 2] ?? 0;
          out[q + 3] = trns && idx < trns.length ? (trns[idx] as number) : 255;
          break;
        }
      }
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crcBuf = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([head, data, tail]);
}

/** Encodes RGBA pixels as a PNG (filter "up" rows, zlib level 6). */
export function encodePng(img: Rgba, level = 6): Buffer {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = y === 0 ? 0 : 2;
    for (let i = 0; i < stride; i++) {
      const v = data[y * stride + i] as number;
      raw[o + 1 + i] = y === 0 ? v : (v - (data[(y - 1) * stride + i] as number)) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}
