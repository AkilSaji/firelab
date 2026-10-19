import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMedia, type MediaLimits } from '../src/media/check.js';
import { probeMp4 } from '../src/media/mp4.js';
import { probeMedia, listMediaFiles } from '../src/media/probe.js';
import { bufferReader, httpReader, parseContentRange } from '../src/media/readers.js';
import type { MediaInfo } from '../src/media/types.js';
import { DECODERS } from '../src/fit/model-facts.js';
import { av1C, avcC, h264_1080p, hvcC, mp4, visualEntry } from './media-fixtures.js';

const probe = (buf: Buffer) => probeMp4(bufferReader(buf, 'clip.mp4'));
const AFTSSS: MediaLimits = { name: 'Fire TV Stick (3rd gen)', decoders: DECODERS.AFTSSS, decodersFrom: 'estimated', streamOkMbps: 4.5, streamStallMbps: 6.7, streamFrom: 'measured' };
const AFTKRT: MediaLimits = { name: 'Fire TV Stick 4K Max (2nd gen)', decoders: DECODERS.AFTKRT, decodersFrom: 'estimated' };
const AFTB: MediaLimits = { name: 'Fire TV (1st gen)', decoders: DECODERS.AFTB, decodersFrom: 'estimated' };
const keys = (xs: { key: string }[]) => xs.map((x) => x.key);

describe('checkMedia against decoder limits', () => {
  it('warns that 6.7 Mbps H.264 stalled on GE8300 sticks over Wi-Fi, with a re-encode fix', async () => {
    const info = await probe(mp4({ video: h264_1080p() }));
    const issues = checkMedia(info, AFTSSS);
    expect(keys(issues)).toEqual(['bitrate-stall']);
    expect(issues[0]).toMatchObject({ status: 'warn', scope: 'model', short: '6.7 Mbps stalls', confidence: 'high' });
    expect(issues[0]?.reason).toBe('6.7 Mbps average. 6.7 Mbps H.264 stalled on this model over Wi-Fi in our tests; up to 4.5 Mbps played fine.');
    expect(issues[0]?.fix).toMatch(/2\.5-4\.5 Mbps H\.264 High/);
    // Same file on a sibling with inherited (estimated) thresholds says so.
    const lite = checkMedia(info, { ...AFTSSS, name: 'Fire TV Stick Lite', streamFrom: 'estimated' });
    expect(lite[0]?.reason).toMatch(/on GE8300 sticks \(same hardware\)/);
    expect(lite[0]?.confidence).toBe('medium');
  });

  it('passes 4 Mbps H.264 High on the 3rd gen stick and anything on a 4K Max', async () => {
    const info = await probe(mp4({ video: h264_1080p({ sampleBytes: 15000 }) }));
    expect(checkMedia(info, AFTSSS)).toEqual([]);
    expect(checkMedia(await probe(mp4({ video: h264_1080p() })), AFTKRT)).toEqual([]);
  });

  it('a bitrate between "played fine" and "stalled" is a softer warning', async () => {
    const info = await probe(mp4({ video: h264_1080p({ sampleBytes: 21000 }) })); // ~5 Mbps
    const issues = checkMedia(info, AFTSSS);
    expect(issues).toMatchObject([{ key: 'bitrate-high', status: 'warn', confidence: 'low' }]);
  });

  it('fails 4K HEVC on an HD stick, passes it on a 4K Max', async () => {
    const info = await probe(mp4({ video: { entry: visualEntry('hvc1', 3840, 2160, hvcC(2, 0, 153)), width: 3840, height: 2160, sampleBytes: 10000 } }));
    const hd = checkMedia(info, AFTSSS);
    expect(hd).toMatchObject([{ key: 'resolution:hevc:1920x1080', status: 'fail', short: '3840x2160 > 1920x1080' }]);
    expect(hd[0]?.reason).toBe('3840x2160 is above the 1920x1080 its HEVC (H.265) decoder handles.');
    expect(checkMedia(info, AFTKRT)).toEqual([]);
  });

  it('AV1: unknown on the 3rd gen stick (warn), missing on old models (fail), fine on a 4K Max', async () => {
    const info = await probe(mp4({ video: { entry: visualEntry('av01', 1920, 1080, av1C(0, 8, 0, 0)), width: 1920, height: 1080, sampleBytes: 10000 } }));
    expect(checkMedia(info, AFTSSS)).toMatchObject([{ key: 'codec-unknown-support:av1', status: 'warn', confidence: 'low' }]);
    expect(checkMedia(info, AFTB)).toMatchObject([{ key: 'codec-unsupported:av1', status: 'fail', short: 'no AV1 decoder' }]);
    expect(checkMedia(info, AFTKRT)).toEqual([]);
  });

  it('a generic class guess (most smart TVs) only warns, never fails', async () => {
    const info = await probe(mp4({ video: { entry: visualEntry('av01', 1920, 1080, av1C(0, 8, 0, 0)), width: 1920, height: 1080, sampleBytes: 10000 } }));
    const issues = checkMedia(info, { ...AFTB, decodersFrom: 'generic' });
    expect(issues).toMatchObject([{ status: 'warn', confidence: 'low' }]);
  });

  it('H.264 High 10 is not hardware-decoded; a too-high level warns', async () => {
    const hi10 = await probe(mp4({ video: { entry: visualEntry('avc1', 1920, 1080, avcC(110, 0, 41)), width: 1920, height: 1080, sampleBytes: 10000 } }));
    expect(checkMedia(hi10, AFTSSS)).toMatchObject([{ key: 'profile:avc:high10', status: 'fail' }]);
    const l51 = await probe(mp4({ video: { entry: visualEntry('avc1', 1920, 1080, avcC(100, 0, 51)), width: 1920, height: 1080, sampleBytes: 10000 } }));
    expect(checkMedia(l51, AFTSSS)).toMatchObject([{ key: 'level:avc:4.2', status: 'warn', fix: 'Re-encode with -level 4.2.' }]);
  });

  it('frame rate above the decoder rating warns', async () => {
    const info = await probe(mp4({ video: { entry: visualEntry('avc1', 1920, 1080, avcC(100, 0, 42)), width: 1920, height: 1080, fps: 120, sampleBytes: 4000 } }));
    expect(keys(checkMedia(info, AFTSSS))).toContain('framerate:avc:60');
  });

  it('fast start and unreadable files are file-level issues', async () => {
    const info = await probe(mp4({ video: h264_1080p({ sampleBytes: 10000 }), fastStart: false }));
    expect(checkMedia(info, AFTKRT)).toMatchObject([{ key: 'faststart', scope: 'file', status: 'warn' }]);
    expect(checkMedia(info, AFTKRT)[0]?.fix).toMatch(/-movflags \+faststart/);
    const bad: MediaInfo = { source: 'x.mp4', container: 'unknown', tracks: [], error: 'not an MP4' };
    expect(checkMedia(bad, AFTKRT)).toMatchObject([{ key: 'unreadable', scope: 'file' }]);
  });
});

