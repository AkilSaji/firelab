/**
 * Served at / when ui/ has no index.html (e.g. a checkout without the
 * dashboard): a tiny page that still shows devices and their screens.
 */
export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FireLab</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f5f2; --fg: #1d1c1a; --muted: #6b6862; --card: #fff; --line: #e3e0da; --accent: #e8590c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #ecebe7; --muted: #9c988f; --card: #201f1c; --line: #34322e; } }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 1000px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h1 b { color: var(--accent); }
  p { color: var(--muted); margin: 0 0 20px; }
  .dev { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 16px; }
  .dev h2 { font-size: 16px; margin: 0 0 6px; } .meta { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
  img { width: 100%; border-radius: 6px; background: #000; aspect-ratio: 16 / 9; object-fit: contain; }
  .keys { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--accent); }
  code { font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1><b>FireLab</b> dashboard</h1>
  <p>Minimal view: the full dashboard lives in <code>ui/</code>. The API is at <code>/api</code> (see docs/CONTRACT.md).</p>
  <div id="list">Loading devices…</div>
</main>
<script>
const list = document.getElementById('list');
const keys = ['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'playpause'];
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
async function load() {
  try {
    const devices = await api('/api/devices');
    if (!devices.length) { list.textContent = 'No devices. Run "firelab devices --scan" or "firelab doctor".'; return; }
    list.innerHTML = devices.map((d) => '<div class="dev" data-id="' + esc(d.id) + '"><h2>' + esc(d.name || d.model || d.id) + '</h2>' +
      '<div class="meta">' + esc([d.id, d.state, d.os, d.gpu, d.tier && ('tier ' + d.tier)].filter(Boolean).join(' · ')) + '</div>' +
      (d.state === 'device' ? '<img alt="Screen of ' + esc(d.name || d.id) + '"><div class="keys">' + keys.map((k) => '<button data-k="' + k + '">' + k + '</button>').join('') + '</div>' : '') + '</div>').join('');
    for (const el of list.querySelectorAll('.dev')) {
      const id = el.dataset.id, img = el.querySelector('img');
      if (!img) continue;
      const refresh = () => { img.src = '/api/devices/' + encodeURIComponent(id) + '/screen.jpg?w=960&t=' + Date.now(); };
      img.onload = () => setTimeout(refresh, 1500);
      img.onerror = () => setTimeout(refresh, 4000);
      refresh();
      el.querySelectorAll('button').forEach((b) => b.onclick = () => api('/api/devices/' + encodeURIComponent(id) + '/keys', { keys: [b.dataset.k] }).catch((e) => alert(e.message)));
    }
  } catch (e) { list.textContent = 'Error: ' + e.message; }
}
load();
</script>
</body>
</html>
`;
