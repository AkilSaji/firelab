import fs from 'node:fs';
import path from 'node:path';
import { probeMp4 } from './mp4.js';
import { fileReader, httpReader, type FetchLike } from './readers.js';
import type { ByteReader, MediaInfo } from './types.js';
import { mapLimit } from '../lib/util.js';

export const MEDIA_EXTENSIONS = /\.(mp4|m4v|mov|3gp|mp4v)(\?|#|$)/i;

/** Media files in a folder (recursive, up to `max`). */
export function listMediaFiles(dir: string, max = 200, depth = 4): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    if (out.length >= max || level > depth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, level + 1);
      else if (MEDIA_EXTENSIONS.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

async function probeOne(reader: ByteReader): Promise<MediaInfo> {
  try {
    return await probeMp4(reader);
  } catch (e) {
    return { source: reader.source, container: 'unknown', tracks: [], bytesRead: reader.bytesRead, error: (e as Error).message };
  } finally {
    await reader.close?.().catch(() => {});
  }
}

/**
 * Probes local files, folders and http(s) URLs. URLs are read with Range
 * requests, so only headers are downloaded.
 */
export async function probeMedia(inputs: string[], opts: { fetch?: FetchLike; max?: number; concurrency?: number } = {}): Promise<MediaInfo[]> {
  const targets: string[] = [];
  for (const input of inputs) {
    if (/^https?:\/\//i.test(input)) targets.push(input);
    else if (fs.existsSync(input) && fs.statSync(input).isDirectory()) targets.push(...listMediaFiles(input, opts.max ?? 200));
    else targets.push(input);
  }
  const unique = [...new Set(targets)].slice(0, opts.max ?? 200);
  return mapLimit(unique, opts.concurrency ?? 4, (t) => {
    if (/^https?:\/\//i.test(t)) return probeOne(httpReader(t, { fetch: opts.fetch }));
    if (!fs.existsSync(t)) return Promise.resolve<MediaInfo>({ source: t, container: 'unknown', tracks: [], error: 'file not found' });
    return probeOne(fileReader(t));
  });
}

/** Evaluated in a page: the media URLs it loaded or points at (video elements, sources, resource timing). */
export const PAGE_MEDIA_SCRIPT = `(() => {
  const urls = new Set();
  const add = (u) => { try { if (u && !/^(blob|data):/.test(u)) urls.add(new URL(u, location.href).href); } catch (e) {} };
  document.querySelectorAll('video, audio, source').forEach((el) => { add(el.currentSrc || el.src); });
  try { performance.getEntriesByType('resource').forEach((e) => { if (e.initiatorType === 'video' || e.initiatorType === 'audio' || ${MEDIA_EXTENSIONS.toString()}.test(e.name)) add(e.name); }); } catch (e) {}
  return [...urls].slice(0, 50);
})()`;
