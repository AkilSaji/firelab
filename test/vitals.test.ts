import { describe, expect, it } from 'vitest';
import { VitalsSampler, VITALS_COMMAND, netRate, parseNetDev, parseThermalService, parseThermalZones, pickIface, splitVitals } from '../src/core/vitals.js';

const NET_DEV = (rx: number, tx: number) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  123456     800    0    0    0     0          0         0   123456     800    0    0    0     0       0          0
  eth0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
 wlan0: ${rx}   91234    0   12    0     0          0       410 ${tx}   40211    0    0    0     0       0          0
`;

const THERMAL = `IsStatusOverride: false
ThermalEventListeners:
	callbacks: 1
Current temperatures from HAL:
	Temperature{mValue=51.3, mType=0, mName=CPU0, mStatus=0}
	Temperature{mValue=54.8, mType=0, mName=CPU1, mStatus=0}
	Temperature{mValue=49.0, mType=1, mName=GPU, mStatus=0}
	Temperature{mValue=38.2, mType=3, mName=skin, mStatus=0}
Current cooling devices from HAL:
	CoolingDevice{mValue=0, mType=2, mName=cpufreq}
`;

describe('vitals parsing', () => {
  it('reads byte counters from /proc/net/dev and prefers the busy interface', () => {
    const c = parseNetDev(NET_DEV(987654321, 12345678));
    expect(c.wlan0).toEqual({ rx: 987654321, tx: 12345678 });
    expect(c.lo).toEqual({ rx: 123456, tx: 123456 });
    expect(pickIface(c)).toBe('wlan0');
    expect(pickIface(parseNetDev('  lo: 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16\n'))).toBeUndefined();
  });

  it('turns two readings into bytes/s and Mbps; counter resets give null', () => {
    const a = parseNetDev(NET_DEV(1_000_000, 200_000));
    const b = parseNetDev(NET_DEV(3_500_000, 300_000));
    expect(netRate(a, b, 2000)).toEqual({ iface: 'wlan0', rxBps: 1_250_000, txBps: 50_000, rxMbps: 10, txMbps: 0.4 });
    expect(netRate(b, a, 2000)).toBeNull();
    expect(netRate({}, b, 2000)).toBeNull();
  });

  it('picks the hottest CPU sensor from dumpsys thermalservice', () => {
    expect(parseThermalService(THERMAL)).toEqual({ c: 54.8, sensor: 'CPU1' });
    expect(parseThermalService('Current temperatures from HAL:\n\tTemperature{mValue=40.5, mType=3, mName=skin, mStatus=0}\n')).toEqual({ c: 40.5, sensor: 'skin' });
    expect(parseThermalService('Can\'t find service: thermalservice')).toBeNull();
    expect(parseThermalService('Current temperatures from HAL:\n\n')).toBeNull();
  });

  it('falls back to thermal zones, in millidegrees or degrees, preferring the SoC zone', () => {
    const zones = ['/sys/class/thermal/thermal_zone0 board_thermal 41000', '/sys/class/thermal/thermal_zone1 mtktscpu 58500', '/sys/class/thermal/thermal_zone2 battery'].join('\n');
    expect(parseThermalZones(zones)).toEqual({ c: 58.5, sensor: 'mtktscpu (thermal_zone1)' });
    expect(parseThermalZones('/sys/class/thermal/thermal_zone0 board 47')).toEqual({ c: 47, sensor: 'board (thermal_zone0)' });
    expect(parseThermalZones('/sys/class/thermal/thermal_zone* ')).toBeNull();
  });

  it('splits the combined command output', () => {
    expect(splitVitals('A\n@@thermal\nB\n@@zones\nC')).toEqual({ net: 'A\n', thermal: '\nB\n', zones: '\nC' });
  });
});

describe('VitalsSampler', () => {
  it('needs two readings for a rate, never samples faster than every 2 s, and reads temperature less often', async () => {
    let now = 1_000_000;
    let rx = 1_000_000;
    const cmds: string[] = [];
    const s = new VitalsSampler(
      async (cmd) => {
        cmds.push(cmd);
        rx += 500_000;
        return cmd === VITALS_COMMAND ? `${NET_DEV(rx, 100)}@@thermal\n${THERMAL}@@zones\n` : NET_DEV(rx, 100);
      },
      { now: () => now },
    );
    const a = await s.sample();
    expect(a.network).toBeNull();
    expect(a.networkNote).toMatch(/first reading/);
    expect(a.temperature).toEqual({ c: 54.8, sensor: 'CPU1', source: 'thermalservice' });
    now += 500;
    expect(await s.sample()).toBe(a); // rate-limited: same reading
    expect(cmds).toHaveLength(1);
    now += 1500;
    const b = await s.sample();
    expect(b.network).toMatchObject({ iface: 'wlan0', rxBps: 250_000, rxMbps: 2 });
    expect(b.temperature?.c).toBe(54.8); // cached
    expect(cmds[1]).not.toContain('thermal');
  });

  it('says why when nothing is readable', async () => {
    const s = new VitalsSampler(async () => {
      throw new Error('device offline');
    });
    const v = await s.sample();
    expect(v).toMatchObject({ network: null, temperature: null, networkNote: expect.stringMatching(/device offline/), temperatureNote: expect.stringMatching(/device offline/) });
    const none = await new VitalsSampler(async () => '@@thermal\n@@zones\n').sample();
    expect(none.networkNote).toMatch(/not readable/);
    expect(none.temperatureNote).toMatch(/no readable sensor/);
  });
});
