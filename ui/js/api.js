// HTTP client for the dashboard API (docs/CONTRACT.md). Same origin as the page.

export class ApiError extends Error {
  constructor(message, status, network = false) {
    super(message);
    this.status = status;
    this.network = network;
  }
}

export async function api(path, { method = 'GET', body, signal, timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeout);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError' && signal?.aborted) throw err;
    const msg = err?.name === 'TimeoutError' || ctrl.signal.reason?.name === 'TimeoutError'
      ? 'The FireLab server took too long to answer.'
      : "Can't reach the FireLab server. Is `firelab ui` still running?";
    throw new ApiError(msg, 0, true);
  }
  clearTimeout(timer);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) };
    }
  }
  if (!res.ok) throw new ApiError(data?.error || `${res.status} ${res.statusText}`, res.status);
  return data;
}

export const post = (path, body = {}, opts) => api(path, { ...opts, method: 'POST', body });

/** `/devices/<encoded id>` (ids look like 192.168.1.194:5555). */
export const dev = (id) => `/devices/${encodeURIComponent(id)}`;

/**
 * Subscribe to an SSE endpoint. `handlers` maps event names to callbacks that
 * receive parsed JSON. Returns a close() function.
 */
export function subscribe(path, handlers, { onopen, onerror } = {}) {
  const es = new EventSource(`/api${path}`);
  for (const [event, fn] of Object.entries(handlers)) {
    es.addEventListener(event, (e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      fn(data);
    });
  }
  if (onopen) es.addEventListener('open', onopen);
  if (onerror) es.addEventListener('error', () => onerror(es));
  return () => es.close();
}
