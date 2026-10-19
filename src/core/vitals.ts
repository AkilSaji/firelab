/**
 * Device vitals for the dashboard: network throughput and temperature.
 *
 * Network: byte counters from /proc/net/dev (wlan0 / eth0), turned into a
 * rate from two readings. Temperature: `dumpsys thermalservice` (Android 10+,
 * the HAL's own CPU/GPU/skin sensors), else the kernel's thermal zones. Every
 * value is measured or null with a reason; nothing is guessed.
 */

export type NetCounters = Record<string, { rx: number; tx: number }>;

export type Vitals = {
  ts: number;
  network: { iface: string; rxBps: number; txBps: number; rxMbps: number; txMbps: number } | null;
  /** Why network is null. */
  networkNote?: string;
  temperature: { c: number; sensor: string; source: 'thermalservice' | 'thermal_zone' } | null;
  /** Why temperature is null. */
  temperatureNote?: string;
};

/** Interfaces that carry the TV's traffic, in preference order. */
const IFACES = ['wlan0', 'eth0'];

/** `/proc/net/dev` -> rx/tx byte counters per interface. */
export function parseNetDev(text: string): NetCounters {
  const out: NetCounters = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\w.-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const f = (m[2] as string).trim().split(/\s+/).map(Number);
    // Fields: rx bytes packets errs drop fifo frame compressed multicast | tx bytes ...
    if (f.length < 9 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue;
    out[m[1] as string] = { rx: f[0] as number, tx: f[8] as number };
  }
  return out;
}

/** The interface to report: wlan0 or eth0, whichever has carried more bytes. */
export function pickIface(c: NetCounters): string | undefined {
  const have = IFACES.filter((i) => c[i]);
  if (!have.length) return undefined;
  return have.sort((a, b) => (c[b]!.rx + c[b]!.tx) - (c[a]!.rx + c[a]!.tx))[0];
}

/** Rates between two readings `ms` apart. Counter resets (reboot, interface down) give null. */
export function netRate(prev: NetCounters, cur: NetCounters, ms: number): Vitals['network'] {
  const iface = pickIface(cur);
  if (!iface || !prev[iface] || ms <= 0) return null;
  const drx = cur[iface]!.rx - prev[iface]!.rx;
  const dtx = cur[iface]!.tx - prev[iface]!.tx;
  if (drx < 0 || dtx < 0) return null;
  const rxBps = Math.round((drx * 1000) / ms);
  const txBps = Math.round((dtx * 1000) / ms);
  const mbps = (bps: number) => Math.round((bps * 8) / 10_000) / 100;
  return { iface, rxBps, txBps, rxMbps: mbps(rxBps), txMbps: mbps(txBps) };
}

// Android's TemperatureType: CPU 0, GPU 1, BATTERY 2, SKIN 3, ... NPU 9.
const TYPE_RANK: Record<number, number> = { 0: 0, 1: 1, 9: 2, 3: 3 };

/**
 * `dumpsys thermalservice` -> the hottest CPU sensor (else GPU, NPU, skin)
 * from "Current temperatures from HAL". Null when the HAL reports none.
 */
export function parseThermalService(text: string): { c: number; sensor: string } | null {
  const start = text.indexOf('Current temperatures from HAL');
  if (start < 0) return null;
  const section = text.slice(start).split(/\n\s*\n|Current cooling devices|Temperature static thresholds/)[0] as string;
  const temps: { c: number; type: number; name: string }[] = [];
  for (const m of section.matchAll(/Temperature\{mValue=([-\d.]+), mType=(\d+), mName=([^,}]+)/g)) {
    const c = Number(m[1]);
    if (Number.isFinite(c) && c > -30 && c < 150) temps.push({ c, type: Number(m[2]), name: (m[3] as string).trim() });
  }
  const ranked = temps.filter((t) => TYPE_RANK[t.type] !== undefined).sort((a, b) => (TYPE_RANK[a.type] as number) - (TYPE_RANK[b.type] as number) || b.c - a.c);
  const best = ranked[0];
  return best ? { c: Math.round(best.c * 10) / 10, sensor: best.name } : null;
}

const SOC_ZONE = /cpu|soc|tsens|mtktscpu|apu|ddr|tcpu|core|thermal_zone0/i;

/**
 * Lines of "<zone path> <type> <temp>" (our shell loop over
 * /sys/class/thermal/thermal_zone*) -> the CPU/SoC zone. Kernels report
 * millidegrees (45000) or, rarely, degrees (45).
 */
