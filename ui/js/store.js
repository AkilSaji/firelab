// Shared state and a small event bus. Modules read `state` and subscribe to
// the events they care about; only the owning module writes a given field.
//
// Events:
//   health        server health changed            (state.health / state.server)
//   devices       device list refreshed             (state.devices)
//   select        selected device changed           (state.selectedId)
//   stream        SSE connection status changed     (state.stream)
//   perf|log|key|state|vitals   SSE payloads for the selected device
//   page          the visible page changed           (state.page: devices | tests | scenarios | logs | reports)
//   test:started  a test job or sweep was started    ({ kind: 'test' | 'sweep', job })
//   test:update   the followed job changed           (TestJob, or a sweep adapted to that shape)
//   test:done     a followed job finished            (same)
//   keysent       the dashboard sent remote keys    ({ keys, holdMs, ts })
//   theme         the theme changed (charts redraw)

import { storage, save } from './dom.js';

export const state = {
  server: 'unknown', // 'unknown' | 'up' | 'down'
  health: null,
  devices: [],
  devicesError: null,
  selectedId: storage('firelab.selected', null),
  live: null, // last StateEvent for the selected device
  stream: 'idle', // 'idle' | 'connecting' | 'live' | 'retrying'
  watching: null, // { sessionId, device, startedAt } when a watch session runs here
  sweeping: false,
  page: 'devices',
};

const subs = new Map();

export function on(type, fn) {
  if (!subs.has(type)) subs.set(type, new Set());
  subs.get(type).add(fn);
  return () => subs.get(type).delete(fn);
}

export function emit(type, payload) {
  const set = subs.get(type);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[firelab] ${type} handler failed`, err);
    }
  }
}

export function selected() {
  return state.devices.find((d) => d.id === state.selectedId) || null;
}

/** The selected device, only if adb can talk to it right now. */
export function liveDevice() {
  const d = selected();
  return d && d.state === 'device' ? d : null;
}

export function select(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  state.live = null;
  save('firelab.selected', id);
  emit('select', id);
}

export function deviceLabel(d) {
  if (!d) return '';
  return d.name || d.model || d.id;
}
