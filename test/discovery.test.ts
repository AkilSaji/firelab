import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { ipToInt, intToIp, netmaskToPrefix, parseCidr, hostsInCidr, subnet24, localInterfaces, isPrivate, defaultScanRanges, adbConnectPacket, parseAdbReply, probeAdb, probeTcp, scanNetwork } from '../src/adb/discovery.js';

describe('IPv4 math', () => {
  it('converts addresses', () => {
    expect(ipToInt('192.168.1.194')).toBe(3232235970);
    expect(intToIp(3232235970)).toBe('192.168.1.194');
    expect(intToIp(ipToInt('255.255.255.255'))).toBe('255.255.255.255');
    expect(() => ipToInt('192.168.1')).toThrow();
    expect(() => ipToInt('192.168.1.256')).toThrow();
  });
  it('turns netmasks into prefixes', () => {
    expect(netmaskToPrefix('255.255.255.0')).toBe(24);
    expect(netmaskToPrefix('255.255.252.0')).toBe(22);
    expect(netmaskToPrefix('255.255.255.255')).toBe(32);
    expect(netmaskToPrefix('0.0.0.0')).toBe(0);
  });
  it('parses CIDR ranges (host bits allowed)', () => {
    expect(parseCidr('192.168.1.164/24')).toEqual({ network: '192.168.1.0', prefix: 24, first: '192.168.1.1', last: '192.168.1.254', size: 254 });
    expect(parseCidr('10.0.0.8/30')).toMatchObject({ first: '10.0.0.9', last: '10.0.0.10', size: 2 });
    expect(parseCidr('10.0.0.8/31')).toMatchObject({ first: '10.0.0.8', last: '10.0.0.9', size: 2 });
    expect(parseCidr('10.0.0.8/32')).toMatchObject({ first: '10.0.0.8', size: 1 });
    expect(parseCidr('10.0.0.8')).toMatchObject({ prefix: 32 });
    expect(() => parseCidr('10.0.0.0/33')).toThrow();
  });
  it('lists hosts, with a cap against scanning a /8 by accident', () => {
    const h = hostsInCidr('192.168.1.0/24');
    expect(h).toHaveLength(254);
    expect(h[0]).toBe('192.168.1.1');
    expect(h[253]).toBe('192.168.1.254');
    expect(() => hostsInCidr('10.0.0.0/8')).toThrow(/scan at most 1024/);
    expect(hostsInCidr('172.16.0.0/22')).toHaveLength(1022);
  });
  it('finds the /24 around an address', () => {
    expect(subnet24('192.168.1.164')).toBe('192.168.1.0/24');
  });
  it('knows private ranges', () => {
    expect(isPrivate('192.168.1.5')).toBe(true);
    expect(isPrivate('10.20.30.40')).toBe(true);
    expect(isPrivate('172.20.0.1')).toBe(true);
    expect(isPrivate('172.32.0.1')).toBe(false);
    expect(isPrivate('8.8.8.8')).toBe(false);
  });
});

describe('local interfaces', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '', cidr: '127.0.0.1/8' }],
    en0: [
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, mac: '', cidr: null, scopeid: 4 },
      { address: '192.168.1.164', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: '192.168.1.164/24' },
    ],
    en5: [{ address: '10.1.2.3', netmask: '255.255.0.0', family: 'IPv4', internal: false, mac: '', cidr: '10.1.2.3/16' }],
    utun3: [{ address: '100.101.102.103', netmask: '255.255.255.255', family: 'IPv4', internal: false, mac: '', cidr: '100.101.102.103/32' }],
    bridge: [{ address: '169.254.10.1', netmask: '255.255.0.0', family: 'IPv4', internal: false, mac: '', cidr: '169.254.10.1/16' }],
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

  it('keeps private IPv4 LAN interfaces only', () => {
    expect(localInterfaces(ifaces).map((i) => [i.name, i.cidr])).toEqual([
      ['en0', '192.168.1.0/24'],
      ['en5', '10.1.0.0/16'],
    ]);
  });
  it('scans the /24 around each address by default (not a whole /16)', () => {
    expect(defaultScanRanges(ifaces)).toEqual(['192.168.1.0/24', '10.1.2.0/24']);
  });
});

describe('adb handshake', () => {
  it('builds a valid CNXN packet', () => {
    const p = adbConnectPacket();
    expect(p.readUInt32LE(0)).toBe(0x4e584e43);
    expect((p.readUInt32LE(0) ^ p.readUInt32LE(20)) >>> 0).toBe(0xffffffff);
    expect(p.readUInt32LE(12)).toBe(p.length - 24);
    expect(p.subarray(24).toString()).toBe('host::firelab\0');
  });

  const reply = (cmd: number, payload = '') => {
    const b = Buffer.alloc(24);
    b.writeUInt32LE(cmd, 0);
    b.writeUInt32LE(payload.length, 12);
    b.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
    return Buffer.concat([b, Buffer.from(payload)]);
  };

  it('recognizes AUTH, TLS and an open adbd with its banner', () => {
    expect(parseAdbReply(reply(0x48545541, 'x'.repeat(20)))).toEqual({ kind: 'auth' });
    expect(parseAdbReply(reply(0x534c5453))).toEqual({ kind: 'tls' });
    expect(parseAdbReply(reply(0x4e584e43, 'device::ro.product.name=karat;ro.product.model=AFTMA08C15;features=shell_v2\0'))).toEqual({
      kind: 'open',
      banner: { 'ro.product.name': 'karat', 'ro.product.model': 'AFTMA08C15', features: 'shell_v2' },
    });
  });
  it('rejects things that are not adb', () => {
    expect(parseAdbReply(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'))).toBeNull();
    expect(parseAdbReply(Buffer.alloc(10))).toBeNull();
  });

  it('probes a fake adbd and a non-adb server over real sockets', async () => {
    const adbd = net.createServer((s) => s.once('data', () => s.write(reply(0x48545541, 'y'.repeat(20)))));
    const http = net.createServer((s) => s.once('data', () => s.end('HTTP/1.1 400 Bad Request\r\n\r\n')));
    await Promise.all([new Promise<void>((r) => adbd.listen(0, '127.0.0.1', r)), new Promise<void>((r) => http.listen(0, '127.0.0.1', r))]);
    const ap = (adbd.address() as net.AddressInfo).port;
    const hp = (http.address() as net.AddressInfo).port;
    try {
      expect(await probeTcp('127.0.0.1', ap, 500)).toBe(true);
      expect(await probeAdb('127.0.0.1', ap)).toEqual({ kind: 'auth' });
      expect(await probeAdb('127.0.0.1', hp)).toBeNull();
      const hits = await scanNetwork({ ranges: ['127.0.0.1'], port: ap });
      expect(hits).toEqual([{ ip: '127.0.0.1', port: ap, adb: 'auth' }]);
      expect(await scanNetwork({ ranges: ['127.0.0.1'], port: hp })).toEqual([]);
    } finally {
      adbd.close();
      http.close();
    }
  });

  it('scans a range with a concurrency limit and reports progress', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    const hits = await scanNetwork({
      ranges: ['10.9.8.0/26'],
      concurrency: 8,
      verify: false,
      probe: async (ip) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return ip === '10.9.8.42';
      },
      onProgress: (d) => seen.push(d),
    });
    expect(hits).toEqual([{ ip: '10.9.8.42', port: 5555 }]);
    expect(peak).toBeLessThanOrEqual(8);
    expect(seen[seen.length - 1]).toBe(62);
  });

  it('says closed ports are closed', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await probeTcp('127.0.0.1', port, 300)).toBe(false);
  });
});
