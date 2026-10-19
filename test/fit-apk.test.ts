import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apkFactsFromBuffer, readApkFacts, requiredFeatures, missingOnTv } from '../src/fit/apk.js';
import { checkAbi, checkSdk, checkFeatures, checkLeanback, checkGles } from '../src/fit/checks.js';
import { buildTargets } from '../src/fit/targets.js';
import { scoreFit } from '../src/fit/score.js';
import { emptyMeasurement } from '../src/fit/measurement.js';
import { loadProfiles } from '../src/profile/load.js';
import { appendToZip } from '../src/wrap/zip.js';
import type { FitTarget } from '../src/fit/types.js';

const fx = (f: string) => path.join(import.meta.dirname, 'fixtures', 'fit', f);
const profiles = loadProfiles().profiles;
const targets = buildTargets(profiles);
const t = (model: string) => targets.find((x) => x.model === model) as FitTarget;
const phone = readApkFacts(fx('fixture-phone.apk'));
const tv = readApkFacts(fx('fixture-tv.apk'));
const arm64Only = apkFactsFromBuffer(appendToZip(fs.readFileSync(fx('fixture-phone.apk')), [{ name: 'lib/arm64-v8a/libgame.so', data: Buffer.from('\x7fELF fake') }]), 'arm64.apk');
const both = apkFactsFromBuffer(
  appendToZip(fs.readFileSync(fx('fixture-tv.apk')), [
    { name: 'lib/arm64-v8a/libgame.so', data: Buffer.from('x') },
    { name: 'lib/armeabi-v7a/libgame.so', data: Buffer.from('x') },
  ]),
);

describe('APK facts (aapt2-built fixtures)', () => {
  it('reads uses-feature entries and the required OpenGL ES version', () => {
    expect(phone).toMatchObject({ package: 'com.firelab.fixture.phone', minSdk: 26, targetSdk: 34, leanback: false, nativeAbis: [], glEsVersion: 3.1, file: 'fixture-phone.apk' });
    expect(phone.features).toEqual([
      { name: 'android.hardware.camera', required: true },
      { name: 'android.hardware.location.gps', required: true },
    ]);
    expect(tv).toMatchObject({ package: 'com.firelab.fixture.tv', minSdk: 22, leanback: true, glEsVersion: 2 });
    expect(tv.features).toEqual([
      { name: 'android.hardware.touchscreen', required: false },
      { name: 'android.software.leanback', required: false },
      { name: 'android.hardware.camera', required: false },
    ]);
    expect(arm64Only.nativeAbis).toEqual(['arm64-v8a']);
    expect(both.nativeAbis).toEqual(['arm64-v8a', 'armeabi-v7a']);
  });

  it('works out required features the way Android and the Appstore do', () => {
    expect(requiredFeatures(phone).map((f) => f.name)).toEqual(['android.hardware.camera', 'android.hardware.location.gps', 'android.hardware.touchscreen']);
    // READ_PHONE_STATE does not imply telephony; ACCESS_FINE_LOCATION implies GPS only below targetSdk 21.
    expect(requiredFeatures({ ...phone, features: [], targetSdk: 19 }).map((f) => f.name)).toEqual(['android.hardware.touchscreen', 'android.hardware.location.gps']);
    expect(requiredFeatures({ ...phone, features: [], permissions: ['android.permission.SEND_SMS', 'android.permission.RECORD_AUDIO'] }).map((f) => f.name)).toEqual(['android.hardware.touchscreen', 'android.hardware.telephony', 'android.hardware.microphone']);
    // The TV fixture opts out of touchscreen and camera (CAMERA permission notwithstanding).
    expect(requiredFeatures(tv)).toEqual([]);
    expect(missingOnTv(phone).map((m) => m.what)).toEqual(['a camera', 'GPS / location hardware', 'a touchscreen']);
  });
});

