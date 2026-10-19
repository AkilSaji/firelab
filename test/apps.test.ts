import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePackageList, parsePackageVersions, parseComponents, parseListApps, parseForeground, parseMainActivity, assertPackage, launchApp, resetApp, stopApp, resolveLaunchActivity, shQuote } from '../src/adb/apps.js';
import { readApk, readApkFile, abiProblem, parseAxml, zipEntries } from '../src/adb/apk.js';
import { fakeAdb, SERIAL } from './helpers/fake-adb.js';

const fxPath = (f: string) => new URL(`./fixtures/${f}`, import.meta.url);

const PM = `package:com.example.skyfall versionCode:1
package:com.amazon.tv.legal.notices.overlay.localisation.common versionCode:0
package:com.sunsetvilla.tv versionCode:1
package:com.FDGEntertainment.RedBall4.amazon versionCode:1313
`;
const VERSIONS = `  Package [com.sunsetvilla.tv] (1a2b3c):
    versionName=0.1.0
    lastUpdateTime=2026-10-14 22:10:01
  Package [com.amazon.tv.legal.notices.overlay.localisation.common] (4d5e6f):
    versionName=null
  Package [com.FDGEntertainment.RedBall4.amazon] (777):
    versionName=1.3.13
    lastUpdateTime=2026-10-01 10:00:00
`;
const LEANBACK = `3 activities found:
  Activity #0:
    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false
    com.sunsetvilla.tv/.MainActivity
  Activity #1:
    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false
    com.FDGEntertainment.RedBall4.amazon/com.unity3d.player.UnityPlayerActivity
`;

describe('app listing', () => {
  it('parses pm list output with and without version codes', () => {
    expect(parsePackageList(PM)[3]).toEqual({ package: 'com.FDGEntertainment.RedBall4.amazon', versionCode: 1313 });
    expect(parsePackageList('package:com.a.b\npackage:com.c.d\n')).toEqual([{ package: 'com.a.b' }, { package: 'com.c.d' }]);
  });
  it('reads version names, treating "null" as missing', () => {
    const v = parsePackageVersions(VERSIONS);
    expect(v.get('com.sunsetvilla.tv')).toEqual({ version: '0.1.0', updatedAt: '2026-10-14 22:10:01' });
    expect(v.get('com.amazon.tv.legal.notices.overlay.localisation.common')?.version).toBeUndefined();
  });
  it('extracts components from query-activities / resolve-activity', () => {
    expect(parseComponents(LEANBACK)).toEqual(['com.sunsetvilla.tv/.MainActivity', 'com.FDGEntertainment.RedBall4.amazon/com.unity3d.player.UnityPlayerActivity']);
    expect(parseComponents('No activity found')).toEqual([]);
  });
  it('merges everything, launchable apps first', () => {
    const apps = parseListApps(`${PM}@@versions\n${VERSIONS}@@leanback\n${LEANBACK}@@launcher\n`);
    expect(apps.map((a) => [a.package, a.launchable, a.version])).toEqual([
      ['com.FDGEntertainment.RedBall4.amazon', true, '1.3.13'],
      ['com.sunsetvilla.tv', true, '0.1.0'],
      ['com.amazon.tv.legal.notices.overlay.localisation.common', false, undefined],
      ['com.example.skyfall', false, undefined],
    ]);
  });
});

describe('foreground app', () => {
  it('reads Fire OS 8 (Android 11) dumpsys output', () => {
    const t = `    mResumedActivity: ActivityRecord{74c7a02 u0 com.sunsetvilla.tv/.MainActivity t1535}
  ResumedActivity: ActivityRecord{74c7a02 u0 com.sunsetvilla.tv/.MainActivity t1535}
  mFocusedApp=ActivityRecord{74c7a02 u0 com.sunsetvilla.tv/.MainActivity t1535}
  mCurrentFocus=Window{1ca3782 u0 com.sunsetvilla.tv/com.sunsetvilla.tv.MainActivity}`;
    expect(parseForeground(t)).toEqual({ package: 'com.sunsetvilla.tv', activity: 'com.sunsetvilla.tv.MainActivity' });
  });
  it('reads Android 10+ topResumedActivity and Android 9 focus lines', () => {
    expect(parseForeground('  topResumedActivity=ActivityRecord{f00 u0 com.amazon.tv.launcher/.ui.HomeActivity_vNext t2}')).toEqual({ package: 'com.amazon.tv.launcher', activity: 'com.amazon.tv.launcher.ui.HomeActivity_vNext' });
    expect(parseForeground('  mCurrentFocus=Window{abc u0 com.netflix.ninja/com.netflix.ninja.MainActivity}')?.package).toBe('com.netflix.ninja');
    expect(parseForeground('nothing here')).toBeNull();
  });
});

