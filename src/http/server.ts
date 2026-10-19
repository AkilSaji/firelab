import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { FireLab } from '../core/firelab.js';
import type { WatchSummary } from '../perf/watch.js';
import { FireLabError, httpStatus } from '../lib/errors.js';
import { packageRoot } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { PLACEHOLDER_HTML } from './placeholder.js';
import { startAppLaunch, startExplore, startGpuCheck, startPerformance, startReplay, gpuModels, lastReplays, testFindings, type ExploreOptions } from '../core/test-runs.js';
import { benchFile, listBench, listRuns, listTraces, runDetail, runFile, safeName, sessionKeys } from '../core/runs.js';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;
type Params = Record<string, string>;
type Handler = (ctx: { req: Req; res: Res; params: Params; query: URLSearchParams; body: () => Promise<Record<string, unknown>> }) => Promise<unknown> | unknown;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

/**
 * Reports are pages FireLab wrote, served from the API's origin: a sandbox
 * (opaque origin) keeps anything inside them from calling the API.
 */
const REPORT_HEADERS = { 'content-security-policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads', 'x-content-type-options': 'nosniff' };

function sendFile(res: http.ServerResponse, file: string, extra: Record<string, string> = {}): void {
  const ext = path.extname(file).toLowerCase();
  const html = ext === '.html';
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...(html ? REPORT_HEADERS : { 'x-content-type-options': 'nosniff' }), ...extra });
  fs.createReadStream(file).pipe(res);
}

/** A sent response that isn't JSON (images, SSE): handlers return this to say "already handled". */
const HANDLED = Symbol('handled');

export type DashboardOptions = {
  port?: number;
  host?: string;
  /** Folder with the dashboard's static files (default: <package>/ui). */
  uiDir?: string;
};

class Router {
  private routes: { method: string; parts: string[]; handler: Handler }[] = [];
  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }
  match(method: string, pathname: string): { handler: Handler; params: Params } | { allowed: string[] } | null {
    const segs = pathname.split('/').filter(Boolean);
    const allowed: string[] = [];
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i] as string;
        const s = segs[i] as string;
        if (p.startsWith(':')) {
          try {
            params[p.slice(1)] = decodeURIComponent(s);
          } catch {
            ok = false;
          }
        } else if (p !== s) ok = false;
        if (!ok) break;
      }
      if (!ok) continue;
      if (r.method === method) return { handler: r.handler, params };
      allowed.push(r.method);
    }
    return allowed.length ? { allowed } : null;
  }
}

function sendJson(res: Res, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req: Req, limit = 1 << 20): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new FireLabError('bad-request', 'Request body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new FireLabError('bad-request', 'Body must be a JSON object');
  }
}

/** Server-sent events helper: returns a writer and calls `onClose` when the client leaves. */
export function openSse(req: Req, res: Res, onClose: () => void): (event: string, data: unknown) => void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': connected\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    onClose();
  };
  req.on('close', close);
  res.on('close', close);
  return (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

const str = (v: unknown, name: string, required = true): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new FireLabError('bad-request', `Missing "${name}"`);
    return undefined;
  }
  if (typeof v !== 'string') throw new FireLabError('bad-request', `"${name}" must be a string`);
  return v;
};
const num = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new FireLabError('bad-request', `"${name}" must be a number`);
  return n;
};
const bool = (v: unknown, name: string): boolean | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new FireLabError('bad-request', `"${name}" must be true or false`);
  return v;
};
const strList = (v: unknown, name: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new FireLabError('bad-request', `"${name}" must be an array of strings`);
  return v as string[];
};

/** Thumbnails as dashboard URLs instead of file names. */
function withThumbUrls(s: WatchSummary): WatchSummary {
  const { dir: _dir, ...rest } = s;
  return { ...rest, thumbnails: s.thumbnails.map((t) => (t.startsWith('/') ? t : `/api/sessions/${encodeURIComponent(s.sessionId)}/${encodeURIComponent(t)}`)) };
}

