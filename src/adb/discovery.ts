import net from 'node:net';
import os from 'node:os';
import { mapLimit } from '../lib/util.js';
import { FireLabError } from '../lib/errors.js';

// ---------- IPv4 / CIDR math ----------

export function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new FireLabError('bad-request', `Not an IPv4 address: ${ip}`);
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) throw new FireLabError('bad-request', `Not an IPv4 address: ${ip}`);
    n = n * 256 + Number(p);
  }
  return n >>> 0;
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** "255.255.255.0" -> 24. */
export function netmaskToPrefix(mask: string): number {
  const n = ipToInt(mask);
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if (n & (1 << i)) bits++;
    else break;
  }
  return bits;
}

export type Cidr = { network: string; prefix: number; first: string; last: string; size: number };

/** Parses "192.168.1.0/24" (a host address is fine: "192.168.1.77/24"). */
export function parseCidr(cidr: string): Cidr {
  const [ip, pfx] = cidr.trim().split('/');
  const prefix = pfx === undefined ? 32 : Number(pfx);
  if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new FireLabError('bad-request', `Not a CIDR range: ${cidr}`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToInt(ip) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  // /31 and /32 have no network/broadcast addresses to skip.
  const first = prefix >= 31 ? network : network + 1;
  const last = prefix >= 31 ? broadcast : broadcast - 1;
  return { network: intToIp(network), prefix, first: intToIp(first), last: intToIp(last), size: last - first + 1 };
}

/** All usable host addresses in a range, capped (default 1024) so a typo can't scan a /8. */
export function hostsInCidr(cidr: string, cap = 1024): string[] {
  const c = parseCidr(cidr);
  if (c.size > cap) throw new FireLabError('bad-request', `${cidr} has ${c.size} addresses; scan at most ${cap} (use a /22 or smaller)`);
  const start = ipToInt(c.first);
  return Array.from({ length: c.size }, (_, i) => intToIp(start + i));
}

/** The /24 that contains an address: "192.168.1.164" -> "192.168.1.0/24". */
export function subnet24(ip: string): string {
  return `${parseCidr(`${ip}/24`).network}/24`;
}

export type LocalInterface = { name: string; address: string; netmask: string; cidr: string };

/** Private IPv4 interfaces of this computer (Wi-Fi, Ethernet), skipping loopback, link-local and VPN-style /32s. */
export function localInterfaces(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (i.address.startsWith('169.254.')) continue;
      const prefix = netmaskToPrefix(i.netmask);
      if (prefix >= 31) continue;
      if (!isPrivate(i.address)) continue;
      out.push({ name, address: i.address, netmask: i.netmask, cidr: `${parseCidr(`${i.address}/${prefix}`).network}/${prefix}` });
    }
  }
  return out;
}

export function isPrivate(ip: string): boolean {
  const n = ipToInt(ip);
  return (
    (n & 0xff000000) >>> 0 === ipToInt('10.0.0.0') ||
    (n & 0xfff00000) >>> 0 === ipToInt('172.16.0.0') ||
    (n & 0xffff0000) >>> 0 === ipToInt('192.168.0.0') ||
    (n & 0xffc00000) >>> 0 === ipToInt('100.64.0.0')
  );
}

/** The ranges `scanNetwork` covers by default: the /24 around each local address. */
export function defaultScanRanges(ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  return [...new Set(localInterfaces(ifaces).map((i) => subnet24(i.address)))];
}

// ---------- probing ----------

