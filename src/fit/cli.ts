/**
 * The `firelab fit`, `firelab profile` and `firelab media` commands, as one
 * function the main CLI can dispatch to: `return runFitCli(cmd, argv)`.
 * Exit codes: 0 ok, 1 error, 2 the --fail-on gate tripped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { FireLab } from '../core/firelab.js';
import { errorMessage } from '../lib/errors.js';
import { dataDir, firelabVersion } from '../lib/paths.js';
import { loadProfiles, defaultProfilesDir, saveProfile, mergeProfile, profileFileName } from '../profile/load.js';
import { assertProfile } from '../profile/schema.js';
import { captureProfile, factSummary } from '../profile/capture.js';
import { probeMedia } from '../media/probe.js';
import { describeMedia } from '../media/check.js';
import { readApkFacts } from './apk.js';
import { parseNeedsFlag, mergeNeeds } from './needs.js';
import { emptyMeasurement, readMeasurement, writeMeasurement, MEASUREMENT_FILE } from './measurement.js';
import { runFit, type SimulateOptions } from './run.js';
import { scoreFit } from './score.js';
import { ciGate, ciSummary } from './offline.js';
import { fitMarkdown, fitText } from './markdown.js';
import { renderFitReport } from './report/html.js';
import { buildTargets } from './targets.js';
import { checkMediaOn } from './checks.js';
import { gpuEmulationFor, gpuEmulationText, gpuRunText, runGpuEmulation, type GpuRunResult } from './gpu-emulate.js';
import { gpuShimBookmarklet, gpuShimFile } from './gpu-shim.js';
import { ONE_GB_STICKS, STATUS_MARK, type FitMeasurement, type FitReport } from './types.js';

export type FitIo = {
  out(s: string): void;
  err(s: string): void;
  /** Supplies the FireLab core (device mode). Default: a new FireLab. */
  lab?: () => FireLab | Promise<FireLab>;
};

const defaultIo: FitIo = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) };

export const FIT_HELP = `firelab fit: will your app run on every Fire TV? A per-model matrix from the one device you own.

  firelab fit [--apk app.apk] [--url <page>] [-p <package>] [-d <device>] [options]
  firelab fit --offline firelab-measurement.json [--fail-on AFTSSS,AFTSS] [--summary $GITHUB_STEP_SUMMARY]
  firelab fit --static --apk app.apk [--needs webgl2] [--media ./videos]

What to check
  --apk <file>             Static checks: CPU ABIs, minSdk, TV hardware in the manifest, Leanback, OpenGL ES
  --url <url>              The page the app loads (web checks, tier runs, GPU simulation)
  -p, --package <pkg>      The app (default: the foreground app)
  --needs <list>           What the page needs: webgl2, astc, etc2, max-texture=4096, float-render, webview>=110, ext:<EXT>, wasm-simd
  --detect-needs           Reload the page with a hook that records the WebGL it really uses
  --media <path|url>       MP4 files, folders or URLs to check (repeatable); the page's own media are added
  --no-page-media          Don't probe the media the page loaded

Measuring (on the device you own)
  --tiers tv,tv-hd         Measure at each tier (?q=<tier>); each model is judged at the tier it would use
  --param q                Tier URL parameter (default q)
  --seconds 15  --warmup 5  --target 30
  --simulate cpu,gpu,trim  Imitate slower models: CPU throttling, more pixels, RUNNING_CRITICAL trim-memory ("all" = all three)
  --simulate-for AFTSSS    Models to imitate (default AFTSSS)
  --scale-param scale      URL parameter that pins the render scale (@firelab/perf's ?scale=)
  --sim-scale 1            Render scale to imitate the target at (default 1 = the tier's full resolution)

GPU capability emulation (features and limits, not speed)
  --emulate-gpu A,B        Load the page with WebGL reporting only what each model's GPU supports, then list the
                           WebGL calls that failed (WebGL2, texture sizes, extensions, ASTC/ETC/S3TC, shader precision).
                           Runs on the device or emulator lab WebView for --seconds (play the game meanwhile)
  --script <file>          With --emulate-gpu: write the shim as a file instead (first <script> in your page, or a
                           userscript) to use in desktop Chrome without a device
  --bookmarklet            With --emulate-gpu: print a bookmarklet (catches contexts created after the click only)
                           --json, --markdown <file>; --strict exits 2 when a call failed

Scoring and output
  --offline <file>         Re-score a saved measurement, no device needed
  --static                 Don't touch a device (APK, --needs and media only)
  --models A,B             Only these models    --focus A,B   Models the headline is about (default AFTSSS,AFTSS)
  --profiles <dir>         Extra device profiles (beat the bundled ones)
  --out <file>             Where to save the measurement (default ${MEASUREMENT_FILE} when a device was measured)
  --report fit.html        Self-contained HTML report
  --markdown fit.md        Markdown report
  --summary <file>         Append the CI summary (e.g. "$GITHUB_STEP_SUMMARY")
  --fail-on A,B|all|none   Exit 2 when any of these is ❌ (default with --offline: AFTSSS,AFTSS; otherwise none)
  --strict                 ⚠️ also fails the gate
  --json  --all            JSON report / list every model
  -d, --device <id>

The verdicts are estimates; the real device is the final word.`;