describe('static checks per model', () => {
  it('ABI: an arm64-only APK fails on 32-bit sticks, passes on the arm64 Cube', () => {
    const sss = checkAbi(arm64Only, t('AFTSSS'), false);
    expect(sss).toMatchObject({ status: 'fail', basis: 'profile', confidence: 'high', summary: 'arm64-v8a only' });
    expect(sss.reason).toMatch(/INSTALL_FAILED_NO_MATCHING_ABIS/);
    expect(sss.fix).toMatch(/abiFilters 'armeabi-v7a'/);
    expect(checkAbi(arm64Only, t('AFTKRT'), false)).toMatchObject({ status: 'fail', basis: 'estimated', confidence: 'medium' });
    expect(checkAbi(arm64Only, t('AFTR'), false)).toMatchObject({ status: 'pass' });
    expect(checkAbi(both, t('AFTSSS'), false)).toMatchObject({ status: 'pass', summary: 'armeabi-v7a' });
    expect(checkAbi(tv, t('AFTSSS'), false)).toMatchObject({ status: 'pass', summary: 'no native code' });
  });

  it('SDK: minSdk 26 installs on Fire OS 7 and 8, not on Fire OS 5 or 6', () => {
    expect(checkSdk(phone, t('AFTSSS'), false)).toMatchObject({ status: 'pass', basis: 'profile' });
    expect(checkSdk(phone, t('AFTKRT'), false)).toMatchObject({ status: 'pass', basis: 'estimated', confidence: 'high' });
    const old = checkSdk(phone, t('AFTMM'), false);
    expect(old).toMatchObject({ status: 'fail', summary: 'needs API 26' });
    expect(old.reason).toMatch(/API 25 \(Fire OS 6\).*INSTALL_FAILED_OLDER_SDK/);
    expect(checkSdk(phone, t('AFTT'), false).status).toBe('fail');
    expect(checkSdk({ ...tv, targetSdk: 14 }, t('AFTSSS'), false)).toMatchObject({ status: 'warn' });
  });

  it('TV hardware and Leanback', () => {
    const f = checkFeatures(phone, t('AFTSSS'));
    expect(f).toMatchObject({ status: 'warn', confidence: 'high' });
    expect(f.reason).toMatch(/a camera, GPS \/ location hardware, a touchscreen/);
    expect(f.fix).toContain('<uses-feature android:name="android.hardware.touchscreen" android:required="false"/>');
    expect(checkFeatures(tv, t('AFTSSS')).status).toBe('pass');
    expect(checkLeanback(phone, t('AFTSSS'))).toMatchObject({ status: 'warn', summary: 'no TV launcher entry' });
    expect(checkLeanback(tv, t('AFTSSS')).status).toBe('pass');
  });

  it('OpenGL ES: ES 3.1 required fails on Mali-450 and VideoCore, passes on PowerVR', () => {
    expect(checkGles(phone, t('AFTT'))).toMatchObject({ status: 'fail', summary: 'needs ES 3.1' });
    expect(checkGles(phone, t('AFTM'))?.status).toBe('fail');
    expect(checkGles(phone, t('AFTSSS'))).toMatchObject({ status: 'pass', basis: 'profile' });
    expect(checkGles({ ...phone, glEsVersion: undefined }, t('AFTSSS'))).toBeUndefined();
  });
});

describe('a static-only fit', () => {
  it('arm64-only + minSdk 26 phone APK: won\'t run on the 1 GB sticks, with the ABI as headline', () => {
    const r = scoreFit(emptyMeasurement({ app: { apk: arm64Only } }), profiles);
    const sss = r.models.find((m) => m.model === 'AFTSSS');
    expect(sss).toMatchObject({ verdict: 'wont-run', headline: 'CPU ABI: arm64-v8a only', basis: 'profile', confidence: 'high' });
    expect(r.summary.focus.verdict).toBe('wont-run');
    expect(r.models.find((m) => m.model === 'AFTR')?.verdict).toBe('risky'); // installs, but TV hardware + Leanback warnings
    expect(r.evidence).toMatchObject({ static: true, measured: false, media: false });
  });

  it('a TV-ready APK "runs" with low confidence: static checks only', () => {
    const r = scoreFit(emptyMeasurement({ app: { apk: tv } }), profiles);
    const sss = r.models.find((m) => m.model === 'AFTSSS');
    expect(sss).toMatchObject({ verdict: 'runs', headline: 'Static checks pass', confidence: 'low' });
    expect(sss?.reasons.at(-1)).toMatch(/Static checks only/);
    expect(r.models.filter((m) => m.verdict === 'not-covered').map((m) => m.model).sort()).toEqual(['AFTCA002', 'AFTCL001', 'AFTCR001']);
    expect(r.summary.headline).toMatch(/^Of 63 Fire OS models, it runs on 63, risky on 0, won't run on 0 \(3 Vega OS models not covered\)\.$/);
  });
});
