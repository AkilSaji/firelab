/**
 * Frame fingerprints (docs/ENGINE.md 5.4): grey conversion, block-mean
 * resizing, the 64-bit dHash [27], luma statistics and frame differences.
 * Works on raw RGBA only; the engine never decodes JPEG or PNG.
 */

export type RgbaImage = { width: number; height: number; data: Uint8Array };

/** ITU-R BT.601 luma of each pixel, 0..255. */
export function toGrey(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const g = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) g[i] = 0.299 * (d[i * 4] as number) + 0.587 * (d[i * 4 + 1] as number) + 0.114 * (d[i * 4 + 2] as number);
  return g;
}

/** Block-mean downscale of a grey image (each target pixel is the mean of its source block). */
export function resizeGrey(g: Float32Array, w: number, h: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < h; y++) for (let x = x0; x < x1 && x < w; x++) (sum += g[y * w + x] as number), n++;
      out[ty * tw + tx] = n ? sum / n : 0;
    }
  }
  return out;
}

/** Block-mean RGBA downscale to `tw` pixels wide (keeps the aspect ratio). */
export function resizeRgba(img: RgbaImage, tw: number): RgbaImage {
  if (img.width <= tw) return img;
  const th = Math.max(1, Math.round((img.height * tw) / img.width));
  const out = new Uint8Array(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * img.height) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * img.height) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * img.width) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * img.width) / tw));
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const o = (y * img.width + x) * 4;
          for (let c = 0; c < 4; c++) acc[c] = (acc[c] as number) + (img.data[o + c] as number);
          n++;
        }
      for (let c = 0; c < 4; c++) out[(ty * tw + tx) * 4 + c] = Math.round((acc[c] as number) / n);
    }
  }
  return { width: tw, height: th, data: out };
}

/**
 * dHash [27]: grey 9x8 block-mean downscale, one bit per horizontal neighbour
 * pair (left darker than right), 64 bits as 16 hex digits.
 */
export function dhash(img: RgbaImage): string {
  const g = resizeGrey(toGrey(img), img.width, img.height, 9, 8);
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | ((g[y * 9 + x] as number) < (g[y * 9 + x + 1] as number) ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const POPCOUNT = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));

/** Number of differing bits between two hex hashes of the same length (Infinity when lengths differ). */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT[parseInt(a[i] as string, 16) ^ parseInt(b[i] as string, 16)] as number;
  return d;
}

/** Mean and standard deviation of the grey values (0..255). */
export function luma(img: RgbaImage): { mean: number; std: number } {
  const g = toGrey(img);
  if (!g.length) return { mean: 0, std: 0 };
  let s = 0;
  for (const v of g) s += v;
  const mean = s / g.length;
  let v2 = 0;
  for (const v of g) v2 += (v - mean) * (v - mean);
  return { mean, std: Math.sqrt(v2 / g.length) };
}

/** Mean absolute grey difference between two same-sized RGBA buffers (Infinity when sizes differ). */
export function meanAbsDiff(a: Uint8Array | undefined, b: Uint8Array | undefined): number {
  if (!a || !b || a.length !== b.length || !a.length) return Infinity;
  let s = 0;
  const n = a.length / 4;
  for (let i = 0; i < n; i++) {
    const ga = 0.299 * (a[i * 4] as number) + 0.587 * (a[i * 4 + 1] as number) + 0.114 * (a[i * 4 + 2] as number);
    const gb = 0.299 * (b[i * 4] as number) + 0.587 * (b[i * 4 + 1] as number) + 0.114 * (b[i * 4 + 2] as number);
    s += Math.abs(ga - gb);
  }
  return s / n;
}

/** Hash, luma and the 64-px thumbnail of a frame, as the Observation stores them. */
export function fingerprint(img: RgbaImage): { hash: string; luma: { mean: number; std: number }; thumb64: Uint8Array; size: [number, number] } {
  const small = resizeRgba(img, 64);
  return { hash: dhash(small), luma: luma(small), thumb64: small.data, size: [small.width, small.height] };
}