/** Builds the dashboard HTTP API (docs/CONTRACT.md) plus static files from ui/. */
export function createDashboardHandler(lab: FireLab, opts: DashboardOptions = {}): http.RequestListener {
  const r = new Router();
  const uiDir = opts.uiDir ?? path.join(packageRoot(), 'ui');
  const shots = new Map<string, { at: number; p: Promise<{ data: Buffer }> }>();

  r.add('GET', '/api/health', () => lab.health());
  r.add('GET', '/api/devices', () => lab.listDevices());
  r.add('POST', '/api/scan', async ({ body }) => lab.scan(str((await body()).subnet, 'subnet', false)));
  r.add('GET', '/api/devices/:id', ({ params }) => lab.deviceInfo(params.id));
  r.add('POST', '/api/devices/:id/connect', ({ params }) => lab.connect(params.id as string));
  r.add('POST', '/api/devices/:id/disconnect', ({ params }) => lab.disconnect(params.id as string));

  const screen = (format: 'jpeg' | 'png') => async ({ params, query, res }: Parameters<Handler>[0]) => {
    const w = Math.min(Math.max(num(query.get('w'), 'w') ?? 960, 64), 3840);
    const key = `${params.id}|${format}|${w}`;
    let entry = shots.get(key);
    // Several dashboard tabs polling at once share one capture.
    if (!entry || Date.now() - entry.at > 400) {
      entry = { at: Date.now(), p: lab.screenshot(params.id, { width: w, format }) };
      shots.set(key, entry);
      entry.p.catch(() => shots.delete(key));
    }
    const s = await entry.p;
    res.writeHead(200, { 'content-type': format === 'png' ? 'image/png' : 'image/jpeg', 'cache-control': 'no-store', 'content-length': s.data.length });
    res.end(s.data);
    return HANDLED;
  };
  r.add('GET', '/api/devices/:id/screen.jpg', screen('jpeg'));
  r.add('GET', '/api/devices/:id/screen.png', screen('png'));

  r.add('POST', '/api/devices/:id/keys', async ({ params, body }) => {
    const b = await body();
    const keys = strList(b.keys, 'keys');
    if (!keys?.length) throw new FireLabError('bad-request', 'Missing "keys"', { hint: 'e.g. { "keys": ["up", "ok"] }' });
    await lab.pressKeys(params.id, keys, { holdMs: num(b.holdMs, 'holdMs'), gapMs: num(b.gapMs, 'gapMs') });
    return { ok: true };
  });
  r.add('POST', '/api/devices/:id/text', async ({ params, body }) => lab.typeText(params.id, str((await body()).text, 'text') as string));
  r.add('POST', '/api/devices/:id/wake', ({ params }) => lab.wake(params.id));
  r.add('GET', '/api/devices/:id/apps', async ({ params }) => ({ apps: (await lab.apps(params.id)).apps }));
  r.add('POST', '/api/devices/:id/apps/launch', async ({ params, body }) => {
    const b = await body();
    return lab.launch(params.id, str(b.package, 'package') as string, { url: str(b.url, 'url', false) });
  });
  r.add('POST', '/api/devices/:id/apps/stop', async ({ params, body }) => lab.stop(params.id, str((await body()).package, 'package') as string));
  r.add('POST', '/api/devices/:id/apps/reset', async ({ params, body }) => {
    const b = await body();
    return lab.reset(params.id, str(b.package, 'package') as string, b.confirm === true);
  });
  r.add('POST', '/api/devices/:id/apps/install', async ({ params, body }) => lab.install(params.id, str((await body()).path, 'path') as string));
  r.add('POST', '/api/devices/:id/webview/eval', async ({ params, body }) => {
    const b = await body();
    const out = await lab.evaluate(params.id, str(b.expression, 'expression') as string, { package: str(b.package, 'package', false), timeoutMs: num(b.timeoutMs, 'timeoutMs') });
    return { value: out.value === undefined ? null : out.value, package: out.package, url: out.url };
  });
  r.add('GET', '/api/devices/:id/webview/console', ({ params, query }) =>
    lab.consoleLogs(params.id, { package: query.get('package') ?? undefined, since: num(query.get('since'), 'since'), limit: num(query.get('limit'), 'limit') }),
  );
  r.add('POST', '/api/devices/:id/measure', async ({ params, body }) => {
    const b = await body();
    return lab.measure(params.id, { package: str(b.package, 'package', false), seconds: num(b.seconds, 'seconds'), fpsExpr: str(b.fpsExpr, 'fpsExpr', false) });
  });
  r.add('GET', '/api/devices/:id/logcat', ({ params, query }) =>
    lab.logcat(params.id, {
      package: query.get('package') ?? undefined,
      lines: num(query.get('lines'), 'lines'),
      minLevel: (query.get('level') as 'warn' | null) ?? undefined,
    }),
  );

  r.add('GET', '/api/devices/:id/stream', async ({ req, res, params }) => {
    const m = await lab.monitor(params.id as string);
    let unsub: () => void = () => {};
    const send = openSse(req, res, () => unsub());
    unsub = m.subscribe({
      perf: (e) => send('perf', e),
      log: (e) => send('log', e),
      key: (e) => send('key', e),
      state: (e) => send('state', e),
      vitals: (e) => send('vitals', e),
    });
    return HANDLED;
  });

  r.add('GET', '/api/devices/:id/vitals', ({ params }) => lab.vitals(params.id as string));

  r.add('POST', '/api/devices/:id/sweep', async ({ params, body }) => {
    const b = await body();
    const action = b.action as { keys?: unknown; eval?: unknown } | undefined;
    const job = await lab.startSweep(params.id, {
      url: str(b.url, 'url') as string,
      package: str(b.package, 'package', false),
      tiers: strList(b.tiers, 'tiers'),
      param: str(b.param, 'param', false),
      warmupS: num(b.warmupS, 'warmupS'),
      sampleS: num(b.sampleS, 'sampleS'),
      targetFps: num(b.targetFps, 'targetFps'),
      minP10: num(b.minP10, 'minP10'),
      fpsExpr: str(b.fpsExpr, 'fpsExpr', false),
      action: action ? { keys: strList(action.keys, 'action.keys'), eval: str(action.eval, 'action.eval', false) } : undefined,
    });
    return { jobId: job.id };
  });
  r.add('GET', '/api/jobs', () => lab.jobs.list());
  r.add('GET', '/api/jobs/:jobId', ({ params }) => {
    const j = lab.jobs.get(params.jobId as string);
    if (!j) throw new FireLabError('not-found', `No job ${params.jobId}`);
    return j;
  });
  r.add('POST', '/api/jobs/:jobId/cancel', ({ params }) => ({ ok: lab.jobs.cancel(params.jobId as string) }));
  r.add('GET', '/api/jobs/:jobId/stream', ({ req, res, params }) => {
    const id = params.jobId as string;
    const j = lab.jobs.get(id);
    if (!j) throw new FireLabError('not-found', `No job ${id}`);
    const onProgress = (job: { id: string }, p: unknown) => job.id === id && send('progress', { ...lab.jobs.get(id), event: p });
    const onDone = (job: { id: string }) => {
      if (job.id !== id) return;
      send('done', lab.jobs.get(id));
      res.end();
    };
    const send = openSse(req, res, () => {
      lab.jobs.off('progress', onProgress);
      lab.jobs.off('done', onDone);
    });
    if (j.status !== 'running') {
      send('done', j);
      res.end();
      return HANDLED;
    }
    send('progress', j);
    lab.jobs.on('progress', onProgress);
    lab.jobs.on('done', onDone);
    return HANDLED;
  });

  r.add('POST', '/api/devices/:id/watch/start', async ({ params, body }) => {
    const b = await body();
    const s = await lab.watchStart(params.id, { package: str(b.package, 'package', false), intervalMs: num(b.intervalMs, 'intervalMs'), thumbEveryMs: num(b.thumbEveryMs, 'thumbEveryMs') });
    return { sessionId: s.sessionId, device: s.device, package: s.package };
  });
  r.add('POST', '/api/devices/:id/watch/stop', async ({ params }) => withThumbUrls(await lab.watchStop(params.id)));
  r.add('GET', '/api/sessions', () => lab.sessions().map(withThumbUrls));
  r.add('GET', '/api/sessions/:sessionId/:file', ({ params, res }) => {
    const file = params.file as string;
    const sid = params.sessionId as string;
    if (!/^[\w-]+$/.test(sid) || !/^[\w.-]+$/.test(file) || file.includes('..')) throw new FireLabError('bad-request', 'Bad session file name');
    const p = path.join(lab.sessionsDir, sid, file);
    if (!fs.existsSync(p)) throw new FireLabError('not-found', 'No such session file');
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' });
    fs.createReadStream(p).pipe(res);
    return HANDLED;
  });


  // ---------- test engine (docs/CONTRACT.md "Test engine") ----------

  r.add('GET', '/api/gpu/models', async () => ({ models: await gpuModels(), note: "GPU emulation copies the GPU's WebGL features and limits, not its speed" }));

  const exploreOpts = (b: Record<string, unknown>): ExploreOptions => {
    const keys = typeof b.keys === 'string' ? b.keys : strList(b.keys, 'keys');
    const strategy = str(b.strategy, 'strategy', false);
    if (strategy && strategy !== 'explore' && strategy !== 'random') throw new FireLabError('bad-request', '"strategy" must be "explore" or "random"');
    const driver = str(b.driver, 'driver', false);
    if (driver && driver !== 'adb' && driver !== 'demo') throw new FireLabError('bad-request', '"driver" must be "adb" or "demo"');
    const o: ExploreOptions = {};
    const set = <K extends keyof ExploreOptions>(k: K, v: ExploreOptions[K] | undefined) => {
      if (v !== undefined) o[k] = v;
    };
    set('package', str(b.package, 'package', false));
    set('url', str(b.url, 'url', false));
    set('minutes', num(b.minutes, 'minutes'));
    set('steps', num(b.steps, 'steps'));
    set('seed', num(b.seed, 'seed'));
    set('keys', keys);
    set('oracles', strList(b.oracles, 'oracles'));
    set('stateExpr', str(b.stateExpr, 'stateExpr', false));
    set('focusSelector', str(b.focusSelector, 'focusSelector', false));
    set('strategy', strategy as ExploreOptions['strategy']);
    set('emulateGpu', str(b.emulateGpu, 'emulateGpu', false));
    set('failOn', strList(b.failOn, 'failOn'));
    set('minimize', bool(b.minimize, 'minimize'));
    set('minimizeMinutes', num(b.minimizeMinutes, 'minimizeMinutes'));
    set('driver', driver as ExploreOptions['driver']);
    return o;
  };
  r.add('POST', '/api/devices/:id/tests/explore', async ({ params, body }) => startExplore(lab, params.id, exploreOpts(await body()), 'explore'));
  r.add('POST', '/api/devices/:id/tests/navigation', async ({ params, body }) => startExplore(lab, params.id, exploreOpts(await body()), 'navigation'));
  r.add('POST', '/api/devices/:id/tests/app-launch', async ({ params, body }) => {
    const b = await body();
    return startAppLaunch(lab, params.id, { package: str(b.package, 'package', false), url: str(b.url, 'url', false), settleS: num(b.settleS, 'settleS'), maxLaunchMs: num(b.maxLaunchMs, 'maxLaunchMs') });
  });
  r.add('POST', '/api/devices/:id/tests/performance', async ({ params, body }) => {
    const b = await body();
    return startPerformance(lab, params.id, { package: str(b.package, 'package', false), seconds: num(b.seconds, 'seconds'), targetFps: num(b.targetFps, 'targetFps') });
  });
  r.add('POST', '/api/devices/:id/tests/gpu', async ({ params, body }) => {
    const b = await body();
    return startGpuCheck(lab, params.id, { model: str(b.model, 'model', false), package: str(b.package, 'package', false), url: str(b.url, 'url', false), seconds: num(b.seconds, 'seconds') });
  });
  r.add('POST', '/api/devices/:id/tests/replay', async ({ params, body }) => {
    const b = await body();
    return startReplay(lab, params.id, { runId: str(b.runId, 'runId', false), trace: str(b.trace, 'trace', false), sessionId: str(b.sessionId, 'sessionId', false), times: num(b.times, 'times') });
  });

  const testJob = (id: string) => {
    const j = lab.tests.get(id);
    if (!j) throw new FireLabError('not-found', `No test ${id}`);
    return j;
  };
  r.add('GET', '/api/tests', ({ query }) => lab.tests.history(num(query.get('since'), 'since') ?? 0, Math.min(num(query.get('limit'), 'limit') ?? 100, 500)));
  r.add('GET', '/api/tests/:testId', ({ params }) => testJob(params.testId as string));
  r.add('POST', '/api/tests/:testId/stop', ({ params }) => {
    testJob(params.testId as string);
    return { ok: lab.tests.stop(params.testId as string) };
  });
  r.add('GET', '/api/tests/:testId/findings', async ({ params }) => ({ findings: await testFindings(testJob(params.testId as string)) }));
  r.add('GET', '/api/tests/:testId/files/:file', ({ params, res }) => {
    const id = safeName(params.testId, 'test id');
    const dir = lab.tests.filesDir(id);
    const p = dir ? path.join(dir, safeName(params.file, 'file name')) : '';
    if (!p || !fs.existsSync(p)) throw new FireLabError('not-found', 'No such test file');
    sendFile(res, p);
    return HANDLED;
  });
  r.add('GET', '/api/tests/:testId/stream', ({ req, res, params }) => {
    const id = params.testId as string;
    const j = testJob(id);
    const onProgress = (job: { id: string }) => job.id === id && send('progress', job);
    const onDone = (job: { id: string }) => {
      if (job.id !== id) return;
      send('done', lab.tests.get(id));
      res.end();
    };
    const send = openSse(req, res, () => {
      lab.tests.off('progress', onProgress);
      lab.tests.off('done', onDone);
    });
    if (j.status !== 'running') {
      send('done', j);
      res.end();
      return HANDLED;
    }
    send('progress', j);
    lab.tests.on('progress', onProgress);
    lab.tests.on('done', onDone);
    return HANDLED;
  });

  // ---------- engine runs, scenarios, reports ----------

  r.add('GET', '/api/runs', ({ query }) => listRuns(Math.min(num(query.get('limit'), 'limit') ?? 200, 1000)));
  r.add('GET', '/api/runs/:runId', ({ params }) => runDetail(params.runId as string));
  r.add('GET', '/api/runs/:runId/:file', ({ params, res }) => {
    const file = params.file as string;
    if (!['report.html', 'report.md', 'run.json', 'findings.json'].includes(file)) throw new FireLabError('not-found', `No ${file} in a run`);
    sendFile(res, runFile(params.runId as string, '', file));
    return HANDLED;
  });
  for (const sub of ['traces', 'thumbs'] as const) {
    r.add('GET', `/api/runs/:runId/${sub}/:file`, ({ params, res }) => {
      sendFile(res, runFile(params.runId as string, sub, params.file as string), sub === 'thumbs' ? { 'cache-control': 'max-age=3600' } : {});
      return HANDLED;
    });
  }
  r.add('GET', '/api/scenarios', () => {
    const replays = lastReplays(lab);
    const sessions = lab.sessions().filter((s) => s.endedAt).map((s) => {
      const keys = sessionKeys(lab.sessionsDir, s.sessionId);
      return { ...withThumbUrls(s), keySequence: keys, replayable: !!s.package && keys.length > 0, lastReplay: replays[`session:${s.sessionId}`] ?? null };
    });
    const traces = listTraces().map((t) => ({ ...t, lastReplay: replays[`run:${t.runId}/${t.file}`] ?? null }));
    return { sessions, traces };
  });
  r.add('GET', '/api/reports', () => ({
    engine: listRuns().filter((x) => x.report).map((x) => ({ runId: x.runId, package: x.package, device: x.device, strategy: x.strategy, createdAt: x.writtenAt, steps: x.steps, states: x.states, findings: x.findings, failed: x.failed, demo: x.demo, report: x.report })),
    bench: listBench(),
  }));
  r.add('GET', '/api/bench/:benchId/:file', ({ params, res }) => {
    sendFile(res, benchFile(params.benchId as string, [params.file as string]));
    return HANDLED;
  });
  r.add('GET', '/api/bench/:benchId/:dir/:file', ({ params, res }) => {
    sendFile(res, benchFile(params.benchId as string, [params.dir as string, params.file as string]));
    return HANDLED;
  });

  const serveStatic = (pathname: string, res: Res): void => {
    const hasUi = fs.existsSync(path.join(uiDir, 'index.html'));
    if (!hasUi) {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(PLACEHOLDER_HTML);
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      rel = pathname;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(uiDir, rel));
    if (!file.startsWith(path.normalize(uiDir + path.sep)) && file !== path.join(uiDir, 'index.html')) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        // Unknown paths without an extension get the app shell (client-side routes).
        if (!path.extname(rel)) {
          res.writeHead(200, { 'content-type': MIME['.html'] as string, 'cache-control': 'no-cache' });
          fs.createReadStream(path.join(uiDir, 'index.html')).pipe(res);
        } else sendJson(res, 404, { error: 'Not found' });
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  };

  const port = opts.port ?? 7300;
  const allowedHost = (h: string | undefined): boolean => {
    if (!h) return false;
    const host = h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (['localhost', '127.0.0.1', '::1'].includes(host)) return true;
    return !!opts.host && opts.host !== '127.0.0.1' && opts.host !== 'localhost' && (opts.host === '0.0.0.0' || host === opts.host);
  };

  return (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    // Protect a localhost API that can install apps and run JS on a TV:
    // reject DNS-rebinding Hosts and cross-site writes.
    if (!allowedHost(req.headers.host)) return sendJson(res, 403, { error: 'Host not allowed' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let oh = '';
        try {
          oh = new URL(origin).host;
        } catch {}
        if (oh !== req.headers.host) return sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
      }
      const ct = req.headers['content-type'] ?? '';
      if (req.headers['content-length'] && req.headers['content-length'] !== '0' && !/application\/json/i.test(ct)) {
        return sendJson(res, 415, { error: 'Send JSON (Content-Type: application/json)' });
      }
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      return serveStatic(url.pathname, res);
    }
    const m = r.match(req.method ?? 'GET', url.pathname);
    if (!m) return sendJson(res, 404, { error: `No API route ${req.method} ${url.pathname}` });
    if ('allowed' in m) {
      res.setHeader('allow', m.allowed.join(', '));
      return sendJson(res, 405, { error: `Use ${m.allowed.join(' or ')} for ${url.pathname}` });
    }
    let bodyP: Promise<Record<string, unknown>> | undefined;
    const ctx = { req, res, params: m.params, query: url.searchParams, body: () => (bodyP ??= readBody(req)) };
    Promise.resolve()
      .then(() => m.handler(ctx))
      .then((out) => {
        if (out === HANDLED || res.headersSent) return;
        sendJson(res, 200, out === undefined ? { ok: true } : out);
      })
      .catch((e: unknown) => {
        const status = httpStatus(e);
        if (status >= 500) log.warn(`${req.method} ${url.pathname}:`, e);
        if (res.headersSent) {
          res.end();
          return;
        }
        const body: { error: string; code?: string; hint?: string } = { error: e instanceof FireLabError ? e.friendly : (e as Error)?.message ?? String(e) };
        if (e instanceof FireLabError) {
          body.code = e.code;
          if (e.hint) body.hint = e.hint;
        }
        sendJson(res, status, body);
      });
  };
}

/** Starts the dashboard server (default http://127.0.0.1:7300). */
export async function startDashboard(lab: FireLab, opts: DashboardOptions = {}): Promise<{ server: http.Server; url: string }> {
  const port = opts.port ?? 7300;
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer(createDashboardHandler(lab, { ...opts, port, host }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'EADDRINUSE' ? new FireLabError('busy', `Port ${port} is in use`, { hint: `Is FireLab already running? Open http://localhost:${port} or pick another port with --port` }) : e),
    );
    server.listen(port, host, () => resolve());
  });
  const shownHost = host === '0.0.0.0' || host === '127.0.0.1' ? 'localhost' : host;
  return { server, url: `http://${shownHost}:${port}` };
}
