import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { FireLab } from '../../src/core/firelab.js';
import { fakeAdb, DEVICES_L } from './fake-adb.js';

const fx = (f: string) => fs.readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8');

/** A raw 16-byte-header screencap of a 128x72 gray screen, gzipped like `screencap | gzip`. */
export function fakeScreen(): Buffer {
  const head = Buffer.alloc(16);
  head.writeUInt32LE(128, 0);
  head.writeUInt32LE(72, 4);
  head.writeUInt32LE(1, 8);
  head.writeUInt32LE(1, 12);
  return zlib.gzipSync(Buffer.concat([head, Buffer.alloc(128 * 72 * 4, 128)]));
}

/** A FireLab wired to a scripted Fire TV Stick 4K Plus. */
export function fakeLab() {
  const { adb, runner } = fakeAdb();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-home-'));
  runner
    .on(/^version$/, 'Android Debug Bridge version 1.0.41\nVersion 37.0.1-15733141\n')
    .on(/^devices -l$/, DEVICES_L)
    .on(/shell getprop; echo @@mem/, fx('deviceinfo-AFTMA08C15.txt'))
    .on(/shell dumpsys power/, '  mWakefulness=Awake\nDisplay Power: state=ON\n')
    .on(/shell dumpsys activity activities/, '  ResumedActivity: ActivityRecord{74c7a02 u0 com.amazon.tv.launcher/.ui.HomeActivity_vNext t2}\n')
    .on(/shell input keyevent/, '')
    .on(/shell input text/, '')
    .on(/shell pm list packages -3/, 'package:com.example.game versionCode:3\n@@versions\n  Package [com.example.game] (1):\n    versionName=1.0.3\n@@leanback\ncom.example.game/.Main\n@@launcher\n')
    .on(/exec-out screencap 2>\/dev\/null \| gzip -1/, () => fakeScreen())
    .on(/shell am force-stop com.example.game/, '')
    .on(/shell pm clear com.example.game/, 'Success\n')
    .on(/shell logcat -d/, '1760538791.300  4242  4242 E GameMain: boom\n')
    .on(/shell pidof com.example.game/, '4242\n')
    .on(/shell grep -a devtools_remote/, '@@ps\n');
  const lab = new FireLab({ adb, home, autoReconnect: false });
  return { lab, runner, home };
}