describe('launching', () => {
  it('validates package names (and keeps shell metacharacters out)', () => {
    expect(assertPackage('com.example.game')).toBe('com.example.game');
    expect(() => assertPackage('com.example; reboot')).toThrow(/not an Android package/);
    expect(() => assertPackage('game')).toThrow();
  });

  it('resolves the Leanback activity, falls back to LAUNCHER, then dumpsys', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/LEANBACK_LAUNCHER com.phone.app/, 'No activity found\n');
    runner.on(/category.LAUNCHER com.phone.app/, 'priority=0\ncom.phone.app/.Main\n');
    expect(await resolveLaunchActivity(adb, SERIAL, 'com.phone.app')).toBe('com.phone.app/.Main');
    runner.on(/resolve-activity .* com.old.app/, '/system/bin/sh: cmd: not found\n');
    runner.on(/dumpsys package com.old.app/, 'Activity Resolver Table:\n  Non-Data Actions:\n      android.intent.action.MAIN:\n        4f1 com.old.app/.Splash filter 5e2\n');
    expect(await resolveLaunchActivity(adb, SERIAL, 'com.old.app')).toBe('com.old.app/.Splash');
  });

  it('starts the app with am start -W, passes the URL, reads launch time and pid', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/resolve-activity/, 'priority=0\ncom.sunsetvilla.tv/.MainActivity\n');
    runner.on(/am start/, 'Starting: Intent { cmp=com.sunsetvilla.tv/.MainActivity }\nStatus: ok\nLaunchState: COLD\nActivity: com.sunsetvilla.tv/.MainActivity\nTotalTime: 1834\nWaitTime: 1840\nComplete\n');
    runner.on(/pidof com.sunsetvilla.tv/, '13059\n');
    const r = await launchApp(adb, SERIAL, 'com.sunsetvilla.tv', { url: "http://192.168.1.164:4173/?q=tv&x='1'" });
    expect(r).toEqual({ ok: true, package: 'com.sunsetvilla.tv', activity: 'com.sunsetvilla.tv/.MainActivity', launchMs: 1834, launchState: 'COLD', pid: 13059 });
    const am = runner.shellCommands().find((c) => c.startsWith('am start')) as string;
    expect(am).toContain("-d 'http://192.168.1.164:4173/?q=tv&x='\\''1'\\'''");
    expect(am).toContain('--es url ');
    expect(shQuote("a'b")).toBe("'a'\\''b'");
  });

  it('reports a missing launcher activity clearly', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/resolve-activity/, 'No activity found\n');
    runner.on(/dumpsys package/, '');
    await expect(launchApp(adb, SERIAL, 'com.overlay.only')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('parses MAIN activities from dumpsys package', () => {
    expect(parseMainActivity('      android.intent.action.MAIN:\n        123 com.x.y/.A filter 1', 'com.x.y')).toBe('com.x.y/.A');
    expect(parseMainActivity('nothing', 'com.x.y')).toBeNull();
  });
});

describe('stop and reset', () => {
  it('force-stops', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/am force-stop com.example.game/, '');
    await stopApp(adb, SERIAL, 'com.example.game');
    expect(runner.shellCommands()).toEqual(['am force-stop com.example.game']);
  });
  it('never clears data without confirm: true', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/pm clear/, 'Success\n');
    await expect(resetApp(adb, SERIAL, 'com.example.game', false)).rejects.toMatchObject({ code: 'confirm-required' });
    expect(runner.calls).toHaveLength(0);
    await resetApp(adb, SERIAL, 'com.example.game', true);
    expect(runner.shellCommands()).toEqual(['pm clear com.example.game']);
  });
  it('reports a failed pm clear', async () => {
    const { adb, runner } = fakeAdb();
    runner.on(/pm clear/, 'Failed\n');
    await expect(resetApp(adb, SERIAL, 'com.example.game', true)).rejects.toThrow(/pm clear com.example.game failed/);
  });
});

describe('APK reader', () => {
  it('reads a real aapt2-built APK (package, version, SDKs, label, leanback, ABIs)', () => {
    const apk = readApkFile(fxPath('fixture-armv7.apk').pathname);
    expect(apk).toEqual({
      package: 'com.firelab.fixture',
      versionCode: 42,
      versionName: '1.2.3',
      minSdk: 22,
      targetSdk: 30,
      label: 'FireLab Fixture',
      leanback: true,
      nativeAbis: ['armeabi-v7a'],
      permissions: ['android.permission.INTERNET'],
    });
  });

  it('spots ABI mismatches before adb install fails', () => {
    const arm64 = readApk(fs.readFileSync(fxPath('fixture-arm64.apk')));
    expect(arm64.nativeAbis).toEqual(['arm64-v8a']);
    expect(abiProblem(arm64, ['armeabi-v7a', 'armeabi'])).toMatch(/arm64-v8a only.*armeabi-v7a/);
    expect(abiProblem(arm64, ['arm64-v8a', 'armeabi-v7a'])).toBeNull();
    expect(abiProblem({ ...arm64, nativeAbis: [] }, ['armeabi-v7a'])).toBeNull();
  });

  it('rejects files that are not APKs', () => {
    expect(() => readApk(Buffer.from('not a zip at all, sorry'))).toThrow(/Not an APK/);
    expect(() => parseAxml(Buffer.from('<?xml version="1.0"?>'))).toThrow(/not binary XML/);
    expect(zipEntries(fs.readFileSync(fxPath('fixture-armv7.apk'))).map((e) => e.name)).toContain('AndroidManifest.xml');
  });
});
