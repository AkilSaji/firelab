import http from 'node:http';
import crypto from 'node:crypto';
import type net from 'node:net';

type Msg = { id: number; method: string; params?: Record<string, unknown> };
type Handler = (msg: Msg, send: (obj: unknown) => void) => unknown;

/**
 * A tiny stand-in for a WebView's DevTools endpoint: /json/list over HTTP and
 * a WebSocket that answers CDP commands with a handler. Enough to test the
 * CDP client, WebView sessions and fps sampling without a device.
 */
export class FakeDevtools {
  private server = http.createServer((req, res) => this.onHttp(req, res));
  private sockets = new Set<net.Socket>();
  received: Msg[] = [];
  port = 0;
  handler: Handler = () => ({});
  url = 'http://192.168.1.164:4173/';

  async start(): Promise<this> {
    this.server.on('upgrade', (req, socket) => this.onUpgrade(req, socket as net.Socket));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/json/list' || req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { id: 'W1', type: 'worker', title: '', url: '', webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/W1` },
          { id: 'P0', type: 'page', title: 'hidden', url: 'about:blank', description: '{"attached":false,"visible":false,"empty":true}', webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/P0` },
          { id: 'P1', type: 'page', title: 'Game', url: this.url, description: '{"attached":true,"visible":true,"empty":false,"width":1920,"height":1080}', webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/P1` },
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private onUpgrade(req: http.IncomingMessage, socket: net.Socket): void {
    const key = req.headers['sec-websocket-key'] as string;
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = (buf[0] as number) & 0x0f;
        let len = (buf[1] as number) & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = ((buf[1] as number) & 0x80) !== 0;
        const total = off + (masked ? 4 : 0) + len;
        if (buf.length < total) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), total));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
        buf = buf.subarray(total);
        if (op === 0x8) {
          socket.end();
          return;
        }
        if (op === 0x1) this.onMessage(socket, JSON.parse(payload.toString('utf8')) as Msg);
      }
    });
  }

  private sendTo(socket: net.Socket, obj: unknown): void {
    const data = Buffer.from(JSON.stringify(obj));
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255]) : (() => {
      const h = Buffer.alloc(10);
      h[0] = 0x81;
      h[1] = 127;
      h.writeBigUInt64BE(BigInt(data.length), 2);
      return h;
    })();
    socket.write(Buffer.concat([head, data]));
  }

  /** Sends a CDP event to every connected client. */
  emit(method: string, params: Record<string, unknown>): void {
    for (const s of this.sockets) this.sendTo(s, { method, params });
  }

  private onMessage(socket: net.Socket, msg: Msg): void {
    this.received.push(msg);
    const send = (obj: unknown) => this.sendTo(socket, obj);
    const result = this.handler(msg, send);
    if (result === undefined) return; // handler will answer later (or never)
    if (result && typeof result === 'object' && 'error' in (result as object)) send({ id: msg.id, ...(result as object) });
    else send({ id: msg.id, result });
  }

  /** Drops all WebSocket connections, like an app restart. */
  dropClients(): void {
    for (const s of this.sockets) s.destroy();
  }

  async stop(): Promise<void> {
    this.dropClients();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