export const PROFILE_HELP = `firelab profile: record what this Fire TV really has (start on the Home screen).

  firelab profile [-d <device>] [-p <WebView app>] [--url <page>] [--out <dir>] [--no-merge] [--json]

  -p, --package <pkg>   A debuggable WebView app (e.g. one made by firelab wrap) for WebGL, WebView and media facts; launched if not running
  --out <dir>           Where <MODEL>.json goes (default ./profiles in a FireLab checkout, else ~/.firelab/profiles)
  --no-merge            Replace an existing profile instead of merging into it

Read-only on the device: getprop, /proc/meminfo, wm size, cpufreq, dumpsys webviewupdate, and WebGL/MediaCapabilities in the page.`;

export const MEDIA_HELP = `firelab media: check MP4 files against every Fire TV's video decoders.

  firelab media <file|folder|url>... [--models A,B] [--profiles <dir>] [--json]

URLs are read with HTTP Range requests: only the headers are downloaded.`;

const list = (s?: string) => (s ? s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) : undefined);

/** Bundled profiles, then ~/.firelab/profiles, then ./profiles, then --profiles (later wins). */
export function profileDirs(extra?: string): string[] {
  const dirs = [defaultProfilesDir(), path.join(dataDir(), 'profiles')];
  // ./profiles only when it is a FireLab profiles folder (it has schema.json), not some app's own folder.
  if (fs.existsSync(path.resolve('profiles', 'schema.json'))) dirs.push(path.resolve('profiles'));
  if (extra) dirs.push(path.resolve(extra));
  return [...new Set(dirs)];
}

function loadAllProfiles(extra: string | undefined, io: FitIo) {
  const loaded = loadProfiles(profileDirs(extra));
  for (const e of loaded.errors) io.err(`Skipping invalid profile ${e.file}: ${e.errors.slice(0, 3).map((x) => `${x.path} ${x.message}`).join('; ')}`);
  return loaded.profiles;
}

function parseSimulate(s?: string): SimulateOptions | undefined {
  if (!s) return undefined;
  const parts = list(s) ?? [];
  if (parts.includes('all')) return { cpu: true, gpu: true, trim: true };
  const bad = parts.filter((p) => !['cpu', 'gpu', 'trim'].includes(p));
  if (bad.length) throw new Error(`--simulate takes cpu, gpu, trim or all (got ${bad.join(', ')})`);
  return { cpu: parts.includes('cpu'), gpu: parts.includes('gpu'), trim: parts.includes('trim') };
}

function writeOutputs(report: FitReport, v: Record<string, unknown>, io: FitIo, gateModels: string[] | 'all' | 'none' | undefined): number {
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
  if (str('report')) {
    fs.writeFileSync(str('report') as string, renderFitReport(report));
    io.err(`Report: ${path.resolve(str('report') as string)}`);
  }
  if (str('markdown')) fs.writeFileSync(str('markdown') as string, `${fitMarkdown(report)}\n`);
  const gate = gateModels ? ciGate(report, gateModels, { strict: v.strict === true }) : undefined;
  if (str('summary')) fs.appendFileSync(str('summary') as string, `${gate ? ciSummary(report, gate) : fitMarkdown(report)}\n\n`);
  if (v.json) io.out(JSON.stringify(report, null, 2));
  else io.out(fitText(report, { all: v.all === true }));
  if (gate) {
    io.err(gate.message);
    if (gate.unknown.length) io.err(`Unknown models in --fail-on: ${gate.unknown.join(', ')}`);
    if (gate.failed) return 2;
  }
  return 0;
}

