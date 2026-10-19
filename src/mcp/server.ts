import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { FireLab } from '../core/firelab.js';
import { REMOTE_KEY_NAMES } from '../adb/keys.js';
import { FireLabError } from '../lib/errors.js';
import { firelabVersion } from '../lib/paths.js';
import fs from 'node:fs';
import path from 'node:path';
import { exploreDir, getExploreJob, readRunDir, resolveRunDir, startExploreJob, waitForRunId, type ExploreJob } from '../engine/index.js';

const INSTRUCTIONS = `FireLab drives real Amazon Fire TV / Android TV devices over adb.
Typical flow: list_devices (or scan_network + connect_device) -> wake_device -> launch_app -> screenshot -> press_keys -> screenshot ...
No TV connected? explore_start with driver "demo" runs the engine on a simulated TV game so the user can see what FireLab does.
To hunt bugs automatically: explore_start (the engine plays the app with the remote for N minutes), poll explore_status, then explore_findings for crashes, black/frozen screens and D-pad focus traps, each with the shortest key sequence that reproduces it.
For WebView apps and web games: webview_eval reads page state, webview_console shows errors, measure_performance / performance_sweep measure frame rate.
The "device" parameter is optional when exactly one device is connected. A person may be watching the TV: keep disruptive actions short and finish on the home screen (press_keys ["home"]) when you are done.`;

const device = z.string().optional().describe('adb serial or IP of the device, e.g. "192.168.1.50:5555" or "192.168.1.50". Optional when only one device is connected.');
const pkg = z.string().describe('Android package name, e.g. "com.example.game" (see list_apps).');

const json = (value: unknown): CallToolResult => {
  const structured = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }], structuredContent: structured };
};

const fail = (e: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: e instanceof FireLabError ? `${e.friendly}${e.code ? ` [${e.code}]` : ''}` : `Error: ${(e as Error)?.message ?? String(e)}` }],
});

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

type Extra = { _meta?: { progressToken?: string | number }; sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void> };

/** Sends MCP progress notifications when the client asked for them. */
function progressReporter(extra: unknown): (progress: number, message: string) => void {
  const ex = extra as Extra;
  const token = ex?._meta?.progressToken;
  if (token === undefined || !ex.sendNotification) return () => {};
  return (progress, message) => {
    void ex.sendNotification?.({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(progress * 100), total: 100, message } }).catch(() => {});
  };
}

export const TOOL_NAMES = [
  'list_devices',
  'scan_network',
  'connect_device',
  'device_info',
  'wake_device',
  'press_keys',
  'type_text',
  'screenshot',
  'list_apps',
  'install_app',
  'launch_app',
  'stop_app',
  'reset_app',
  'webview_eval',
  'webview_console',
  'measure_performance',
  'performance_sweep',
  'watch_start',
  'watch_stop',
  'logcat',
  'explore_start',
  'explore_status',
  'explore_stop',
  'explore_findings',
  'learn_export',
] as const;