export function parseThermalZones(text: string): { c: number; sensor: string } | null {
  const zones: { c: number; type: string; zone: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S*thermal_zone\d+)\s+(\S+)\s+(-?\d+)\s*$/.exec(line.trim());
    if (!m) continue;
    const raw = Number(m[3]);
    const c = Math.abs(raw) >= 1000 ? raw / 1000 : Math.abs(raw) >= 200 ? raw / 10 : raw;
    if (c > 0 && c < 150) zones.push({ c, type: m[2] as string, zone: (m[1] as string).split('/').pop() as string });
  }
  if (!zones.length) return null;
  const soc = zones.filter((z) => SOC_ZONE.test(z.type)).sort((a, b) => b.c - a.c)[0];
  const z = soc ?? zones.find((x) => x.zone === 'thermal_zone0') ?? (zones[0] as (typeof zones)[0]);
  return { c: Math.round(z.c * 10) / 10, sensor: `${z.type} (${z.zone})` };
}

export const VITALS_COMMAND = [
  'cat /proc/net/dev 2>/dev/null',
  'echo @@thermal',
  'dumpsys thermalservice 2>/dev/null | head -80',
  'echo @@zones',
  'for z in /sys/class/thermal/thermal_zone*; do echo "$z $(cat $z/type 2>/dev/null | tr -d \' \') $(cat $z/temp 2>/dev/null)"; done 2>/dev/null',
].join('; ');

const NET_ONLY = 'cat /proc/net/dev 2>/dev/null';

/** Splits the combined command's output into its parts. */
export function splitVitals(out: string): { net: string; thermal: string; zones: string } {
  const [net = '', rest = ''] = out.split('@@thermal');
  const [thermal = '', zones = ''] = rest.split('@@zones');
  return { net, thermal, zones };
}

/**
 * Samples one device, at most every `minIntervalMs` (2 s): calls in between
 * get the last reading. Temperature is read every `tempEveryMs` (10 s); it
 * changes slowly and dumpsys is not free.
 */
export class VitalsSampler {
  private prev?: { at: number; counters: NetCounters };
  private last?: Vitals;
  private pending?: Promise<Vitals>;
  private temp?: { at: number; value: Vitals['temperature']; note?: string };

  constructor(
    private readonly shell: (cmd: string) => Promise<string>,
    private readonly opts: { minIntervalMs?: number; tempEveryMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  sample(): Promise<Vitals> {
    const min = Math.max(2000, this.opts.minIntervalMs ?? 2000);
    if (this.last && this.now() - this.last.ts < min) return Promise.resolve(this.last);
    this.pending ??= this.read().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async read(): Promise<Vitals> {
    const at = this.now();
    const wantTemp = !this.temp || at - this.temp.at >= (this.opts.tempEveryMs ?? 10_000);
    let out = '';
    let error: string | undefined;
    try {
      out = await this.shell(wantTemp ? VITALS_COMMAND : NET_ONLY);
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
    }
    const parts = wantTemp ? splitVitals(out) : { net: out, thermal: '', zones: '' };
    const v: Vitals = { ts: at, network: null, temperature: null };

    const counters = parseNetDev(parts.net);
    if (error) v.networkNote = `adb shell failed: ${error}`;
    else if (!pickIface(counters)) v.networkNote = Object.keys(counters).length ? 'no wlan0 or eth0 interface in /proc/net/dev' : '/proc/net/dev is not readable';
    else if (!this.prev) v.networkNote = 'first reading: the rate needs two';
    else {
      v.network = netRate(this.prev.counters, counters, at - this.prev.at);
      if (!v.network) v.networkNote = 'the byte counters reset (interface restarted)';
    }
    if (pickIface(counters)) this.prev = { at, counters };

    if (wantTemp) {
      const hal = parseThermalService(parts.thermal);
      const zone = hal ? null : parseThermalZones(parts.zones);
      if (hal) this.temp = { at, value: { ...hal, source: 'thermalservice' } };
      else if (zone) this.temp = { at, value: { ...zone, source: 'thermal_zone' } };
      else this.temp = { at, value: null, note: error ? `adb shell failed: ${error}` : 'no readable sensor: dumpsys thermalservice reports none and /sys/class/thermal is not readable' };
    }
    v.temperature = this.temp?.value ?? null;
    if (!v.temperature && this.temp?.note) v.temperatureNote = this.temp.note;
    this.last = v;
    return v;
  }
}