function gateFrom(v: Record<string, unknown>, offline: boolean): string[] | 'all' | 'none' | undefined {
  const f = typeof v['fail-on'] === 'string' ? (v['fail-on'] as string).trim() : undefined;
  if (f === 'all' || f === 'none') return f;
  if (f) return list(f);
  return offline ? ONE_GB_STICKS : undefined;
}

async function fitCommand(argv: string[], io: FitIo): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      apk: { type: 'string' },
      url: { type: 'string' },
      package: { type: 'string', short: 'p' },
      device: { type: 'string', short: 'd' },
      needs: { type: 'string' },
      'detect-needs': { type: 'boolean' },
      media: { type: 'string', multiple: true },
      'no-page-media': { type: 'boolean' },
      tiers: { type: 'string' },
      param: { type: 'string' },
      seconds: { type: 'string' },
      warmup: { type: 'string' },
      target: { type: 'string' },
      simulate: { type: 'string' },
      'simulate-for': { type: 'string' },
      'scale-param': { type: 'string' },
      'sim-scale': { type: 'string' },
      offline: { type: 'string' },
      static: { type: 'boolean' },
      models: { type: 'string' },
      focus: { type: 'string' },
      profiles: { type: 'string' },
      out: { type: 'string' },
      report: { type: 'string' },
      markdown: { type: 'string' },
      summary: { type: 'string' },
      'fail-on': { type: 'string' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      name: { type: 'string' },
      'emulate-gpu': { type: 'string' },
      script: { type: 'string' },
      bookmarklet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (v.help) {
    io.out(FIT_HELP);
    return 0;
  }
  if (v['emulate-gpu'] !== undefined) return emulateGpuCommand(v, io);
  if (v.script || v.bookmarklet) throw new Error('--script and --bookmarklet go with --emulate-gpu <model>');
  const num = (k: 'seconds' | 'warmup' | 'target' | 'sim-scale') => {
    if (v[k] === undefined) return undefined;
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${k} must be a positive number`);
    return n;
  };
  const profiles = loadAllProfiles(v.profiles, io);
  const scoreOpts = { ...(list(v.models) ? { models: list(v.models) } : {}), ...(list(v.focus) ? { focus: list(v.focus) } : {}), ...(num('target') ? { targetFps: num('target') } : {}) };
  const flagNeeds = v.needs ? parseNeedsFlag(v.needs) : undefined;
  const apk = v.apk ? readApkFacts(v.apk) : undefined;
  const media = (v.media ?? []).flatMap((m) => list(m) ?? []);

  let m: FitMeasurement;
  if (v.offline) {
    m = readMeasurement(v.offline);
    if (flagNeeds) m.needs = mergeNeeds(m.needs, flagNeeds);
    if (apk) m.app.apk = apk;
    if (media.length) m.media = [...m.media, ...(await probeMedia(media))];
  } else if (v.static) {
    m = emptyMeasurement({ app: { ...(apk ? { apk } : {}), ...(v.url ? { url: v.url } : {}), ...(v.package ? { package: v.package } : {}), ...(v.name ? { name: v.name } : {}) }, ...(flagNeeds ? { needs: flagNeeds } : {}), ...(num('target') ? { targetFps: num('target') } : {}) });
    if (media.length) m.media = await probeMedia(media);
    m.notes.push('Static checks only (--static): no device was measured.');
  } else {
    const { FireLab } = await import('../core/firelab.js');
    const lab = io.lab ? await io.lab() : new FireLab({ autoReconnect: false });
    try {
      const { fitDepsFromLab } = await import('./lab.js');
      const { deps, package: pkg } = await fitDepsFromLab(lab, v.device, v.package);
      m = await runFit(
        deps,
        {
          ...(apk ? { apk } : {}),
          ...(v.url ? { url: v.url } : {}),
          ...(pkg ? { package: pkg } : {}),
          ...(v.name ? { name: v.name } : {}),
          ...(list(v.tiers) ? { tiers: list(v.tiers) } : {}),
          ...(v.param ? { param: v.param } : {}),
          ...(num('seconds') ? { seconds: num('seconds') } : {}),
          ...(num('warmup') ? { warmupS: num('warmup') } : {}),
          ...(num('target') ? { targetFps: num('target') } : {}),
          ...(flagNeeds ? { needs: flagNeeds } : {}),
          ...(v['detect-needs'] ? { detectNeeds: true } : {}),
          ...(parseSimulate(v.simulate) ? { simulate: parseSimulate(v.simulate) } : {}),
          ...(list(v['simulate-for']) ? { simulateFor: list(v['simulate-for']) } : {}),
          ...(v['scale-param'] ? { scaleParam: v['scale-param'] } : {}),
          ...(num('sim-scale') ? { simScale: num('sim-scale') } : {}),
          ...(media.length ? { media } : {}),
          ...(v['no-page-media'] ? { pageMedia: false } : {}),
          profiles,
        },
        (p) => io.err(`[${String(Math.round(p.progress * 100)).padStart(3)}%] ${p.message}`),
      );
    } finally {
      await lab.close().catch(() => {});
    }
    const out = v.out ?? MEASUREMENT_FILE;
    writeMeasurement(m, out);
    io.err(`Measurement: ${path.resolve(out)} (re-score it any time with firelab fit --offline ${out})`);
  }
  if (v.offline && v.out) writeMeasurement(m, v.out);
  const report = scoreFit(m, profiles, scoreOpts);
  return writeOutputs(report, v, io, gateFrom(v, !!v.offline));
}

/** `fit --emulate-gpu`: the GPU capability profile as a script, or run on the device's WebView. */
async function emulateGpuCommand(v: Record<string, string | boolean | string[] | undefined>, io: FitIo): Promise<number> {
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
  const models = list(str('emulate-gpu')) ?? [];
  if (!models.length) throw new Error('--emulate-gpu takes a model, e.g. --emulate-gpu AFTSSS (or several: AFTSSS,AFTT)');
  const profiles = loadAllProfiles(str('profiles'), io);
  const emus = models.map((m) => gpuEmulationFor(m, profiles));
  if (str('script') || v.bookmarklet || v.static) {
    if (str('script')) {
      if (emus.length > 1) throw new Error('--script writes one model: pass a single --emulate-gpu model');
      const file = str('script') as string;
      fs.writeFileSync(file, gpuShimFile(emus[0] as (typeof emus)[0]));
      io.err(`Shim: ${path.resolve(file)} (load it before the game's scripts; window.__firelabGpu.report() lists the failed calls)`);
    }
    if (v.bookmarklet) for (const e of emus) io.out(gpuShimBookmarklet(e));
    else if (v.json) io.out(JSON.stringify(emus.length === 1 ? emus[0] : emus, null, 2));
    else io.out(emus.map(gpuEmulationText).join('\n\n'));
    return 0;
  }
  const seconds = str('seconds') !== undefined ? Number(str('seconds')) : 20;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--seconds must be a positive number');
  const { FireLab } = await import('../core/firelab.js');
  const lab = io.lab ? await io.lab() : new FireLab({ autoReconnect: false });
  const results: GpuRunResult[] = [];
  try {
    const { fitDepsFromLab } = await import('./lab.js');
    const { deps } = await fitDepsFromLab(lab, str('device'), str('package'));
    if (!deps.openPage) throw new Error('No WebView page to load: GPU emulation needs a debuggable WebView app');
    const page = await deps.openPage();
    try {
      for (const [i, emu] of emus.entries())
        results.push(await runGpuEmulation(page, emu, { ...(str('url') ? { url: str('url') } : {}), seconds, sleep: deps.sleep, restore: i === emus.length - 1, onProgress: (m) => io.err(m) }));
    } finally {
      page.close();
    }
  } finally {
    await lab.close().catch(() => {});
  }
  if (v.json) io.out(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  else io.out(results.map(gpuRunText).join('\n\n'));
  if (str('markdown')) {
    const md = results.map((r) => ['## ' + `${r.name} (${r.model}), ${r.renderer}`, '', ...(r.failures.length ? r.failures.map((f) => `- ${f.sev === 'fail' ? '❌' : '⚠️'} \`${f.call}\` ${f.detail}${f.n > 1 ? ` (x${f.n})` : ''}`) : ['No WebGL call failed.']), '', ...r.notes.map((n) => `> ${n}`)].join('\n'));
    fs.writeFileSync(str('markdown') as string, `# GPU emulation\n\nWebGL features and limits of each model's GPU, not its speed.\n\n${md.join('\n\n')}\n`);
  }
  return v.strict && results.some((r) => r.failures.some((f) => f.sev === 'fail')) ? 2 : 0;
}

async function profileCommand(argv: string[], io: FitIo): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      device: { type: 'string', short: 'd' },
      package: { type: 'string', short: 'p' },
      url: { type: 'string' },
      out: { type: 'string' },
      'no-merge': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (v.help) {
    io.out(PROFILE_HELP);
    return 0;
  }
  const { FireLab } = await import('../core/firelab.js');
  const { captureDepsFromLab } = await import('./lab.js');
  const lab = io.lab ? await io.lab() : new FireLab({ autoReconnect: false });
  try {
    const { deps } = await captureDepsFromLab(lab, v.device, v.package, v.url);
    const { profile, warnings } = await captureProfile(deps, { firelabVersion: firelabVersion() });
    for (const w of warnings) io.err(`note: ${w}`);
    const dir = v.out ?? (fs.existsSync(path.resolve('profiles', 'schema.json')) ? path.resolve('profiles') : path.join(dataDir(), 'profiles'));
    const file = path.join(dir, profileFileName(profile.model));
    let final = profile;
    if (!v['no-merge'] && fs.existsSync(file)) {
      final = mergeProfile(assertProfile(JSON.parse(fs.readFileSync(file, 'utf8')), file), profile);
      io.err(`Merged into the existing ${file}`);
    }
    const saved = saveProfile(final, dir);
    if (v.json) io.out(JSON.stringify(final, null, 2));
    else {
      const s = factSummary(final);
      io.out(`${final.name} (${final.model}) -> ${saved}`);
      io.out(`  measured: ${s.measured.length} facts, spec: ${s.spec.length}, estimated: ${s.estimated.length}, unknown: ${s.unknown.length}`);
      if (s.unknown.length) io.out(`  still unknown: ${s.unknown.join(', ')}`);
      io.out('Share it: open a pull request adding this file to profiles/ (see profiles/README.md).');
    }
    return 0;
  } finally {
    await lab.close().catch(() => {});
  }
}

