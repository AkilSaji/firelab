import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDashboardHandler } from '../src/http/server.js';
import { sessionTrace } from '../src/core/runs.js';
import { fakeLab } from './helpers/fake-lab.js';
import { SERIAL } from './helpers/fake-adb.js';

const ID = encodeURIComponent(SERIAL);

type Job = { id: string; kind: string; status: string; verdict?: string; runId?: string; report?: string; steps?: number; log: { text: string }[]; findings?: Record<string, number> };

/** Reads an SSE stream until the server closes it and returns the last `done` payload. */
async function untilDone(base: string, testId: string): Promise<Job> {
  const text = await (await fetch(`${base}/api/tests/${testId}/stream`)).text();
  const m = [...text.matchAll(/event: done\ndata: (.*)\n/g)].pop();
  return JSON.parse(m?.[1] ?? '{}') as Job;
}

describe('dashboard test-engine API', () => {
  const world = fakeLab();
  const prevHome = process.env.FIRELAB_HOME;
  let base = '';
  let srv: http.Server;
  const get = (p: string) => fetch(base + p);
  const post = (p: string, body: unknown = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    // The engine writes runs to $FIRELAB_HOME/explore; benchmarks live in $FIRELAB_HOME/bench.
    process.env.FIRELAB_HOME = world.home;
    world.runner.on(/shell cat \/proc\/net\/dev/, (args) =>
      (args[3] as string).includes('thermalservice')
        ? ' wlan0: 5000000 10 0 0 0 0 0 0 200000 5 0 0 0 0 0 0\n@@thermal\nCurrent temperatures from HAL:\n\tTemperature{mValue=47.5, mType=0, mName=cpu, mStatus=0}\n@@zones\n'
        : ' wlan0: 6000000 10 0 0 0 0 0 0 300000 5 0 0 0 0 0 0\n',
    );
    srv = http.createServer(createDashboardHandler(world.lab, { uiDir: fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-ui-')) }));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  });
  afterAll(async () => {
    await world.lab.close();
    srv.close();
    if (prevHome === undefined) delete process.env.FIRELAB_HOME;
    else process.env.FIRELAB_HOME = prevHome;
  });

  it('GET /vitals: temperature from the thermal HAL, network after a second reading', async () => {
    const a = await (await get(`/api/devices/${ID}/vitals`)).json();
    expect(a).toMatchObject({ device: SERIAL, network: null, networkNote: expect.stringMatching(/first reading/), temperature: { c: 47.5, sensor: 'cpu', source: 'thermalservice' } });
    const again = await (await get(`/api/devices/${ID}/vitals`)).json();
    expect(again.ts).toBe(a.ts); // never faster than every 2 s
  });

  it('GET /api/gpu/models lists Fire TV models with their GPU and whether it can be emulated', async () => {
    const j = (await (await get('/api/gpu/models')).json()) as { models: { model: string; gpu?: string; emulatable: boolean; reason?: string }[]; note: string };
    expect(j.note).toMatch(/not its speed/);
    expect(j.models.find((m) => m.model === 'AFTSSS')).toMatchObject({ gpu: 'PowerVR GE8300', emulatable: true, tier: 'tv' });
    expect(j.models.length).toBeGreaterThan(20);
  });

  it('validates test requests', async () => {
    expect((await post(`/api/devices/${ID}/tests/gpu`, {})).status).toBe(400);
    const unknown = await post(`/api/devices/${ID}/tests/gpu`, { model: 'NOPE1' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toMatch(/Unknown Fire TV model/);
    const prot = await post(`/api/devices/${ID}/tests/app-launch`, { package: 'com.sunsetvilla.tv' });
    expect(prot.status).toBe(400);
    expect(await prot.json()).toMatchObject({ code: 'confirm-required' });
    expect((await post(`/api/devices/${ID}/tests/explore`, { driver: 'demo', strategy: 'smart' })).status).toBe(400);
    expect((await post(`/api/devices/${ID}/tests/explore`, { driver: 'demo', keys: ['jump'] })).status).toBe(400);
    expect((await post(`/api/devices/${ID}/tests/replay`, {})).status).toBe(400);
    expect((await get('/api/tests/t_nope')).status).toBe(404);
  });

  let runId = '';
  let job: Job;

  it('runs an explore job (demo game), streams it to done, and lists the run with its report', async () => {
    const r = await post(`/api/devices/${ID}/tests/explore`, { driver: 'demo', steps: 40, minimize: false, seed: 3 });
    expect(r.status).toBe(200);
    const started = (await r.json()) as Job;
    expect(started).toMatchObject({ kind: 'explore', status: 'running' });
    job = await untilDone(base, started.id);
    expect(job).toMatchObject({ id: started.id, status: 'done', verdict: expect.stringMatching(/pass|fail/), runId: expect.stringMatching(/^ex-/) });
    expect(job.steps).toBeGreaterThanOrEqual(40);
    runId = job.runId as string;
    expect(job.report).toBe(`/api/runs/${runId}/report.html`);
    expect(job.log.length).toBeGreaterThan(1);

    const runs = (await (await get('/api/runs')).json()) as { runId: string; steps: number; demo: boolean; report?: string; findings: Record<string, number> }[];
    expect(runs.find((x) => x.runId === runId)).toMatchObject({ steps: job.steps, demo: true, report: job.report });
    const detail = await (await get(`/api/runs/${runId}`)).json();
    expect(detail).toMatchObject({ runId, findingList: expect.any(Array) });

    const rep = await get(`/api/runs/${runId}/report.html`);
    expect(rep.status).toBe(200);
    expect(rep.headers.get('content-type')).toMatch(/text\/html/);
    expect(rep.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(await rep.text()).toContain('<html');

    const hist = (await (await get('/api/tests')).json()) as Job[];
    expect(hist[0]).toMatchObject({ id: job.id, status: 'done' });
    expect((await (await get(`/api/tests/${job.id}/findings`)).json()).findings).toEqual(expect.any(Array));
    // The history survives a restart: it is on disk.
    expect(fs.existsSync(path.join(world.home, 'tests', `${job.id}.json`))).toBe(true);
  });

  it('lists finding traces as scenarios and replays one, remembering the last result', async () => {
    const sc = (await (await get('/api/scenarios')).json()) as { sessions: unknown[]; traces: { runId: string; file: string; keys: string[]; lastReplay: unknown }[] };
    const t = sc.traces.find((x) => x.runId === runId);
    if (!t) return; // this seed found nothing to replay
    expect(t.keys.length).toBeGreaterThan(0);
    const r = await post(`/api/devices/${ID}/tests/replay`, { runId, trace: t.file });
    expect(r.status).toBe(200);
    const done = await untilDone(base, ((await r.json()) as Job).id);
    expect(done).toMatchObject({ kind: 'replay', status: 'done', verdict: expect.stringMatching(/pass|fail/) });
    const after = (await (await get('/api/scenarios')).json()) as typeof sc;
    expect(after.traces.find((x) => x.runId === runId && x.file === t.file)?.lastReplay).toMatchObject({ jobId: done.id, runs: 1 });
  });

  it('serves run files safely', async () => {
    expect((await get(`/api/runs/${runId}/graph.json`)).status).toBe(404);
    expect((await get('/api/runs/..%2F..%2Fetc/report.html')).status).toBe(400);
    expect((await get(`/api/runs/${runId}/traces/..%2F..%2Frun.json`)).status).toBe(400);
    expect((await get('/api/runs/ex-nope/report.html')).status).toBe(404);
    expect((await get('/api/tests/t_x/files/..%2F..%2Fsecret')).status).toBe(400);
  });

  it('lists benchmark reports, tolerating missing fields and skipping other folders', async () => {
    const root = path.join(world.home, 'bench');
    fs.mkdirSync(path.join(root, 'b-2026-10-18'), { recursive: true });
    fs.writeFileSync(path.join(root, 'b-2026-10-18', 'bench.json'), JSON.stringify({ kind: 'firelab-bench', id: 'b-2026-10-18', createdAt: 1792300000000, title: 'Explore vs random', subjects: ['lantern-lake'], strategies: ['explore', 'random'], headline: '2.1x more states' }));
    fs.writeFileSync(path.join(root, 'b-2026-10-18', 'report.html'), '<!doctype html><title>bench</title>');
    fs.mkdirSync(path.join(root, 'partial'), { recursive: true });
    fs.writeFileSync(path.join(root, 'partial', 'bench.json'), JSON.stringify({ kind: 'firelab-bench' }));
    fs.mkdirSync(path.join(root, 'other'), { recursive: true });
    fs.writeFileSync(path.join(root, 'other', 'bench.json'), JSON.stringify({ kind: 'something-else' }));
    const j = (await (await get('/api/reports')).json()) as { engine: { runId: string }[]; bench: { id: string; title: string; report?: string; subjects: string[] }[] };
    expect(j.engine.some((x) => x.runId === runId)).toBe(true);
    expect(j.bench.map((b) => b.id)).toEqual(['b-2026-10-18', 'partial']);
    expect(j.bench[0]).toMatchObject({ title: 'Explore vs random', headline: '2.1x more states', report: '/api/bench/b-2026-10-18/report.html' });
    expect(j.bench[1]).toMatchObject({ title: 'partial', subjects: [], strategies: [] });
    expect(j.bench[1]?.report).toBeUndefined();
    const page = await get('/api/bench/b-2026-10-18/report.html');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect((await get('/api/bench/b-2026-10-18/bench.json')).status).toBe(200);
    expect((await get('/api/bench/..%2Fexplore/report.html')).status).toBe(400);
  });

  it('turns a watch session into a replayable trace with the recorded gaps', async () => {
    const dir = path.join(world.lab.sessionsDir, 'w_abc123');
    fs.mkdirSync(dir, { recursive: true });
    const t0 = 1_760_000_000_000;
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ sessionId: 'w_abc123', device: SERIAL, package: 'com.example.game', startedAt: t0, endedAt: t0 + 9000, keys: 3, errors: 0, thumbnails: [] }));
    const ev = (o: object) => JSON.stringify(o);
    fs.writeFileSync(
      path.join(dir, 'timeline.jsonl'),
      [
        ev({ type: 'start', ts: t0 }),
        ev({ type: 'key', ts: t0 + 1200, key: 'right', action: 'down' }),
        ev({ type: 'key', ts: t0 + 1300, key: 'right', action: 'up', holdMs: 100 }),
        ev({ type: 'key', ts: t0 + 2000, key: 'ok', action: 'down' }),
        ev({ type: 'key', ts: t0 + 2900, key: 'ok', action: 'up', holdMs: 900 }),
        ev({ type: 'key', ts: t0 + 4000, key: 'volup', action: 'down' }),
        'not json',
      ].join('\n'),
    );
    const t = sessionTrace(world.lab.sessionsDir, 'w_abc123');
    expect(t.app.package).toBe('com.example.game');
    expect(t.steps.map((s) => [s.action, s.gapMs])).toEqual([
      [{ kind: 'key', key: 'right' }, 1200],
      [{ kind: 'key', key: 'ok', mode: 'hold', holdMs: 900 }, 800],
    ]);
    const sc = (await (await get('/api/scenarios')).json()) as { sessions: { sessionId: string; keySequence: string[]; replayable: boolean }[] };
    expect(sc.sessions.find((s) => s.sessionId === 'w_abc123')).toMatchObject({ replayable: true, keySequence: ['right', 'ok:900'] });
    expect(() => sessionTrace(world.lab.sessionsDir, '../x')).toThrow(/Bad session id/);
  });
});
