import jpeg from 'jpeg-js';
import type { Rgba } from './png.js';

/** Area-average downscale (box filter): sharp enough for UI text, fast in plain JS. */
export function resizeRgba(img: Rgba, width: number): Rgba {
  if (width >= img.width) return img;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round((img.height * w) / img.width));
  const out = new Uint8Array(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  const src = img.data;
  const srcW = img.width;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(srcW, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * srcW + x0) * 4;
        for (let xx = x0; xx < x1; xx++, p += 4) {
          r += src[p] as number;
          g += src[p + 1] as number;
          b += src[p + 2] as number;
          a += src[p + 3] as number;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const q = (y * w + x) * 4;
      out[q] = r / n;
      out[q + 1] = g / n;
      out[q + 2] = b / n;
      out[q + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

export function encodeJpeg(img: Rgba, quality = 70): Buffer {
  const r = jpeg.encode({ data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height }, quality);
  return Buffer.from(r.data);
}

export function decodeJpeg(buf: Buffer): Rgba {
  const r = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: r.width, height: r.height, data: r.data };
}
