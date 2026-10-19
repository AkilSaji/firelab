#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { FireLab } from './core/firelab.js';
import { FireLabError, errorMessage } from './lib/errors.js';
import { firelabVersion } from './lib/paths.js';
import { setLogLevel } from './lib/log.js';
import { openBrowser } from './lib/open.js';
import { findAdb, adbCandidates, ADB_INSTALL_HINT } from './adb/locate.js';
import { localInterfaces, defaultScanRanges } from './adb/discovery.js';
import { REMOTE_KEY_NAMES } from './adb/keys.js';
import type { Device } from './core/types.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1);
const dim = c(2);
const red = c(31);
const green = c(32);
const yellow = c(33);
const orange = c(38);

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${s}\n`);

const HELP = `${bold('firelab')} ${firelabVersion()}: test and tune apps and games on real Fire TV / Android TV devices

${bold('Usage')}
  firelab <command> [options]

${bold('Try it now (no Fire TV needed)')}
  demo [--minutes 10] [--out dir] [--no-open]   The game-testing engine on a simulated TV game; opens the report

${bold('For AI agents')}
  mcp [--http <port>] [--host <h>]   MCP server on stdio (default) or Streamable HTTP (/mcp)

${bold('For people')}
  ui [--port 7300] [--no-open]       Live dashboard: screen mirror, remote, perf charts, console, sweeps
  doctor                             Check adb, devices and Wi-Fi debugging; explains how to fix each problem
  devices [--scan] [--connect]       List devices; --scan finds Fire TVs on the Wi-Fi, --connect connects them
  connect <ip>  |  disconnect <ip>   adb over Wi-Fi (kept alive: FireLab reconnects on drops)
  info                               Model, Fire OS, ABI, RAM, GPU, tier, screen, power state, foreground app
  screenshot [-o file] [--width n] [--png]
  keys <key...> [--gap ms] [--hold ms]   e.g. firelab keys down*3 ok   (keys: ${REMOTE_KEY_NAMES.join(' ')})
  text <text>                        Type into the focused field
  wake                               Wake from sleep / screensaver
  apps                               Third-party apps
  launch <package> [--url u]  |  stop <package>  |  reset <package> --yes
  install <file.apk>
  eval <js> [--package p]            Evaluate JavaScript in an app's WebView
  logcat [--package p] [--level warn] [--lines 100]
  measure [--package p] [--seconds 10]
  sweep --url <url> [--package p] [--tiers low,tv,tv-hd,high] [--param q] [--seconds 15] [--warmup 8] [--target 30] [--keys "ok down"] [--eval js] [--out file]
  watch [--package p] [--minutes n]  Record a person's play session (Ctrl-C to stop)
  wrap ...                           Turn a web URL into a Fire TV APK

${bold('Will it run on every Fire TV?')}  (estimates from your one device plus model profiles; see firelab fit --help)
  fit [--apk app.apk] [--url u] [-p package] [--tiers tv,tv-hd] [--simulate all] [--report fit.html] [--fail-on AFTSSS,AFTSS]
  fit --offline firelab-measurement.json [--fail-on ...] [--summary file]   Re-score a saved measurement, no device
  fit --static --apk app.apk [--needs webgl2] [--media ./videos]           Manifest, needs and video checks only
  profile [-p <WebView app>]         Record this Fire TV's real facts into profiles/<MODEL>.json
  media <file|folder|url>...         Check MP4s against every Fire TV's video decoders

${bold('Emulators')}
  lab ...                            Fire-TV-shaped Android emulators for CI (firelab lab --help)

${bold('Game testing engine')}  (plays your app with the remote; finds crashes, black/frozen screens, focus traps)
  explore --package p | --apk f [--url u] [--minutes 10 | --steps n] [--seed 1] [--keys up,down,...]
          [--oracles health,screen,focus] [--state-expr js] [--focus-selector .focused] [--setup js]
          [--strategy explore|random|monkey] [--no-minimize] [--minimize-minutes 20] [--fail-on crash,black,frozen,focus-trap]
          [--baseline <runDir>] [--out dir] [--json]     exit code 1 when a --fail-on finding reproduces
          [--coverage] [--coverage-include <regex>]  V8 JS block coverage: a progress reward and a metric
          [--emulate-gpu AFTSSS]  WebGL reports only that model's GPU features and limits (not speed); failed calls are findings
          [--driver adb|vda|browser|demo]  browser = a web game in headless Chrome at the Fire TV viewport (--url, no TV; --headed shows the window);
                                           vda = Vega OS (--apk takes a .vpkg; not yet run on a real Vega device; docs/VEGA.md); demo = a simulated TV game
          [--knowledge <file|dir>] [--no-knowledge]   shared bug patterns and key priors (default: bundled + ~/.firelab/knowledge)
  learn export [<run>...] | show | merge   share what FireLab learned on your game (a JSON file for a pull request; firelab learn --help)
  bench [--subjects firefly,deep-quest] [--runs 5] [--minutes 10]   FireLab vs Random and Monkey on games with seeded bugs (firelab bench --help)
  replay <trace.json> [--times 5] [--driver adb|vda]    Replay a finding's keys from a fresh launch; prints reproduced k/n
  shrink <trace.json | runDir:f-id> [--budget-min 20] [--driver adb|vda]   Shrink a trace to the shortest repro
  report <runId | dir> [--baseline <runDir>] [--label <path>] [--open]    Rebuild report.html / report.md (--label: the path to show, for a report you publish)

${bold('Common options')}
  -d, --device <serial|ip>   Which device (optional when only one is connected)
  --json                     Machine-readable output
  --adb <path>               Use this adb binary (or set ADB=...)
  -v, --verbose / -q, --quiet

