import { EventEmitter } from 'node:events';
import { FireLabError } from '../lib/errors.js';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string };

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

function makeWebSocket(url: string): WebSocketLike {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!WS) {
    throw new FireLabError('unsupported', 'WebView DevTools needs a WebSocket client, which Node has built in from version 22', {
      hint: `You are on Node ${process.versions.node}: upgrade to Node 22+, or run Node 20 with --experimental-websocket`,
    });
  }
  return new WS(url);
}

/**
 * A minimal Chrome DevTools Protocol client over Node's global WebSocket.
 * Every command has a timeout, so a busy or frozen page can't hang FireLab.
 */
export class CdpClient extends EventEmitter<{ event: [method: string, params: Record<string, unknown>]; close: [] }> {
  private ws?: WebSocketLike;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  closed = false;

  static async connect(url: string, timeoutMs = 5000): Promise<CdpClient> {
    const c = new CdpClient();
    await c.open(url, timeoutMs);
    return c;
  }

  private open(url: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = makeWebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new FireLabError('timeout', `DevTools connection to ${url} timed out`));
        try {
          ws.close();
        } catch {}
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        if (!this.closed) reject(new FireLabError('cdp-failed', `Couldn't connect to DevTools at ${url}`));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        this.handleClose();
      };
      ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    });
  }

  private handleMessage(text: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string; code?: number } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new FireLabError('cdp-failed', `${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      this.emit('event', msg.method, msg.params ?? {});
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new FireLabError('cdp-failed', `DevTools connection closed during ${p.method} (the page reloaded, crashed or the app stopped)`));
    }
    this.pending.clear();
    this.emit('close');
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<T> {
    if (this.closed || !this.ws) return Promise.reject(new FireLabError('cdp-failed', 'DevTools connection is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FireLabError('timeout', `${method} got no answer in ${Math.round(timeoutMs / 100) / 10} s (the page's main thread may be busy or frozen)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      try {
        this.ws?.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new FireLabError('cdp-failed', `Couldn't send ${method}: ${(e as Error).message}`));
      }
    });
  }

  /** Resolves with the params of the next `method` event, or rejects after timeoutMs. */
  waitFor(method: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const onEvent = (m: string, params: Record<string, unknown>) => {
        if (m !== method) return;
        cleanup();
        resolve(params);
      };
      const onClose = () => {
        cleanup();
        reject(new FireLabError('cdp-failed', `DevTools closed while waiting for ${method}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new FireLabError('timeout', `No ${method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('event', onEvent);
        this.off('close', onClose);
      };
      this.on('event', onEvent);
      this.on('close', onClose);
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {}
    this.handleClose();
  }
}
