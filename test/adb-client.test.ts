import { describe, expect, it } from 'vitest';
import { parseDevices, transportOf, normalizeSerial, parseHostPort } from '../src/adb/devices.js';
import { classifyAdbError, parseAdbVersion, parseConnectOutput } from '../src/adb/client.js';
import { adbCandidates, findAdb } from '../src/adb/locate.js';
import { FireLabError, httpStatus } from '../src/lib/errors.js';
import { fakeAdb, DEVICES_L, SERIAL } from './helpers/fake-adb.js';

describe('parseDevices', () => {
  it('parses a real `adb devices -l` line from a Fire TV Stick 4K Plus', () => {
    const [d] = parseDevices(DEVICES_L);
    expect(d).toEqual({
      serial: SERIAL,
      state: 'device',
      props: { product: 'karat', model: 'AFTMA08C15', device: 'karat', transport_id: '4' },
      model: 'AFTMA08C15',
      transportId: 4,
      ip: '192.168.1.194',
      port: 5555,
      transport: 'tcp',
    });
  });

  it('handles every state adb prints, daemon noise and blank lines', () => {
    const text = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      '192.168.1.205:5555\tunauthorized transport_id:7',
      '192.168.1.214:5555\toffline transport_id:9',
      'G070VM1234567890\tdevice usb:1-1 product:sheldonp model:AFTSSS device:sheldonp transport_id:2',
      'ZX1G22ABCD\tno permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:3-2 transport_id:3',
      'emulator-5554\tdevice product:sdk_google_atv_x86 model:AOSP_TV_on_x86 transport_id:1',
      'adb-GT54TR-abc._adb-tls-connect._tcp\tdevice transport_id:5',
      '192.168.1.50:5555\tconnecting',
      '',
    ].join('\n');
    const ds = parseDevices(text);
    expect(ds.map((d) => [d.serial, d.state, d.transport])).toEqual([
      ['192.168.1.205:5555', 'unauthorized', 'tcp'],
      ['192.168.1.214:5555', 'offline', 'tcp'],
      ['G070VM1234567890', 'device', 'usb'],
      ['ZX1G22ABCD', 'no permissions', 'usb'],
      ['emulator-5554', 'device', 'emulator'],
      ['adb-GT54TR-abc._adb-tls-connect._tcp', 'device', 'mdns'],
      ['192.168.1.50:5555', 'connecting', 'tcp'],
    ]);
    expect(ds[2]?.model).toBe('AFTSSS');
    expect(ds[3]?.props.transport_id).toBe('3');
  });

  it('returns nothing for an empty list', () => {
    expect(parseDevices('List of devices attached\n\n')).toEqual([]);
  });
});

describe('serial helpers', () => {
  it('normalizes bare IPs to the default adb port', () => {
    expect(normalizeSerial('192.168.1.194')).toBe('192.168.1.194:5555');
    expect(normalizeSerial(' 192.168.1.194:5556 ')).toBe('192.168.1.194:5556');
    expect(normalizeSerial('G070VM1234567890')).toBe('G070VM1234567890');
  });
  it('rejects impossible addresses', () => {
    expect(parseHostPort('300.1.1.1:5555')).toBeNull();
    expect(parseHostPort('10.0.0.1:70000')).toBeNull();
    expect(parseHostPort('10.0.0.1')).toBeNull();
    expect(transportOf('10.0.0.1:5555')).toBe('tcp');
  });
});

