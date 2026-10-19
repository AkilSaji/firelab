import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, TOOL_NAMES } from '../src/mcp/server.js';
import { fakeLab } from './helpers/fake-lab.js';
import { SERIAL } from './helpers/fake-adb.js';

describe('MCP server', () => {
  const world = fakeLab();
  const client = new Client({ name: 'test', version: '1.0.0' });

  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(world.lab).connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
    await world.lab.close();
  });

  it('registers every contract tool with a description and an input schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES).toHaveLength(25);
    for (const t of tools) {
      expect(t.description?.length, t.name).toBeGreaterThan(60);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('marks state-changing tools and says what they change', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ['reset_app', 'install_app', 'stop_app']) {
      expect(byName[n]?.annotations?.destructiveHint, n).toBe(true);
      expect(byName[n]?.description).toMatch(/CHANGES|DELETES/);
    }
    expect(byName.reset_app?.inputSchema.required).toContain('confirm');
    expect(byName.list_devices?.annotations?.readOnlyHint).toBe(true);
    expect(byName.screenshot?.annotations?.readOnlyHint).toBe(true);
  });

  it('offers the playtest and tune_performance prompts', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["explore_app", "playtest", "tune_performance"]);
    const p = await client.getPrompt({ name: 'tune_performance', arguments: { url: 'http://192.168.1.20:4173/', tiers: 'tv,tv-hd' } });
    const text = (p.messages[0]?.content as { text: string }).text;
    expect(text).toContain('performance_sweep');
    expect(text).toContain('["tv","tv-hd"]');
  });

  it('list_devices returns JSON text and structured content', async () => {
    const r = await client.callTool({ name: 'list_devices', arguments: {} });
    const sc = r.structuredContent as { devices: { id: string; name: string }[] };
    expect(sc.devices[0]).toMatchObject({ id: SERIAL, name: 'Fire TV Stick 4K Plus' });
    expect((r.content as { type: string; text: string }[])[0]?.text).toContain('"Fire TV Stick 4K Plus"');
  });

  it('press_keys drives the remote (device optional with one device)', async () => {
    world.runner.calls = [];
    const r = await client.callTool({ name: 'press_keys', arguments: { keys: ['down*2', 'ok'] } });
    expect(r.isError).toBeFalsy();
    expect(world.runner.shellCommands()).toContain('input keyevent 20 20 23');
  });

  it('screenshot returns an image', async () => {
    const r = await client.callTool({ name: 'screenshot', arguments: { width: 160 } });
    const content = r.content as { type: string; mimeType?: string; data?: string; text?: string }[];
    expect(content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(Buffer.from(content[0]?.data ?? '', 'base64')[0]).toBe(0xff);
    expect(JSON.parse(content[1]?.text ?? '{}')).toMatchObject({ device: SERIAL, width: 128 });
  });

  it('reset_app refuses without confirm: true (schema) and works with it', async () => {
    const bad = await client.callTool({ name: 'reset_app', arguments: { package: 'com.example.game' } });
    expect(bad.isError).toBe(true);
    expect(world.runner.shellCommands().some((c) => c.startsWith('pm clear'))).toBe(false);
    const ok = await client.callTool({ name: 'reset_app', arguments: { package: 'com.example.game', confirm: true } });
    expect(ok.isError).toBeFalsy();
  });

  it('turns FireLab errors into readable tool errors with hints', async () => {
    const r = await client.callTool({ name: 'webview_eval', arguments: { expression: 'document.title' } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]?.text).toMatch(/No debuggable WebView.*setWebContentsDebuggingEnabled.*\[no-webview\]/);
    const k = await client.callTool({ name: 'press_keys', arguments: { keys: ['jump'] } });
    expect((k.content as { text: string }[])[0]?.text).toMatch(/Unknown key "jump"/);
  });

  it('logcat and list_apps', async () => {
    const l = await client.callTool({ name: 'logcat', arguments: { package: 'com.example.game', level: 'error' } });
    expect((l.structuredContent as { lines: { text: string }[] }).lines[0]?.text).toBe('boom');
    const a = await client.callTool({ name: 'list_apps', arguments: {} });
    expect((a.structuredContent as { apps: { package: string }[] }).apps[0]?.package).toBe('com.example.game');
  });
});

describe('MCP over Streamable HTTP', () => {
  it('serves the same tools at /mcp and rejects foreign Host headers', async () => {
    const net = await import('node:net');
    const http = await import('node:http');
    const { runHttp } = await import('../src/mcp/transports.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as import('node:net').AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const world = fakeLab();
    const srv = await runHttp(world.lab, port);
    const c = new Client({ name: 'http-test', version: '1' });
    try {
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const { tools } = await c.listTools();
      expect(tools).toHaveLength(25);
      const r = await c.callTool({ name: 'list_devices', arguments: {} });
      expect((r.structuredContent as { devices: unknown[] }).devices).toHaveLength(1);
      const status = await new Promise<number>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: `evil.example:${port}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }));
      });
      expect(status).toBeGreaterThanOrEqual(400);
    } finally {
      await c.close();
      srv.close();
      await world.lab.close();
    }
  });
});
