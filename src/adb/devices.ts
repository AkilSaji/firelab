/** Parsing `adb devices -l` and telling USB from Wi-Fi devices. */

export type AdbState = 'device' | 'offline' | 'unauthorized' | 'authorizing' | 'connecting' | 'no permissions' | 'recovery' | 'sideload' | 'bootloader' | 'host' | 'unknown';

export type AdbDevice = {
  serial: string;
  state: AdbState;
  /** Raw extra fields, e.g. { product: 'karat', model: 'AFTMA08C15', device: 'karat', transport_id: '4' } */
  props: Record<string, string>;
  model?: string;
  transportId?: number;
  /** For Wi-Fi devices: the IP address and port. */
  ip?: string;
  port?: number;
  transport: 'tcp' | 'usb' | 'mdns' | 'emulator';
};

const STATES: AdbState[] = ['device', 'offline', 'unauthorized', 'authorizing', 'connecting', 'recovery', 'sideload', 'bootloader', 'host'];

export function parseDevices(text: string): AdbDevice[] {
  const out: AdbDevice[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*') || line.startsWith('adb server')) continue;
    // "serial<TAB or spaces>state [key:value ...]"; "no permissions" contains a space.
    const m = /^(\S+)\s+(no permissions(?: \([^)]*\))?(?:; see \[[^\]]*\])?|\S+)(.*)$/.exec(line);
    if (!m) continue;
    const serial = m[1] as string;
    const stateRaw = (m[2] as string).startsWith('no permissions') ? 'no permissions' : (m[2] as string);
    const state: AdbState = stateRaw === 'no permissions' ? 'no permissions' : (STATES as string[]).includes(stateRaw) ? (stateRaw as AdbState) : 'unknown';
    const props: Record<string, string> = {};
    for (const kv of (m[3] ?? '').trim().split(/\s+/)) {
      const i = kv.indexOf(':');
      if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const dev: AdbDevice = { serial, state, props, transport: transportOf(serial) };
    if (props.model) dev.model = props.model;
    if (props.transport_id) dev.transportId = Number(props.transport_id);
    const addr = parseHostPort(serial);
    if (addr) {
      dev.ip = addr.ip;
      dev.port = addr.port;
    }
    out.push(dev);
  }
  return out;
}

export function transportOf(serial: string): AdbDevice['transport'] {
  if (parseHostPort(serial)) return 'tcp';
  if (/_adb-tls-connect\._tcp|_adb\._tcp/.test(serial)) return 'mdns';
  if (/^emulator-\d+$/.test(serial)) return 'emulator';
  return 'usb';
}

/** "192.168.1.194:5555" -> { ip, port }. IPv4 only (adb's usual form). */
export function parseHostPort(serial: string): { ip: string; port: number } | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(serial);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  if ((m[1] as string).split('.').some((o) => Number(o) > 255)) return null;
  return { ip: m[1] as string, port };
}

/** Accepts "192.168.1.194", "192.168.1.194:5555" or a USB serial; returns the adb serial. */
export function normalizeSerial(idOrIp: string): string {
  const s = idOrIp.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return `${s}:5555`;
  return s;
}
