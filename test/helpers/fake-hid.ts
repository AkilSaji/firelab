import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { FakeProcess, FakeRunner } from './fake-adb.js';

const OTHER_DEVICES = `add device 1: /dev/input/event0
  name:     "mtk-kpd"
  events:
    KEY (0001): KEY_POWER
  input props:
    <none>
add device 2: /dev/input/event3
  name:     "AR Remote"
  events:
    KEY (0001): KEY_ESC               KEY_ENTER             KEY_UP                KEY_LEFT
                KEY_RIGHT             KEY_DOWN              KEY_MENU              KEY_BACK
                KEY_HOMEPAGE          KEY_PLAYPAUSE         KEY_REWIND            KEY_FASTFORWARD
                KEY_SELECT
    MSC (0004): MSC_SCAN
  input props:
    <none>
`;

/**
 * Plays a device for the virtual HID remote: `hid -` (records the JSON lines
 * it gets), `getevent -lp` (lists the virtual device under the name it
 * registered, or not) and `getevent -l` watchers (see its key events, or not).
 */
export function fakeHidDevice(runner: FakeRunner, opts: { listed: boolean; delivers: boolean; path?: string }) {
  const path = opts.path ?? '/dev/input/event9';
  const hidLines: string[] = [];
  let registeredName: string | undefined;
  const watchers: FakeProcess[] = [];
  runner.on(/shell getevent -lp/, () =>
    opts.listed && registeredName ? `${OTHER_DEVICES}add device 9: ${path}\n  name:     "${registeredName}"\n  events:\n    KEY (0001): KEY_UP KEY_DOWN\n` : OTHER_DEVICES,
  );
  const origSpawn = runner.spawn.bind(runner);
  runner.spawn = (args: string[]): ChildProcessWithoutNullStreams => {
    const proc = origSpawn(args);
    const fp = proc as unknown as FakeProcess;
    if (args[3] === 'hid') {
      let buf = '';
      fp.stdin.on('data', (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines.filter(Boolean)) {
          hidLines.push(l);
          const m = JSON.parse(l) as { command: string; name?: string; report?: number[] };
          if (m.command === 'register') registeredName = m.name;
          if (opts.delivers && m.command === 'report' && (m.report?.[1] ?? 0) !== 0) {
            for (const w of watchers) if (!w.killed) w.write(`${path}: EV_KEY       KEY_RIGHT            DOWN\n`);
          }
        }
      });
    } else if (args[3] === 'getevent -l') {
      watchers.push(fp);
      setTimeout(() => {
        fp.write(`add device 1: /dev/input/event0\n  name:     "mtk-kpd"\nadd device 2: /dev/input/event3\n  name:     "AR Remote"\n`);
        if (opts.listed) fp.write(`add device 3: ${path}\n  name:     "${registeredName}"\n`);
      }, 5);
    }
    return proc;
  };
  return { path, hidLines, watchers, get registeredName() { return registeredName; } };
}