Start here: docs/GETTING-STARTED.md   More: README.md, docs/TOOLS.md, docs/ENGINE.md, docs/TROUBLESHOOTING.md`;

const COMMON: NonNullable<ParseArgsConfig['options']> = {
  device: { type: 'string', short: 'd' },
  json: { type: 'boolean' },
  adb: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
};

function parse(argv: string[], options: NonNullable<ParseArgsConfig['options']> = {}) {
  const { values, positionals } = parseArgs({ args: argv, options: { ...COMMON, ...options }, allowPositionals: true, strict: true });
  return { v: values as Record<string, string | boolean | string[] | undefined>, pos: positionals };
}

const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const n = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const x = Number(v);
  if (!Number.isFinite(x)) throw new FireLabError('bad-request', `--${name} must be a number`);
  return x;
};

function printJson(x: unknown): void {
  out(JSON.stringify(x, null, 2));
}

function deviceLine(d: Device): string {
  const st = d.state === 'device' ? green('ready') : d.state === 'unauthorized' ? yellow('unauthorized: press Allow on the TV') : red(d.state);
  const bits = [d.os, d.abi, d.ramMB ? `${d.ramMB} MB` : undefined, d.gpu, d.tier ? `tier ${d.tier}` : undefined, d.resolution ? `${d.resolution.width}x${d.resolution.height}` : undefined].filter(Boolean);
  return `${bold(d.id.padEnd(22))} ${st}  ${d.name ?? d.model ?? ''}${bits.length ? dim(`  (${bits.join(', ')})`) : ''}`;
}

export const FIRE_TV_ADB_STEPS = [
  'On the Fire TV: Settings > My Fire TV > About, then select the device name (e.g. "Fire TV Stick 4K") 7 times until it says you are a developer.',
  'Go back to My Fire TV > Developer options and turn ADB debugging ON. (On older Fire OS, Developer options are already there.)',
  'Find the TV\'s IP address in Settings > My Fire TV > About > Network.',
  'Run `firelab connect <ip>` (or `firelab devices --scan --connect`).',
  'The TV shows "Allow USB debugging?": tick "Always allow from this computer" and select OK.',
];

async function doctor(lab: FireLab, json: boolean, adbOverride?: string): Promise<number> {
  const checks: { name: string; ok: boolean | 'warn'; detail: string; fix?: string[] }[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js',
    ok: major >= 22 ? true : major >= 20 ? 'warn' : false,
    detail: `v${process.versions.node}`,
    fix: major >= 22 ? undefined : ['WebView features need Node 22+ (built-in WebSocket). Install Node 22 LTS or newer, or run Node 20 with --experimental-websocket.'],
  });
  const adbPath = adbOverride ?? findAdb();
  if (!adbPath) {
    checks.push({ name: 'adb', ok: false, detail: 'not found', fix: [ADB_INSTALL_HINT, `Looked in: ${adbCandidates({ env: process.env, platform: process.platform, home: process.env.HOME ?? '' }).slice(0, 6).join(', ')}, ...`] });
  }
  const health = await lab.health();
  if (health.adb) checks.push({ name: 'adb', ok: true, detail: `${health.adb.version} at ${health.adb.path}` });
  else if (adbPath) checks.push({ name: 'adb', ok: false, detail: health.error ?? 'not working', fix: health.error?.includes(ADB_INSTALL_HINT) ? undefined : [ADB_INSTALL_HINT] });
  const ifaces = localInterfaces();
  checks.push({
    name: 'Network',
    ok: ifaces.length ? true : 'warn',
    detail: ifaces.length ? ifaces.map((i) => `${i.name} ${i.address} (scans ${defaultScanRanges().join(', ')})`).join('; ') : 'no private IPv4 network found',
    fix: ifaces.length ? undefined : ['Connect this computer to the same Wi-Fi/LAN as the Fire TV.'],
  });
  let devices: Device[] = [];
  if (health.adb) {
    devices = await lab.listDevices().catch(() => []);
    const ready = devices.filter((d) => d.state === 'device');
    const unauth = devices.filter((d) => d.state === 'unauthorized');
    const off = devices.filter((d) => d.state === 'offline' || d.state === 'connecting');
    if (!devices.length) checks.push({ name: 'Devices', ok: false, detail: 'none connected', fix: FIRE_TV_ADB_STEPS });
    else checks.push({ name: 'Devices', ok: ready.length ? true : 'warn', detail: devices.map((d) => `${d.id} ${d.state}${d.name ? ` (${d.name})` : ''}`).join('; ') });
    if (unauth.length) {
      checks.push({
        name: 'Authorization',
        ok: false,
        detail: `${unauth.map((d) => d.id).join(', ')} waiting for approval`,
        fix: ['Look at the TV: a dialog "Allow USB debugging?" is showing. Tick "Always allow from this computer" and select OK.', 'No dialog? Run `adb kill-server`, then `firelab connect <ip>` again. Make sure only one adb version is installed (Android Studio and Homebrew can both ship one).'],
      });
    }
    if (off.length) checks.push({ name: 'Connection', ok: 'warn', detail: `${off.map((d) => d.id).join(', ')} offline`, fix: ['The TV may be asleep or off the Wi-Fi. FireLab keeps retrying; or run `adb disconnect && firelab connect <ip>`.', 'Fire TVs get new IPs from DHCP: `firelab devices --scan` finds them again.'] });
    for (const d of ready) {
      try {
        const info = await lab.deviceInfo(d.id);
        const pw = info.power;
        checks.push({
          name: `  ${d.id}`,
          ok: pw && !pw.awake ? 'warn' : true,
          detail: `${info.name}, ${info.os}, ${info.abis.join('/')}, ${info.ramMB} MB${pw ? `, screen ${pw.awake ? 'awake' : pw.dreaming ? 'screensaver' : (pw.wakefulness ?? 'off').toLowerCase()}` : ''}${info.foreground ? `, showing ${info.foreground}` : ''}`,
          fix: pw && !pw.awake ? ['Run `firelab wake` before testing (screenshots of a sleeping TV are black).'] : undefined,
        });
      } catch (e) {
        checks.push({ name: `  ${d.id}`, ok: 'warn', detail: errorMessage(e) });
      }
    }
  }
  try {
    const wrapMod = './wrap/index.js';
    const w = (await import(wrapMod)) as { wrapDoctorChecks?: () => typeof checks };
    if (typeof w.wrapDoctorChecks === 'function') checks.push(...w.wrapDoctorChecks());
  } catch {
    /* wrap not built: nothing to check */
  }
  if (json) {
    printJson({ ok: checks.every((x) => x.ok !== false), checks });
  } else {
    out(bold(`FireLab doctor (v${firelabVersion()})`));
    for (const ch of checks) {
      const mark = ch.ok === true ? green('[ok]') : ch.ok === 'warn' ? yellow('[!!]') : red('[XX]');
      out(`${mark} ${bold(ch.name)}: ${ch.detail}`);
      for (const [i, f] of (ch.fix ?? []).entries()) out(`     ${ch.fix && ch.fix.length > 1 ? `${i + 1}. ` : ''}${f}`);
    }
    if (checks.every((x) => x.ok !== false)) out(green('\nAll set. Try `firelab screenshot` or `firelab ui`.'));
  }
  return checks.every((x) => x.ok !== false) ? 0 : 1;
}

async function runWrapCommand(argv: string[]): Promise<number> {
  const target = './wrap/index.js';
  let mod: { runWrap?: (argv: string[]) => Promise<number> };
  try {
    mod = (await import(target)) as typeof mod;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' && String((e as Error).message).includes('wrap')) {
      out('`firelab wrap` (turn a web URL into a Fire TV APK) is coming soon.');
      return 0;
    }
    throw e;
  }
  if (typeof mod.runWrap !== 'function') {
    out('`firelab wrap` is coming soon.');
    return 0;
  }
  return mod.runWrap(argv);
}

const SEV_COLOR: Record<string, (x: string) => string> = { critical: red, major: yellow, minor: (x) => x, info: dim };

/** `--driver adb|vda|demo` for the engine commands (default adb). */
function driverKindOf(v: Record<string, unknown>): 'adb' | 'vda' | 'demo' | 'browser' | undefined {
  const k = s(v.driver);
  if (k === undefined) return undefined;
  if (k !== 'adb' && k !== 'vda' && k !== 'demo' && k !== 'browser') throw new FireLabError('bad-request', '--driver must be adb, vda, browser or demo', { hint: 'vda is Vega OS (docs/VEGA.md); browser is a web game in headless Chrome at the Fire TV viewport (no device); demo is a simulated TV game' });
  return k;
}

async function demoCommand(v: Record<string, string | boolean | string[] | undefined>, json: boolean): Promise<number> {
  const { runDemo } = await import('./engine/index.js');
  if (!json) {
    out(`${orange('FireLab demo')}: the game-testing engine plays ${bold('Lantern Lake')}, a simulated TV game with 6 seeded bugs.`);
    out(dim('No Fire TV needed: the game runs inside FireLab, and 10 minutes of device time take a few seconds.'));
    out('');
  }
  const seen = new Set<string>();
  const r = await runDemo({
    out: s(v.out),
    minutes: n(v.minutes, 'minutes'),
    seed: n(v.seed, 'seed'),
    onEvent: (e, run) => {
      if (json) return;
      if (e.type === 'phase' && e.phase === 'explore' && !seen.has(run)) {
        seen.add(run);
        out(run === 'random' ? dim('1/2  random baseline (presses random keys, for comparison)...') : dim('2/2  Go-Explore (returns to promising screens, walks the D-pad focus, then shrinks each bug)...'));
      }
      if (run === 'explore' && e.type === 'finding' && e.finding.severity !== 'info') out(`     ${SEV_COLOR[e.finding.severity]?.(e.finding.severity.toUpperCase().padEnd(8)) ?? e.finding.severity} ${e.finding.title}`);
    },
  });
  const sm = r.summary;
  if (json) printJson({ root: r.root, baseline: r.baselineDir, ...sm });
  else {
    out('');
    out(bold(`Found ${sm.findings.filter((f) => f.severity !== 'info').length} bugs in ${sm.steps} key presses over ${Math.round(sm.durationS / 60)} simulated minutes:`));
    for (const f of sm.findings.filter((x) => x.severity !== 'info')) out(`  ${(SEV_COLOR[f.severity] ?? ((x: string) => x))(f.severity.padEnd(8))} ${f.title}${dim(`  (${f.keys.length} key${f.keys.length === 1 ? '' : 's'}: ${f.keys.slice(0, 8).join(' ')}${f.keys.length > 8 ? ' …' : ''}${f.repro ? `; reproduced ${f.repro.hits}/${f.repro.runs}` : ''})`)}`);
    out('');
    out(`Report: ${bold(sm.report.html)}`);
    out(dim('Next: connect a Fire TV (firelab devices --scan --connect) or an emulator (firelab lab), then firelab explore --package <your.app>.'));
  }
  if (process.env.CODESPACES && !json) out(dim('In Codespaces: open the report file in the Explorer, right-click it and choose "Show Preview" (Live Preview).'));
  else if (!v['no-open'] && !json && !process.env.CI) openBrowser(`file://${sm.report.html}`);
  return 0;
}

