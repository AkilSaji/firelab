/**
 * Wires fit and profile capture to a real device through FireLab's own adb
 * and DevTools layers (public FireLab APIs only).
 */
import type { FireLab } from '../core/firelab.js';
import { FpsSampler } from '../cdp/fps.js';
import { NativeSampler } from '../perf/native.js';
import { SurfaceFlingerSampler } from '../perf/surfaceflinger.js';
import { pidOf, launchApp } from '../adb/apps.js';
import { sleep } from '../lib/util.js';
import type { CaptureDeps } from '../profile/capture.js';
import type { FitDeps, FitPage } from './run.js';
import type { FitDeviceInfo } from './types.js';

export async function fitDepsFromLab(lab: FireLab, deviceId: string | undefined, pkg?: string): Promise<{ deps: FitDeps; serial: string; package?: string }> {
  const serial = await lab.resolveDevice(deviceId);
  const target = pkg ?? (await lab.foreground(serial).catch(() => null))?.package;
  const nat = target ? new NativeSampler(lab.adb, serial, target) : undefined;
  const deps: FitDeps = {
    device: async (): Promise<FitDeviceInfo> => {
      const i = await lab.deviceInfo(serial);
      return {
        id: serial,
        ...(i.model ? { model: i.model } : {}),
        name: i.name,
        ...(i.gpu ? { gpu: i.gpu } : {}),
        ...(i.sdk ? { sdk: i.sdk } : {}),
        os: i.os,
        abis: i.abis,
        ...(i.ramMB ? { ramMB: i.ramMB } : {}),
        ...(i.resolution ? { resolution: i.resolution } : {}),
      };
    },
    openPage: async (): Promise<FitPage> => {
      const s = await lab.webview(serial, target);
      const fps = new FpsSampler(s);
      return {
        get closed() {
          return s.closed;
        },
        eval: (expr, timeoutMs) => s.eval(expr, { timeoutMs: timeoutMs ?? 15000 }),
        send: (method, params) => s.cdp.send(method, params ?? {}, 10000),
        navigate: (url) => s.navigate(url, 45000),
        addInitScript: (src) => s.addInitScript(src),
        removeInitScript: (id) => s.removeInitScript(id),
        reload: () => s.reload(false, 45000),
        currentUrl: () => s.url(),
        installProbe: () => fps.install().catch(() => undefined),
        resetFps: () => fps.reset(),
        readFps: () => fps.read(),
        lastHook: () => fps.lastHook as Record<string, unknown> | null,
        close: () => {},
      };
    },
    ...(nat ? { native: (memory: boolean) => nat.sample({ memory }) } : {}),
    ...(target ? { frames: (() => {
      const sf = new SurfaceFlingerSampler(lab.adb, serial, target);
      return { reset: async () => void (await sf.read()), read: () => sf.read() };
    })() } : {}),
    shell: (command) => lab.adb.shell(serial, command, { timeoutMs: 20000 }),
    sleep: (ms) => sleep(ms),
    now: () => Date.now(),
  };
  return { deps, serial, ...(target ? { package: target } : {}) };
}

/**
 * Capture deps. With a package, the app is launched if it isn't running
 * (after the idle memory reading) and its WebView is used for the WebGL,
 * WebView and media facts.
 */
export async function captureDepsFromLab(lab: FireLab, deviceId: string | undefined, pkg?: string, url?: string): Promise<{ deps: CaptureDeps; serial: string }> {
  const serial = await lab.resolveDevice(deviceId);
  const deps: CaptureDeps = {
    shell: (command) => lab.adb.shell(serial, command, { timeoutMs: 20000 }),
    sleep: (ms) => sleep(ms),
    ...(pkg
      ? {
          openPage: async () => {
            if (!(await pidOf(lab.adb, serial, pkg))) {
              await launchApp(lab.adb, serial, pkg, url ? { url } : {});
              await sleep(6000);
            }
            const s = await lab.webview(serial, pkg);
            return { eval: <T>(expr: string, timeoutMs?: number) => s.eval<T>(expr, { timeoutMs: timeoutMs ?? 15000 }), url: () => s.url() };
          },
        }
      : {}),
  };
  return { deps, serial };
}
