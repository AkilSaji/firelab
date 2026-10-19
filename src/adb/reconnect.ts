import { EventEmitter } from 'node:events';
import type { Adb } from './client.js';
import type { AdbDevice } from './devices.js';
import { parseHostPort } from './devices.js';
import { log } from '../lib/log.js';

export type ReconnectEvents = {
  lost: [serial: string];
  reconnected: [serial: string, attempts: number];
  devices: [devices: AdbDevice[]];
};

/**
 * Keeps Wi-Fi devices connected. Fire TVs drop off adb when Wi-Fi blips, when
 * they sleep, and after DHCP renewals; adb doesn't retry by itself. Every
 * `intervalMs` this polls `adb devices` and reconnects watched serials that
 * are missing or offline, backing off from 2 s to 30 s.
 */
export class Reconnector extends EventEmitter<ReconnectEvents> {
  private watched = new Map<string, { attempts: number; nextTry: number; lost: boolean; offlineSince?: number }>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  last: AdbDevice[] = [];

  constructor(
    private readonly adb: Adb,
    private readonly intervalMs = 5000,
  ) {
    super();
  }

  watch(serial: string): void {
    if (!parseHostPort(serial)) return; // USB devices come back by themselves
    if (!this.watched.has(serial)) this.watched.set(serial, { attempts: 0, nextTry: 0, lost: false });
  }

  unwatch(serial: string): void {
    this.watched.delete(serial);
  }

  get watching(): string[] {
    return [...this.watched.keys()];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass: exposed for tests and for callers that want an immediate check. */
  async poll(now = Date.now()): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let devices: AdbDevice[];
      try {
        devices = await this.adb.devices();
      } catch (e) {
        log.debug('reconnect: adb devices failed', e);
        return;
      }
      this.last = devices;
      this.emit('devices', devices);
      for (const d of devices) if (d.transport === 'tcp' && d.state === 'device') this.watch(d.serial);
      for (const [serial, st] of this.watched) {
        const dev = devices.find((d) => d.serial === serial);
        if (dev?.state === 'device') {
          if (st.lost) {
            log.info(`reconnected ${serial}${st.attempts ? ` after ${st.attempts} attempt(s)` : ''}`);
            this.emit('reconnected', serial, st.attempts);
          }
          st.lost = false;
          st.attempts = 0;
          st.nextTry = 0;
          st.offlineSince = undefined;
          continue;
        }
        if (dev?.state === 'unauthorized') continue; // a person has to press OK on the TV
        if (!st.lost) {
          st.lost = true;
          log.warn(`${serial} dropped off adb (${dev ? dev.state : 'missing'}); reconnecting`);
          this.emit('lost', serial);
        }
        if (now < st.nextTry) continue;
        st.attempts++;
        st.nextTry = now + Math.min(30000, 2000 * 2 ** Math.min(st.attempts - 1, 4));
        try {
          // A stale "offline" entry blocks a fresh connect: drop it first.
          if (dev?.state === 'offline') await this.adb.disconnect(serial);
          await this.adb.connect(serial, 5000);
        } catch (e) {
          log.debug(`reconnect ${serial} failed`, e);
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
