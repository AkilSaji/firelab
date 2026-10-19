/**
 * A small, dependency-free MP4 / ISO-BMFF reader: codec, profile, level,
 * size, frame rate, duration, bitrate and whether `moov` comes before `mdat`
 * (fast start). It walks top-level box headers and only reads the `moov` box
 * in full, so probing a URL costs a few Range requests, not the whole file.
 */
import type { VideoCodec } from '../profile/types.js';
import type { ByteReader, MediaInfo, MediaTrack } from './types.js';

type Box = { type: string; start: number; end: number };

const fourcc = (b: Buffer, at: number) => b.toString('latin1', at, at + 4);
const u64 = (b: Buffer, at: number) => b.readUInt32BE(at) * 2 ** 32 + b.readUInt32BE(at + 4);

/** Child boxes of the payload b[start, end). */
export function* children(b: Buffer, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = b.readUInt32BE(p);
    const type = fourcc(b, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = u64(b, p + 8);
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) return;
    yield { type, start: p + header, end: p + size };
    p += size;
  }
}

const child = (b: Buffer, box: Box, type: string): Box | undefined => {
  for (const c of children(b, box.start, box.end)) if (c.type === type) return c;
  return undefined;
};
const path = (b: Buffer, box: Box, ...types: string[]): Box | undefined => {
  let cur: Box | undefined = box;
  for (const t of types) {
    if (!cur) return undefined;
    cur = child(b, cur, t);
  }
  return cur;
};

const AVC_PROFILES: Record<number, string> = { 66: 'baseline', 77: 'main', 88: 'extended', 100: 'high', 110: 'high10', 122: 'high422', 244: 'high444', 44: 'cavlc444' };
const HEVC_PROFILES: Record<number, string> = { 1: 'main', 2: 'main10', 3: 'mainstill', 4: 'rext' };
const AV1_PROFILES: Record<number, string> = { 0: 'main', 1: 'high', 2: 'professional' };
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

const CODEC_OF: Record<string, VideoCodec> = { avc1: 'avc', avc3: 'avc', hvc1: 'hevc', hev1: 'hevc', vp09: 'vp9', av01: 'av1' };

function reverseBits32(n: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | (n & 1);
    n >>>= 1;
  }
  return r >>> 0;
}

/** Fills codec details from a video sample entry's config child box. */
function readVideoConfig(b: Buffer, entry: Box, fmt: string, t: MediaTrack): void {
  const kids = [...children(b, entry.start + 78, entry.end)];
  const find = (type: string) => kids.find((k) => k.type === type);
  const avcC = find('avcC');
  if (avcC && avcC.end - avcC.start >= 4) {
    const prof = b[avcC.start + 1] as number;
    const compat = b[avcC.start + 2] as number;
    const lvl = b[avcC.start + 3] as number;
    t.profileIdc = prof;
    t.profile = AVC_PROFILES[prof] ?? `profile${prof}`;
    t.level = lvl === 9 ? '1.1' : (lvl / 10).toFixed(1);
    t.codecString = `${fmt}.${hex2(prof)}${hex2(compat)}${hex2(lvl)}`;
    t.bitDepth = prof === 110 || prof === 122 || prof === 244 ? 10 : 8;
  }
  const hvcC = find('hvcC');
  if (hvcC && hvcC.end - hvcC.start >= 13) {
    const x = b[hvcC.start + 1] as number;
    const space = x >> 6;
    const tier = (x >> 5) & 1;
    const prof = x & 0x1f;
    const compat = b.readUInt32BE(hvcC.start + 2);
    const cons: number[] = [];
    for (let i = 0; i < 6; i++) cons.push(b[hvcC.start + 6 + i] as number);
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    const lvl = b[hvcC.start + 12] as number;
    t.profileIdc = prof;
    t.profile = HEVC_PROFILES[prof] ?? `profile${prof}`;
    t.level = (lvl / 30).toFixed(1);
    t.codecString = `${fmt}.${['', 'A', 'B', 'C'][space]}${prof}.${reverseBits32(compat).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${lvl}${cons.length ? `.${cons.map((c) => c.toString(16).toUpperCase()).join('.')}` : ''}`;
    t.bitDepth = prof === 2 ? 10 : 8;
  }
  const vpcC = find('vpcC');
  if (vpcC && vpcC.end - vpcC.start >= 7) {
    const prof = b[vpcC.start + 4] as number;
    const lvl = b[vpcC.start + 5] as number;
    const depth = (b[vpcC.start + 6] as number) >> 4;
    t.profileIdc = prof;
    t.profile = `profile${prof}`;
    t.level = (lvl / 10).toFixed(1);
    t.bitDepth = depth || 8;
    t.codecString = `vp09.${String(prof).padStart(2, '0')}.${String(lvl).padStart(2, '0')}.${String(t.bitDepth).padStart(2, '0')}`;
  }
  const av1C = find('av1C');
  if (av1C && av1C.end - av1C.start >= 3) {
    const x = b[av1C.start + 1] as number;
    const y = b[av1C.start + 2] as number;
    const prof = x >> 5;
    const idx = x & 0x1f;
    const tier = y >> 7;
    const high = (y >> 6) & 1;
    const twelve = (y >> 5) & 1;
    t.profileIdc = prof;
    t.profile = AV1_PROFILES[prof] ?? `profile${prof}`;
    t.level = `${2 + (idx >> 2)}.${idx & 3}`;
    t.bitDepth = high ? (twelve ? 12 : 10) : 8;
    t.codecString = `av01.${prof}.${String(idx).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(t.bitDepth).padStart(2, '0')}`;
  }
  const btrt = find('btrt');
  if (btrt && btrt.end - btrt.start >= 12) {
    const max = b.readUInt32BE(btrt.start + 4);
    if (max > 0) t.maxBitrateKbps = Math.round(max / 1000);
  }
}

