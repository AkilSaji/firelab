import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractPng, parseRawScreencap, gunzipAfterJunk, captureScreen, screenJpeg } from '../src/adb/screenshot.js';
import { decodePng, encodePng, crc32, pngSize, PNG_SIGNATURE, type Rgba } from '../src/adb/png.js';
import { resizeRgba, decodeJpeg } from '../src/adb/image.js';
import { fakeAdb, SERIAL } from './helpers/fake-adb.js';

/** A small test image: a red/green/blue/white quadrant pattern. */
function pattern(w = 8, h = 6): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const left = x < w / 2;
      const top = y < h / 2;
      data.set(top ? (left ? [255, 0, 0, 255] : [0, 255, 0, 255]) : left ? [0, 0, 255, 255] : [255, 255, 255, 255], i);
    }
  return { width: w, height: h, data };
}

describe('PNG extraction from screencap output', () => {
  const png = encodePng(pattern());

  it('passes a clean PNG through unchanged', () => {
    expect(extractPng(png).equals(png)).toBe(true);
  });

  it('strips warning text that some Fire OS builds print before the image', () => {
    const junk = Buffer.from('WARNING: linker: /system/bin/screencap: unused DT entry: type 0x6ffffef5\n[SurfaceFlinger] capture took 12ms\n');
    const out = extractPng(Buffer.concat([junk, png]));
    expect(out.equals(png)).toBe(true);
    expect(decodePng(out).width).toBe(8);
  });

  it('strips trailing bytes after IEND', () => {
    expect(extractPng(Buffer.concat([png, Buffer.from('\nexit 0\n')])).equals(png)).toBe(true);
  });

  it('undoes CRLF translation from old shells', () => {
    const translated = Buffer.from(png.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
    expect(translated.equals(png)).toBe(false);
    const out = extractPng(Buffer.concat([Buffer.from('noise\r\n'), translated]));
    expect(out.equals(png)).toBe(true);
  });

  it('says what came back when there is no PNG at all', () => {
    expect(() => extractPng(Buffer.from('Error: capture failed: Permission denied\n'))).toThrow(/no PNG: "Error: capture failed: Permission denied"/);
    expect(() => extractPng(Buffer.alloc(0))).toThrow(/empty output/);
  });

  it('rejects a corrupted header and a truncated file', () => {
    const bad = Buffer.from(png);
    bad[20] = (bad[20] ?? 0) ^ 0xff; // inside IHDR data, CRC no longer matches
    expect(() => extractPng(bad)).toThrow(/CRC/);
    expect(() => extractPng(png.subarray(0, png.length - 20))).toThrow(/truncated/);
  });
});

describe('PNG codec', () => {
  it('round-trips RGBA', () => {
    const img = pattern(13, 7);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(13);
    expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
  });

  it('decodes RGB (color type 2) with every filter type', () => {
    const w = 4, h = 5;
    const rows: number[] = [];
    for (let y = 0; y < h; y++) {
      rows.push(y); // filter 0..4
      for (let x = 0; x < w; x++) rows.push(10 * x, 20 * y, 7, ...[]);
      rows.splice(rows.length - w * 3, w * 3, ...Array.from({ length: w * 3 }, (_, i) => (i * 3 + y) & 255));
    }
    const raw = Buffer.from(rows);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([len, body, crc]);
    };
    const png = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    const img = decodePng(png);
    expect(pngSize(png)).toEqual({ width: 4, height: 5 });
    expect(img.data[3]).toBe(255); // opaque
    // Row 0 has filter 0: raw values pass through.
    expect([...img.data.subarray(0, 3)]).toEqual([0, 3, 6]);
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082);
  });
});

describe('raw screencap', () => {
  const header = (w: number, h: number, f: number, cs?: number) => {
    const b = Buffer.alloc(cs === undefined ? 12 : 16);
    b.writeUInt32LE(w, 0);
    b.writeUInt32LE(h, 4);
    b.writeUInt32LE(f, 8);
    if (cs !== undefined) b.writeUInt32LE(cs, 12);
    return b;
  };

  it('parses Android 9+ (16-byte header) RGBA', () => {
    const px = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const img = parseRawScreencap(Buffer.concat([header(2, 1, 1, 1), px]));
    expect(img.width).toBe(2);
    expect([...img.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('parses Android <= 8 (12-byte header) RGBX and forces alpha', () => {
    const img = parseRawScreencap(Buffer.concat([header(1, 1, 2), Buffer.from([9, 8, 7, 0])]));
    expect([...img.data]).toEqual([9, 8, 7, 255]);
  });

  it('converts BGRA and RGB565', () => {
    expect([...parseRawScreencap(Buffer.concat([header(1, 1, 5, 1), Buffer.from([10, 20, 30, 40])])).data]).toEqual([30, 20, 10, 40]);
    const white565 = Buffer.alloc(2);
    white565.writeUInt16LE(0xffff);
    expect([...parseRawScreencap(Buffer.concat([header(1, 1, 4), white565])).data]).toEqual([255, 255, 255, 255]);
  });

  it('rejects data of the wrong size', () => {
    expect(() => parseRawScreencap(Buffer.concat([header(100, 100, 1, 1), Buffer.alloc(10)]))).toThrow(/unexpected size/);
  });

  it('inflates gzip that follows stderr noise', () => {
    const gz = zlib.gzipSync(Buffer.from('hello'));
    expect(gunzipAfterJunk(Buffer.concat([Buffer.from('warning: x\n'), gz])).toString()).toBe('hello');
  });
});

describe('captureScreen', () => {
  it('uses gzip-compressed raw capture when the device supports it', async () => {
    const { adb, runner } = fakeAdb();
    const raw = Buffer.concat([Buffer.from([4, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), Buffer.alloc(4 * 2 * 4, 200)]);
    runner.on(/exec-out screencap 2>\/dev\/null \| gzip -1/, zlib.gzipSync(raw));
    const s = await captureScreen(adb, `${SERIAL}-gz`);
    expect(s).toMatchObject({ width: 4, height: 2, method: 'raw-gzip' });
  });

  it('falls back to PNG (and remembers) when gzip is missing', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/gzip/, '/system/bin/sh: gzip: not found\n');
    runner.on(/exec-out screencap -p/, Buffer.concat([Buffer.from('WARNING: junk\n'), encodePng(pattern())]));
    const serial = `${SERIAL}-nogz`;
    expect((await captureScreen(adb, serial)).method).toBe('png');
    await captureScreen(adb, serial);
    expect(runner.calls.filter((c) => c.join(' ').includes('gzip'))).toHaveLength(1);
  });
});

describe('downscaling and JPEG', () => {
  it('averages pixel blocks when shrinking', () => {
    const img = resizeRgba(pattern(8, 6), 2);
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect([...img.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...img.data.subarray(12, 16)]).toEqual([255, 255, 255, 255]);
  });

  it('never upscales', () => {
    const p = pattern(8, 6);
    expect(resizeRgba(p, 100)).toBe(p);
  });

  it('produces a decodable JPEG at the requested width', () => {
    const big = pattern(640, 360);
    const jpg = screenJpeg({ width: 640, height: 360, method: 'raw-gzip', ms: 0, rgba: big }, { width: 320, quality: 80 });
    expect(jpg[0]).toBe(0xff);
    expect(jpg[1]).toBe(0xd8);
    const back = decodeJpeg(jpg);
    expect([back.width, back.height]).toEqual([320, 180]);
    // top-left quadrant stays red-ish
    expect(back.data[0]).toBeGreaterThan(200);
    expect(back.data[1]).toBeLessThan(60);
  });
});
