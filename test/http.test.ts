import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDashboardHandler } from '../src/http/server.js';
import { decodeJpeg } from '../src/adb/image.js';
import { fakeLab } from './helpers/fake-lab.js';
import { SERIAL } from './helpers/fake-adb.js';

const ID = encodeURIComponent(SERIAL);

async function serve(handler: http.RequestListener) {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  return { srv, base };
}

describe('dashboard HTTP API', () => {
  const world = fakeLab();
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-ui-'));
  let base = '';
  let srv: http.Server;
  const post = (p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>FireLab UI</title>');
    fs.writeFileSync(path.join(uiDir, 'app.js'), 'console.log(1)');
    ({ srv, base } = await serve(createDashboardHandler(world.lab, { uiDir })));
  });
  afterAll(async () => {
    await world.lab.close();
    srv.close();
  });

  it('GET /api/health reports adb and the FireLab version', async () => {
    const j = await (await fetch(`${base}/api/health`)).json();
    expect(j).toMatchObject({ ok: true, adb: { path: '/fake/adb', version: '1.0.41 (platform-tools 37.0.1-15733141)' }, version: expect.any(String) });
  });

  it('GET /api/devices returns contract Device objects', async () => {
    const j = (await (await fetch(`${base}/api/devices`)).json()) as Record<string, unknown>[];
    expect(j[0]).toMatchObject({ id: SERIAL, ip: '192.168.1.194', state: 'device', model: 'AFTMA08C15', name: 'Fire TV Stick 4K Plus', os: 'Fire OS 8.1.8.2 (Android 11)', abi: 'armeabi-v7a', ramMB: 1670, gpu: 'PowerVR GE9215', tier: 'tv-hd', resolution: { width: 1920, height: 1080 } });
  });

  it('POST /keys presses keys in one batch and validates input', async () => {
    world.runner.calls = [];
    const r = await post(`/api/devices/${ID}/keys`, { keys: ['up', 'up', 'ok'] });
    expect(await r.json()).toEqual({ ok: true });
    expect(world.runner.shellCommands()).toContain('input keyevent 19 19 23');
    const bad = await post(`/api/devices/${ID}/keys`, { keys: [] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: expect.stringMatching(/keys/) });
    const unknown = await post(`/api/devices/${ID}/keys`, { keys: ['jump'] });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).hint).toMatch(/up, down/);
  });

  it('POST /text and /wake', async () => {
    expect(await (await post(`/api/devices/${ID}/text`, { text: 'hi there' })).json()).toEqual({ ok: true });
    expect(world.runner.shellCommands()).toContain("input text 'hi%sthere'");
    expect(await (await post(`/api/devices/${ID}/wake`)).json()).toMatchObject({ ok: true, woke: false });
  });

  it('GET /screen.jpg returns a JPEG of the requested width', async () => {
    const r = await fetch(`${base}/api/devices/${ID}/screen.jpg?w=64`);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    const img = decodeJpeg(Buffer.from(await r.arrayBuffer()));
    expect([img.width, img.height]).toEqual([64, 36]);
  });

  it('apps: list, launch errors, stop, reset needs confirm', async () => {
    expect(await (await fetch(`${base}/api/devices/${ID}/apps`)).json()).toEqual({ apps: [{ package: 'com.example.game', version: '1.0.3', versionCode: 3, launchable: true }] });
    expect(await (await post(`/api/devices/${ID}/apps/stop`, { package: 'com.example.game' })).json()).toMatchObject({ ok: true });
    const noConfirm = await post(`/api/devices/${ID}/apps/reset`, { package: 'com.example.game' });
    expect(noConfirm.status).toBe(400);
    expect(await noConfirm.json()).toMatchObject({ code: 'confirm-required' });
    expect(world.runner.shellCommands().some((c) => c.startsWith('pm clear'))).toBe(false);
    expect(await (await post(`/api/devices/${ID}/apps/reset`, { package: 'com.example.game', confirm: true })).json()).toMatchObject({ ok: true });
    const badPkg = await post(`/api/devices/${ID}/apps/stop`, { package: 'x; reboot' });
    expect(badPkg.status).toBe(400);
  });

  it('webview eval explains when there is no debuggable WebView', async () => {
    const r = await post(`/api/devices/${ID}/webview/eval`, { expression: 'document.title' });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'no-webview', hint: expect.stringMatching(/setWebContentsDebuggingEnabled/) });
  });

  it('logcat for an app', async () => {
    const j = await (await fetch(`${base}/api/devices/${ID}/logcat?package=com.example.game&lines=10`)).json();
    expect(j).toMatchObject({ pid: 4242, lines: [{ tag: 'GameMain', text: 'boom', level: 'error' }] });
  });

  it('sweep needs a URL; unknown jobs are 404; sessions start empty', async () => {
    const r = await post(`/api/devices/${ID}/sweep`, {});
    expect(r.status).toBe(400);
    expect((await fetch(`${base}/api/jobs/nope`)).status).toBe(404);
    expect(await (await fetch(`${base}/api/sessions`)).json()).toEqual([]);
    expect((await post(`/api/devices/${ID}/watch/stop`)).status).toBe(404);
  });

  it('runs sweeps as jobs: the job echoes the request and criteria, and its SSE stream ends after done', async () => {
    const r = await post(`/api/devices/${ID}/sweep`, { url: 'http://192.168.1.164:4173/', tiers: ['tv', 'tv-hd'], targetFps: 30 });
    const { jobId } = (await r.json()) as { jobId: string };
    expect(jobId).toMatch(/^sw_/);
    const res = await fetch(`${base}/api/jobs/${jobId}/stream`);
    const text = await res.text(); // resolves only because the server closes the stream after `done`
    expect(text).toContain('event: done');
    const done = JSON.parse(/event: done\ndata: (.*)\n/.exec(text)?.[1] ?? '{}');
    expect(done).toMatchObject({
      id: jobId,
      status: 'error',
      error: expect.stringMatching(/debuggable WebView/),
      request: { url: 'http://192.168.1.164:4173/', tiers: ['tv', 'tv-hd'], param: 'q', targetFps: 30 },
      criteria: { targetFps: 30, minP10: 24, tolerance: 0.05 },
    });
    expect(await (await fetch(`${base}/api/jobs/${jobId}`)).json()).toMatchObject({ id: jobId, status: 'error' });
    const bad = await post(`/api/devices/${ID}/sweep`, { url: 'localhost:4173' });
    expect(bad.status).toBe(400);
  });

  it('scan echoes the subnet it scanned', async () => {
    const j = await (await post('/api/scan', { subnet: '127.0.0.1/32' })).json();
    expect(j).toMatchObject({ subnet: '127.0.0.1/32', found: expect.any(Array) });
  });

  it('protects the API: cross-origin writes, foreign Host headers and non-JSON bodies are refused', async () => {
    const xo = await post(`/api/devices/${ID}/keys`, { keys: ['home'] }, { origin: 'https://evil.example' });
    expect(xo.status).toBe(403);
    const plain = await fetch(`${base}/api/devices/${ID}/keys`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"keys":["home"]}' });
    expect(plain.status).toBe(415);
    const port = new URL(base).port;
    const rebind = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/devices', headers: { host: `attacker.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    expect(rebind).toBe(403);
    const same = await post(`/api/devices/${ID}/wake`, undefined, { origin: base });
    expect(same.status).toBe(200);
  });

  it('404s unknown routes and 405s wrong methods', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    const r = await fetch(`${base}/api/devices`, { method: 'DELETE' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
  });

  it('serves ui/ statically, falls back to the shell for routes, and blocks traversal', async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain('FireLab UI');
    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toMatch(/javascript/);
    expect(await (await fetch(`${base}/sessions/abc`)).text()).toContain('FireLab UI');
    expect((await fetch(`${base}/missing.css`)).status).toBe(404);
    const get = (p: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        http.get({ host: '127.0.0.1', port: new URL(base).port, path: p }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
      });
    const raw = await get('/../../etc/passwd');
    expect(raw.body).not.toMatch(/root:/);
    expect((await get('/%2e%2e/%2e%2e/etc/passwd')).body).not.toMatch(/root:/); // URL parsing folds these
    const encoded = await get('/..%2f..%2f..%2fetc%2fpasswd');
    expect(encoded.status).toBe(403);
  });

  it('streams device events over SSE', async () => {
    const ctrl = new AbortController();
    const r = await fetch(`${base}/api/devices/${ID}/stream`, { signal: ctrl.signal });
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = r.body!.getReader();
    let text = '';
    const deadline = Date.now() + 3000;
    while (!text.includes('event: state') && Date.now() < deadline) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    expect(text).toContain('event: state');
    const data = JSON.parse(/event: state\ndata: (.*)\n/.exec(text)?.[1] ?? '{}');
    expect(data).toMatchObject({ connected: true, foreground: 'com.amazon.tv.launcher', screenOn: true });
  });
});

describe('dashboard without ui/', () => {
  it('serves a working placeholder page', async () => {
    const world = fakeLab();
    const { srv, base } = await serve(createDashboardHandler(world.lab, { uiDir: path.join(os.tmpdir(), 'firelab-no-ui-here') }));
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<title>FireLab</title>');
    expect(html).toContain('/api/devices');
    srv.close();
    await world.lab.close();
  });
});
