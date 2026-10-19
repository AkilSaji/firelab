#!/usr/bin/env node
// A tiny static file server for the demo, with no dependencies.
//
//   node examples/web-game/serve.mjs            # http://0.0.0.0:8080
//   node examples/web-game/serve.mjs --port 9000
//
// It serves the repository root (so the page can import packages/perf
// directly) and listens on every interface, so a Fire TV on the same Wi-Fi
// can open it. The addresses to type on the TV are printed at start-up.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const START = '/examples/web-game/';
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer((req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (path === '/' || path === '/examples/web-game') {
    res.writeHead(302, { Location: START }).end();
    return;
  }
  const file = normalize(join(ROOT, path));
  // Never serve anything outside the repository (../ tricks) or dotfiles (.git, .env).
  if ((file !== ROOT && !file.startsWith(ROOT + sep)) || /[\\/]\./.test(path) || file.includes(`${sep}node_modules${sep}`)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let target = file;
  try {
    if (statSync(target).isDirectory()) target = join(target, 'index.html');
    statSync(target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`not found: ${path}`);
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    // A dev server: always fresh, so a TV never runs yesterday's build.
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(target).pipe(res);
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use: try --port ${PORT + 1}` : e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  console.log(`Firefly Lake is running:\n  http://localhost:${PORT}${START}`);
  for (const ip of lan) console.log(`  http://${ip}:${PORT}${START}   <- open this on the TV (same Wi-Fi)`);
  console.log(`\nTry ?perf=1 (meter), ?q=tv-hd (force a tier), ?busy=1 (heavy scene), ?autoplay=1. Ctrl+C stops.`);
});