function readTrack(b: Buffer, trak: Box): MediaTrack | undefined {
  const mdia = child(b, trak, 'mdia');
  if (!mdia) return undefined;
  const hdlr = child(b, mdia, 'hdlr');
  const handler = hdlr ? fourcc(b, hdlr.start + 8) : '';
  const t: MediaTrack = { kind: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other', fourcc: '' };
  const mdhd = child(b, mdia, 'mdhd');
  let timescale = 0;
  if (mdhd) {
    const v = b[mdhd.start] as number;
    timescale = b.readUInt32BE(mdhd.start + (v === 1 ? 20 : 12));
    const dur = v === 1 ? u64(b, mdhd.start + 24) : b.readUInt32BE(mdhd.start + 16);
    if (timescale > 0 && dur > 0 && dur !== 0xffffffff) t.durationS = Math.round((dur / timescale) * 1000) / 1000;
  }
  const tkhd = child(b, trak, 'tkhd');
  if (tkhd && t.kind === 'video') {
    const v = b[tkhd.start] as number;
    const at = tkhd.start + (v === 1 ? 88 : 76);
    if (at + 8 <= tkhd.end) {
      const w = Math.round(b.readUInt32BE(at) / 65536);
      const h = Math.round(b.readUInt32BE(at + 4) / 65536);
      if (w && h) {
        t.width = w;
        t.height = h;
      }
    }
  }
  const stbl = path(b, mdia, 'minf', 'stbl');
  if (!stbl) return t;
  const stsd = child(b, stbl, 'stsd');
  if (stsd) {
    const entry = children(b, stsd.start + 8, stsd.end).next().value as Box | undefined;
    if (entry) {
      let fmt = entry.type;
      t.fourcc = fmt;
      if (fmt === 'encv' || fmt === 'enca') {
        t.encrypted = true;
        const offset = fmt === 'encv' ? 78 : 28;
        for (const k of children(b, entry.start + offset, entry.end)) {
          if (k.type !== 'sinf') continue;
          const frma = child(b, k, 'frma');
          if (frma) fmt = fourcc(b, frma.start);
        }
        t.fourcc = fmt;
      }
      if (t.kind === 'video' && entry.end - entry.start >= 78) {
        const w = b.readUInt16BE(entry.start + 24);
        const h = b.readUInt16BE(entry.start + 26);
        if (w && h) {
          t.width = w;
          t.height = h;
        }
        const codec = CODEC_OF[fmt];
        if (codec) t.codec = codec;
        readVideoConfig(b, entry, fmt, t);
      } else if (t.kind === 'audio' && entry.end - entry.start >= 28) {
        t.channels = b.readUInt16BE(entry.start + 16);
        t.sampleRate = b.readUInt32BE(entry.start + 24) >>> 16;
        if (fmt === 'mp4a') t.codecString = 'mp4a.40.2';
      }
    }
  }
  const stts = child(b, stbl, 'stts');
  if (stts && timescale > 0) {
    const n = b.readUInt32BE(stts.start + 4);
    let samples = 0;
    let ticks = 0;
    for (let i = 0; i < n && stts.start + 8 + i * 8 + 8 <= stts.end; i++) {
      const c = b.readUInt32BE(stts.start + 8 + i * 8);
      const d = b.readUInt32BE(stts.start + 12 + i * 8);
      samples += c;
      ticks += c * d;
    }
    if (t.kind === 'video' && samples > 0 && ticks > 0) t.fps = Math.round((samples / (ticks / timescale)) * 100) / 100;
  }
  const stsz = child(b, stbl, 'stsz');
  if (stsz && t.durationS) {
    const fixed = b.readUInt32BE(stsz.start + 4);
    const count = b.readUInt32BE(stsz.start + 8);
    let bytes = 0;
    if (fixed > 0) bytes = fixed * count;
    else for (let i = 0; i < count && stsz.start + 12 + i * 4 + 4 <= stsz.end; i++) bytes += b.readUInt32BE(stsz.start + 12 + i * 4);
    if (bytes > 0) t.bitrateKbps = Math.round((bytes * 8) / t.durationS / 1000);
  }
  return t;
}

/** Parses a complete moov box payload. */
export function parseMoov(b: Buffer, moov: Box = { type: 'moov', start: 0, end: b.length }): { durationS?: number; fragmented: boolean; tracks: MediaTrack[] } {
  let durationS: number | undefined;
  let timescale = 0;
  const mvhd = child(b, moov, 'mvhd');
  if (mvhd) {
    const v = b[mvhd.start] as number;
    timescale = b.readUInt32BE(mvhd.start + (v === 1 ? 20 : 12));
    const dur = v === 1 ? u64(b, mvhd.start + 24) : b.readUInt32BE(mvhd.start + 16);
    if (timescale > 0 && dur > 0 && dur !== 0xffffffff) durationS = Math.round((dur / timescale) * 1000) / 1000;
  }
  const mvex = child(b, moov, 'mvex');
  if (mvex && !durationS && timescale > 0) {
    const mehd = child(b, mvex, 'mehd');
    if (mehd) {
      const v = b[mehd.start] as number;
      const d = v === 1 ? u64(b, mehd.start + 4) : b.readUInt32BE(mehd.start + 4);
      if (d > 0) durationS = Math.round((d / timescale) * 1000) / 1000;
    }
  }
  const tracks: MediaTrack[] = [];
  for (const c of children(b, moov.start, moov.end)) if (c.type === 'trak') {
    const t = readTrack(b, c);
    if (t) tracks.push(t);
  }
  return { ...(durationS ? { durationS } : {}), fragmented: !!mvex, tracks };
}

const MAX_MOOV = 64 << 20;

/** Probes an MP4 through a reader, fetching only box headers and the moov box. */
export async function probeMp4(reader: ByteReader): Promise<MediaInfo> {
  const info: MediaInfo = { source: reader.source, container: 'unknown', tracks: [] };
  // The first read comes before size(): HTTP readers learn the size from its Content-Range.
  await reader.read(0, 16);
  const size = await reader.size();
  if (size !== undefined) info.sizeBytes = size;
  let pos = 0;
  let moovAt = -1;
  let mdatAt = -1;
  let moov: Buffer | undefined;
  for (let n = 0; n < 10000; n++) {
    if (size !== undefined && pos + 8 > size) break;
    const head = await reader.read(pos, 16);
    if (head.length < 8) break;
    let boxSize = head.readUInt32BE(0);
    const type = fourcc(head, 4);
    let header = 8;
    if (!/^[\x20-\x7e]{4}$/.test(type)) {
      if (n === 0) throw new Error('not an MP4 (no ISO-BMFF box at the start)');
      break;
    }
    if (boxSize === 1) {
      if (head.length < 16) break;
      boxSize = u64(head, 8);
      header = 16;
    } else if (boxSize === 0) boxSize = size !== undefined ? size - pos : Number.POSITIVE_INFINITY;
    if (boxSize < header) throw new Error(`corrupt box "${type}" at ${pos}`);
    if (n === 0 && type !== 'ftyp' && type !== 'moov' && type !== 'free' && type !== 'skip' && type !== 'wide' && type !== 'styp') throw new Error(`not an MP4 (first box is "${type}")`);
    if (type === 'ftyp') {
      const ft = await reader.read(pos, Math.min(boxSize, 256));
      info.container = 'mp4';
      const brands = [fourcc(ft, 8)];
      for (let i = 16; i + 4 <= ft.length; i += 4) brands.push(fourcc(ft, i));
      info.brands = [...new Set(brands.filter((x) => x.trim()))];
    } else if (type === 'moov' && moovAt < 0) {
      moovAt = pos;
      if (boxSize > MAX_MOOV) throw new Error(`moov is ${Math.round(boxSize / 1048576)} MB; too big to probe`);
      moov = await reader.read(pos, boxSize);
      info.container = 'mp4';
    } else if (type === 'mdat' && mdatAt < 0) mdatAt = pos;
    else if (type === 'moof') info.fragmented = true;
    if (!Number.isFinite(boxSize)) break;
    pos += boxSize;
    if (moovAt >= 0 && mdatAt >= 0) break;
  }
  info.bytesRead = reader.bytesRead;
  if (!moov) {
    info.error = mdatAt >= 0 ? 'no moov box found after mdat (truncated or not a complete MP4)' : 'no moov box found';
    return info;
  }
  const parsed = parseMoov(moov, { type: 'moov', start: moov.readUInt32BE(0) === 1 ? 16 : 8, end: moov.length });
  info.tracks = parsed.tracks;
  if (parsed.fragmented) info.fragmented = true;
  info.durationS = parsed.durationS ?? parsed.tracks.find((t) => t.durationS)?.durationS;
  info.fastStart = mdatAt < 0 || moovAt < mdatAt;
  if (info.sizeBytes && info.durationS) info.bitrateKbps = Math.round((info.sizeBytes * 8) / info.durationS / 1000);
  info.video = parsed.tracks.find((t) => t.kind === 'video');
  info.audio = parsed.tracks.find((t) => t.kind === 'audio');
  return info;
}
