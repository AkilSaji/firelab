import fs from 'node:fs';
import zlib from 'node:zlib';
import { FireLabError } from '../lib/errors.js';

/**
 * Reads what FireLab needs from an APK without the Android build tools:
 * the package name, version, SDK levels, whether it has a Leanback (TV)
 * launcher entry, and which CPU ABIs its native code supports.
 */
export type ApkInfo = {
  package: string;
  versionCode?: number;
  versionName?: string;
  minSdk?: number;
  targetSdk?: number;
  /** The app label when it is a literal string in the manifest (not a resource). */
  label?: string;
  /** Has an activity with category LEANBACK_LAUNCHER (shows up on TV launchers). */
  leanback: boolean;
  /** ABIs with native libraries (lib/<abi>/); empty = pure Java/Kotlin, runs anywhere. */
  nativeAbis: string[];
  permissions: string[];
};

// ---------- zip ----------

type ZipEntry = { name: string; method: number; compSize: number; size: number; localOffset: number };

export function zipEntries(buf: Buffer): ZipEntry[] {
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FireLabError('bad-request', 'Not an APK (zip directory not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new FireLabError('bad-request', 'Corrupt APK (bad zip entry)');
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    out.push({
      method: buf.readUInt16LE(off + 10),
      compSize: buf.readUInt32LE(off + 20),
      size: buf.readUInt32LE(off + 24),
      localOffset: buf.readUInt32LE(off + 42),
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipRead(buf: Buffer, e: ZipEntry): Buffer {
  const lo = e.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new FireLabError('bad-request', `Corrupt APK (bad local header for ${e.name})`);
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new FireLabError('unsupported', `APK entry ${e.name} uses zip method ${e.method}`);
}

// ---------- Android binary XML ----------

const ATTR_IDS: Record<number, string> = {
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x0101020c: 'minSdkVersion',
  0x01010270: 'targetSdkVersion',
  0x01010001: 'label',
  0x01010003: 'name',
};

type XmlAttr = { name: string; str?: string; int?: number; type: number };
export type XmlElement = { name: string; depth: number; attrs: XmlAttr[] };

function readStringPool(buf: Buffer, off: number): string[] {
  const count = buf.readUInt32LE(off + 8);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = buf.readUInt32LE(off + 20);
  const utf8 = (flags & 0x100) !== 0;
  const strings: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = off + stringsStart + buf.readUInt32LE(off + 28 + i * 4);
    if (utf8) {
      let n = buf[p] as number; // char count (skip)
      p += n & 0x80 ? 2 : 1;
      n = buf[p] as number;
      let len = n;
      if (n & 0x80) {
        len = ((n & 0x7f) << 8) | (buf[p + 1] as number);
        p += 2;
      } else p += 1;
      strings.push(buf.toString('utf8', p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2);
        p += 4;
      } else p += 2;
      strings.push(buf.toString('utf16le', p, p + len * 2));
    }
  }
  return strings;
}

/** Parses an AXML document into a flat list of start elements with their attributes. */
export function parseAxml(buf: Buffer): XmlElement[] {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) throw new FireLabError('bad-request', 'AndroidManifest.xml is not binary XML');
  let strings: string[] = [];
  let resIds: number[] = [];
  const out: XmlElement[] = [];
  let depth = 0;
  let off = buf.readUInt16LE(2);
  while (off + 8 <= buf.length) {
    const type = buf.readUInt16LE(off);
    const headerSize = buf.readUInt16LE(off + 2);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = readStringPool(buf, off);
    else if (type === 0x0180) {
      resIds = [];
      for (let p = off + headerSize; p < off + size; p += 4) resIds.push(buf.readUInt32LE(p));
    } else if (type === 0x0102) {
      const ext = off + headerSize;
      const name = strings[buf.readUInt32LE(ext + 4)] ?? '';
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10);
      const attrCount = buf.readUInt16LE(ext + 12);
      const attrs: XmlAttr[] = [];
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = buf.readUInt32LE(a + 4);
        const raw = buf.readInt32LE(a + 8);
        const dataType = buf[a + 15] as number;
        const data = buf.readUInt32LE(a + 16);
        const attrName = ATTR_IDS[resIds[nameIdx] ?? -1] ?? strings[nameIdx] ?? '';
        const attr: XmlAttr = { name: attrName, type: dataType };
        if (raw >= 0) attr.str = strings[raw];
        else if (dataType === 0x03) attr.str = strings[data];
        if (dataType >= 0x10 && dataType <= 0x1f) attr.int = data | 0;
        attrs.push(attr);
      }
      out.push({ name, depth, attrs });
      depth++;
    } else if (type === 0x0103) depth--;
    off += size;
  }
  return out;
}

const attr = (el: XmlElement | undefined, name: string) => el?.attrs.find((a) => a.name === name);

export function parseManifest(xml: Buffer): Omit<ApkInfo, 'nativeAbis'> {
  const els = parseAxml(xml);
  const manifest = els.find((e) => e.name === 'manifest');
  const pkg = attr(manifest, 'package')?.str;
  if (!pkg) throw new FireLabError('bad-request', 'AndroidManifest.xml has no package name');
  const usesSdk = els.find((e) => e.name === 'uses-sdk');
  const app = els.find((e) => e.name === 'application');
  const vc = attr(manifest, 'versionCode');
  const intOrStr = (a?: XmlAttr) => (a?.int !== undefined ? a.int : a?.str ? Number(a.str) || undefined : undefined);
  return {
    package: pkg,
    versionCode: vc?.int ?? (vc?.str ? Number(vc.str) : undefined),
    versionName: attr(manifest, 'versionName')?.str,
    minSdk: intOrStr(attr(usesSdk, 'minSdkVersion')),
    targetSdk: intOrStr(attr(usesSdk, 'targetSdkVersion')),
    label: attr(app, 'label')?.str,
    leanback: els.some((e) => e.name === 'category' && attr(e, 'name')?.str === 'android.intent.category.LEANBACK_LAUNCHER'),
    permissions: els.filter((e) => e.name === 'uses-permission').map((e) => attr(e, 'name')?.str ?? '').filter(Boolean),
  };
}

export function readApk(buf: Buffer): ApkInfo {
  const entries = zipEntries(buf);
  const m = entries.find((e) => e.name === 'AndroidManifest.xml');
  if (!m) throw new FireLabError('bad-request', 'Not an APK (no AndroidManifest.xml)');
  const abis = new Set<string>();
  for (const e of entries) {
    const mm = /^lib\/([^/]+)\/[^/]+\.so$/.exec(e.name);
    if (mm) abis.add(mm[1] as string);
  }
  return { ...parseManifest(zipRead(buf, m)), nativeAbis: [...abis].sort() };
}

export function readApkFile(file: string): ApkInfo {
  return readApk(fs.readFileSync(file));
}

/** Null if the APK can run on a device with these ABIs, else a reason people can act on. */
export function abiProblem(apk: ApkInfo, deviceAbis: string[]): string | null {
  if (!apk.nativeAbis.length || !deviceAbis.length) return null;
  if (apk.nativeAbis.some((a) => deviceAbis.includes(a))) return null;
  return `The APK has native code for ${apk.nativeAbis.join(', ')} only, but the device runs ${deviceAbis.join(', ')}. Build it with an ${deviceAbis[0]} ABI split (Fire TV Sticks are 32-bit ARM).`;
}