/** Builds an MCP server exposing FireLab's tools and prompts. One per client connection; they share `lab`. */
export function createMcpServer(lab: FireLab): McpServer {
  const server = new McpServer({ name: 'firelab', title: 'FireLab', version: firelabVersion() }, { instructions: INSTRUCTIONS, capabilities: { logging: {} } });
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
  const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  // ----- devices -----
  server.registerTool(
    'list_devices',
    {
      title: 'List devices',
      description:
        'Lists Fire TV / Android TV devices known to adb with their state ("device" = ready, "unauthorized" = someone must press Allow on the TV, "offline", "connecting"), model, friendly name (e.g. "Fire TV Stick 4K Plus"), Fire OS version, CPU ABI, RAM, GPU and the quality tier FireLab suggests for it. Start here.',
      inputSchema: {},
      annotations: ro,
    },
    () => run(async () => json({ devices: await lab.listDevices() })),
  );

  server.registerTool(
    'scan_network',
    {
      title: 'Scan the network',
      description:
        'Scans the local network (the /24 of each network interface, or the given subnet) for devices with ADB over Wi-Fi on port 5555 and checks they speak adb. Does not connect to anything and never triggers a prompt on other devices; use connect_device on a result. Takes about 2-5 seconds.',
      inputSchema: { subnet: z.string().optional().describe('CIDR range, e.g. "192.168.1.0/24". Default: this computer\'s local /24 networks.') },
      annotations: ro,
    },
    ({ subnet }) => run(async () => json(await lab.scan(subnet))),
  );

  server.registerTool(
    'connect_device',
    {
      title: 'Connect a device',
      description:
        'Connects to a device over Wi-Fi (adb connect) and keeps it connected (FireLab reconnects automatically if Wi-Fi drops). The first time, the TV shows "Allow USB debugging?": a person must select Allow (tick "Always allow"); until then the state is "unauthorized". Requires Developer options > ADB debugging ON on the device.',
      inputSchema: { ip: z.string().describe('IP address, optionally with port: "192.168.1.50" or "192.168.1.50:5555".') },
      annotations: act,
    },
    ({ ip }) => run(async () => json(await lab.connect(ip))),
  );

  server.registerTool(
    'device_info',
    {
      title: 'Device info',
      description:
        'Details of one device: model and friendly name, Fire OS / Android version, API level, ABIs (most Fire TV Sticks are 32-bit armeabi-v7a), RAM, screen resolution and density, SoC, GPU (the real WebGL renderer once a WebView has been inspected), suggested quality tier, whether the screen is awake or showing the screensaver, and the foreground app.',
      inputSchema: { device },
      annotations: ro,
    },
    ({ device: d }) => run(async () => json(await lab.deviceInfo(d))),
  );

  server.registerTool(
    'wake_device',
    {
      title: 'Wake device',
      description: 'Wakes the device from sleep or the screensaver (KEYCODE_WAKEUP, which does not act inside the foreground app) and confirms via the power manager. Use before screenshots or key presses if the screen may be off.',
      inputSchema: { device },
      annotations: act,
    },
    ({ device: d }) => run(async () => json(await lab.wake(d))),
  );

  // ----- remote -----
  server.registerTool(
    'press_keys',
    {
      title: 'Press remote keys',
      description: `Presses Fire TV remote buttons in order. Keys: ${REMOTE_KEY_NAMES.join(', ')} ("ok" is the center/select button). Modifiers: "down*3" presses three times, "ok:long" is a long press, "right:1500" holds for 1.5 s. Plain presses with gapMs 0 are sent in one batch (about 1 s on a Fire TV Stick); set gapMs (e.g. 300) when an app needs time between presses (animations, page loads). Take a screenshot afterwards to see the result.`,
      inputSchema: {
        device,
        keys: z.array(z.string()).min(1).max(100).describe('e.g. ["down", "down", "ok"] or ["right:1500"]'),
        gapMs: z.number().int().min(0).max(10000).optional().describe('Pause between presses in ms (default 0).'),
        holdMs: z.number().int().min(1).max(30000).optional().describe('Hold every key this long (ms), for games that read key-down time.'),
      },
      annotations: act,
    },
    ({ device: d, keys, gapMs, holdMs }) => run(async () => json(await lab.pressKeys(d, keys, { gapMs, holdMs }))),
  );

  server.registerTool(
    'type_text',
    {
      title: 'Type text',
      description: 'Types text into the focused text field (adb input text). Plain ASCII only. Focus a field first (press_keys "ok" on it). For WebView pages you can also set values with webview_eval.',
      inputSchema: { device, text: z.string().min(1).max(2000) },
      annotations: act,
    },
    ({ device: d, text }) => run(async () => json(await lab.typeText(d, text))),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot',
      description:
        'Captures the TV screen as a JPEG image (default 960 px wide, enough to read UI text). DRM-protected video shows black. Capture takes about 1-2.5 s over Wi-Fi.',
      inputSchema: {
        device,
        width: z.number().int().min(160).max(1920).optional().describe('Image width in px (default 960).'),
        quality: z.number().int().min(30).max(95).optional().describe('JPEG quality (default 70).'),
      },
      annotations: ro,
    },
    ({ device: d, width, quality }) =>
      run(async () => {
        const s = await lab.screenshot(d, { width: width ?? 960, quality });
        return {
          content: [
            { type: 'image', data: s.data.toString('base64'), mimeType: s.mime },
            { type: 'text', text: JSON.stringify({ device: s.device, width: s.width, height: s.height, captureMs: s.captureMs }) },
          ],
        };
      }),
  );

  // ----- apps -----
  server.registerTool(
    'list_apps',
    {
      title: 'List installed apps',
      description: 'Lists third-party (user-installed) apps with version and whether they have a launcher entry (launchable). Launchable apps come first.',
      inputSchema: { device },
      annotations: ro,
    },
    ({ device: d }) => run(async () => json(await lab.apps(d))),
  );

  server.registerTool(
    'install_app',
    {
      title: 'Install an APK',
      description:
        'CHANGES THE DEVICE: installs an APK file from this computer (adb install -r), replacing an existing install of the same app but keeping its data. Checks first that the APK\'s native code matches the device CPU (Fire TV Sticks are 32-bit ARM) and its minSdk. Returns the package name.',
      inputSchema: { device, path: z.string().describe('Path to the .apk on this computer.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ device: d, path }) => run(async () => json(await lab.install(d, path))),
  );

  server.registerTool(
    'launch_app',
    {
      title: 'Launch an app',
      description:
        'Wakes the device and starts an app on its TV (Leanback) launcher activity, or brings it to the front if it is running. Optional url is passed in the intent as data and as a "url" string extra (for WebView wrappers that read it). Returns the pid and the launch time Android reports.',
      inputSchema: {
        device,
        package: pkg,
        url: z.string().optional().describe('Optional URL for apps that accept one (intent data + "url" extra).'),
        activity: z.string().optional().describe('Explicit component, e.g. "com.example/.MainActivity". Default: the launcher activity.'),
      },
      annotations: act,
    },
    ({ device: d, package: p, url, activity }) => run(async () => json(await lab.launch(d, p, { url, activity }))),
  );

  server.registerTool(
    'stop_app',
    {
      title: 'Force-stop an app',
      description: 'CHANGES APP STATE: force-stops an app (am force-stop). Its process ends and unsaved in-app progress is lost; installed data and saves stay. Use to restart an app cleanly.',
      inputSchema: { device, package: pkg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ device: d, package: p }) => run(async () => json(await lab.stop(d, p))),
  );

  server.registerTool(
    'reset_app',
    {
      title: 'Reset an app (clear data)',
      description:
        'DELETES ALL OF THE APP\'S DATA (pm clear): saves, logins, settings and caches, so the next launch is a true first run. Cannot be undone. Only use on apps you are testing, never on a person\'s own apps, and only when asked. Requires confirm: true.',
      inputSchema: { device, package: pkg, confirm: z.literal(true).describe('Must be true: acknowledges that all app data is deleted.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ device: d, package: p, confirm }) => run(async () => json(await lab.reset(d, p, confirm === true))),
  );

  // ----- WebView -----
  server.registerTool(
    'webview_eval',
    {
      title: 'Evaluate JS in a WebView',
      description:
        'Runs a JavaScript expression in the page inside an app\'s WebView (over Chrome DevTools via adb) and returns its JSON value; promises are awaited. Great for reading game/app state, document.title, location.href, navigator.userAgent, or checking the DOM. The app must enable WebView debugging (WebView.setWebContentsDebuggingEnabled(true), usually in debug builds). Prefer read-only expressions; never loop inside the page waiting for UI state (it can freeze the page); poll from outside with repeated calls instead.',
      inputSchema: {
        device,
        expression: z.string().min(1).max(20000).describe('e.g. "document.title" or "({ url: location.href, w: innerWidth })"'),
        package: z.string().optional().describe('App whose WebView to use. Default: the foreground app, else any debuggable WebView.'),
        timeoutMs: z.number().int().min(100).max(60000).optional().describe('Default 10000.'),
      },
      annotations: act,
    },
    ({ device: d, expression, package: p, timeoutMs }) => run(async () => json(await lab.evaluate(d, expression, { package: p, timeoutMs }))),
  );

  server.registerTool(
    'webview_console',
    {
      title: 'WebView console',
      description:
        'Console messages and uncaught exceptions from the page in an app\'s WebView, recorded from the moment FireLab connected. Use waitMs to collect for a few seconds (e.g. while you press keys in another call), minLevel "warn" or "error" to focus on problems.',
      inputSchema: {
        device,
        package: z.string().optional(),
        minLevel: z.enum(['debug', 'log', 'info', 'warn', 'error']).optional(),
        since: z.number().optional().describe('Only entries after this epoch-ms timestamp.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 200 (newest).'),
        waitMs: z.number().int().min(0).max(30000).optional().describe('Collect for this long before returning.'),
      },
      annotations: ro,
    },
    ({ device: d, package: p, minLevel, since, limit, waitMs }) => run(async () => json(await lab.consoleLogs(d, { package: p, minLevel, since, limit, waitMs }))),
  );

  // ----- performance -----
  server.registerTool(
    'measure_performance',
    {
      title: 'Measure performance',
      description:
        'Measures the running app for a few seconds without changing anything: frame rate (median and p10 of per-second fps: from window.firelab if the page uses @firelab/perf, else by counting frames that draw WebGL / requestAnimationFrame; for apps without a WebView, such as Unity or native games, from SurfaceFlinger frame timing), memory (app + WebView renderer PSS in MB), CPU (% of one core, like top) and free device memory.',
      inputSchema: {
        device,
        package: z.string().optional().describe('Default: the foreground app.'),
        seconds: z.number().int().min(2).max(120).optional().describe('Default 10.'),
        fpsExpr: z.string().optional().describe('Optional JS expression returning the app\'s own fps number, e.g. "window.game.stats.fps".'),
      },
      annotations: ro,
    },
    ({ device: d, package: p, seconds, fpsExpr }) => run(async () => json(await lab.measure(d, { package: p, seconds, fpsExpr }))),
  );

  server.registerTool(
    'performance_sweep',
    {
      title: 'Quality-tier sweep',
      description:
        'For a WebView app or web game: loads the page at each quality tier (url?q=low, ?q=tv, ...), warms up, measures fps and memory, and recommends the richest tier that holds the target (default: median >= 30 fps within 5%, p10 >= 24) with a reason and a markdown table. Reloads the page several times and restores the original URL at the end. Takes about (warmupS + sampleS + load time) per tier: around 2 minutes for 3 tiers.',
      inputSchema: {
        device,
        url: z.string().describe('The page URL the app loads, e.g. "http://192.168.1.20:4173/". The tier parameter is added.'),
        package: z.string().optional().describe('The app hosting the WebView (launched if not running). Default: the foreground app\'s WebView.'),
        tiers: z.array(z.string()).optional().describe('Lightest to richest. Default ["low", "tv", "tv-hd", "high"].'),
        param: z.string().optional().describe('URL parameter name for the tier (default "q").'),
        warmupS: z.number().min(0).max(120).optional().describe('Seconds to wait after load before measuring (default 8).'),
        sampleS: z.number().min(3).max(300).optional().describe('Seconds to measure per tier (default 15).'),
        targetFps: z.number().min(10).max(120).optional().describe('Default 30.'),
        minP10: z.number().min(1).max(120).optional().describe('Default 80% of targetFps.'),
        actionKeys: z.array(z.string()).optional().describe('Remote keys to press after each load to reach a busy scene, e.g. ["ok", "down", "ok"].'),
        actionEval: z.string().optional().describe('JS to run after each load to reach a busy scene (awaited).'),
        fpsExpr: z.string().optional().describe('JS expression returning the app\'s own fps, if it has a meter.'),
      },
      annotations: act,
    },
    (args, extra) =>
      run(async () => {
        const report = progressReporter(extra);
        const r = await lab.sweep(
          args.device,
          {
            url: args.url,
            package: args.package,
            tiers: args.tiers,
            param: args.param,
            warmupS: args.warmupS,
            sampleS: args.sampleS,
            targetFps: args.targetFps,
            minP10: args.minP10,
            fpsExpr: args.fpsExpr,
            action: args.actionKeys || args.actionEval ? { keys: args.actionKeys, eval: args.actionEval } : undefined,
          },
          (j, message) => report(j.progress, message),
        );
        const out = { recommendation: r.job.recommendation, rows: r.job.rows, criteria: r.result?.criteria, device: r.result?.device, durationS: r.result?.durationS, resultPath: r.job.resultPath };
        return { content: [{ type: 'text', text: `${r.markdown ?? ''}\n\n${JSON.stringify(out, null, 1)}` }], structuredContent: out as Record<string, unknown> };
      }),
  );

  server.registerTool(
    'watch_start',
    {
      title: 'Start watching a play session',
      description:
        'Starts recording while a PERSON plays on the TV with the real remote: every remote press (via getevent; keys you send with press_keys are not recorded), fps / memory / CPU every few seconds, console errors, and a thumbnail every 10 s. Call watch_stop for the summary. One session per device.',
      inputSchema: {
        device,
        package: z.string().optional().describe('App to measure. Default: the foreground app.'),
        intervalMs: z.number().int().min(1000).max(60000).optional().describe('Perf sample interval (default 3000).'),
        thumbEveryS: z.number().int().min(0).max(600).optional().describe('Thumbnail interval in seconds (default 10, 0 = none).'),
      },
      annotations: act,
    },
    ({ device: d, package: p, intervalMs, thumbEveryS }) => run(async () => json(await lab.watchStart(d, { package: p, intervalMs, thumbEveryMs: thumbEveryS === undefined ? undefined : thumbEveryS * 1000 }))),
  );

  server.registerTool(
    'watch_stop',
    {
      title: 'Stop watching',
      description: 'Stops the play session recording and returns the summary: number of key presses and the most used keys, fps median / p10, peak memory, error count and first errors, thumbnail files and the folder with the full timeline (timeline.jsonl).',
      inputSchema: { device },
      annotations: act,
    },
    ({ device: d }) => run(async () => json(await lab.watchStop(d))),
  );

  server.registerTool(
    'logcat',
    {
      title: 'Device log',
      description: 'Recent Android log lines (logcat), optionally only from one app\'s process, at or above a level, or with a tag containing some text. Useful for native crashes (level "error"), ANRs and WebView renderer crashes.',
      inputSchema: {
        device,
        package: z.string().optional().describe('Only this app\'s process.'),
        lines: z.number().int().min(1).max(2000).optional().describe('Default 100.'),
        level: z.enum(['verbose', 'debug', 'info', 'warn', 'error', 'fatal']).optional().describe('Minimum level.'),
        tag: z.string().optional().describe('Only tags containing this text (case-insensitive).'),
      },
      annotations: ro,
    },
    ({ device: d, package: p, lines, level, tag }) => run(async () => json(await lab.logcat(d, { package: p, lines: lines ?? 100, minLevel: level, tag }))),
  );

  // ----- game testing engine -----
  const SEV = ['critical', 'major', 'minor', 'info'] as const;
  const jobView = (job: ExploreJob) => {
    const p = job.explorer?.progress();
    return {
      runId: job.runId,
      status: job.status,
      step: p?.step ?? 0,
      states: p?.states ?? 0,
      elapsedS: Math.round((p?.elapsedMs ?? Date.now() - job.startedAt) / 1000),
      findings: p?.findings ?? { critical: 0, major: 0, minor: 0, info: 0 },
      current: p?.current ? { stateId: p.current.stateId, label: p.current.label } : undefined,
      coverageCurve: p?.coverage.map((c) => ({ s: Math.round(c.t / 1000), states: c.states })),
      dir: p?.dir,
      ...(job.summary ? { report: job.summary.report.html, exitCode: job.summary.exitCode } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  };
  const image = (file: string | undefined) => {
    if (!file) return [];
    try {
      return [{ type: 'image' as const, data: fs.readFileSync(file).toString('base64'), mimeType: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg' }];
    } catch {
      return [];
    }
  };

  server.registerTool(
    'explore_start',
    {
      title: 'Start exploring an app',
      description:
        "Starts FireLab's game-testing engine in the background: it plays the app with the remote (Go-Explore: returns to promising screens and tries every key there, plus fast repeats and long presses), walks the D-pad focus on every new screen, and watches for crashes, ANRs, JS exceptions, black screens, frozen pictures or a stopped render loop, focus traps, unreachable controls and non-spatial D-pad moves. Afterwards it shrinks each finding to the shortest key sequence that reproduces it and writes report.html. Presses keys and relaunches the app for the whole run: don't use the TV meanwhile. Returns a runId for explore_status / explore_findings / explore_stop. Refuses com.sunsetvilla.tv.",
      inputSchema: {
        device,
        package: z.string().optional().describe('Android package name of the app to explore, e.g. "com.example.game" (see list_apps). Not needed with driver "demo".'),
        url: z.string().optional().describe('For a wrapped web app (firelab wrap): the page to open, passed as the launch intent\'s url extra.'),
        minutes: z.number().min(0.5).max(240).optional().describe('Exploration time (default 10). Shrinking runs afterwards.'),
        steps: z.number().int().min(5).max(100000).optional().describe('Stop after this many steps instead.'),
        seed: z.number().int().optional().describe('Random seed (default 1); the same seed repeats the same choices.'),
        keys: z.array(z.enum(['up', 'down', 'left', 'right', 'ok', 'back', 'menu', 'playpause', 'rewind', 'fastforward', 'home', 'search'])).optional().describe('Remote keys to use (default up down left right ok back menu playpause, rewind/fastforward rarely).'),
        oracles: z.array(z.enum(['health', 'screen', 'focus'])).optional().describe('Default all three.'),
        stateExpr: z.string().optional().describe('JS expression returning small JSON app state, e.g. "({mode: game.mode})"; makes states sharper.'),
        focusSelector: z.string().optional().describe('CSS selector of the focused control for apps that draw focus with a class, e.g. ".focused".'),
        strategy: z.enum(['explore', 'random']).optional().describe('"random" is the monkey baseline for comparisons.'),
        minimize: z.boolean().optional().describe('Shrink findings afterwards (default true).'),
        minimizeMinutes: z.number().min(0.5).max(60).optional().describe('Shrink budget per finding (default 20).'),
        emulateGpu: z.string().optional().describe('A Fire TV model id (e.g. "AFTSSS"): WebGL in the app reports only that model\'s GPU features and limits (WebGL2, max texture size, extensions, compressed formats, shader precision), not its speed; every WebGL call that fails becomes a gpu-unsupported finding. Useful on the emulator lab, which has the model\'s RAM and screen but not its GPU. Needs a debuggable WebView.'),
        driver: z
          .enum(['adb', 'vda', 'demo'])
          .optional()
          .describe('"adb" (default): Fire OS / Android TV. "vda": Vega OS over the Vega SDK\'s `vega` CLI; device is then a `vega exec vda devices` serial. Vega has no JS evaluation and FireLab sees the app go only when its process ends; states come from the screen. Not yet run on a real Vega device or the Vega Virtual Device. "demo": Lantern Lake, a simulated TV game with 6 seeded bugs that runs inside FireLab (no device needed; 10 minutes of device time take a few seconds): use it to try FireLab.'),
      },
      annotations: act,
    },
    ({ driver, ...args }) =>
      run(async () => {
        const job = startExploreJob({ ...args, device: args.device, driverKind: driver, lab, minimizeMinutes: args.minimizeMinutes });
        const runId = await waitForRunId(job, 90_000);
        if (job.status === 'failed') throw new FireLabError('bad-request', job.error ?? 'explore failed to start');
        return json({ runId, status: job.status, hint: 'Poll explore_status every 30-60 s; explore_findings when it is done (or any time).' });
      }),
  );

  server.registerTool(
    'explore_status',
    {
      title: 'Exploration status',
      description: 'Progress of an exploration run: status (running, minimizing, reporting, done, failed, stopped), steps, distinct states, findings per severity, the coverage curve (states over seconds), the current screen (as an image) and, when done, the report path and exit code.',
      inputSchema: { runId: z.string().describe('From explore_start.') },
      annotations: ro,
    },
    ({ runId }) =>
      run(async () => {
        const job = getExploreJob(runId);
        if (!job) {
          const r = readRunDir(resolveRunDir(runId));
          const counts = Object.fromEntries(SEV.map((sv) => [sv, r.findings.filter((f) => f.severity === sv).length]));
          return json({ runId, status: 'done', step: r.steps, states: r.states, findings: counts, report: path.join(r.dir, 'report.html') });
        }
        const v = jobView(job);
        const thumb = job.explorer?.progress().current?.thumb;
        return { content: [{ type: 'text', text: JSON.stringify(v, null, 1) }, ...image(thumb)], structuredContent: v as Record<string, unknown> };
      }),
  );

  server.registerTool(
    'explore_stop',
    {
      title: 'Stop exploring',
      description: 'Stops an exploration run (it keeps what it found, skips shrinking and writes the report). Returns the summary.',
      inputSchema: { runId: z.string() },
      annotations: act,
    },
    ({ runId }) =>
      run(async () => {
        const job = getExploreJob(runId);
        if (!job) throw new FireLabError('not-found', `No running exploration ${runId}`, { hint: 'explore_findings reads finished runs' });
        job.abort.abort();
        const summary = await job.done;
        return json({ ok: true, status: job.status, summary: summary ?? null, ...(job.error ? { error: job.error } : {}) });
      }),
  );

  server.registerTool(
    'explore_findings',
    {
      title: 'Exploration findings',
      description:
        'The findings of an exploration run (running or finished), most severe first: oracle, kind, title, detail, reproduction status and rate, and the key sequence that reproduces it (shrunk when shrinking ran), plus the screenshot of the first ones as images. Replay one with `firelab replay <trace>`.',
      inputSchema: {
        runId: z.string(),
        minSeverity: z.enum(SEV).optional().describe('Default minor (info findings such as "plateau" are left out).'),
      },
      annotations: ro,
    },
    ({ runId, minSeverity }) =>
      run(async () => {
        const job = getExploreJob(runId);
        const dir = job?.explorer?.dir ?? resolveRunDir(runId);
        const list = job?.explorer && job.status !== 'done' ? job.explorer.findingsSoFar() : readRunDir(dir).findings;
        const max = SEV.indexOf(minSeverity ?? 'minor');
        const keep = list.filter((f) => SEV.indexOf(f.severity) <= max).sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
        const readKeys = (file: string | undefined) => {
          try {
            const t = JSON.parse(fs.readFileSync(path.join(dir, 'traces', file ?? ''), 'utf8')) as { steps: { action: { kind: string; key?: string; repeat?: number; mode?: string } }[] };
            return t.steps.map((st) => (st.action.kind === 'key' ? `${st.action.key}${st.action.mode === 'long' ? ':long' : ''}${st.action.repeat ? `*${st.action.repeat}` : ''}` : st.action.kind));
          } catch {
            return [];
          }
        };
        const out = keep.map((f) => ({ id: f.id, severity: f.severity, oracle: f.oracle, kind: f.kind, title: f.title, detail: f.detail.slice(0, 800), status: f.status, repro: f.repro, keys: readKeys(f.minimized ?? f.trace), trace: path.join(dir, 'traces', f.minimized ?? f.trace), count: f.count }));
        const images = keep.slice(0, 3).flatMap((f) => image(f.evidence.thumbs[0] ? path.join(dir, 'thumbs', f.evidence.thumbs[0]) : undefined));
        return { content: [{ type: 'text', text: JSON.stringify({ runId, findings: out }, null, 1) }, ...images], structuredContent: { runId, findings: out } };
      }),
  );

  server.registerTool(
    'learn_export',
    {
      title: 'Export what FireLab learned (knowledge pack)',
      description:
        "Turns finished exploration runs into a FireLab knowledge pack the developer can contribute: the last remote keys of each confirmed, shrunk finding (a bug pattern such as 'ok*3 -> black-screen') and how often each key changed the app's state. Shares only key names, finding kinds, counts and hashed game ids: no URLs, package names, screen names, text, screenshots or code. Writes a JSON file and returns it with a summary. Nothing is uploaded: tell the developer they can contribute it by opening a pull request that adds the file to knowledge/ in the FireLab repository, and only if they want to. Future explore runs everywhere then try these patterns early on new screens.",
      inputSchema: {
        runIds: z.array(z.string()).optional().describe('Run ids or run directories (default: the 5 most recent runs).'),
        reject: z.array(z.string()).optional().describe('Finding ids the developer says are not bugs (they lower a pattern\'s weight).'),
      },
      annotations: act,
    },
    ({ runIds, reject }) =>
      run(async () => {
        const { exportKnowledge, describePack, writePack } = await import('../engine/learn.js');
        const base = exploreDir();
        let dirs = (runIds ?? []).map((r) => (fs.existsSync(path.join(r, 'run.json')) ? r : resolveRunDir(r)));
        if (!dirs.length && fs.existsSync(base))
          dirs = fs.readdirSync(base).map((d) => path.join(base, d)).filter((d) => fs.existsSync(path.join(d, 'run.json'))).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 5);
        if (!dirs.length) throw new FireLabError('bad-request', 'No exploration runs to learn from', { hint: 'Run explore_start first' });
        const pack = exportKnowledge(dirs, reject ?? []);
        const file = writePack(pack);
        return json({ file, summary: describePack(pack), howToContribute: 'Optional: fork the FireLab repository, add this file to knowledge/, and open a pull request.', pack });
      }),
  );

  // ----- prompts -----
  server.registerPrompt(
    'playtest',
    {
      title: 'Play-test an app on a Fire TV',
      description: 'Walks through a full play-test on a real device: launch, navigate with the remote, look for visual and console problems, measure performance, report.',
      argsSchema: {
        package: z.string().describe('Package of the app or game to test.'),
        goal: z.string().optional().describe('What to try, e.g. "start a new game and play the first level".'),
        device: z.string().optional(),
      },
    },
    ({ package: p, goal, device: d }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Play-test ${p} on the Fire TV${d ? ` ${d}` : ''} with FireLab's tools.`,
              goal ? `Goal: ${goal}.` : 'Goal: get through the first-run flow and the main screens.',
              '',
              '1. device_info (is the screen awake? which device, GPU and tier?); wake_device if needed.',
              `2. launch_app ${p}; wait a moment; screenshot.`,
              '3. Navigate with press_keys (D-pad: up/down/left/right, ok, back). Take a screenshot after each step and describe what you see. Note anything that is hard to read from 3 m away, focus that is invisible or lost, text cut off at the screen edges (TV overscan), or dead ends where Back does nothing.',
              '4. If it is a WebView app: webview_console with minLevel "warn" for errors; webview_eval for state you need (read-only expressions).',
              '5. measure_performance for 10 s in the busiest scene you reach.',
              '6. logcat with level "error" for the app if anything crashed or froze.',
              '7. Report: what works, what is broken (with screenshots described), performance numbers, and concrete fixes. Finish with press_keys ["home"].',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'tune_performance',
    {
      title: 'Tune quality tiers on a real device',
      description: 'Runs a quality-tier sweep for a WebView app or web game, explains the result, and suggests changes.',
      argsSchema: {
        url: z.string().describe('The page URL the app loads, e.g. http://192.168.1.20:4173/'),
        package: z.string().optional(),
        tiers: z.string().optional().describe('Comma-separated, lightest first. Default "low,tv,tv-hd,high".'),
        device: z.string().optional(),
      },
    },
    ({ url, package: p, tiers, device: d }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Find the best quality tier for ${url}${p ? ` (app ${p})` : ''} on the Fire TV${d ? ` ${d}` : ''}.`,
              '',
              '1. device_info: note the model, GPU and the tier FireLab suggests from the GPU.',
              `2. performance_sweep with url "${url}"${p ? `, package "${p}"` : ''}${tiers ? `, tiers ${JSON.stringify(tiers.split(',').map((t) => t.trim()))}` : ''}. If the first screen is a menu that doesn't render the heavy scene, pass actionKeys (or actionEval) that reach gameplay, so the measurement is meaningful.`,
              '3. Explain the table: median vs p10 (stutter), memory headroom (Fire TV Sticks have 1-2 GB shared with the GPU), and the recommendation.',
              '4. Suggest concrete changes: e.g. pick the tier from the GPU at startup with @firelab/perf (it also publishes window.firelab so FireLab can read the app\'s own fps), cap the frame rate at 30 on weak chips, adaptive resolution, fewer shadows/draw calls on the lighter tier.',
              '5. If a tier sits close to the line, re-run it with a longer sampleS before deciding.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'explore_app',
    {
      title: 'Hunt bugs in an app with the engine',
      description: "Runs FireLab's game-testing engine on an app, reads the findings and summarises them for the developer with repro keys.",
      argsSchema: {
        package: z.string().describe('Package of the app or game to test.'),
        minutes: z.string().optional().describe('Exploration time in minutes (default 10).'),
        device: z.string().optional(),
      },
    },
    ({ package: p, minutes, device: d }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Find bugs in ${p} on the Fire TV${d ? ` ${d}` : ''} with FireLab's engine.`,
              '',
              `1. explore_start with package "${p}"${minutes ? `, minutes ${minutes}` : ''}${d ? `, device "${d}"` : ''}. For a web app that marks focus with a class, pass focusSelector (e.g. ".focused").`,
              '2. explore_status every minute or so; describe the screen it shows and how many states and findings it has.',
              '3. When the status is done, explore_findings. For each finding: what the viewer would experience, the key sequence that reproduces it, how reliably it reproduced, and the likely cause (crash stack, JS error, which control traps focus).',
              '4. Finish with a short prioritised list of fixes and the path to report.html.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}