/** True if something accepts TCP connections on ip:port within `timeoutMs`. */
export function probeTcp(ip: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// adb wire protocol (https://android.googlesource.com/platform/packages/modules/adb/+/HEAD/protocol.txt)
const A_CNXN = 0x4e584e43;
const A_AUTH = 0x48545541;
const A_STLS = 0x534c5453;
const A_VERSION = 0x01000001;

/** An adb CNXN packet, the first thing a host sends. */
export function adbConnectPacket(): Buffer {
  const payload = Buffer.from('host::firelab\0', 'utf8');
  const header = Buffer.alloc(24);
  let sum = 0;
  for (const b of payload) sum = (sum + b) >>> 0;
  header.writeUInt32LE(A_CNXN, 0);
  header.writeUInt32LE(A_VERSION, 4);
  header.writeUInt32LE(256 * 1024, 8);
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt32LE(sum, 16);
  header.writeUInt32LE((A_CNXN ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, payload]);
}

export type AdbProbe = {
  /** 'auth' = adbd asked us to authenticate (normal), 'open' = adbd let us in without auth, 'tls' = wireless-debugging TLS. */
  kind: 'auth' | 'open' | 'tls';
  /** From the device banner when adbd needs no auth, e.g. { 'ro.product.model': 'AFTMA08C15' }. */
  banner?: Record<string, string>;
};

/** Parses a device's reply to CNXN; null if it isn't adb. */
export function parseAdbReply(buf: Buffer): AdbProbe | null {
  if (buf.length < 24) return null;
  const cmd = buf.readUInt32LE(0);
  const magic = buf.readUInt32LE(20);
  if (((cmd ^ 0xffffffff) >>> 0) !== magic) return null;
  if (cmd === A_AUTH) return { kind: 'auth' };
  if (cmd === A_STLS) return { kind: 'tls' };
  if (cmd === A_CNXN) {
    const len = buf.readUInt32LE(12);
    const text = buf.subarray(24, 24 + len).toString('utf8').replace(/\0+$/, '');
    // "device::ro.product.name=karat;ro.product.model=AFTMA08C15;..."
    const banner: Record<string, string> = {};
    for (const kv of text.split('::')[1]?.split(';') ?? []) {
      const i = kv.indexOf('=');
      if (i > 0) banner[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { kind: 'open', banner };
  }
  return null;
}

/**
 * Says hello in adb's protocol and reads the answer. This never triggers the
 * "Allow USB debugging?" prompt (that only appears when a host offers its
 * public key), so it is safe to run against devices that aren't yours.
 */
export function probeAdb(ip: string, port = 5555, timeoutMs = 800): Promise<AdbProbe | null> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    let buf = Buffer.alloc(0);
    const done = (r: AdbProbe | null) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => done(parseAdbReply(buf)));
    sock.once('connect', () => sock.write(adbConnectPacket()));
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 24) {
        const len = buf.readUInt32LE(12);
        if (buf.length >= 24 + len) done(parseAdbReply(buf));
      }
    });
    sock.once('error', () => done(null));
    sock.once('close', () => done(parseAdbReply(buf)));
  });
}

export type ScanHit = { ip: string; port: number; adb?: AdbProbe['kind']; model?: string };

export type ScanOptions = {
  /** CIDR ranges or single IPs; default: the /24 of every local interface. */
  ranges?: string[];
  port?: number;
  concurrency?: number;
  timeoutMs?: number;
  /** Confirm hits speak adb (default true). */
  verify?: boolean;
  onProgress?: (done: number, total: number) => void;
  probe?: (ip: string, port: number, timeoutMs: number) => Promise<boolean>;
};

/** Scans for adb over TCP (port 5555). A /24 takes about 2 s. */
export async function scanNetwork(opts: ScanOptions = {}): Promise<ScanHit[]> {
  const port = opts.port ?? 5555;
  const ranges = opts.ranges?.length ? opts.ranges : defaultScanRanges();
  if (!ranges.length) throw new FireLabError('no-device', 'No local network found to scan', { hint: 'Connect this computer to the same Wi-Fi as the Fire TV, or pass a subnet like 192.168.1.0/24' });
  const ips = [...new Set(ranges.flatMap((r) => (r.includes('/') ? hostsInCidr(r) : [r])))];
  const probe = opts.probe ?? probeTcp;
  let done = 0;
  const open = await mapLimit(ips, opts.concurrency ?? 96, async (ip) => {
    const ok = await probe(ip, port, opts.timeoutMs ?? 450);
    done++;
    opts.onProgress?.(done, ips.length);
    return ok ? ip : null;
  });
  const hits: ScanHit[] = [];
  for (const ip of open) {
    if (!ip) continue;
    const hit: ScanHit = { ip, port };
    if (opts.verify !== false) {
      const p = await probeAdb(ip, port);
      if (!p) continue; // something else listens on 5555
      hit.adb = p.kind;
      if (p.banner?.['ro.product.model']) hit.model = p.banner['ro.product.model'];
    }
    hits.push(hit);
  }
  return hits;
}