describe('probeMedia: files, folders and URLs', () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  const served = new Map<string, Buffer>();
  const ranges: string[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-media-'));
    fs.mkdirSync(path.join(dir, 'videos', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'videos', 'intro.mp4'), mp4({ video: h264_1080p(), fastStart: false, mdatBytes: 300_000 }));
    fs.writeFileSync(path.join(dir, 'videos', 'nested', 'outro.m4v'), mp4({ video: h264_1080p({ sampleBytes: 12000 }) }));
    fs.writeFileSync(path.join(dir, 'videos', 'notes.txt'), 'not media');
    served.set('/big.mp4', mp4({ video: h264_1080p(), fastStart: false, mdatBytes: 3_000_000 }));
    served.set('/norange.mp4', mp4({ video: h264_1080p({ sampleBytes: 12000 }), mdatBytes: 500_000 }));
    // Our own throwaway server on an OS-assigned port: no device involved.
    server = http.createServer((req, res) => {
      const body = served.get(req.url ?? '');
      if (!body) return void res.writeHead(404).end();
      const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      if (range && req.url !== '/norange.mp4') {
        ranges.push(`${req.url} ${req.headers.range}`);
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), body.length - 1);
        if (start >= body.length) return void res.writeHead(416).end();
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
        return void res.end(body.subarray(start, end + 1));
      }
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists media files in a folder, recursively', () => {
    expect(listMediaFiles(path.join(dir, 'videos')).map((p) => path.relative(dir, p))).toEqual([path.join('videos', 'intro.mp4'), path.join('videos', 'nested', 'outro.m4v')]);
  });

  it('probes a folder and a missing file', async () => {
    const infos = await probeMedia([path.join(dir, 'videos'), path.join(dir, 'missing.mp4')]);
    expect(infos.map((i) => path.basename(i.source))).toEqual(['intro.mp4', 'outro.m4v', 'missing.mp4']);
    expect(infos[0]).toMatchObject({ fastStart: false, video: { codec: 'avc', width: 1920 } });
    expect(infos[2]?.error).toBe('file not found');
  });

  it('reads a URL with Range requests: header bytes only, even when moov is at the end', async () => {
    const [info] = await probeMedia([`${base}/big.mp4`]);
    const size = (served.get('/big.mp4') as Buffer).length;
    expect(info).toMatchObject({ container: 'mp4', fastStart: false, sizeBytes: size, video: { codec: 'avc', profile: 'high', width: 1920, height: 1080 } });
    expect(info?.bytesRead).toBeLessThan(80_000);
    expect(ranges.some((r) => r.startsWith('/big.mp4 bytes=0-'))).toBe(true);
    // The moov after the 3 MB mdat came from a second Range request near the end.
    expect(ranges.filter((r) => r.startsWith('/big.mp4')).length).toBeGreaterThanOrEqual(2);
  });

  it('copes with a server that ignores Range when the header is in the first chunk', async () => {
    const r = httpReader(`${base}/norange.mp4`);
    const info = await probeMp4(r);
    expect(info.video?.codec).toBe('avc');
    expect(r.bytesRead).toBeLessThanOrEqual(64 * 1024);
  });

  it('parses Content-Range', () => {
    expect(parseContentRange('bytes 0-65535/1234567')).toEqual({ start: 0, end: 65535, total: 1234567 });
    expect(parseContentRange('bytes 10-20/*')).toEqual({ start: 10, end: 20 });
    expect(parseContentRange(null)).toBeUndefined();
  });

  it('reports HTTP errors per file instead of throwing', async () => {
    const [info] = await probeMedia([`${base}/nope.mp4`]);
    expect(info?.error).toMatch(/HTTP 404/);
  });
});
