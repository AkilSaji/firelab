/**
 * APK facts for fit: everything src/adb/apk.ts reads, plus the manifest's
 * <uses-feature> entries (touchscreen, camera, OpenGL ES version...).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseAxml, readApk, zipEntries, zipRead, type XmlElement } from '../adb/apk.js';
import type { ApkFacts, ManifestFeature } from './types.js';

const attr = (el: XmlElement, name: string) => el.attrs.find((a) => a.name === name);

/** <uses-feature> entries; android:required defaults to true. */
export function manifestFeatures(els: XmlElement[]): { features: ManifestFeature[]; glEsVersion?: number } {
  const features: ManifestFeature[] = [];
  let glEsVersion: number | undefined;
  for (const el of els) {
    if (el.name !== 'uses-feature') continue;
    const req = attr(el, 'required');
    const required = req === undefined ? true : req.int !== undefined ? req.int !== 0 : req.str !== 'false';
    const gles = attr(el, 'glEsVersion');
    if (gles?.int) {
      const v = gles.int >>> 0;
      const ver = (v >> 16) + (v & 0xffff) / 10;
      if (required && (glEsVersion === undefined || ver > glEsVersion)) glEsVersion = ver;
      continue;
    }
    const name = attr(el, 'name')?.str;
    if (name) features.push({ name, required });
  }
  return { features, ...(glEsVersion !== undefined ? { glEsVersion } : {}) };
}

export function apkFactsFromBuffer(buf: Buffer, file?: string): ApkFacts {
  const info = readApk(buf);
  const m = zipEntries(buf).find((e) => e.name === 'AndroidManifest.xml');
  const extra = m ? manifestFeatures(parseAxml(zipRead(buf, m))) : { features: [] };
  return { ...info, ...extra, ...(file ? { file: path.basename(file) } : {}), sizeBytes: buf.length };
}

export function readApkFacts(file: string): ApkFacts {
  return apkFactsFromBuffer(fs.readFileSync(file), file);
}

/** Hardware Fire TVs don't have, by feature-name prefix. */
export const TV_MISSING: { match: RegExp; what: string }[] = [
  { match: /^android\.hardware\.touchscreen/, what: 'a touchscreen' },
  { match: /^android\.hardware\.camera/, what: 'a camera' },
  { match: /^android\.hardware\.telephony/, what: 'telephony' },
  { match: /^android\.hardware\.location/, what: 'GPS / location hardware' },
  { match: /^android\.hardware\.sensor\.(accelerometer|gyroscope|compass|barometer|proximity|light|stepcounter|stepdetector)/, what: 'motion and environment sensors' },
  { match: /^android\.hardware\.nfc/, what: 'NFC' },
  { match: /^android\.hardware\.microphone/, what: 'a microphone apps can record from (most Fire TVs)' },
  { match: /^android\.hardware\.screen\.portrait/, what: 'a portrait screen' },
  { match: /^android\.hardware\.fingerprint|^android\.hardware\.biometrics/, what: 'a fingerprint reader' },
];

const TELEPHONY_PERMS = /\.(CALL_PHONE|CALL_PRIVILEGED|MODIFY_PHONE_STATE|PROCESS_OUTGOING_CALLS|READ_SMS|RECEIVE_SMS|RECEIVE_MMS|RECEIVE_WAP_PUSH|SEND_SMS|WRITE_APN_SETTINGS|WRITE_SMS)$/;

/**
 * Features the app effectively requires: declared ones plus those Android
 * (and the Appstore's filters) imply from permissions, minus anything the
 * manifest marks android:required="false". Touchscreen is implied for every
 * app that doesn't opt out.
 */
export function requiredFeatures(apk: ApkFacts): { name: string; why: string }[] {
  const declared = new Map(apk.features.map((f) => [f.name, f.required]));
  const out = new Map<string, string>();
  for (const f of apk.features) if (f.required) out.set(f.name, 'declared required in the manifest');
  const imply = (name: string, why: string) => {
    if (declared.has(name) || out.has(name)) return;
    // A sub-feature marked optional (e.g. camera.any) also covers its parent.
    if ([...declared].some(([n, req]) => !req && (n.startsWith(`${name}.`) || name.startsWith(`${n}.`)))) return;
    out.set(name, why);
  };
  imply('android.hardware.touchscreen', 'implied: every app requires a touchscreen unless the manifest says android:required="false"');
  const perms = apk.permissions;
  if (perms.some((p) => p.endsWith('.CAMERA'))) imply('android.hardware.camera', 'implied by the CAMERA permission');
  if (perms.some((p) => TELEPHONY_PERMS.test(p))) imply('android.hardware.telephony', 'implied by a phone/SMS permission');
  if (perms.some((p) => p.endsWith('.RECORD_AUDIO'))) imply('android.hardware.microphone', 'implied by the RECORD_AUDIO permission');
  if ((apk.targetSdk ?? 0) < 21) {
    if (perms.some((p) => p.endsWith('.ACCESS_FINE_LOCATION'))) imply('android.hardware.location.gps', 'implied by ACCESS_FINE_LOCATION (targetSdk < 21)');
    if (perms.some((p) => p.endsWith('.ACCESS_COARSE_LOCATION'))) imply('android.hardware.location.network', 'implied by ACCESS_COARSE_LOCATION (targetSdk < 21)');
  }
  return [...out].map(([name, why]) => ({ name, why }));
}

/** Required features that no Fire TV has. */
export function missingOnTv(apk: ApkFacts): { name: string; why: string; what: string }[] {
  const out: { name: string; why: string; what: string }[] = [];
  for (const f of requiredFeatures(apk)) {
    const m = TV_MISSING.find((t) => t.match.test(f.name));
    if (m) out.push({ ...f, what: m.what });
  }
  return out;
}
