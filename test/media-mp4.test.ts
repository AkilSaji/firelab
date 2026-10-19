import { describe, expect, it } from 'vitest';
import { probeMp4, parseMoov } from '../src/media/mp4.js';
import { bufferReader } from '../src/media/readers.js';
import { describeMedia } from '../src/media/check.js';
import { av1C, avcC, box, btrt, full, ftyp, h264_1080p, hvcC, largeBox, mp4, mvhd, u32, visualEntry, vpcC, zeros } from './media-fixtures.js';

const probe = (buf: Buffer, name = 'test.mp4') => probeMp4(bufferReader(buf, name));

describe('MP4 probe: H.264', () => {
  it('reads codec, profile, level, size, frame rate, duration, bitrate and fast start', async () => {
    const info = await probe(mp4({ video: h264_1080p(), audio: true }));
    expect(info.container).toBe('mp4');
    expect(info.brands).toEqual(['isom', 'iso2', 'avc1', 'mp41']);
    expect(info.fastStart).toBe(true);
    expect(info.durationS).toBe(10);
    expect(info.video).toMatchObject({ kind: 'video', fourcc: 'avc1', codec: 'avc', codecString: 'avc1.640028', profile: 'high', profileIdc: 100, level: '4.0', width: 1920, height: 1080, fps: 30, bitDepth: 8 });
    // 300 samples x 27900 bytes over 10 s
    expect(info.video?.bitrateKbps).toBe(6696);
    expect(info.audio).toMatchObject({ kind: 'audio', fourcc: 'mp4a', channels: 2, sampleRate: 48000, codecString: 'mp4a.40.2' });
    expect(info.tracks).toHaveLength(2);
    expect(describeMedia(info)).toBe('H.264 high 4.0, 1920x1080, 30 fps, 6.7 Mbps, 10.0 s, audio mp4a, fast start');
  });

  it('spots a moov after mdat (not fast start)', async () => {
    const info = await probe(mp4({ video: h264_1080p(), fastStart: false }));
    expect(info.fastStart).toBe(false);
    expect(info.video?.codec).toBe('avc');
    expect(describeMedia(info)).toMatch(/moov at the end$/);
  });

  it('reads fractional frame rates and the btrt max bitrate', async () => {
    const entry = visualEntry('avc3', 1280, 720, avcC(77, 0x40, 31), btrt(4_500_000, 3_000_000));
    const info = await probe(mp4({ video: { entry, width: 1280, height: 720, fps: 29.97, duration: 4 } }));
    expect(info.video).toMatchObject({ fourcc: 'avc3', codec: 'avc', profile: 'main', level: '3.1', maxBitrateKbps: 4500, codecString: 'avc3.4D401F' });
    expect(info.video?.fps).toBeCloseTo(29.97, 1);
  });

  it('flags H.264 High 10 as 10-bit', async () => {
    const info = await probe(mp4({ video: { entry: visualEntry('avc1', 1920, 1080, avcC(110, 0, 41)), width: 1920, height: 1080 } }));
    expect(info.video).toMatchObject({ profile: 'high10', bitDepth: 10, level: '4.1' });
  });
});

