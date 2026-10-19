// One SSE connection to the selected device: perf, log, key, state and vitals events
// are re-emitted on the bus. Events already seen (a reconnect may replay a
// backlog) are dropped here, so panels never show duplicates.

import { subscribe, dev } from './api.js';
import { state, on, emit, liveDevice } from './store.js';
import { $ } from './dom.js';

let close = null;
let currentId = null;
let last = { perf: 0, log: 0, key: 0, logText: '' };

function setStream(s) {
  state.stream = s;
  emit('stream', s);
  const pill = $('#stream-pill');
  const label = { idle: 'idle', connecting: 'connecting', live: 'live', retrying: 'retrying' }[s];
  pill.querySelector('.status-pill-val').textContent = label;
  pill.querySelector('.dot').className = `dot ${s === 'live' ? 'dot--ok' : s === 'retrying' ? 'dot--warn' : s === 'connecting' ? 'dot--busy' : ''}`;
}

function sync() {
  const d = liveDevice();
  const id = d ? d.id : null;
  if (id === currentId) return;
  close?.();
  close = null;
  currentId = id;
  last = { perf: 0, log: 0, key: 0, logText: '' };
  if (!id) {
    setStream('idle');
    return;
  }
  setStream('connecting');
  close = subscribe(
    `${dev(id)}/stream`,
    {
      perf: (e) => {
        if (e.ts <= last.perf) return;
        last.perf = e.ts;
        emit('perf', e);
      },
      log: (e) => {
        if (e.ts < last.log || (e.ts === last.log && e.text === last.logText)) return;
        last.log = e.ts;
        last.logText = e.text;
        emit('log', e);
      },
      key: (e) => {
        if (e.ts < last.key) return;
        last.key = e.ts;
        emit('key', e);
      },
      state: (e) => {
        state.live = e;
        emit('state', e);
      },
      vitals: (e) => emit('vitals', e),
    },
    {
      onopen: () => setStream('live'),
      onerror: (es) => {
        if (es.readyState !== EventSource.CLOSED) {
          setStream('retrying');
          return;
        }
        // The server refused the stream (e.g. the device just went away): try again shortly.
        setStream('retrying');
        close?.();
        close = null;
        currentId = null;
        setTimeout(sync, 3000);
      },
    },
  );
}

export function initStream() {
  on('select', sync);
  on('devices', sync);
  setStream('idle');
}
