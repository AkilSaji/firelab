import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { explore } from '../../src/engine/index.js';
import { fakeLab } from '../helpers/fake-lab.js';
import { SimGame, PKG } from './sim-app.js';

describe('MCP explore tools', () => {
  const world = fakeLab();
  const client = new Client({ name: 'test', version: '1.0.0' });
  let dir = '';
  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(world.lab).connect(a), client.connect(b)]);
    const sim = new SimGame(['crash', 'throw']);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-mcp-'));
    await explore({ driver: sim.driver as never, clock: sim.clock, package: PKG, minutes: 4, out: dir, minimizeMinutes: 2 });
  });
  afterAll(async () => {
    await client.close();
    await world.lab.close();
  });

  it('explore_findings reads a finished run, most severe first, with repro keys and images', async () => {
    const r = await client.callTool({ name: 'explore_findings', arguments: { runId: dir } });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { findings: { severity: string; kind: string; keys: string[] }[] };
    expect(s.findings[0]?.severity).toBe('critical');
    expect(s.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(['crash', 'js-exception']));
    expect(s.findings.find((f) => f.kind === 'crash')?.keys.at(-1)).toBe('ok');
    expect((r.content as { type: string }[]).some((c) => c.type === 'image')).toBe(true);
  });

  it('explore_status of a finished run, and errors for unknown ones', async () => {
    const r = await client.callTool({ name: 'explore_status', arguments: { runId: dir } });
    expect(r.structuredContent).toMatchObject({ status: 'done' });
    const bad = await client.callTool({ name: 'explore_stop', arguments: { runId: 'nope' } });
    expect(bad.isError).toBe(true);
  });

  it('explore_start with driver "demo" runs on the simulated game with no device', async () => {
    const r = await client.callTool({ name: 'explore_start', arguments: { driver: 'demo', minutes: 3, minimize: false } });
    expect(r.isError).toBeFalsy();
    const { runId } = r.structuredContent as { runId: string };
    let status = '';
    for (let i = 0; i < 100 && status !== 'done'; i++) {
      const st = await client.callTool({ name: 'explore_status', arguments: { runId } });
      status = (st.structuredContent as { status: string }).status;
      if (status !== 'done') await new Promise((res) => setTimeout(res, 100));
    }
    expect(status).toBe('done');
    const f = await client.callTool({ name: 'explore_findings', arguments: { runId } });
    expect((f.structuredContent as { findings: unknown[] }).findings.length).toBeGreaterThan(0);
  });

  it('explore_start refuses the protected package without touching the TV', async () => {
    const r = await client.callTool({ name: 'explore_start', arguments: { package: 'com.sunsetvilla.tv', minutes: 1 } });
    expect(r.isError).toBe(true);
  });
});
