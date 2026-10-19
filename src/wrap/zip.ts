/**
 * Adds files to an existing zip (an APK made by aapt2) without a zip tool:
 * the new entries go where the central directory was, followed by the old
 * central directory, the new entries' records and a fresh end record.
 * Timestamps are fixed, so the same input gives the same bytes.
 */
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './png.js';

export type NewEntry = { name: string; data: Buffer; compress?: boolean };

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
// 1980-01-01 00:00:00 in MS-DOS format.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** Finds the end-of-central-directory record. */
function findEnd(zip: Buffer): number {
  const min = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= min; i--) if (zip.readUInt32LE(i) === SIG_END) return i;
  throw new Error('not a zip file (no end of central directory record)');
}

/** Names of the entries in a zip, from its central directory. */
export function listZip(zip: Buffer): string[] {
  const end = findEnd(zip);
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('corrupt central directory');
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    names.push(zip.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Returns a new zip with `entries` added (replacing nothing: names must be new). */
export function appendToZip(zip: Buffer, entries: NewEntry[]): Buffer {
  const end = findEnd(zip);
  const count = zip.readUInt16LE(end + 10);
  const cdSize = zip.readUInt32LE(end + 12);
  const cdOffset = zip.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
  const existing = new Set(listZip(zip));
  const head = zip.subarray(0, cdOffset);
  const oldCd = zip.subarray(cdOffset, cdOffset + cdSize);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = head.length;
  for (const e of entries) {
    if (existing.has(e.name)) throw new Error(`${e.name} is already in the archive`);
    const name = Buffer.from(e.name, 'utf8');
    const compress = e.compress ?? true;
    const body = compress ? deflateRawSync(e.data, { level: 9 }) : e.data;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(compress ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const newCd = Buffer.concat([oldCd, ...centrals]);
  const endRec = Buffer.alloc(22);
  endRec.writeUInt32LE(SIG_END, 0);
  endRec.writeUInt16LE(count + entries.length, 8);
  endRec.writeUInt16LE(count + entries.length, 10);
  endRec.writeUInt32LE(newCd.length, 12);
  endRec.writeUInt32LE(offset, 16);
  return Buffer.concat([head, ...locals, newCd, endRec]);
}
