import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { FireLab } from '../core/firelab.js';
import { createMcpServer } from './server.js';
import { log } from '../lib/log.js';

/** `firelab mcp`: MCP over stdin/stdout (what Claude Code, Cursor, Kiro and VS Code start). */
export async function runStdio(lab: FireLab): Promise<void> {
  const server = createMcpServer(lab);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server ready on stdio');
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on('end', () => resolve());
  });
  await server.close().catch(() => {});
}

async function readJson(req: http.IncomingMessage, limit = 4 << 20): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

/**
 * `firelab mcp --http 7301`: MCP Streamable HTTP at http://<host>:<port>/mcp,
 * stateful (one MCP session per client). Binds to 127.0.0.1 by default and
 * rejects foreign Host headers (DNS-rebinding protection).
 */
export async function runHttp(lab: FireLab, port: number, host = '127.0.0.1'): Promise<http.Server> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(host !== '127.0.0.1' && host !== '0.0.0.0' ? [`${host}:${port}`] : [])];
  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/mcp') {
        res.writeHead(url.pathname === '/' ? 200 : 404, { 'content-type': 'text/plain' });
        res.end(url.pathname === '/' ? 'FireLab MCP server: POST /mcp (Streamable HTTP)\n' : 'Not found\n');
        return;
      }
      const sid = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      if (req.method === 'POST') {
        const body = await readJson(req);
        let transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          if (sessionId || !isInitializeRequest(body)) {
            res.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sessionId ? 'Unknown session' : 'Send initialize first' }, id: null }));
            return;
          }
          const t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, t);
            },
            enableDnsRebindingProtection: host === '127.0.0.1' || host === 'localhost',
            allowedHosts,
          });
          t.onclose = () => {
            if (t.sessionId) sessions.delete(t.sessionId);
          };
          await createMcpServer(lab).connect(t);
          transport = t;
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        const transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('Missing or unknown mcp-session-id\n');
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(405, { allow: 'GET, POST, DELETE' });
      res.end();
    } catch (e) {
      log.warn('MCP HTTP request failed', e);
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: (e as Error).message }, id: null }));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => resolve());
  });
  srv.on('close', () => {
    for (const t of sessions.values()) void t.close();
    sessions.clear();
  });
  return srv;
}
