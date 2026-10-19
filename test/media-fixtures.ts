/**
 * Builds tiny synthetic MP4 (ISO-BMFF) files box by box, for the media tests.
 * Only the boxes FireLab reads are filled in; mdat holds placeholder bytes.
 */

export const u8 = (...xs: number[]) => Buffer.from(xs);
export const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
export const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
export const zeros = (n: number) => Buffer.alloc(n);

export function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}

/** A box with a 64-bit size field (size = 1). */
export function largeBox(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(16);
  h.writeUInt32BE(1);
  h.write(type, 4, 'latin1');
  h.writeUInt32BE(0, 8);
  h.writeUInt32BE(16 + body.length, 12);
  return Buffer.concat([h, body]);
}

export const full = (type: string, version: number, flags: number, ...parts: Buffer[]) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);

export const ftyp = (major = 'isom', brands = ['isom', 'iso2', 'avc1', 'mp41']) => box('ftyp', Buffer.from(major, 'latin1'), u32(512), ...brands.map((b) => Buffer.from(b, 'latin1')));
export const mvhd = (timescale: number, duration: number) => full('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), zeros(80));
export const tkhd = (w: number, h: number) => full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), zeros(8), zeros(36), u32(w * 65536), u32(h * 65536));
export const mdhd = (timescale: number, duration: number) => full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
export const hdlr = (handler: 'vide' | 'soun') => full('hdlr', 0, 0, u32(0), Buffer.from(handler, 'latin1'), zeros(12), u8(0));

export function visualEntry(fourcc: string, w: number, h: number, ...kids: Buffer[]): Buffer {
  const fixed = Buffer.concat([zeros(6), u16(1), u16(0), u16(0), zeros(12), u16(w), u16(h), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff)]);
  return box(fourcc, fixed, ...kids);
}
export const audioEntry = (fourcc = 'mp4a', channels = 2, rate = 48000) => box(fourcc, zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(rate * 65536));

export const avcC = (profile: number, compat: number, level: number) => box('avcC', u8(1, profile, compat, level, 0xff, 0xe0, 0));
export const hvcC = (profile: number, tier: number, levelIdc: number) => box('hvcC', u8(1, (tier << 5) | profile), u32(0x60000000), u8(0x90, 0, 0, 0, 0, 0), u8(levelIdc), zeros(10));
export const vpcC = (profile: number, level: number, bitDepth: number) => full('vpcC', 1, 0, u8(profile, level, (bitDepth << 4) | (1 << 1), 1, 1, 1, 0), u16(0));
export const av1C = (profile: number, levelIdx: number, tier: number, highBitdepth: number) => box('av1C', u8(0x81, (profile << 5) | levelIdx, (tier << 7) | (highBitdepth << 6), 0));
export const btrt = (maxBitrate: number, avg: number) => box('btrt', u32(0), u32(maxBitrate), u32(avg));

export const stsd = (entry: Buffer) => full('stsd', 0, 0, u32(1), entry);
export const stts = (count: number, delta: number) => full('stts', 0, 0, u32(1), u32(count), u32(delta));
export const stsz = (count: number, size: number) => full('stsz', 0, 0, u32(size), u32(count));

export type VideoSpec = {
  entry: Buffer;
  width: number;
  height: number;
  /** Seconds. */
  duration?: number;
  fps?: number;
  /** Bytes per sample (sets the track bitrate). */
  sampleBytes?: number;
};

export function videoTrak(v: VideoSpec): Buffer {
  const timescale = 30000;
  const fps = v.fps ?? 30;
  const duration = v.duration ?? 10;
  const delta = Math.round(timescale / fps);
  const count = Math.round(duration * fps);
  return box(
    'trak',
    tkhd(v.width, v.height),
    box('mdia', mdhd(timescale, count * delta), hdlr('vide'), box('minf', box('stbl', stsd(v.entry), stts(count, delta), stsz(count, v.sampleBytes ?? 20000)))),
  );
}

export function audioTrak(duration = 10): Buffer {
  return box('trak', tkhd(0, 0), box('mdia', mdhd(48000, duration * 48000), hdlr('soun'), box('minf', box('stbl', stsd(audioEntry()), stts(duration * 47, 1024), stsz(duration * 47, 400)))));
}

/** A complete MP4: ftyp + moov + mdat (fast start), or ftyp + mdat + moov. */
export function mp4(opts: { video?: VideoSpec; audio?: boolean; fastStart?: boolean; mdatBytes?: number; extraMoov?: Buffer[] } = {}): Buffer {
  const duration = opts.video?.duration ?? 10;
  const traks = [...(opts.video ? [videoTrak(opts.video)] : []), ...(opts.audio ? [audioTrak(duration)] : [])];
  const moov = box('moov', mvhd(1000, duration * 1000), ...traks, ...(opts.extraMoov ?? []));
  const mdat = box('mdat', zeros(opts.mdatBytes ?? 4096));
  return opts.fastStart === false ? Buffer.concat([ftyp(), mdat, moov]) : Buffer.concat([ftyp(), moov, mdat]);
}

/** H.264 High@4.0 1920x1080 30 fps, about 6.7 Mbps by its sample sizes. */
export const h264_1080p = (extra: Partial<VideoSpec> = {}): VideoSpec => ({ entry: visualEntry('avc1', 1920, 1080, avcC(100, 0, 40)), width: 1920, height: 1080, sampleBytes: 27900, ...extra });
