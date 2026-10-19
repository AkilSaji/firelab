/**
 * VdaDriver: the DeviceDriver for Vega OS (Fire TV Stick 4K Select and newer,
 * and the Vega Virtual Device), over the Vega SDK's `vda` and `inputd-cli`.
 *
 * NOT YET TESTED ON A REAL VEGA DEVICE. It follows Amazon's Vega 0.24 docs,
 * and the unit tests run it against a fake `vega` CLI. docs/VEGA.md lists each
 * command with its status (documented / assumed) and how to verify it.
 *
 * What Vega can't do the way Fire OS does: there is no Android WebView, so no
 * CDP eval/console (caps eval/console/cdp stay false), no frame-rate
 * measurement, no getevent key recording, and no clearing of app data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodePng, encodePng } from '../adb/png.js';
import { encodeJpeg, resizeRgba } from '../adb/image.js';
import { FireLabError } from '../lib/errors.js';
import { sleep } from '../lib/util.js';
import { minimalCaps, type AppRef, type DeviceDriver, type DriverCaps, type DriverInfo, type Frame, type KeySpec, type LogLine, type MemorySample } from '../driver/types.js';
import { VEGA_KEYS, escapeSendText, inputdArgs } from './keys.js';
import { parseAceMemusage, parsePid, parseVdaDevices, parseVegaLogs, type VdaDevice } from './parse.js';
import type { VegaResult, VegaRunner } from './runner.js';

const LEVELS: LogLine['level'][] = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'];

export type VdaDriverOptions = {
  serial: string;
  runner: VegaRunner;
  /** Override key names (e.g. { home: 'KEY_HOME' }) once a real device shows which ones it takes. */
  keyMap?: Partial<Record<keyof typeof VEGA_KEYS, string>>;
  /** Where screenshots are written on the device before `vda pull` (default /tmp/firelab-shot.png). */
  remoteShotPath?: string;
  /** Per-command timeout (default 30 s; installs get 5 min). */
  timeoutMs?: number;
};

function assertApp(app: AppRef | undefined): string {
  const id = app?.package;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) {
    throw new FireLabError('bad-request', `"${String(id)}" is not a Vega app id`, { hint: 'e.g. com.example.game (the component id in your manifest)' });
  }
  return id;
}

export class VdaDriver implements DeviceDriver {
  readonly kind = 'vda' as const;
  readonly serial: string;
  readonly caps: DriverCaps;
  private readonly runner: VegaRunner;
  private readonly keyMap: Record<string, string>;
  private readonly remoteShot: string;
  private readonly timeoutMs: number;
  private resolution?: { width: number; height: number };
  private lastLaunched?: string;
  private closed = false;

  constructor(o: VdaDriverOptions) {
    if (!o.serial) throw new FireLabError('bad-request', 'VdaDriver needs a device serial');
    this.serial = o.serial;
    this.runner = o.runner;
    this.keyMap = { ...VEGA_KEYS, ...(o.keyMap ?? {}) } as Record<string, string>;
    this.remoteShot = o.remoteShotPath ?? '/tmp/firelab-shot.png';
    this.timeoutMs = o.timeoutMs ?? 30000;
    // Documented on Amazon's pages: keys + holds (inputd-cli), text (send_text),
    // screenshots (gwsi-tool-screenshooter), logs (loggingctl). Install and
    // memory are enabled but their exact output is unverified.
    this.caps = { ...minimalCaps(), holds: true, text: true, rgbaThumb: true, install: true, memory: true };
  }

  private assertOpen(): void {
    if (this.closed) throw new FireLabError('bad-request', 'This Vega driver is closed');
  }