async function mediaCommand(argv: string[], io: FitIo): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { models: { type: 'string' }, profiles: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (v.help || !positionals.length) {
    io.out(MEDIA_HELP);
    return v.help ? 0 : 1;
  }
  const media = await probeMedia(positionals);
  const targets = buildTargets(loadAllProfiles(v.profiles, io), list(v.models)).filter((t) => !t.vega);
  const results = media.map((info) => ({
    info,
    models: targets.map((t) => ({ model: t.model, name: t.name, issues: checkMediaOn([info], t).perFile[0]?.issues ?? [] })),
  }));
  if (v.json) {
    io.out(JSON.stringify(results, null, 2));
    return 0;
  }
  for (const r of results) {
    io.out(`${r.info.source}\n  ${describeMedia(r.info)}`);
    const grouped = new Map<string, { status: string; reason: string; fix?: string; models: string[] }>();
    for (const mm of r.models)
      for (const i of mm.issues) {
        const g = grouped.get(i.key + i.reason) ?? { status: i.status, reason: i.reason, ...(i.fix ? { fix: i.fix } : {}), models: [] };
        g.models.push(mm.model);
        grouped.set(i.key + i.reason, g);
      }
    if (!grouped.size) io.out(`  ${STATUS_MARK.pass} fine on all ${targets.length} Fire OS models`);
    for (const g of grouped.values()) {
      io.out(`  ${STATUS_MARK[g.status as 'warn' | 'fail']} ${g.reason} [${g.models.length > 8 ? `${g.models.length} models` : g.models.join(', ')}]`);
      if (g.fix) io.out(`     fix: ${g.fix}`);
    }
  }
  return 0;
}

/** Entry point for `firelab fit | profile | media`. */
export async function runFitCli(command: string, argv: string[], io: FitIo = defaultIo): Promise<number> {
  try {
    if (command === 'fit') return await fitCommand(argv, io);
    if (command === 'profile') return await profileCommand(argv, io);
    if (command === 'media') return await mediaCommand(argv, io);
    io.err(`Unknown command "${command}". Use fit, profile or media.`);
    return 1;
  } catch (e) {
    io.err(`Error: ${errorMessage(e)}`);
    return 1;
  }
}