describe('MP4 probe: HEVC, VP9, AV1', () => {
  it('HEVC Main10 level 5.1, high tier', async () => {
    const info = await probe(mp4({ video: { entry: visualEntry('hvc1', 3840, 2160, hvcC(2, 1, 153)), width: 3840, height: 2160, fps: 60 } }));
    expect(info.video).toMatchObject({ codec: 'hevc', fourcc: 'hvc1', profile: 'main10', profileIdc: 2, level: '5.1', bitDepth: 10, width: 3840, height: 2160, fps: 60 });
    expect(info.video?.codecString).toBe('hvc1.2.6.H153.90');
  });

  it('hev1 Main level 4.0', async () => {
    const info = await probe(mp4({ video: { entry: visualEntry('hev1', 1920, 1080, hvcC(1, 0, 120)), width: 1920, height: 1080 } }));
    expect(info.video).toMatchObject({ codec: 'hevc', profile: 'main', level: '4.0', codecString: 'hev1.1.6.L120.90' });
  });

  it('VP9 profile 2, 10-bit', async () => {
    const info = await probe(mp4({ video: { entry: visualEntry('vp09', 1920, 1080, vpcC(2, 41, 10)), width: 1920, height: 1080 } }));
    expect(info.video).toMatchObject({ codec: 'vp9', profile: 'profile2', level: '4.1', bitDepth: 10, codecString: 'vp09.02.41.10' });
  });

  it('AV1 main, level 4.0 and 5.1 high tier 10-bit', async () => {
    const a = await probe(mp4({ video: { entry: visualEntry('av01', 1920, 1080, av1C(0, 8, 0, 0)), width: 1920, height: 1080 } }));
    expect(a.video).toMatchObject({ codec: 'av1', profile: 'main', level: '4.0', bitDepth: 8, codecString: 'av01.0.08M.08' });
    const b = await probe(mp4({ video: { entry: visualEntry('av01', 3840, 2160, av1C(0, 13, 1, 1)), width: 3840, height: 2160 } }));
    expect(b.video).toMatchObject({ level: '5.1', bitDepth: 10, codecString: 'av01.0.13H.10' });
  });
});

describe('MP4 probe: edge cases', () => {
  it('handles 64-bit box sizes', async () => {
    const moov = box('moov', mvhd(1000, 5000));
    const buf = Buffer.concat([ftyp(), moov, largeBox('mdat', zeros(64))]);
    const info = await probe(buf);
    expect(info.durationS).toBe(5);
    expect(info.fastStart).toBe(true);
    expect(info.tracks).toEqual([]);
    expect(info.video).toBeUndefined();
  });

  it('marks fragmented files and reads their duration from mehd', async () => {
    const mvex = box('mvex', full('mehd', 0, 0, u32(7000)), full('trex', 0, 0, zeros(20)));
    const moov = box('moov', mvhd(1000, 0), mvex);
    const info = await probe(Buffer.concat([ftyp('iso6', ['iso6', 'dash']), moov, box('moof', zeros(16)), box('mdat', zeros(32))]));
    expect(info.fragmented).toBe(true);
    expect(info.durationS).toBe(7);
  });

  it('unwraps encrypted sample entries (encv -> frma)', async () => {
    const sinf = box('sinf', box('frma', Buffer.from('avc1', 'latin1')), full('schm', 0, 0, Buffer.from('cenc', 'latin1'), u32(0x10000)));
    const entry = visualEntry('encv', 1920, 1080, avcC(100, 0, 40), sinf);
    const info = await probe(mp4({ video: { entry, width: 1920, height: 1080 } }));
    expect(info.video).toMatchObject({ encrypted: true, fourcc: 'avc1', codec: 'avc', profile: 'high' });
  });

  it('rejects files that are not MP4', async () => {
    await expect(probe(Buffer.from('<!doctype html><html><body>404</body></html>'))).rejects.toThrow(/not an MP4/);
    await expect(probe(Buffer.concat([u32(24), Buffer.from('RIFF'), zeros(16)]))).rejects.toThrow(/not an MP4/);
  });

  it('reports a truncated file with no moov', async () => {
    const info = await probe(Buffer.concat([ftyp(), box('mdat', zeros(128))]));
    expect(info.error).toMatch(/no moov/);
    expect(info.tracks).toEqual([]);
  });

  it('parseMoov works on a bare moov payload', () => {
    const moov = box('moov', mvhd(600, 1200));
    expect(parseMoov(moov, { type: 'moov', start: 8, end: moov.length })).toEqual({ durationS: 2, fragmented: false, tracks: [] });
  });

  it('reads only the boxes it needs', async () => {
    const buf = mp4({ video: h264_1080p(), mdatBytes: 2_000_000 });
    const r = bufferReader(buf);
    await probeMp4(r);
    expect(r.bytesRead).toBeLessThan(10_000);
  });
});
