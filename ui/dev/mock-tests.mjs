// Mock of the test-engine routes (docs/CONTRACT.md "Test engine, vitals and
// reports"): test jobs that play out in a few seconds, engine runs with
// findings and traces, scenarios, benchmark reports, GPU models and device
// vitals. Imported by mock-server.mjs; Node built-ins only.
//
// Durations are compressed: a "3 min" navigation run takes about 20 s here.

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uid = (p) => `${p}${Math.random().toString(36).slice(2, 12)}`;
const HOUR = 3600e3;
const GAME = 'com.firelab.webgame';
const LAUNCHER = 'com.amazon.tv.launcher';
/** Like the server: the foreground app, unless it's the home screen. */
const appOf = (rt, body) => {
  const pkg = body.package || (rt && rt.scene !== 'home' ? rt.app : undefined);
  if (!pkg || pkg === LAUNCHER) throw Object.assign(new Error('Which app? Pick one in “App under test” (the TV shows its home screen)'), { status: 400 });
  return pkg;
};
const pad = (n) => String(n).padStart(2, '0');
const runIdAt = (t) => {
  const d = new Date(t);
  return `ex-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
};

/* ------------------------------------------------------------ GPU models */

// A slice of src/adb/models.ts (the real route lists them all).
export const GPU_MODELS = [
  ['AFTSSS', 'Fire TV Stick (3rd gen)', 'PowerVR GE8300', 'stick', 2020, 'Fire OS 7', 'tv'],
  ['AFTSS', 'Fire TV Stick Lite (2020) / Fire TV Stick HD (2024)', 'PowerVR GE8300', 'stick', 2020, 'Fire OS 7', 'tv'],
  ['AFTMM', 'Fire TV Stick 4K (1st gen)', 'PowerVR GE8300', 'stick', 2018, 'Fire OS 6', 'tv'],
  ['AFTKA', 'Fire TV Stick 4K Max (1st gen)', 'PowerVR GE9215', 'stick', 2021, 'Fire OS 7', 'tv-hd'],
  ['AFTKM', 'Fire TV Stick 4K (2nd gen)', 'PowerVR GE9215', 'stick', 2023, 'Fire OS 8', 'tv-hd'],
  ['AFTKRT', 'Fire TV Stick 4K Max (2nd gen)', 'PowerVR GE9215', 'stick', 2023, 'Fire OS 8', 'tv-hd'],
  ['AFTMA08C15', 'Fire TV Stick 4K Plus', 'PowerVR GE9215', 'stick', 2025, 'Fire OS 8', 'tv-hd'],
  ['AFTT', 'Fire TV Stick (2nd gen) / Basic Edition', 'Mali-450 MP4', 'stick', 2016, 'Fire OS 5', 'low'],
  ['AFTN', 'Fire TV (3rd gen, 4K pendant)', 'Mali-450 MP3', 'box', 2017, 'Fire OS 6', 'low'],
  ['AFTR', 'Fire TV Cube (2nd gen)', 'Mali-G52 MP2', 'cube', 2019, 'Fire OS 7', 'tv-hd'],
  ['AFTGAZL', 'Fire TV Cube (3rd gen)', 'Mali-G52 MP8', 'cube', 2022, 'Fire OS 7', 'tv-hd'],
  ['AFTTI43', 'Amazon Fire TV 4-Series (2021)', 'Mali-G52 MP1', 'tv', 2021, 'Fire OS 7', 'tv-hd'],
  ['AFTMD001', 'TCL S4 / Q6 Fire TV (2023)', 'Mali-G31', 'tv', 2023, 'Fire OS 7', 'tv'],
  ['AFTM', 'Fire TV Stick (1st gen)', 'VideoCore IV', 'stick', 2014, 'Fire OS 5', 'low'],
  ['AFTCA002', 'Fire TV Stick 4K Select', 'Mali-G310', 'stick', 2025, 'Vega OS', 'tv-hd'],
].map(([model, name, gpu, kind, year, platform, tier]) => ({ model, name, gpu, kind, year, platform, tier, emulatable: true }));

/* ------------------------------------------------------------ seed data */

const SEV = ['critical', 'major', 'minor', 'info'];
const counts = (fs) => Object.fromEntries(SEV.map((s) => [s, fs.filter((f) => f.severity === s).length]));

function finding(id, severity, kind, title, keys, status = 'confirmed', repro = [3, 3]) {
  return { id, oracle: kind.includes('focus') || kind === 'unreachable-control' || kind === 'non-spatial-move' ? 'focus' : kind.includes('screen') || kind === 'render-loop-stopped' ? 'screen' : 'health', severity, kind, title, status, repro: { hits: repro[0], runs: repro[1] }, step: Math.round(rand(10, 300)), trace: `${id}.min.trace.json`, keys };
}

function makeRun({ ago, pkg = GAME, device, strategy = 'explore', minutes, steps, states, findings, emulateGpu, demo = false, label }) {
  const startedAt = Date.now() - ago;
  const durationMs = minutes * 60e3;
  const failed = findings.some((f) => (f.severity === 'critical' || f.severity === 'major') && f.status !== 'not-reproduced');
  const runId = demo ? `demo-${runIdAt(startedAt).slice(3, 18)}` : runIdAt(startedAt);
  return {
    runId, package: pkg, device, strategy, startedAt, endedAt: startedAt + durationMs, durationMs, writtenAt: startedAt + durationMs,
    steps, states, stopped: 'budget', findings: counts(findings), failed, ...(emulateGpu ? { emulateGpu } : {}),
    report: `/api/runs/${runId}/report.html`, traces: findings.length, demo, findingList: findings,
    notes: demo ? ['Lantern Lake is a simulated game with 6 seeded bugs.'] : [],
    config: { app: { package: pkg }, minutes, seed: 1, oracles: ['health', 'screen', 'focus'], strategy }, label,
  };
}

const DEV_4K = { serial: '192.168.1.194:5555', model: 'AFTMA08C15', name: 'Fire TV Stick 4K Plus', kind: 'adb', tier: 'tv-hd' };
const DEV_3G = { serial: '192.168.1.205:5555', model: 'AFTSSS', name: 'Fire TV Stick (3rd gen)', kind: 'adb', tier: 'tv' };
const DEV_DEMO = { serial: 'demo-tv', model: 'DEMO', name: 'Simulated Fire TV (demo)', kind: 'mock', tier: 'tv' };

function seedRuns() {
  return [
    makeRun({
      ago: 1.6 * HOUR, device: DEV_4K, minutes: 10, steps: 412, states: 37, label: 'explore',
      findings: [
        finding('f-3a91c2', 'major', 'focus-trap', 'Focus trap on the pause menu: Back and every arrow key stay on "Resume"', ['ok', 'playpause', 'down', 'down', 'right']),
        finding('f-77b0de', 'minor', 'non-spatial-move', 'Right from "Garage" jumps to "Settings" two rows down', ['back', 'down', 'right']),
        finding('f-0c5e18', 'minor', 'console-error', 'console.error: [audio] decode failed for engine-loop.ogg', ['ok', 'ok'], 'flaky', [2, 3]),
        finding('f-91aa04', 'info', 'plateau', 'No new screen for 300 steps after step 211', []),
      ],
    }),
    makeRun({
      ago: 3.9 * HOUR, device: DEV_3G, minutes: 3, steps: 118, states: 14, label: 'navigation',
      findings: [finding('f-5d20aa', 'minor', 'unreachable-control', '"Credits" is never focused from the main menu with the D-pad', ['down', 'down', 'down', 'down'])],
    }),
    makeRun({
      ago: 7.2 * HOUR, device: DEV_3G, strategy: 'random', minutes: 10, steps: 380, states: 17, label: 'random baseline',
      findings: [
        finding('f-e1d3b7', 'critical', 'webgl-context-lost', 'WebGL context lost after the 4th lap on tv-hd textures', ['ok', 'right', 'right', 'ok', 'fastforward*4']),
        finding('f-28cc61', 'minor', 'frozen-screen', 'Picture froze for 2.4 s while loading track-03', ['ok', 'down', 'ok'], 'flaky', [1, 3]),
      ],
    }),
    makeRun({
      ago: 30 * HOUR, device: DEV_3G, minutes: 5, steps: 204, states: 22, emulateGpu: 'AFTSSS', label: 'GPU emulated',
      findings: [finding('f-4b7e90', 'major', 'gpu-unsupported', 'texImage2D with an ASTC texture fails on PowerVR GE8300', ['ok', 'ok'])],
    }),
    makeRun({
      ago: 50 * HOUR, pkg: 'dev.firelab.demo', device: DEV_DEMO, minutes: 10, steps: 498, states: 31, demo: true, label: 'demo',
      findings: [
        finding('f-0acf37', 'critical', 'crash', 'The app crashed (process died) after OK on "Boat"', ['down', 'down', 'ok']),
        finding('f-1732b2', 'major', 'js-exception', 'Uncaught TypeError: Cannot read properties of null (reading "x") in lantern.js', ['right', 'ok', 'ok']),
        finding('f-38419c', 'major', 'black-screen', 'Black screen after Back from the map', ['menu', 'ok', 'back']),
        finding('f-6b88b5', 'major', 'focus-trap', 'Focus trap in the shop dialog', ['right', 'right', 'ok', 'down']),
        finding('f-e7b795', 'minor', 'render-loop-stopped', 'Render loop stopped while paused for 10 s', ['playpause']),
      ],
    }),
  ];
}

function seedHistory(runs) {
  const now = Date.now();
  const mk = (kind, name, ago, durS, verdict, extra = {}) => ({
    id: uid('t_'), kind, name, device: extra.device || '192.168.1.194:5555', status: 'done', verdict, progress: 1,
    startedAt: now - ago, endedAt: now - ago + durS * 1000, log: [], request: {}, ...extra,
  });
  return [
    mk('app-launch', `App launch · ${GAME}`, 0.4 * HOUR, 19, 'pass', { package: GAME, result: { launchMs: 1840, memMB: 268 } }),
    mk('performance', `Performance · ${GAME}`, 0.9 * HOUR, 18, 'pass', { package: GAME }),
    mk('explore', `Explore · ${GAME} · 10 min`, 1.6 * HOUR, 640, 'fail', { package: GAME, runId: runs[0].runId, report: runs[0].report, steps: 412, states: 37, findings: runs[0].findings }),
    mk('gpu', 'GPU check · Fire TV Stick (3rd gen) (AFTSSS)', 2.3 * HOUR, 31, 'pass', { package: GAME }),
    mk('navigation', `Navigation · ${GAME} · 3 min`, 3.9 * HOUR, 214, 'pass', { device: '192.168.1.205:5555', package: GAME, runId: runs[1].runId, report: runs[1].report, steps: 118, states: 14, findings: runs[1].findings }),
    mk('performance', `Performance · ${GAME}`, 4.4 * HOUR, 18, 'fail', { device: '192.168.1.205:5555', package: GAME }),
    mk('replay', `Replay · f-3a91c2 from ${runs[0].runId}`, 5.1 * HOUR, 22, 'fail', { package: GAME }),
    mk('performance', 'Performance · org.videolan.vlc', 6 * HOUR, 18, 'skip', { package: 'org.videolan.vlc' }),
    mk('app-launch', 'App launch · com.example.lobbykiosk', 9.5 * HOUR, 0, undefined, { status: 'failed', error: 'com.example.lobbykiosk has no launchable activity', package: 'com.example.lobbykiosk' }),
    mk('app-launch', `App launch · ${GAME}`, 27 * HOUR, 21, 'pass', { package: GAME }),
  ];
}

const BENCH = [
  {
    id: 'bench-20261017-explore-vs-random', kind: 'firelab-bench', createdAt: Date.now() - 20 * HOUR, title: 'Go-Explore vs monkey on three TV games',
    subjects: ['Lantern Lake (demo)', 'FireLab Web Game', 'Lobby Kiosk'], strategies: ['explore', 'random'],
    headline: 'Explore reached 2.1× the screens and found 9 of 11 seeded bugs; random found 4.',
  },
  { id: 'bench-20261016-smoke', kind: 'firelab-bench', createdAt: Date.now() - 44 * HOUR, title: 'Seed sensitivity (5 seeds)', subjects: ['Lantern Lake (demo)'], strategies: ['explore'] },
];

/* ------------------------------------------------------------ the module */

export function createTestLab(ctx) {
  // ctx: { device(id) -> rt|undefined, applyKey(rt, key), launchApp(rt, pkg), pushLog(rt, level, source, text), sessions() }
  let runs = seedRuns();
  let tests = seedHistory(runs);
  const replays = {};
  const live = new Map(); // id -> { job, timer, clients:Set, findings:[] }

  function reset() {
    for (const l of live.values()) clearInterval(l.timer);
    live.clear();
    runs = seedRuns();
    tests = seedHistory(runs);
  }

  const pub = (j) => ({ ...j, log: [...j.log] });
  function send(l, event) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(pub(l.job))}\n\n`;
    for (const res of l.clients) res.write(msg);
  }
  function step(l, text, status) {
    l.job.log.push({ ts: Date.now(), text, ...(status ? { status } : {}) });
    if (l.job.log.length > 300) l.job.log.shift();
    l.job.message = text;
  }
  function finish(l, verdict, patch = {}) {
    clearInterval(l.timer);
    Object.assign(l.job, patch);
    l.job.status = l.stopped ? 'stopped' : 'done';
    l.job.verdict = verdict;
    l.job.progress = 1;
    l.job.endedAt = Date.now();
    send(l, 'done');
    for (const res of l.clients) res.end();
    l.clients.clear();
  }
  function fail(l, error) {
    clearInterval(l.timer);
    l.job.status = l.stopped ? 'stopped' : 'failed';
    l.job.error = error;
    l.job.endedAt = Date.now();
    step(l, error, 'fail');
    send(l, 'done');
    for (const res of l.clients) res.end();
    l.clients.clear();
  }

  function create(kind, device, name, request, extra = {}) {
    const busy = [...live.values()].find((x) => x.job.device === device && x.job.status === 'running');
    if (busy && device !== 'demo-tv') throw Object.assign(new Error(`A test is already running on ${device} (${busy.job.name})`), { status: 409 });
    const job = { id: uid('t_'), kind, name, device, status: 'running', progress: 0, startedAt: Date.now(), log: [], request, ...extra };
    const l = { job, timer: 0, clients: new Set(), findings: [], t0: Date.now() };
    live.set(job.id, l);
    tests.unshift(job);
    return l;
  }

  /** Plays a script of [atMs, fn] entries, then calls done(). */
  function play(l, totalMs, script, done) {
    let i = 0;
    l.timer = setInterval(() => {
      if (l.job.status !== 'running') return;
      const el = Date.now() - l.t0;
      while (i < script.length && script[i][0] <= el) script[i++][1]();
      if (l.job.progress !== null) l.job.progress = Math.min(0.99, el / totalMs);
      if (el >= totalMs) done();
      else send(l, 'progress');
    }, 250);
  }

  /* --------------------------------------------------------- the kinds */

  function appLaunch(rt, body) {
    const pkg = appOf(rt, body);
    if (pkg === 'com.sunsetvilla.tv') throw Object.assign(new Error("com.sunsetvilla.tv holds someone's real progress: FireLab's tests won't relaunch or drive it. Test a build with its own package id"), { status: 400 });
    const settle = Math.min(Math.max(Number(body.settleS) || 8, 3), 60);
    const l = create('app-launch', rt.id, `App launch · ${pkg}`, { ...body, package: pkg, settleS: settle }, { package: pkg, estimatedMs: 9000 });
    const budget = rt.info.ramMB >= 2048 ? [420, 560] : [230, 330];
    const launchMs = Math.round(rt.id.endsWith('205:5555') ? rand(2600, 3400) : rand(1500, 2100));
    const mem = Math.round(rt.profile.mem[0] + rand(-10, 20));
    play(l, 9000, [
      [0, () => step(l, `Memory budget for ${rt.info.model}: ${budget[0]} MB comfortable, ${budget[1]} MB limit (estimated)`, 'info')],
      [300, () => { l.job.phase = `Launching ${pkg}`; step(l, `Launching ${pkg}`); ctx.launchApp(rt, pkg); }],
      [1600, () => { l.job.phase = `Letting it run for ${settle} s`; step(l, `Letting it run for ${settle} s`); }],
      [6000, () => { l.job.phase = 'Screenshot'; step(l, 'Screenshot'); }],
      [6800, () => { l.job.phase = 'Memory'; step(l, 'Memory'); }],
      [8200, () => { l.job.phase = 'Logcat'; step(l, 'Logcat'); }],
    ], () => {
      const checks = [
        ['Launches', 'pass', `${pkg}/.MainActivity`],
        ['Launch time', launchMs > 5000 ? 'warn' : 'pass', `${launchMs} ms`],
        [`Still running after ${settle} s`, 'pass', `pid ${Math.round(rand(4000, 30000))}`],
        ['Screen shows something', 'pass', `content on screen (luma ${Math.round(rand(60, 110))} ± ${Math.round(rand(30, 60))})`],
        [`Memory vs the ${rt.info.model}'s budget`, mem > budget[0] ? 'warn' : 'pass', `${mem} MB (budget ${budget[0]} MB, limit ${budget[1]} MB)`],
        ['No crash or ANR in logcat', 'pass', 'clean'],
      ];
      const word = { pass: 'ok', warn: 'warn', fail: 'fail' };
      for (const [t, s, d] of checks) step(l, `${t}: ${d}`, word[s]);
      finish(l, 'pass', { result: { launchMs, memMB: mem, budget: { model: rt.info.model, budgetMB: budget[0], limitMB: budget[1], source: 'estimated' }, checks: checks.map(([title, status, detail]) => ({ title, status, detail })) } });
    });
    return l.job;
  }

  function performance(rt, body) {
    const pkg = appOf(rt, body);
    const seconds = Math.min(Math.max(Number(body.seconds) || 15, 5), 120);
    const target = Math.min(Math.max(Number(body.targetFps) || 30, 10), 120);
    const ms = Math.min(seconds, 12) * 1000;
    const l = create('performance', rt.id, `Performance · ${pkg}`, { ...body, seconds, targetFps: target }, { package: pkg, estimatedMs: ms });
    l.job.phase = 'sampling';
    play(l, ms, [[0, () => step(l, `Sampling ${pkg} for ${seconds} s against ${target} fps (median ≥ ${(target * 0.95).toFixed(1)}, p10 ≥ ${(target * 0.8).toFixed(1)})`)]], () => {
      const fps = rt.perfHist.slice(-Math.round(ms / 500)).map((p) => p.fps).filter((x) => x != null).sort((a, b) => a - b);
      if (fps.length < 5) {
        step(l, 'No frame rate from this app (no WebView and no SurfaceFlinger frames)', 'warn');
        return finish(l, 'skip');
      }
      const med = fps[fps.length >> 1];
      const p10 = fps[Math.floor(fps.length * 0.1)];
      const ok = med >= target * 0.95 && p10 >= target * 0.8;
      step(l, `fps median ${med}, p10 ${p10}, min ${fps[0]} (${fps.length} samples, source page)`, ok ? 'ok' : 'fail');
      step(l, `Memory ${Math.round(rt.mem)} MB`, 'info');
      finish(l, ok ? 'pass' : 'fail', { result: { measurement: { seconds, fps: { median: med, p10, min: fps[0], max: fps.at(-1), samples: fps.length, source: 'page' }, memMB: Math.round(rt.mem) } } });
    });
    return l.job;
  }

  function gpu(rt, body) {
    const m = GPU_MODELS.find((x) => x.model === String(body.model || '').toUpperCase());
    if (!body.model) throw Object.assign(new Error('Pick a Fire TV model to emulate'), { status: 400 });
    if (!m) throw Object.assign(new Error(`Unknown Fire TV model "${body.model}"`), { status: 400 });
    const pkg = appOf(rt, body);
    const seconds = Math.min(Math.max(Number(body.seconds) || 20, 5), 300);
    const l = create('gpu', rt.id, `GPU check · ${m.name} (${m.model})`, { ...body, seconds }, { package: pkg, estimatedMs: 12000 });
    const weak = /Mali-450|VideoCore/.test(m.gpu);
    const renderer = m.gpu.replace(/^PowerVR /, 'PowerVR Rogue ');
    play(l, 12000, [
      [0, () => step(l, `${renderer}: copies the GPU's WebGL features and limits, not its speed`, 'info')],
      [400, () => { l.job.phase = 'loading'; step(l, `${m.model}: loading the page with the ${renderer} profile`); }],
      [2500, () => { l.job.phase = 'running'; step(l, `${m.model}: running ${seconds} s (play the game now to reach more WebGL code)`); }],
    ], () => {
      if (weak) {
        step(l, 'getContext("webgl2") refused: this GPU has no WebGL2', 'warn');
        step(l, 'texImage2D 4096×4096 exceeds MAX_TEXTURE_SIZE 2048 (x3)', 'fail');
        step(l, '1 kind(s) of WebGL call failed · contexts 1 WebGL1, 0 WebGL2, 1 refused', 'fail');
        return finish(l, 'fail');
      }
      step(l, 'Features and limits only: the frame rate under this shim is your machine\'s, not the stick\'s.', 'info');
      step(l, 'No WebGL call failed · contexts 0 WebGL1, 1 WebGL2, 0 refused', 'ok');
      finish(l, 'pass', { result: { installed: true, failures: [], contexts: { webgl: 0, webgl2: 1, refused: 0 } } });
    });
    return l.job;
  }

  function explore(rt, body, kind) {
    const demo = body.driver === 'demo';
    const pkg = demo ? 'dev.firelab.demo' : appOf(rt, body);
    if (pkg === 'com.sunsetvilla.tv') throw Object.assign(new Error("com.sunsetvilla.tv holds someone's real progress: FireLab's tests won't relaunch or drive it"), { status: 400 });
    if (body.strategy && !['explore', 'random'].includes(body.strategy)) throw Object.assign(new Error('"strategy" must be "explore" or "random"'), { status: 400 });
    const nav = kind === 'navigation';
    const minutes = body.steps ? undefined : Number(body.minutes) || (nav ? 3 : 10);
    const budget = body.steps ? `${body.steps} steps` : `${minutes} min`;
    const total = demo ? 8000 : nav ? 20000 : 40000;
    const device = demo ? 'demo-tv' : rt.id;
    const l = create(kind, device, `${nav ? 'Navigation' : 'Explore'} · ${pkg} · ${budget}`, { ...body, package: pkg }, { package: pkg, estimatedMs: total, steps: 0, states: 0, findings: { critical: 0, major: 0, minor: 0, info: 0 } });
    const runId = runIdAt(Date.now());
    l.job.runId = runId;
    l.job.report = `/api/runs/${runId}/report.html`;
    l.job.phase = 'explore';
    step(l, `${nav ? 'Navigation' : 'Explore'}: ${budget}, oracles health, screen, focus${body.emulateGpu ? `, GPU emulated as ${body.emulateGpu}` : ''}`, 'info');
    if (rt && !demo) ctx.launchApp(rt, pkg);
    const screens = ['Title', 'Main menu', 'Garage', 'Track select', 'Race: lap 1', 'Pause menu', 'Settings', 'Audio settings', 'Leaderboard', 'Race: lap 2', 'Results', 'Credits'];
    const pool = [
      ['minor', 'non-spatial-move', 'Right from "Garage" jumps to "Settings" two rows down', ['back', 'down', 'right']],
      ['major', 'focus-trap', 'Focus trap on the pause menu: Back and every arrow key stay on "Resume"', ['ok', 'playpause', 'down', 'down', 'right']],
      ['minor', 'console-error', 'console.error: [audio] decode failed for engine-loop.ogg', ['ok', 'ok']],
    ];
    const script = [];
    const n = nav ? 7 : 11;
    for (let i = 0; i < n; i++) script.push([Math.round(((i + 0.5) / n) * total * 0.8), () => step(l, `New screen: ${screens[i]}`, 'info')]);
    pool.slice(0, nav ? 2 : 3).forEach((f, i) => script.push([Math.round(total * (0.3 + i * 0.2)), () => {
      const fd = finding(`f-${Math.random().toString(16).slice(2, 8)}`, ...f, 'new', [0, 0]);
      l.findings.push(fd);
      l.job.findings[fd.severity]++;
      step(l, `Finding (${fd.severity}): ${fd.title}`, fd.severity === 'major' ? 'fail' : 'warn');
    }]));
    script.push([Math.round(total * 0.4), () => step(l, 'Relaunched: left the app (home screen)', 'info')]);
    script.push([Math.round(total * 0.82), () => { l.job.phase = 'minimize'; step(l, 'Phase: minimize', 'info'); }]);
    script.push([Math.round(total * 0.95), () => { l.job.phase = 'report'; step(l, 'Phase: report', 'info'); }]);
    script.sort((a, b) => a[0] - b[0]);
    const keyTimer = setInterval(() => {
      if (l.job.status !== 'running') return clearInterval(keyTimer);
      const el = Date.now() - l.t0;
      if (el < total * 0.82) {
        l.job.steps += 1 + Math.round(Math.random());
        l.job.states = Math.min(screens.length, Math.max(l.job.states, Math.round((el / total) * (nav ? 9 : 14))));
        if (rt && !demo) {
          // like the engine's relaunch: back into the app when a key left it
          if (rt.app !== pkg || rt.scene === 'home') ctx.launchApp(rt, pkg);
          else ctx.applyKey(rt, pick(['up', 'down', 'left', 'right', 'ok', 'right', 'playpause']));
        }
      }
    }, 600);
    play(l, total, script, () => {
      clearInterval(keyTimer);
      l.findings.forEach((f) => { f.status = 'confirmed'; f.repro = { hits: 3, runs: 3 }; });
      const failOn = nav ? ['focus', 'crash', 'black', 'frozen'] : ['critical', 'major'];
      const failed = l.findings.some((f) => f.severity === 'critical' || f.severity === 'major' || (nav && f.oracle === 'focus'));
      const run = makeRun({ ago: 0, pkg, device: demo ? DEV_DEMO : { serial: rt.id, model: rt.info.model, name: rt.info.name, kind: 'adb', tier: rt.info.tier }, strategy: body.strategy || 'explore', minutes: minutes || 3, steps: l.job.steps, states: l.job.states, findings: l.findings, emulateGpu: body.emulateGpu, demo });
      run.runId = runId;
      run.report = l.job.report;
      run.writtenAt = Date.now();
      runs.unshift(run);
      step(l, `${l.job.steps} steps, ${l.job.states} screens, ${l.findings.length} finding(s) in ${Math.round(total / 1000)} s${failed ? ` · fails on ${failOn.join(', ')}` : ''}`, failed ? 'fail' : 'ok');
      finish(l, failed ? 'fail' : 'pass', { phase: 'done' });
    });
    return l.job;
  }

  function replay(rt, body) {
    const times = Math.min(Math.max(Math.round(Number(body.times) || 1), 1), 5);
    let keys;
    let label;
    let key;
    let pkg = GAME;
    let expected = true;
    let device = rt?.id;
    if (body.runId && body.trace) {
      const run = runs.find((r) => r.runId === body.runId);
      const f = run?.findingList.find((x) => x.trace === body.trace);
      if (!f) throw Object.assign(new Error(`No traces/${body.trace} in run ${body.runId}`), { status: 404 });
      keys = f.keys;
      pkg = run.package;
      label = `${f.id} from ${run.runId}`;
      key = `run:${run.runId}/${f.trace}`;
      if (run.demo) device = 'demo-tv';
    } else if (body.sessionId) {
      const s = ctx.sessions().find((x) => x.sessionId === body.sessionId);
      if (!s) throw Object.assign(new Error(`No finished watch session ${body.sessionId}`), { status: 404 });
      keys = sessionKeys(s);
      label = `watch session ${s.sessionId}`;
      key = `session:${s.sessionId}`;
      expected = false;
    } else throw Object.assign(new Error('Say what to replay: { runId, trace } or { sessionId }'), { status: 400 });
    if (!device) throw Object.assign(new Error('Pick a connected device first'), { status: 409 });
    const ms = 3000 + keys.length * 450 * times;
    const l = create('replay', device, `Replay · ${label}`, { ...body, times }, { package: pkg, estimatedMs: ms });
    step(l, `${keys.length} key presses on ${pkg}, ${times}×${expected ? ', expecting the finding' : ''}`, 'info');
    const script = [];
    for (let r = 0; r < times; r++) {
      const base = r * (ms / times);
      script.push([base, () => { l.job.phase = `run ${r + 1}`; step(l, `Run ${r + 1} of ${times}`, 'info'); if (rt && device !== 'demo-tv') ctx.launchApp(rt, pkg); }]);
      keys.forEach((k, i) => script.push([base + 1500 + i * 450, () => rt && device !== 'demo-tv' && ctx.applyKey(rt, k.replace(/[:*].*$/, ''))]));
    }
    play(l, ms, script, () => {
      const hits = expected ? (Math.random() < 0.8 ? times : Math.max(0, times - 1)) : 0;
      const verdict = expected ? (hits ? 'fail' : 'pass') : 'pass';
      const text = expected ? `Reproduced ${hits}/${times}` : `Played ${keys.length} keys, nothing went wrong`;
      step(l, text, verdict === 'pass' ? 'ok' : 'fail');
      replays[key] = { at: Date.now(), hits, runs: times, verdict, text, jobId: l.job.id, expected };
      finish(l, verdict, { result: { hits, runs: times, keys } });
    });
    return l.job;
  }

  function sessionKeys(s) {
    if (s.keySequence) return s.keySequence;
    const seq = s.device.endsWith('205:5555') ? ['right', 'right', 'ok', 'left', 'left', 'right', 'up', 'ok:900', 'right', 'left'] : ['down', 'ok', 'right', 'right', 'left', 'playpause', 'playpause', 'right'];
    return seq;
  }

  /* --------------------------------------------------------- report page */

  function reportHtml(run) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const rows = run.findingList.map((f) => `<tr><td><b class="${f.severity}">${f.severity}</b></td><td>${esc(f.title)}<br><small>${esc(f.kind)}</small></td><td>${f.repro.hits}/${f.repro.runs}</td><td><code>${esc(f.keys.join(' '))}</code></td></tr>`).join('');
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>FireLab report · ${esc(run.runId)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;background:#0d0910;color:#f8f2f6;margin:0;padding:32px}h1{font-size:22px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #322539;padding:8px;text-align:left;vertical-align:top}.critical,.major{color:#ff4d6d}.minor{color:#ffd23f}.info{color:#c084fc}code{color:#ff9442}.muted{color:#9d8b9c}</style>
<h1>FireLab engine report (mock)</h1><p class="muted">${esc(run.package)} on ${esc(run.device.name)} · ${run.strategy} · ${run.steps} steps · ${run.states} screens · ${Math.round(run.durationMs / 60000)} min</p>
<table><thead><tr><th>Severity</th><th>Finding</th><th>Repro</th><th>Keys</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No findings.</td></tr>'}</tbody></table>
<p class="muted">The real report has screenshots, the coverage curve, the screen graph and focus maps. This page comes from ui/dev/mock-tests.mjs.</p></html>`;
  }

  function benchHtml(b) {
    return `<!doctype html><meta charset="utf-8"><title>${b.title}</title><style>body{font:14px/1.5 system-ui,sans-serif;background:#0d0910;color:#f8f2f6;padding:32px}</style><h1>${b.title} (mock)</h1><p>${b.headline || ''}</p><p>Subjects: ${b.subjects.join(', ')} · strategies: ${b.strategies.join(', ')}</p>`;
  }

  /* --------------------------------------------------------- routing */

  const json = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const html = (res, body) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads' });
    res.end(body);
  };
  const runSummary = ({ findingList, notes, config, label, ...r }) => r;

  /** GET routes outside /api/devices. Returns true when handled. */
  function handleGet(req, res, url) {
    const p = url.pathname;
    if (p === '/api/gpu/models') return json(res, 200, { models: GPU_MODELS, note: "GPU emulation copies the GPU's WebGL features and limits, not its speed" }), true;
    if (p === '/api/tests') {
      const since = Number(url.searchParams.get('since')) || 0;
      return json(res, 200, tests.filter((t) => t.startedAt >= since).slice(0, 100).map((t) => ({ ...t, log: t.log.slice(-3) }))), true;
    }
    let m = /^\/api\/tests\/([\w-]+)(?:\/(stream|findings))?$/.exec(p);
    if (m) {
      const job = tests.find((t) => t.id === m[1]);
      if (!job) return json(res, 404, { error: `No test ${m[1]}`, code: 'not-found' }), true;
      const l = live.get(job.id);
      if (m[2] === 'findings') return json(res, 200, { findings: l?.findings || runs.find((r) => r.runId === job.runId)?.findingList || [] }), true;
      if (!m[2]) return json(res, 200, pub(job)), true;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: ${job.status === 'running' ? 'progress' : 'done'}\ndata: ${JSON.stringify(pub(job))}\n\n`);
      if (job.status !== 'running' || !l) return res.end(), true;
      l.clients.add(res);
      req.on('close', () => l.clients.delete(res));
      return true;
    }
    if (p === '/api/runs') return json(res, 200, runs.map(runSummary)), true;
    m = /^\/api\/runs\/([\w.-]+)(?:\/(report\.html|traces\/[\w.-]+))?$/.exec(p);
    if (m) {
      const run = runs.find((r) => r.runId === m[1]);
      if (!run) return json(res, 404, { error: `No engine run ${m[1]}`, code: 'not-found' }), true;
      if (!m[2]) return json(res, 200, run), true;
      if (m[2] === 'report.html') return html(res, reportHtml(run)), true;
      const f = run.findingList.find((x) => `traces/${x.trace}` === m[2]);
      if (!f) return json(res, 404, { error: 'No such trace' }), true;
      return json(res, 200, { version: 1, app: { package: run.package }, device: run.device, createdAt: run.startedAt, seed: 1, setup: [], steps: f.keys.map((k, i) => ({ i, action: { kind: 'key', key: k.replace(/[:*].*$/, '') }, gapMs: 600 })) }), true;
    }
    if (p === '/api/scenarios') {
      const sessions = ctx.sessions().filter((s) => s.endedAt).map((s) => ({ ...s, package: s.package || GAME, keySequence: sessionKeys(s), replayable: true, lastReplay: replays[`session:${s.sessionId}`] || null }));
      const traces = runs.flatMap((r) => r.findingList.filter((f) => f.keys.length).map((f) => ({
        runId: r.runId, file: f.trace, findingId: f.id, title: f.title, severity: f.severity, kind: f.kind, status: f.status, minimized: true,
        keys: f.keys, length: f.keys.length, package: r.package, createdAt: r.startedAt, demo: r.demo, lastReplay: replays[`run:${r.runId}/${f.trace}`] || null,
      })));
      return json(res, 200, { sessions, traces }), true;
    }
    if (p === '/api/reports') {
      return json(res, 200, {
        engine: runs.map((r) => ({ runId: r.runId, package: r.package, device: r.device, strategy: r.strategy, createdAt: r.writtenAt, steps: r.steps, states: r.states, findings: r.findings, failed: r.failed, demo: r.demo, report: r.report })),
        bench: BENCH.map(({ kind, ...b }) => ({ ...b, report: `/api/bench/${b.id}/report.html` })),
      }), true;
    }
    m = /^\/api\/bench\/([\w.-]+)\/report\.html$/.exec(p);
    if (m) {
      const b = BENCH.find((x) => x.id === m[1]);
      if (!b) return json(res, 404, { error: 'No such benchmark' }), true;
      return html(res, benchHtml(b)), true;
    }
    return false;
  }

  function handlePost(res, p) {
    const m = /^\/api\/tests\/([\w-]+)\/stop$/.exec(p);
    if (!m) return false;
    const l = live.get(m[1]);
    if (!l || l.job.status !== 'running') return json(res, 200, { ok: false }), true;
    l.stopped = true;
    step(l, 'Stopping…', 'info');
    if (l.job.kind === 'explore' || l.job.kind === 'navigation') {
      // like the engine: keep what it found, skip shrinking, write the report
      l.t0 = Date.now() - (l.job.estimatedMs || 0) + 1500;
    } else setTimeout(() => fail(l, 'Stopped from the dashboard'), 300);
    return json(res, 200, { ok: true }), true;
  }

  /** POST /api/devices/:id/tests/<kind>. rt may be undefined for driver "demo". */
  function startTest(rt, kind, body) {
    switch (kind) {
      case 'app-launch': return appLaunch(rt, body);
      case 'performance': return performance(rt, body);
      case 'gpu': return gpu(rt, body);
      case 'explore':
      case 'navigation': return explore(rt, body, kind);
      case 'replay': return replay(rt, body);
      default: throw Object.assign(new Error(`No test kind ${kind}`), { status: 404 });
    }
  }

  return { handleGet, handlePost, startTest, reset };
}

/* ------------------------------------------------------------ vitals */

/** Believable vitals per device: Wi-Fi throughput that follows what the app does, and a SoC that warms up in the game. */
export function mockVitals(rt, now = Date.now()) {
  const v = rt._vitals || (rt._vitals = { at: 0, temp: rt.id.endsWith('205:5555') ? 52 : 46, first: true });
  if (now - v.at < 2000 && v.last) return v.last;
  v.at = now;
  const game = rt.scene === 'game';
  const target = (rt.id.endsWith('205:5555') ? 58 : 51) + (game ? 6 : 0) + (rt.sweeping ? 3 : 0);
  v.temp += (target - v.temp) * 0.05 + rand(-0.15, 0.15);
  const rx = game ? rand(0.2, 1.6) + (Math.random() < 0.08 ? rand(8, 22) : 0) : rand(0.05, 0.4);
  const tx = rand(0.02, 0.12);
  const out = {
    ts: now, device: rt.id,
    network: v.first ? null : { iface: 'wlan0', rxBps: Math.round((rx * 1e6) / 8), txBps: Math.round((tx * 1e6) / 8), rxMbps: Math.round(rx * 100) / 100, txMbps: Math.round(tx * 100) / 100 },
    ...(v.first ? { networkNote: 'first reading: the rate needs two' } : {}),
    temperature: { c: Math.round(v.temp * 10) / 10, sensor: rt.id.endsWith('205:5555') ? 'mtktscpu (thermal_zone1)' : 'CPU0', source: rt.id.endsWith('205:5555') ? 'thermal_zone' : 'thermalservice' },
  };
  v.first = false;
  v.last = out;
  return out;
}
