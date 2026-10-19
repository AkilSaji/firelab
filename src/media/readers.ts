import fs from 'node:fs';
import { FireLabError } from '../lib/errors.js';
import type { ByteReader } from './types.js';

/** Reads from a Buffer (tests, already-downloaded bytes). */
export function bufferReader(buf: Buffer, source = 'buffer'): ByteReader {
  let bytesRead = 0;
  return {
    source,
    get bytesRead() {
      return bytesRead;
    },
    size: async () => buf.length,
    read: async (offset, length) => {
      const out = buf.subarray(offset, Math.min(buf.length, offset + length));
      bytesRead += out.length;
      return out;
    },
  };
}

/** Reads a local file with positioned reads (never loads the whole file). */
export function fileReader(file: string): ByteReader {
  let fh: fs.promises.FileHandle | undefined;
  let bytesRead = 0;
  const open = async () => (fh ??= await fs.promises.open(file, 'r'));
  return {
    source: file,
    get bytesRead() {
      return bytesRead;
    },
    size: async () => (await (await open()).stat()).size,
    read: async (offset, length) => {
      const h = await open();
      const buf = Buffer.alloc(length);
      const { bytesRead: n } = await h.read(buf, 0, length, offset);
      bytesRead += n;
      return buf.subarray(0, n);
    },
    close: async () => {
      await fh?.close();
      fh = undefined;
    },
  };
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; method?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
}>;

/** Total size from "Content-Range: bytes 0-65535/1234567". */
export function parseContentRange(h: string | null): { start: number; end: number; total?: number } | undefined {
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(h ?? '');
  if (!m) return undefined;
  return { start: Number(m[1]), end: Number(m[2]), ...(m[3] !== '*' ? { total: Number(m[3]) } : {}) };
}

async function readAtMost(res: Awaited<ReturnType<FetchLike>>, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const reader = res.body.getReader();
  const parts: Buffer[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      parts.push(Buffer.from(value));
      n += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).subarray(0, max);
}

/**
 * Reads a URL with HTTP Range requests: only the bytes asked for are
 * fetched. Servers that ignore Range work for the first chunk only (the
 * download is cut off after it); a later read throws with a hint.
 */
export function httpReader(url: string, opts: { fetch?: FetchLike; timeoutMs?: number; headers?: Record<string, string> } = {}): ByteReader {
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 15000;
  let total: number | undefined;
  let sizeKnown = false;
  let noRange = false;
  let bytesRead = 0;
  const get = async (offset: number, length: number): Promise<Buffer> => {
    if (noRange && offset > 0) {
      throw new FireLabError('unsupported', `${url} ignores HTTP Range requests, so its header can't be read without downloading the whole file`, {
        hint: 'Download it and check the local file instead, or enable Range requests on the server (players need them too)',
      });
    }
    const res = await doFetch(url, { headers: { ...(opts.headers ?? {}), Range: `bytes=${offset}-${offset + length - 1}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 416) return Buffer.alloc(0);
    if (res.status === 206) {
      const cr = parseContentRange(res.headers.get('content-range'));
      if (cr?.total !== undefined) {
        total = cr.total;
        sizeKnown = true;
      }
      const buf = await readAtMost(res, length);
      bytesRead += buf.length;
      return buf;
    }
    if (res.status === 200) {
      noRange = true;
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > 0) {
        total = len;
        sizeKnown = true;
      }
      if (offset > 0) throw new FireLabError('unsupported', `${url} ignores HTTP Range requests`);
      const buf = await readAtMost(res, length);
      bytesRead += buf.length;
      return buf;
    }
    throw new FireLabError('bad-request', `${url} answered HTTP ${res.status}`);
  };
  return cachedReader({
    source: url,
    get bytesRead() {
      return bytesRead;
    },
    size: async () => {
      if (!sizeKnown && bytesRead === 0) await get(0, 1).catch(() => undefined);
      return total;
    },
    read: get,
  });
}

/** Serves small reads near the start from one prefetched chunk (one request instead of one per box header). */
export function cachedReader(inner: ByteReader, chunk = 64 * 1024): ByteReader {
  let head: Buffer | undefined;
  return {
    source: inner.source,
    get bytesRead() {
      return inner.bytesRead;
    },
    size: () => inner.size(),
    read: async (offset, length) => {
      if (!head && offset === 0) head = await inner.read(0, Math.max(chunk, length));
      if (head && offset + length <= head.length) return head.subarray(offset, offset + length);
      if (head && offset < head.length && head.length < chunk) return head.subarray(offset, Math.min(head.length, offset + length));
      return inner.read(offset, length);
    },
    close: inner.close ? () => (inner.close as () => Promise<void>)() : undefined,
  };
}