async function exploreCommand(lab: FireLab, device: string | undefined, v: Record<string, string | boolean | string[] | undefined>, json: boolean): Promise<number> {
  const { explore } = await import('./engine/index.js');
  const driverKind = driverKindOf(v);
  const list = (x: unknown) => (typeof x === 'string' ? x.split(/[\s,]+/).filter(Boolean) : undefined);
  const strategy = s(v.strategy);
  if (strategy && strategy !== 'explore' && strategy !== 'random' && strategy !== 'monkey') throw new FireLabError('bad-request', '--strategy must be explore, random or monkey');
  const reset = s(v.reset);
  if (reset && reset !== 'relaunch' && reset !== 'clear-data') throw new FireLabError('bad-request', '--reset must be relaunch or clear-data');
  if (driverKind === 'browser' && !s(v.url)) throw new FireLabError('bad-request', 'The browser driver needs the game URL: firelab explore --driver browser --url <page>');
  if (!s(v.package) && !s(v.apk) && driverKind !== 'demo' && driverKind !== 'browser') throw new FireLabError('bad-request', 'Usage: firelab explore --package <id> | --apk <file.apk> [--url <page>] [--minutes 10]', { hint: 'For a web page, wrap it first: firelab wrap --url <url> --name <name> --install <device>, then explore --package dev.firelab.<name> --url <url>' });
  const t0 = Date.now();
  const stamp = () => dim(`[${String(Math.floor((Date.now() - t0) / 60000)).padStart(2, '0')}:${String(Math.floor(((Date.now() - t0) / 1000) % 60)).padStart(2, '0')}]`);
  const r = await explore({
    device,
    driverKind,
    lab,
    package: s(v.package),
    apk: s(v.apk),
    url: s(v.url),
    minutes: n(v.minutes, 'minutes'),
    steps: n(v.steps, 'steps'),
    seed: n(v.seed, 'seed'),
    keys: s(v.keys),
    oracles: list(v.oracles),
    stateExpr: s(v['state-expr']),
    focusSelector: s(v['focus-selector']),
    setup: s(v.setup),
    reset: reset as 'relaunch' | 'clear-data' | undefined,
    strategy: strategy as 'explore' | 'random' | 'monkey' | undefined,
    minimize: !v['no-minimize'],
    minimizeMinutes: n(v['minimize-minutes'], 'minimize-minutes'),
    allowPackages: v['allow-package'] as string[] | undefined,
    failOn: list(v['fail-on']),
    baseline: s(v.baseline),
    visualState: !!v.visual,
    emulateGpu: s(v['emulate-gpu']),
    ...(v['no-knowledge'] ? { knowledge: false } : Array.isArray(v.knowledge) && v.knowledge.length ? { knowledge: v.knowledge as string[] } : {}),
    coverage: s(v['coverage-include']) ?? (v.coverage ? true : undefined),
    headed: !!v.headed,
    profilesDir: s(v.profiles),
    out: s(v.out),
    onEvent: (e) => {
      if (e.type === 'start') err(`${orange('Exploring')} ${dim(`(${e.strategy}) run ${e.runId} -> ${e.dir}`)}`);
      else if (e.type === 'state') err(`${stamp()} ${green('new state')} ${e.label} ${dim(`(step ${e.step})`)}`);
      else if (e.type === 'finding') err(`${stamp()} ${SEV_COLOR[e.finding.severity]?.(bold(e.finding.severity.toUpperCase())) ?? e.finding.severity} ${e.finding.title} ${dim(`(${e.finding.id}, step ${e.finding.step})`)}`);
      else if (e.type === 'relaunch') err(`${stamp()} ${dim(`relaunch: ${e.reason}`)}`);
      else if (e.type === 'phase' && e.phase === 'minimize') err(`${stamp()} ${orange('shrinking')} ${e.detail ?? ''}`);
    },
  });
  if (json) printJson(r);
  else {
    out('');
    out(bold(`${r.app.package}: ${r.steps} steps, ${r.states} states in ${Math.round(r.durationS / 60)} min${r.stopped !== 'budget' ? ` (${r.stopped}${r.error ? `: ${r.error}` : ''})` : ''}`));
    if (r.depth) out(dim(`  deepest state: ${r.depth.max} actions from launch (mean ${r.depth.mean})${r.jsBlocks !== undefined ? ` · ${r.jsBlocks} JS blocks covered` : ''}`));
    if (!r.findings.length) out(green('No findings.'));
    for (const f of r.findings) {
      const rate = f.repro ? ` ${f.repro.hits}/${f.repro.runs}` : '';
      out(`  ${(SEV_COLOR[f.severity] ?? ((x: string) => x))(f.severity.padEnd(8))} ${f.failing ? red('FAIL ') : '     '}${f.title}`);
      out(dim(`           ${f.kind} · ${f.status}${rate} · ${f.keys.length} keys: ${f.keys.slice(0, 14).join(' ')}${f.keys.length > 14 ? ' …' : ''}`));
    }
    for (const note of r.notes) out(yellow(`  note: ${note}`));
    out('');
    out(`Report: ${bold(r.report.html)}`);
    out(r.failed ? red(`FAILED (--fail-on ${r.failOn.join(',')})`) : green(`passed (--fail-on ${r.failOn.join(',')})`));
  }
  if (v.open) openBrowser(`file://${r.report.html}`);
  return r.exitCode;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(HELP);
    return cmd ? 0 : 2;
  }
  if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
    out(firelabVersion());
    return 0;
  }
  if (cmd === 'wrap') return runWrapCommand(rest);
  if (cmd === 'lab') return (await import('./lab/cli.js')).runLab(rest);
  if (cmd === 'fit' || cmd === 'profile' || cmd === 'media') return (await import('./fit/cli.js')).runFitCli(cmd, rest);
  if (cmd === 'bench') return (await import('./bench/cli.js')).runBenchCli(rest);
  if (cmd === 'learn') return (await import('./engine/learn-cli.js')).runLearnCli(rest);

  const specs: Record<string, NonNullable<ParseArgsConfig['options']>> = {
    mcp: { http: { type: 'string' }, host: { type: 'string' } },
    ui: { port: { type: 'string', short: 'p' }, host: { type: 'string' }, 'no-open': { type: 'boolean' } },
    devices: { scan: { type: 'boolean' }, subnet: { type: 'string' }, connect: { type: 'boolean' } },
    screenshot: { output: { type: 'string', short: 'o' }, width: { type: 'string', short: 'w' }, png: { type: 'boolean' }, quality: { type: 'string' } },
    keys: { gap: { type: 'string' }, hold: { type: 'string' } },
    launch: { url: { type: 'string' }, activity: { type: 'string' } },
    reset: { yes: { type: 'boolean', short: 'y' } },
    eval: { package: { type: 'string', short: 'p' }, timeout: { type: 'string' } },
    logcat: { package: { type: 'string', short: 'p' }, level: { type: 'string', short: 'l' }, lines: { type: 'string', short: 'n' }, tag: { type: 'string' } },
    measure: { package: { type: 'string', short: 'p' }, seconds: { type: 'string', short: 's' }, 'fps-expr': { type: 'string' } },
    sweep: {
      url: { type: 'string', short: 'u' },
      package: { type: 'string', short: 'p' },
      tiers: { type: 'string', short: 't' },
      param: { type: 'string' },
      seconds: { type: 'string', short: 's' },
      warmup: { type: 'string' },
      target: { type: 'string' },
      'min-p10': { type: 'string' },
      keys: { type: 'string' },
      eval: { type: 'string' },
      'fps-expr': { type: 'string' },
      out: { type: 'string', short: 'o' },
      'no-restore': { type: 'boolean' },
    },
    watch: { package: { type: 'string', short: 'p' }, minutes: { type: 'string', short: 'm' }, interval: { type: 'string' }, thumbs: { type: 'string' } },
    explore: {
      package: { type: 'string', short: 'p' },
      apk: { type: 'string' },
      url: { type: 'string', short: 'u' },
      minutes: { type: 'string', short: 'm' },
      steps: { type: 'string' },
      seed: { type: 'string' },
      keys: { type: 'string' },
      oracles: { type: 'string' },
      'state-expr': { type: 'string' },
      'focus-selector': { type: 'string' },
      setup: { type: 'string' },
      reset: { type: 'string' },
      strategy: { type: 'string' },
      'no-minimize': { type: 'boolean' },
      'minimize-minutes': { type: 'string' },
      'allow-package': { type: 'string', multiple: true },
      'fail-on': { type: 'string' },
      baseline: { type: 'string' },
      visual: { type: 'boolean' },
      'emulate-gpu': { type: 'string' },
      knowledge: { type: 'string', multiple: true },
      'no-knowledge': { type: 'boolean' },
      coverage: { type: 'boolean' },
      'coverage-include': { type: 'string' },
      headed: { type: 'boolean' },
      profiles: { type: 'string' },
      out: { type: 'string', short: 'o' },
      open: { type: 'boolean' },
      driver: { type: 'string' },
    },
    demo: { minutes: { type: 'string', short: 'm' }, seed: { type: 'string' }, out: { type: 'string', short: 'o' }, 'no-open': { type: 'boolean' } },
    replay: { times: { type: 'string', short: 'n' }, 'allow-package': { type: 'string', multiple: true }, driver: { type: 'string' } },
    shrink: { 'budget-min': { type: 'string' }, 'allow-package': { type: 'string', multiple: true }, driver: { type: 'string' } },
    report: { baseline: { type: 'string' }, open: { type: 'boolean' }, label: { type: 'string' } },
  };
  const known = ['mcp', 'ui', 'doctor', 'devices', 'connect', 'disconnect', 'info', 'screenshot', 'keys', 'text', 'wake', 'apps', 'launch', 'stop', 'reset', 'install', 'eval', 'logcat', 'measure', 'sweep', 'watch', 'explore', 'replay', 'shrink', 'report', 'demo'];
  if (!known.includes(cmd)) {
    err(`Unknown command "${cmd}". Run \`firelab help\`.`);
    return 2;
  }
  const { v, pos } = parse(rest, specs[cmd]);
  if (v.help) {
    out(HELP);
    return 0;
  }
  if (cmd === 'mcp') setLogLevel(v.verbose ? 'debug' : 'warn');
  else if (v.quiet) setLogLevel('error');
  else if (v.verbose) setLogLevel('debug');
  const lab = new FireLab({ adbPath: s(v.adb) });
  const device = s(v.device);
  const json = !!v.json;

  try {
    switch (cmd) {
      case 'mcp': {
        if (v.http !== undefined) {
          const port = n(v.http, 'http') ?? 7301;
          const { runHttp } = await import('./mcp/transports.js');
          const host = s(v.host) ?? '127.0.0.1';
          const srv = await runHttp(lab, port, host);
          err(`FireLab MCP (Streamable HTTP) at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/mcp`);
          await new Promise<void>((resolve) => {
            const stop = () => srv.close(() => resolve());
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
          });
        } else {
          const { runStdio } = await import('./mcp/transports.js');
          await runStdio(lab);
        }
        return 0;
      }
      case 'ui': {
        const { startDashboard } = await import('./http/server.js');
        const port = n(v.port, 'port') ?? 7300;
        const { server, url } = await startDashboard(lab, { port, host: s(v.host) });
        out(`${orange('FireLab')} dashboard: ${bold(url)}  ${dim('(Ctrl-C to stop)')}`);
        if (!v['no-open']) openBrowser(url);
        await new Promise<void>((resolve) => {
          const stop = () => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
        return 0;
      }
      case 'doctor':
        return await doctor(lab, json, s(v.adb));
      case 'devices': {
        if (v.scan) {
          if (!json) err(dim(`Scanning ${s(v.subnet) ?? defaultScanRanges().join(', ')} for adb on port 5555...`));
          const r = await lab.scan(s(v.subnet));
          const results: { ip: string; port: number; adb?: string; model?: string; connected: boolean; result?: string }[] = [];
          for (const h of r.found) {
            const row: (typeof results)[number] = { ...h };
            if (v.connect && !h.connected) {
              try {
                const d = await lab.connect(`${h.ip}:${h.port}`);
                row.result = d.state === 'device' ? `connected: ${d.name ?? d.model}` : `connected, ${d.state}`;
              } catch (e) {
                row.result = errorMessage(e);
              }
            }
            results.push(row);
          }
          if (json) printJson(results);
          else if (!results.length) out('No adb devices found on the network. Is ADB debugging on? (`firelab doctor` explains how.)');
          else
            for (const h of results)
              out(`${bold(`${h.ip}:${h.port}`.padEnd(22))} ${h.connected ? green('connected') : h.adb === 'auth' ? 'adb (needs authorization on first connect)' : h.adb === 'open' ? `adb open${h.model ? ` (${h.model})` : ''}` : 'adb'}${h.result ? `  -> ${h.result}` : ''}`);
          if (!json && !v.connect && results.some((h) => !h.connected)) out(dim('Connect with `firelab connect <ip>` or add --connect.'));
          if (!v.connect) return 0;
          out('');
        }
        const devs = await lab.listDevices();
        if (json) printJson(devs);
        else if (!devs.length) out(`No devices connected.\n${FIRE_TV_ADB_STEPS.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}`);
        else for (const d of devs) out(deviceLine(d));
        return 0;
      }
      case 'connect': {
        const ip = pos[0] ?? device;
        if (!ip) throw new FireLabError('bad-request', 'Usage: firelab connect <ip>');
        const d = await lab.connect(ip);
        if (json) printJson(d);
        else out(d.state === 'unauthorized' ? yellow(`${d.id}: look at the TV and allow USB debugging (tick "Always allow")`) : deviceLine(d));
        return 0;
      }
      case 'disconnect': {
        const ip = pos[0] ?? device;
        if (!ip) throw new FireLabError('bad-request', 'Usage: firelab disconnect <ip>');
        await lab.disconnect(ip);
        if (!json) out(`Disconnected ${ip}`);
        return 0;
      }
      case 'info': {
        const info = await lab.deviceInfo(device);
        if (json) printJson(info);
        else {
          out(bold(`${info.name}  ${dim(info.id)}`));
          const rows: [string, unknown][] = [
            ['Model', `${info.model}${info.codename ? ` (${info.codename})` : ''}`],
            ['OS', `${info.os}, API ${info.sdk}`],
            ['Build', info.buildId],
            ['CPU', `${info.soc ?? ''} ${info.abis.join(', ')}`],
            ['RAM', info.ramMB ? `${info.ramMB} MB` : undefined],
            ['GPU', info.gpu ? `${info.gpu}${info.gpuSource === 'spec' ? dim(' (from spec sheet)') : ''}` : undefined],
            ['Tier', info.tier],
            ['Screen', info.resolution ? `${info.resolution.width}x${info.resolution.height} @ ${info.density} dpi` : undefined],
            ['Power', info.power ? (info.power.awake ? 'awake' : info.power.dreaming ? 'screensaver' : info.power.wakefulness) : undefined],
            ['Foreground', info.foreground],
          ];
          for (const [k, val] of rows) if (val) out(`  ${dim(k.padEnd(11))} ${val}`);
        }
        return 0;
      }
      case 'screenshot': {
        const png = !!v.png || /\.png$/i.test(s(v.output) ?? '');
        const shot = await lab.screenshot(device, { format: png ? 'png' : 'jpeg', width: n(v.width, 'width') ?? 1920, quality: n(v.quality, 'quality') ?? 85 });
        const file = s(v.output) ?? `firelab-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${png ? 'png' : 'jpg'}`;
        fs.writeFileSync(file, shot.data);
        if (json) printJson({ file: path.resolve(file), width: shot.width, height: shot.height, captureMs: shot.captureMs, method: shot.method });
        else out(`${path.resolve(file)}  ${dim(`${shot.width}x${shot.height}, captured in ${shot.captureMs} ms (${shot.method})`)}`);
        return 0;
      }
      case 'keys': {
        if (!pos.length) throw new FireLabError('bad-request', `Usage: firelab keys <key...>  (${REMOTE_KEY_NAMES.join(' ')}; down*3, ok:long, right:1500)`);
        const r = await lab.pressKeys(device, pos, { gapMs: n(v.gap, 'gap'), holdMs: n(v.hold, 'hold') });
        if (json) printJson(r);
        else out(`Pressed ${r.pressed.map((p) => (p.mode === 'press' ? p.key : `${p.key}:${p.mode === 'long' ? 'long' : p.holdMs}`)).join(' ')} on ${r.device}`);
        return 0;
      }
      case 'text': {
        if (!pos.length) throw new FireLabError('bad-request', 'Usage: firelab text "<text>"');
        await lab.typeText(device, pos.join(' '));
        return 0;
      }
      case 'wake': {
        const r = await lab.wake(device);
        if (json) printJson(r);
        else out(r.ok ? (r.woke ? 'Woke the device.' : 'Already awake.') : yellow(`Still ${r.wakefulness ?? 'asleep'}${r.dreaming ? ' (screensaver)' : ''}.`));
        return r.ok ? 0 : 1;
      }
      case 'apps': {
        const r = await lab.apps(device);
        if (json) printJson(r.apps);
        else for (const a of r.apps) out(`${a.launchable === false ? dim(a.package) : bold(a.package)}${a.version ? dim(`  ${a.version}`) : ''}${a.launchable === false ? dim('  (no launcher entry)') : ''}`);
        return 0;
      }
      case 'launch': {
        if (!pos[0]) throw new FireLabError('bad-request', 'Usage: firelab launch <package> [--url u]');
        const r = await lab.launch(device, pos[0], { url: s(v.url), activity: s(v.activity) });
        if (json) printJson(r);
        else out(`Started ${r.activity}${r.pid ? ` (pid ${r.pid})` : ''}${r.launchMs ? `, ${r.launchState ? `${r.launchState.toLowerCase()} start ` : ''}${r.launchMs} ms` : ''}`);
        return 0;
      }
      case 'stop': {
        if (!pos[0]) throw new FireLabError('bad-request', 'Usage: firelab stop <package>');
        await lab.stop(device, pos[0]);
        if (!json) out(`Stopped ${pos[0]}`);
        return 0;
      }
      case 'reset': {
        if (!pos[0]) throw new FireLabError('bad-request', 'Usage: firelab reset <package> --yes');
        if (!v.yes) throw new FireLabError('confirm-required', `This deletes ALL data of ${pos[0]} (saves, logins, settings)`, { hint: 'Add --yes if you mean it' });
        await lab.reset(device, pos[0], true);
        if (!json) out(`Cleared all data of ${pos[0]}`);
        return 0;
      }
      case 'install': {
        if (!pos[0]) throw new FireLabError('bad-request', 'Usage: firelab install <file.apk>');
        const r = await lab.install(device, pos[0]);
        if (json) printJson(r);
        else {
          out(`Installed ${r.package}${r.versionName ? ` ${r.versionName}` : ''} on ${r.device}`);
          for (const w of r.warnings) out(yellow(`  ${w}`));
        }
        return 0;
      }
      case 'eval': {
        if (!pos.length) throw new FireLabError('bad-request', 'Usage: firelab eval "<js expression>" [--package p]');
        const r = await lab.evaluate(device, pos.join(' '), { package: s(v.package), timeoutMs: n(v.timeout, 'timeout') });
        if (json) printJson(r);
        else out(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2));
        return 0;
      }
      case 'logcat': {
        const r = await lab.logcat(device, { package: s(v.package), lines: n(v.lines, 'lines') ?? 100, minLevel: s(v.level) as 'warn' | undefined, tag: s(v.tag) });
        if (json) printJson(r);
        else {
          if (r.note) out(yellow(r.note));
          for (const l of r.lines) {
            const lv = l.level === 'error' || l.level === 'fatal' ? red : l.level === 'warn' ? yellow : (x: string) => x;
            out(`${dim(new Date(l.ts).toLocaleTimeString())} ${lv(l.level[0]?.toUpperCase() ?? '?')} ${bold(l.tag)}: ${l.text}`);
          }
        }
        return 0;
      }
      case 'measure': {
        const seconds = n(v.seconds, 'seconds') ?? 10;
        if (!json) err(dim(`Measuring for ${seconds} s...`));
        const m = await lab.measure(device, { package: s(v.package), seconds, fpsExpr: s(v['fps-expr']) });
        if (json) printJson(m);
        else {
          out(bold(`${m.package ?? 'foreground app'} on ${m.device}`));
          if (m.fps) out(`  fps     median ${m.fps.median}, p10 ${m.fps.p10} (min ${m.fps.min}, max ${m.fps.max}; ${m.fps.samples} s, ${m.fps.source}${m.fps.counter ? `/${m.fps.counter}` : ''})`);
          if (m.memMB !== undefined) out(`  memory  ${m.memMB} MB (app ${m.appPssMB ?? '-'} + WebView renderer ${m.rendererPssMB ?? '-'}; graphics ${m.graphicsMB ?? '-'})${m.memAvailableMB !== undefined ? `, device free ${m.memAvailableMB} MB` : ''}`);
          if (m.cpuPct !== undefined) out(`  cpu     ${m.cpuPct}% of one core${m.deviceCpuPct !== undefined ? ` (device ${m.deviceCpuPct}% of all cores)` : ''}`);
          if (m.jank) out(`  ui      ${m.jank.totalFrames} frames, ${m.jank.jankyPct ?? 0}% janky${m.jank.p90 !== undefined ? `, p90 ${m.jank.p90} ms, p99 ${m.jank.p99} ms` : ''}`);
          for (const note of m.notes) out(yellow(`  ${note}`));
        }
        return 0;
      }
      case 'sweep': {
        const url = s(v.url) ?? pos[0];
        if (!url) throw new FireLabError('bad-request', 'Usage: firelab sweep --url <page url> [--package p] [--tiers low,tv,tv-hd,high]');
        const keys = s(v.keys)?.split(/[\s,]+/).filter(Boolean);
        const r = await lab.sweep(
          device,
          {
            url,
            package: s(v.package),
            tiers: s(v.tiers)?.split(',').map((t) => t.trim()).filter(Boolean),
            param: s(v.param),
            sampleS: n(v.seconds, 'seconds'),
            warmupS: n(v.warmup, 'warmup'),
            targetFps: n(v.target, 'target'),
            minP10: n(v['min-p10'], 'min-p10'),
            fpsExpr: s(v['fps-expr']),
            restore: !v['no-restore'],
            action: keys || s(v.eval) ? { keys, eval: s(v.eval) } : undefined,
          },
          (j, message) => {
            if (!json) err(dim(`[${String(Math.round(j.progress * 100)).padStart(3)}%] ${message}`));
          },
        );
        const result = { ...r.result, markdown: r.markdown, resultPath: r.job.resultPath };
        if (s(v.out)) fs.writeFileSync(s(v.out) as string, /\.md$/i.test(s(v.out) as string) ? `${r.markdown}\n` : JSON.stringify(result, null, 2));
        if (json) printJson(result);
        else {
          out('');
          out(r.markdown ?? '');
          out(dim(`\nSaved: ${r.job.resultPath}`));
        }
        return 0;
      }
      case 'demo':
        return await demoCommand(v, json);
      case 'explore':
        return await exploreCommand(lab, device, v, json);
      case 'replay': {
        if (!pos[0]) throw new FireLabError('bad-request', 'Usage: firelab replay <trace.json> [--times 5]');
        const { replay } = await import('./engine/index.js');
        const times = n(v.times, 'times') ?? 1;
        if (!json) err(dim(`Replaying ${pos[0]} ${times}x from a fresh launch...`));
        const r = await replay({ trace: pos[0], device, driverKind: driverKindOf(v), times, lab, allowPackages: v['allow-package'] as string[] | undefined });
        if (json) printJson({ hits: r.hits, runs: r.runs, expect: r.expect, keys: r.keys, detail: r.detail });
        else {
          out(`keys: ${r.keys.join(' ') || '(none)'}`);
          out(r.expect ? `${r.hits ? red('reproduced') : green('not reproduced')} ${bold(`${r.hits}/${r.runs}`)}: ${r.expect.signature}` : `replayed ${r.runs}x (the trace expects nothing)`);
        }
        return r.hits ? 1 : 0;
      }
      case 'shrink': {
        if (!pos[0]) throw new FireLabError('bad-request', 'Usage: firelab shrink <trace.json | runDir:findingId> [--budget-min 20]');
        const { shrink } = await import('./engine/index.js');
        const r = await shrink({ target: pos[0], device, driverKind: driverKindOf(v), lab, budgetMin: n(v['budget-min'], 'budget-min'), allowPackages: v['allow-package'] as string[] | undefined, onProgress: (m) => !json && err(dim(m)) });
        if (json) printJson(r);
        else {
          out(`${bold(`${r.before} -> ${r.after} keys`)}, ${r.status} ${r.repro.hits}/${r.repro.runs} (${r.tests} replays)`);
          out(`keys: ${r.keys.join(' ') || '(none)'}`);
          if (r.status !== 'not-reproduced') out(dim(r.file));
        }
        return 0;
      }
      case 'report': {
        if (!pos[0]) throw new FireLabError('bad-request', 'Usage: firelab report <runId | dir> [--open]');
        const { report } = await import('./engine/index.js');
        const r = report(pos[0], { baseline: s(v.baseline), dirLabel: s(v.label) });
        if (json) printJson({ html: r.html, md: r.md });
        else out(r.html);
        if (v.open) openBrowser(`file://${r.html}`);
        return 0;
      }
      case 'watch': {
        const minutes = n(v.minutes, 'minutes');
        const w = await lab.watchStart(device, { package: s(v.package), intervalMs: n(v.interval, 'interval'), thumbEveryMs: v.thumbs !== undefined ? (n(v.thumbs, 'thumbs') ?? 10) * 1000 : undefined });
        const session = lab.watchFor(w.device);
        err(`${orange('Watching')} ${w.device}${w.package ? ` (${w.package})` : ''}: play with the remote. ${dim(`Ctrl-C to stop${minutes ? `, or after ${minutes} min` : ''}. Saving to ${w.dir}`)}`);
        if (!json && session) {
          session.on('key', (k) => k.action === 'down' && out(`${dim(new Date(k.ts).toLocaleTimeString())} key  ${bold(k.key)}`));
          session.on('key', (k) => k.action === 'up' && k.holdMs !== undefined && k.holdMs > 600 && out(dim(`              (held ${k.key} ${(k.holdMs / 1000).toFixed(1)} s)`)));
          session.on('perf', (p) => out(`${dim(new Date(p.ts).toLocaleTimeString())} perf ${p.fps !== undefined ? `${p.fps} fps ` : ''}${p.memMB !== undefined ? `${p.memMB} MB ` : ''}${p.cpuPct !== undefined ? `${p.cpuPct}% cpu` : ''}`));
          session.on('log', (l) => l.level === 'error' && out(red(`${new Date(l.ts).toLocaleTimeString()} error ${l.text.slice(0, 200)}`)));
        }
        await new Promise<void>((resolve) => {
          const t = minutes ? setTimeout(resolve, minutes * 60_000) : undefined;
          process.once('SIGINT', () => {
            clearTimeout(t);
            resolve();
          });
        });
        const summary = await lab.watchStop(w.device);
        if (json) printJson(summary);
        else {
          out('');
          out(bold('Session summary'));
          out(`  duration ${Math.round(((summary.endedAt ?? Date.now()) - summary.startedAt) / 1000)} s, ${summary.keys} key presses${summary.topKeys?.length ? ` (${summary.topKeys.map((k) => `${k.key} x${k.count}`).join(', ')})` : ''}`);
          if (summary.fps) out(`  fps median ${summary.fps.median}, p10 ${summary.fps.p10}`);
          if (summary.memMB) out(`  peak memory ${summary.memMB.max} MB`);
          out(`  ${summary.errors} errors${summary.firstErrors?.length ? `: ${summary.firstErrors[0]}` : ''}`);
          out(`  ${summary.thumbnails.length} thumbnails, timeline in ${summary.dir}`);
        }
        return 0;
      }
    }
    return 2;
  } finally {
    await lab.close();
  }
}

// Tests import main() instead of running the CLI.
if (!process.env.VITEST) main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof FireLabError) {
      err(red(e.message));
      if (e.hint) err(e.hint);
      process.exit(e.code === 'bad-request' ? 2 : 1);
    }
    if ((e as { code?: string })?.code?.startsWith?.('ERR_PARSE_ARGS')) {
      err(red((e as Error).message));
      err('Run `firelab help` for usage.');
      process.exit(2);
    }
    err(red(`Unexpected error: ${(e as Error)?.stack ?? e}`));
    process.exit(1);
  },
);
