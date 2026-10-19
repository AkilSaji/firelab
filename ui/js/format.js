// Formatting helpers.

export const pad = (n, w = 2) => String(n).padStart(w, '0');

export function clock(ts, ms = false) {
  const d = new Date(ts);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return ms ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

export function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

export function stopwatch(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function ago(ts, now = Date.now()) {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function dateTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const day = sameDay ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function num(v, digits = 0) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function mb(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v >= 1024 ? `${(v / 1024).toFixed(2)} GB` : `${Math.round(v)} MB`;
}

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const TIERS = ['low', 'tv', 'tv-hd', 'high'];

export const TIER_INFO = {
  low: 'Very weak GPUs (Mali-450, Mali-T720). Minimal effects, 540p.',
  tv: 'PowerVR GE8300 (Fire TV Stick 3rd gen, Lite), Mali-G31/G51, Adreno 3xx–5xx. 720p cap, no shadows.',
  'tv-hd': 'PowerVR GE9215 / GE9xxx (Fire TV Stick 4K Max 2nd gen), Mali-G52+, Adreno 6xx+. Up to 1080p, sun shadows.',
  high: 'Desktop and laptop GPUs. Everything on.',
};

export const KEY_NAMES = ['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'playpause', 'rewind', 'fastforward', 'volup', 'voldown', 'mute', 'search', 'wake'];

export const KEY_GLYPH = {
  up: '▲', down: '▼', left: '◀', right: '▶', ok: 'OK', back: 'BACK', home: 'HOME', menu: 'MENU',
  playpause: '▶❙❙', rewind: '◀◀', fastforward: '▶▶', volup: 'VOL+', voldown: 'VOL−', mute: 'MUTE',
  search: 'SEARCH', wake: 'WAKE',
};

export function shortGpu(gpu) {
  if (!gpu) return '';
  return gpu.replace(/^PowerVR Rogue\s*/i, 'PowerVR ').replace(/^ARM\s+/i, '');
}

// ---------- tests ----------

export const KIND_INFO = {
  'app-launch': { label: 'App launch', icon: 'rocket' },
  navigation: { label: 'Navigation', icon: 'remote' },
  performance: { label: 'Performance', icon: 'gauge' },
  explore: { label: 'Explore', icon: 'radar' },
  gpu: { label: 'GPU check', icon: 'chip' },
  replay: { label: 'Replay', icon: 'replay' },
  sweep: { label: 'Sweep', icon: 'layers' },
};

/** One word for a job's state: running, pass, fail, skip, error or stopped (always shown with an icon). */
export function outcome(job) {
  if (!job) return 'skip';
  if (job.status === 'running') return 'running';
  if (job.status === 'failed' || job.status === 'error') return 'error';
  if (job.status === 'stopped') return 'stopped';
  return job.verdict || 'skip';
}

export const OUTCOME = {
  running: { word: 'running', icon: 'play' },
  pass: { word: 'passed', icon: 'check' },
  fail: { word: 'failed', icon: 'x' },
  skip: { word: 'skipped', icon: 'info' },
  error: { word: 'error', icon: 'alert' },
  stopped: { word: 'stopped', icon: 'stop' },
};

export const SEVERITIES = ['critical', 'major', 'minor', 'info'];