  private async exec(args: string[], what: string, timeoutMs = this.timeoutMs): Promise<VegaResult> {
    this.assertOpen();
    const r = await this.runner.run(args, { serial: this.serial, timeoutMs });
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout.toString('utf8')).trim().split('\n').slice(-3).join(' ').slice(0, 400);
      throw new FireLabError('adb-failed', `Vega: ${what} failed${msg ? `: ${msg}` : ''}`, { hint: 'Is the device connected? Check `vega exec vda devices`. See docs/VEGA.md' });
    }
    return r;
  }

  /** `vega exec vda -s <serial> ...` */
  private vda(args: string[], what: string, timeoutMs?: number): Promise<VegaResult> {
    return this.exec(['exec', 'vda', '-s', this.serial, ...args], what, timeoutMs);
  }

  private async shell(command: string[], what: string, timeoutMs?: number): Promise<string> {
    return (await this.vda(['shell', ...command], what, timeoutMs)).stdout.toString('utf8');
  }

  // ---------- device ----------

  async info(): Promise<DriverInfo> {
    const list = parseVdaDevices((await this.vda(['devices', '-l'], 'listing devices')).stdout.toString('utf8'));
    const d: VdaDevice | undefined = list.find((x) => x.serial === this.serial);
    const out: DriverInfo = { os: 'Vega OS' };
    const model = d?.model ?? d?.product;
    if (model) out.model = model;
    if (/emulator|vvd/i.test(this.serial) || /virtual/i.test(model ?? '')) out.name = 'Vega Virtual Device';
    else if (model) out.name = model;
    if (this.resolution) out.resolution = { ...this.resolution };
    return out;
  }

  /** KEY_WAKEUP through inputd-cli (unverified); a TV that is already awake ignores it. */
  async wake(): Promise<void> {
    await this.exec(['exec', 'inputd-cli', ...inputdArgs({ key: 'wake' }, this.keyMap)], 'waking the device').catch(() => undefined);
  }

  // ---------- remote ----------

  async press(keys: KeySpec[], opts: { gapMs?: number } = {}): Promise<void> {
    this.assertOpen();
    if (!Array.isArray(keys) || !keys.length) throw new FireLabError('bad-request', 'No keys given');
    const all = keys.map((k) => ({ k, args: inputdArgs(k, this.keyMap) })); // validate everything first
    for (const [i, { k, args }] of all.entries()) {
      if (i > 0 && opts.gapMs) await sleep(opts.gapMs);
      const holdMs = (k.mode ?? 'press') === 'hold' ? Math.round(k.holdMs ?? 500) : 0;
      await this.exec(['exec', 'inputd-cli', ...args], `pressing ${k.key}`, this.timeoutMs + holdMs);
    }
  }

  async typeText(text: string): Promise<void> {
    await this.exec(['exec', 'inputd-cli', 'send_text', escapeSendText(text)], 'typing text');
  }

  // ---------- screen ----------

  /** `gwsi-tool-screenshooter <file.png>` on the device, then `vda pull` (documented). */
  async screenshot(opts: { width?: number; quality?: number; format?: 'jpeg' | 'png' | 'rgba' } = {}): Promise<Frame> {
    this.assertOpen();
    const t0 = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-vega-'));
    const local = path.join(dir, 'shot.png');
    try {
      await this.shell(['gwsi-tool-screenshooter', this.remoteShot], 'taking a screenshot');
      await this.vda(['pull', this.remoteShot, local], 'pulling the screenshot');
      if (!fs.existsSync(local)) throw new FireLabError('adb-failed', 'Vega: the screenshot was not pulled', { hint: 'See docs/VEGA.md' });
      const png = fs.readFileSync(local);
      const full = decodePng(png);
      this.resolution = { width: full.width, height: full.height };
      const format = opts.format ?? 'jpeg';
      const width = Math.max(1, Math.round(opts.width ?? (format === 'rgba' ? 64 : format === 'png' ? full.width : 960)));
      const img = resizeRgba(full, width);
      const captureMs = Date.now() - t0;
      if (format === 'rgba') return { width: img.width, height: img.height, rgba: img.data, captureMs };
      if (format === 'png') return { width: img.width, height: img.height, data: img === full ? png : encodePng(img), mime: 'image/png', captureMs };
      return { width: img.width, height: img.height, data: encodeJpeg(img, opts.quality ?? 80), mime: 'image/jpeg', captureMs };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------- apps ----------

  /** No documented way to ask Vega which app is in front: this returns the last app FireLab launched while it is still running. */
  async foreground(): Promise<{ package: string; activity?: string } | null> {
    if (!this.lastLaunched) return null;
    return (await this.pid({ package: this.lastLaunched })) ? { package: this.lastLaunched } : null;
  }

  /** `vega device launch-app --appName <id>` (SDK 0.24), falling back to the older `vlcm launch-app pkg://<id>`. */
  async launch(app: AppRef): Promise<{ pid?: number; launchMs?: number }> {
    const id = assertApp(app);
    const t0 = Date.now();
    try {
      await this.exec(['device', 'launch-app', '--appName', id], `launching ${id}`);
    } catch (e) {
      await this.shell(['vlcm', 'launch-app', `pkg://${id}`], `launching ${id}`).catch(() => {
        throw e;
      });
    }
    this.lastLaunched = id;
    const launchMs = Date.now() - t0;
    const pid = await this.pid(app).catch(() => undefined);
    return { ...(pid ? { pid } : {}), launchMs };
  }

  /** `vega device terminate-app --appName <id>`, falling back to `vlcm terminate-app pkg://<id>` (both unverified). */
  async stop(app: AppRef): Promise<void> {
    const id = assertApp(app);
    try {
      await this.exec(['device', 'terminate-app', '--appName', id], `stopping ${id}`);
    } catch (e) {
      await this.shell(['vlcm', 'terminate-app', `pkg://${id}`], `stopping ${id}`).catch(() => {
        throw e;
      });
    }
  }

  /** `pidof <id>`, else a `ps` row naming the app (unverified: Vega is Linux, so both are likely there). */
  async pid(app: AppRef): Promise<number | undefined> {
    const id = assertApp(app);
    const out = await this.shell(['sh', '-c', `pidof ${id} 2>/dev/null || ps -A 2>/dev/null || ps`], `finding ${id}`).catch(() => '');
    return parsePid(out, id);
  }

  /** `vega device install-app --packagePath <file.vpkg>` (SDK 0.24 docs). The app id comes from the CLI's output, else the file name. */
  async install(file: string): Promise<{ package: string }> {
    if (!/\.vpkg$/i.test(file)) throw new FireLabError('bad-request', 'Vega apps install from a .vpkg file', { hint: 'Build one with the Vega SDK (`vega build`); APKs are for Fire OS' });
    if (!fs.existsSync(file)) throw new FireLabError('not-found', `${file} does not exist`);
    const r = await this.exec(['device', 'install-app', '--packagePath', path.resolve(file)], `installing ${path.basename(file)}`, 300000);
    const text = `${r.stdout.toString('utf8')}\n${r.stderr}`;
    const id = /\b(?:installed|package|app(?:Name|Id)?)\W+((?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9_-]+)/i.exec(text)?.[1];
    return { package: id ?? path.basename(file).replace(/\.vpkg$/i, '').replace(/_(armv7|aarch64|x86_64)$/i, '') };
  }

  // ---------- logs + memory ----------

  /** `loggingctl log -o short-precise` (documented), filtered by time, app and level here. */
  async logs(opts: { app?: AppRef; sinceTs?: number; minLevel?: LogLine['level'] } = {}): Promise<LogLine[]> {
    const text = await this.shell(['loggingctl', 'log', '-o', 'short-precise', '--no-pager'], 'reading logs', 60000).catch(async () => this.shell(['loggingctl', 'log', '-o', 'short-precise'], 'reading logs', 60000));
    let lines = parseVegaLogs(text);
    if (opts.sinceTs !== undefined) lines = lines.filter((l) => l.ts >= (opts.sinceTs as number));
    if (opts.minLevel) {
      const min = LEVELS.indexOf(opts.minLevel);
      lines = lines.filter((l) => LEVELS.indexOf(l.level) >= min);
    }
    if (opts.app) {
      const id = assertApp(opts.app);
      const pid = await this.pid(opts.app).catch(() => undefined);
      lines = lines.filter((l) => (pid !== undefined && l.pid === pid) || (l.tag ?? '').includes(id) || l.text.includes(id));
    }
    return lines;
  }

  /** The app's memory from `ace_memusage` (documented tool, undocumented output: parsed leniently). */
  async memory(app: AppRef): Promise<MemorySample> {
    const id = assertApp(app);
    const out = await this.shell(['ace_memusage'], 'reading memory');
    const m = parseAceMemusage(out, id);
    if (!m) throw new FireLabError('not-found', `ace_memusage has no row for ${id}`, { hint: 'Is the app running? If it is, the output format differs from what FireLab expects: please report it (docs/VEGA.md)' });
    return { ts: Date.now(), pssMB: m.pssMB };
  }

  /** Device caps are fixed by the docs; with an app, checks that memory can be read for it. */
  async probe(app?: AppRef): Promise<DriverCaps> {
    await this.vda(['get-serialno'], 'reaching the device');
    if (app) {
      this.caps.memory = await this.memory(app).then(
        () => true,
        () => false,
      );
    }
    return this.caps;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** The one connected Vega device, or the one asked for. */
export async function resolveVegaSerial(runner: VegaRunner, serial?: string): Promise<string> {
  const r = await runner.run(['exec', 'vda', 'devices', '-l'], { timeoutMs: 20000 });
  if (r.code !== 0) throw new FireLabError('adb-failed', `vega exec vda devices failed: ${r.stderr.trim().slice(0, 300)}`, { hint: 'Is the Vega SDK set up? See docs/VEGA.md' });
  const devices = parseVdaDevices(r.stdout.toString('utf8'));
  if (serial) {
    const d = devices.find((x) => x.serial === serial || x.serial === `${serial}:5555`);
    if (!d) throw new FireLabError('device-not-found', `Vega device ${serial} is not connected`, { hint: `Connected: ${devices.map((x) => x.serial).join(', ') || 'none'}. Use \`vega exec vda connect <ip>\` for a Fire TV on Wi-Fi` });
    if (d.state !== 'device') throw new FireLabError(d.state === 'unauthorized' ? 'unauthorized' : 'offline', `Vega device ${d.serial} is ${d.state}`);
    return d.serial;
  }
  const ready = devices.filter((d) => d.state === 'device');
  if (!ready.length) throw new FireLabError('no-device', 'No Vega device connected', { hint: 'Start the Vega Virtual Device (`vega virtual-device start`) or connect a Vega Fire TV with `vega exec vda connect <ip>`' });
  if (ready.length > 1) throw new FireLabError('ambiguous-device', `Several Vega devices are connected: ${ready.map((d) => d.serial).join(', ')}`, { hint: 'Pass the serial' });
  return (ready[0] as VdaDevice).serial;
}