describe('adb output parsing', () => {
  it('reads the adb version', () => {
    expect(parseAdbVersion('Android Debug Bridge version 1.0.41\nVersion 37.0.1-15733141\nInstalled as /x/adb\n')).toBe('1.0.41 (platform-tools 37.0.1-15733141)');
  });

  it('understands `adb connect` results (adb exits 0 even on failure)', () => {
    expect(parseConnectOutput('connected to 192.168.1.194:5555')).toMatchObject({ ok: true, already: false });
    expect(parseConnectOutput('already connected to 192.168.1.194:5555')).toMatchObject({ ok: true, already: true });
    expect(parseConnectOutput('failed to connect to 192.168.1.9:5555: Connection refused').ok).toBe(false);
    expect(parseConnectOutput('cannot connect to 192.168.1.9:5555: No route to host (65)').ok).toBe(false);
    expect(parseConnectOutput('failed to authenticate to 192.168.1.9:5555').ok).toBe(false);
  });

  it('turns adb errors into actionable errors', () => {
    expect(classifyAdbError("error: device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set", SERIAL)).toMatchObject({ code: 'unauthorized' });
    expect(classifyAdbError('error: device offline', SERIAL)?.code).toBe('offline');
    expect(classifyAdbError("adb: device '10.0.0.9:5555' not found")).toMatchObject({ code: 'device-not-found', message: 'Device 10.0.0.9:5555 is not connected' });
    expect(classifyAdbError('error: no devices/emulators found')?.code).toBe('no-device');
    expect(classifyAdbError('error: more than one device/emulator')?.code).toBe('ambiguous-device');
    expect(classifyAdbError('some program output')).toBeNull();
    expect(classifyAdbError('unauthorized')?.hint).toMatch(/Allow USB debugging/);
  });
});

describe('Adb client', () => {
  it('shell() returns stdout even when the remote command fails', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/shell pidof/, { stdout: Buffer.from(''), stderr: '', code: 1 });
    expect(await adb.shell(SERIAL, 'pidof com.nope')).toBe('');
  });

  it('shell() throws adb transport errors with hints', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/shell/, { stdout: Buffer.from(''), stderr: 'error: device offline', code: 1 });
    await expect(adb.shell(SERIAL, 'echo hi')).rejects.toMatchObject({ code: 'offline' });
  });

  it('forward() reads the port adb picked for tcp:0', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/forward tcp:0 localabstract:webview_devtools_remote_42/, '56529\n');
    expect(await adb.forward(SERIAL, 'localabstract:webview_devtools_remote_42')).toBe(56529);
  });

  it('install() reports the INSTALL_FAILED reason with a hint', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/install/, { stdout: Buffer.from('Performing Streamed Install\nadb: failed to install x.apk: Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]\n'), stderr: '', code: 1 });
    await expect(adb.install(SERIAL, 'x.apk')).rejects.toMatchObject({ code: 'adb-failed', hint: expect.stringMatching(/32-bit/) });
  });
});

describe('locating adb', () => {
  it('tries $ADB, PATH, ANDROID_HOME and the Android Studio folder, in that order (macOS)', () => {
    const c = adbCandidates({ env: { ADB: '/custom/adb', PATH: '/usr/bin:/opt/bin', ANDROID_HOME: '/sdk' }, platform: 'darwin', home: '/Users/me' });
    expect(c.slice(0, 5)).toEqual(['/custom/adb', '/usr/bin/adb', '/opt/bin/adb', '/sdk/platform-tools/adb', '/Users/me/Library/Android/sdk/platform-tools/adb']);
  });
  it('knows Windows and Linux defaults', () => {
    const w = adbCandidates({ env: { Path: 'C:\\tools', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\me' });
    expect(w).toContain('C:\\tools\\adb.exe');
    expect(w).toContain('C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe');
    const l = adbCandidates({ env: {}, platform: 'linux', home: '/home/me' });
    expect(l).toContain('/home/me/Android/Sdk/platform-tools/adb');
    expect(l).toContain('/usr/bin/adb');
  });
  it('returns the first candidate that exists, or null', () => {
    const env = { env: { PATH: '/a:/b' }, platform: 'linux' as const, home: '/h' };
    expect(findAdb(env, (f) => f === '/b/adb')).toBe('/b/adb');
    expect(findAdb(env, () => false)).toBeNull();
  });
});

describe('HTTP status for errors', () => {
  it('maps error codes to statuses people and the UI can act on', () => {
    const st = (c: ConstructorParameters<typeof FireLabError>[0]) => httpStatus(new FireLabError(c, 'x'));
    expect([st('bad-request'), st('confirm-required'), st('device-not-found'), st('unauthorized'), st('no-webview'), st('eval-failed'), st('cdp-failed'), st('timeout'), st('adb-missing')]).toEqual([400, 400, 404, 409, 409, 422, 502, 504, 503]);
    expect(httpStatus(new Error('x'))).toBe(500);
  });
});
