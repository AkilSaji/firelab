/**
 * Launcher art without image libraries: a tiny PNG encoder, a 5x7 pixel font,
 * and generators for the Fire TV banner (320x180) and icon (192x192) when the
 * user brings none.
 */
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (the zip/PNG polynomial). */
export function crc32(buf: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes 8-bit RGBA pixels as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new RangeError('rgba length must be width * height * 4');
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Width and height of a PNG or JPEG, or null if the bytes are neither. */
export function imageSize(buf: Buffer): { width: number; height: number; type: 'png' | 'jpg' } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), type: 'jpg' };
      }
      i += 2 + len;
    }
  }
  return null;
}

// ---------------------------------------------------------------- drawing

type RGB = [number, number, number];

class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }
  /** Blends a colour over pixel (x, y) with coverage a (0..1). */
  blend(x: number, y: number, c: RGB, a = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    const k = Math.min(1, a);
    d[i] = Math.round(d[i] * (1 - k) + c[0] * k);
    d[i + 1] = Math.round(d[i + 1] * (1 - k) + c[1] * k);
    d[i + 2] = Math.round(d[i + 2] * (1 - k) + c[2] * k);
    d[i + 3] = 255;
  }
  rect(x0: number, y0: number, w: number, h: number, c: RGB, a = 1): void {
    for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(this.width, x0 + w); x++) this.blend(x, y, c, a);
  }
  png(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}

function hsl(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** A stable hue for a name, so every app gets its own colours. */
export function hueOf(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

function background(cv: Canvas, hue: number): void {
  const top = hsl(hue, 0.55, 0.3);
  const bottom = hsl(hue + 35, 0.6, 0.11);
  const glow = hsl(hue - 20, 0.9, 0.62);
  const gx = cv.width * 0.78;
  const gy = cv.height * 0.12;
  const gr = Math.max(cv.width, cv.height) * 0.75;
  for (let y = 0; y < cv.height; y++) {
    const t = y / (cv.height - 1);
    const base: RGB = [top[0] + (bottom[0] - top[0]) * t, top[1] + (bottom[1] - top[1]) * t, top[2] + (bottom[2] - top[2]) * t];
    for (let x = 0; x < cv.width; x++) {
      cv.blend(x, y, base);
      const d = Math.hypot(x - gx, y - gy) / gr;
      if (d < 1) cv.blend(x, y, glow, (1 - d) ** 2 * 0.35);
    }
  }
}

// ---------------------------------------------------------------- 5x7 font

/** 5x7 glyphs, one string per row ('#' = ink). */
const GLYPH_ROWS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
};
const GLYPHS: Record<string, string> = Object.fromEntries(Object.entries(GLYPH_ROWS).map(([k, rows]) => [k, rows.join('')]));

/** Upper-cases, strips accents and drops characters the font cannot draw. */
export function fontText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split('')
    .filter((ch) => ch in GLYPHS)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cells (5 wide + 1 gap) a line of text takes. */
const cellsOf = (s: string) => Math.max(0, s.length * 6 - 1);

function drawText(cv: Canvas, text: string, x0: number, y0: number, scale: number, color: RGB, a = 1): void {
  let x = x0;
  for (const ch of text) {
    const g = GLYPHS[ch] ?? GLYPHS['?'];
    for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) if (g[row * 5 + col] === '#') cv.rect(x + col * scale, y0 + row * scale, scale, scale, color, a);
    x += 6 * scale;
  }
}

/** Splits a name into at most `maxLines` lines that balance in width. */
export function layoutLines(text: string, maxCells: number, maxLines = 2): string[] {
  const words = text.split(' ').filter(Boolean);
  if (!words.length) return [];
  if (cellsOf(text) <= maxCells || words.length === 1 || maxLines === 1) return [text];
  let best: string[] = [text];
  let bestWidth = Infinity;
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const w = Math.max(...lines.map(cellsOf));
    if (w < bestWidth) {
      best = lines;
      bestWidth = w;
    }
  }
  return best;
}

function drawCentered(cv: Canvas, lines: string[], boxW: number, boxH: number, maxScale: number): void {
  const widest = Math.max(1, ...lines.map(cellsOf));
  const tall = lines.length * 8 - 1;
  const scale = Math.max(1, Math.min(maxScale, Math.floor(boxW / widest), Math.floor(boxH / tall)));
  const totalH = tall * scale;
  let y = Math.round((cv.height - totalH) / 2);
  const shadow: RGB = [0, 0, 0];
  const ink: RGB = [255, 247, 240];
  for (const line of lines) {
    const x = Math.round((cv.width - cellsOf(line) * scale) / 2);
    const off = Math.max(1, Math.round(scale / 3));
    drawText(cv, line, x + off, y + off, scale, shadow, 0.45);
    drawText(cv, line, x, y, scale, ink);
    y += 8 * scale;
  }
}

/** Fire TV launcher banner: 320x180, the app name on a gradient. */
export function makeBanner(name: string): Buffer {
  const cv = new Canvas(320, 180);
  background(cv, hueOf(name));
  let text = fontText(name) || 'APP';
  // At least 3 px per font pixel: shorten very long names.
  const maxCells = Math.floor(288 / 3);
  let lines = layoutLines(text, Math.floor(288 / 6));
  while (Math.max(...lines.map(cellsOf)) > maxCells && text.length > 4) {
    text = `${text.slice(0, -2).trim()}.`;
    lines = layoutLines(text, Math.floor(288 / 6));
  }
  drawCentered(cv, lines, 288, 120, 8);
  // A thin accent line under the name area.
  cv.rect(130, 160, 60, 3, hsl(hueOf(name) - 20, 0.9, 0.65), 0.9);
  return cv.png();
}

/** Launcher icon: 192x192, the initials on the same gradient. */
export function makeIcon(name: string): Buffer {
  const cv = new Canvas(192, 192);
  background(cv, hueOf(name));
  const words = (fontText(name) || 'APP').split(' ').filter((w) => /[A-Z0-9]/.test(w));
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || 'A').slice(0, 2)).replace(/[^A-Z0-9]/g, '') || 'A';
  drawCentered(cv, [initials], 150, 130, 18);
  return cv.png();
}
