// Fake "device screens" for the mock server, drawn as SVG.
//
// Two scenes react to the virtual remote: a TV launcher (the D-pad moves the
// focus, OK opens an app) and a small racing game (left/right change lanes,
// play/pause pauses). Frames are animated from the clock, so the live mirror
// visibly moves. Node built-ins only; nothing here is shipped to devices.

const W = 1920;
const H = 1080;

export const HOME_NAV = ['Home', 'Find', 'Live', 'Apps', 'Settings'];

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'SF Mono', Menlo, Consolas, monospace";

/**
 * @param {object} s  device runtime snapshot (scene, focus, apps, lane, tier, overlay, perf...)
 * @param {{ now?: number, w?: number }} opts
 */
export function renderScreen(s, { now = Date.now(), w = 960 } = {}) {
  const width = Math.max(160, Math.min(1920, Math.round(w)));
  const height = Math.round((width * 9) / 16);
  let body;
  if (!s.screenOn) body = `<rect width="${W}" height="${H}" fill="#020203"/>`;
  else if (s.scene === 'game') body = game(s, now);
  else if (s.scene === 'app') body = splash(s, now);
  else body = home(s, now);
  if (s.screenOn) body += overlays(s, now);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${W} ${H}" ` +
    `font-family="${FONT}">${body}</svg>`
  );
}

/* ------------------------------------------------------------------ home */

function home(s, now) {
  const apps = s.apps || [];
  const focus = s.focus || { row: 1, col: 0 };
  const d = new Date(now);
  const clock = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const drift = Math.sin(now / 4000) * 30;

  let out = `
  <defs>
    <linearGradient id="hbg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0d1826"/><stop offset="1" stop-color="#060a10"/>
    </linearGradient>
    <radialGradient id="hglow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#1f4b6e" stop-opacity="0.55"/><stop offset="1" stop-color="#1f4b6e" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="hero" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b2a52"/><stop offset="0.55" stop-color="#c2410c"/><stop offset="1" stop-color="#fdba74"/>
    </linearGradient>
    <linearGradient id="heroFade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#050a14" stop-opacity="0.92"/><stop offset="0.6" stop-color="#050a14" stop-opacity="0.1"/>
    </linearGradient>
    ${apps
      .map(
        (a, i) => `<linearGradient id="t${i}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${a.color[0]}"/><stop offset="1" stop-color="${a.color[1]}"/></linearGradient>`,
      )
      .join('')}
    <clipPath id="heroClip"><rect x="96" y="150" width="1728" height="420" rx="22"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#hbg)"/>
  <circle cx="${1450 + drift}" cy="220" r="620" fill="url(#hglow)"/>`;

  // top navigation
  let x = 96;
  HOME_NAV.forEach((label, i) => {
    const wv = label.length * 19 + 56;
    const on = focus.row === 0 && focus.col === i;
    if (on) out += `<rect x="${x}" y="52" width="${wv}" height="60" rx="30" fill="#f4f7fb"/>`;
    out += `<text x="${x + wv / 2}" y="92" text-anchor="middle" font-size="30" font-weight="${on ? 700 : 500}" fill="${on ? '#0b1220' : '#b7c3d1'}">${label}</text>`;
    x += wv + 14;
  });
  out += `<text x="1824" y="93" text-anchor="end" font-size="32" font-weight="500" fill="#dfe6ee">${esc(clock)}</text>`;
  out += wifi(1660, 70);

  // hero banner (sunset over hills)
  out += `<g clip-path="url(#heroClip)">
    <rect x="96" y="150" width="1728" height="420" fill="url(#hero)"/>
    <circle cx="${1380 + drift * 0.6}" cy="420" r="120" fill="#ffe0b2" opacity="0.9"/>
    <path d="M96 520 L420 430 L700 500 L980 400 L1300 490 L1560 410 L1824 470 L1824 570 L96 570Z" fill="#3b1a2e" opacity="0.75"/>
    <path d="M96 560 L380 500 L760 545 L1100 480 L1500 540 L1824 500 L1824 570 L96 570Z" fill="#1a0f1f"/>
    <rect x="96" y="150" width="1728" height="420" fill="url(#heroFade)"/>
  </g>
  <text x="160" y="250" font-size="24" letter-spacing="5" font-weight="700" fill="#fdba74">FEATURED · NEW BUILD</text>
  <text x="160" y="330" font-size="76" font-weight="800" fill="#ffffff">FireLab Web Game</text>
  <text x="160" y="385" font-size="30" fill="#d6dde6">A tiny WebGL racer that tunes itself to your TV.</text>
  <rect x="160" y="430" width="230" height="64" rx="32" fill="#ffffff"/>
  <text x="275" y="472" text-anchor="middle" font-size="28" font-weight="700" fill="#0b1220">Play now</text>`;

  // app rows
  out += `<text x="96" y="650" font-size="32" font-weight="700" fill="#eef2f6">Your apps &amp; games</text>`;
  const tw = 300;
  const th = 170;
  const gap = 34;
  apps.forEach((a, i) => {
    const tx = 96 + i * (tw + gap);
    const ty = 680;
    const on = focus.row === 1 && focus.col === i;
    const sc = on ? 1.08 : 1;
    const cx = tx + tw / 2;
    const cy = ty + th / 2;
    out += `<g transform="translate(${cx} ${cy}) scale(${sc}) translate(${-cx} ${-cy})">`;
    if (on) out += `<rect x="${tx - 9}" y="${ty - 9}" width="${tw + 18}" height="${th + 18}" rx="20" fill="none" stroke="#ffffff" stroke-width="6"/>`;
    out += `<rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="14" fill="url(#t${i})"/>
      <text x="${tx + 26}" y="${ty + 92}" font-size="74" font-weight="800" fill="#ffffff" opacity="0.9">${esc((a.label || a.package)[0])}</text>
      <text x="${tx + 26}" y="${ty + th - 24}" font-size="26" font-weight="600" fill="#ffffff">${esc(a.label || a.package)}</text>
    </g>`;
  });
  out += `<text x="96" y="935" font-size="32" font-weight="700" fill="#eef2f6">Recently added</text>`;
  for (let i = 0; i < 6; i++) {
    const tx = 96 + i * (tw + gap);
    out += `<rect x="${tx}" y="965" width="${tw}" height="${th}" rx="14" fill="#16212e"/>
      <rect x="${tx + 24}" y="990" width="${120 + ((i * 37) % 90)}" height="16" rx="8" fill="#26364a"/>`;
  }
  return out;
}

function wifi(x, y) {
  return `<g transform="translate(${x} ${y})" fill="none" stroke="#dfe6ee" stroke-width="4" stroke-linecap="round">
    <path d="M0 10 Q22 -8 44 10"/><path d="M8 19 Q22 7 36 19"/><circle cx="22" cy="28" r="3" fill="#dfe6ee" stroke="none"/></g>`;
}

/* ------------------------------------------------------------------ game */

function game(s, now) {
  const t = (s.paused ? s.pausedAt || now : now) / 1000;
  const tier = s.tier || 'tv';
  const low = tier === 'low';
  const rich = tier === 'tv-hd' || tier === 'high';
  const lane = typeof s.laneX === 'number' ? s.laneX : s.lane || 0;
  const hy = 640; // horizon
  let out = `
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#070b1f"/><stop offset="0.42" stop-color="#2b1d4a"/>
      <stop offset="0.56" stop-color="#d9480f"/><stop offset="0.6" stop-color="#ffb066"/>
    </linearGradient>
    <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff1c1"/><stop offset="1" stop-color="#ff7a2f"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a0f24"/><stop offset="1" stop-color="#07050c"/>
    </linearGradient>
    <linearGradient id="road" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a1d36"/><stop offset="1" stop-color="#110b18"/>
    </linearGradient>
    <clipPath id="sunClip"><rect x="0" y="0" width="${W}" height="${hy}"/></clipPath>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
  </defs>
  <rect width="${W}" height="${hy}" fill="url(#sky)"/>`;

  // stars
  if (!low) {
    for (let i = 0; i < 40; i++) {
      const sx = (i * 431) % W;
      const sy = (i * 197) % 360;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.3 + i));
      out += `<circle cx="${sx}" cy="${sy}" r="${i % 5 === 0 ? 3 : 2}" fill="#ffffff" opacity="${(tw * 0.7).toFixed(2)}"/>`;
    }
  }
  // sun with retro stripes
  out += `<g clip-path="url(#sunClip)">`;
  if (rich) out += `<circle cx="960" cy="520" r="250" fill="#ff8a3d" opacity="0.45" filter="url(#glow)"/>`;
  out += `<circle cx="960" cy="520" r="210" fill="url(#sun)"/>`;
  for (let i = 0; i < 7; i++) {
    const y = 470 + i * 26;
    out += `<rect x="740" y="${y}" width="440" height="${4 + i * 2}" fill="#2b1d4a" opacity="0.9"/>`;
  }
  out += `</g>`;
  // mountains
  out += `<path d="M0 ${hy} L0 520 L180 470 L330 540 L520 430 L700 560 L820 520 L860 ${hy}Z" fill="#251538"/>
    <path d="M1060 ${hy} L1110 520 L1260 450 L1420 540 L1600 440 L1780 520 L1920 480 L1920 ${hy}Z" fill="#251538"/>`;
  if (!low) {
    out += `<path d="M0 ${hy} L120 560 L260 600 L420 540 L600 610 L760 ${hy}Z" fill="#170c25"/>
      <path d="M1160 ${hy} L1320 590 L1500 550 L1690 600 L1920 560 L1920 ${hy}Z" fill="#170c25"/>`;
  }
  // ground + perspective grid
  out += `<rect x="0" y="${hy}" width="${W}" height="${H - hy}" fill="url(#ground)"/>`;
  if (!low) {
    const speed = 0.9;
    for (let i = 0; i < 16; i++) {
      const z = (((i / 16 + t * speed * 0.25) % 1) + 1) % 1;
      const y = hy + Math.pow(z, 2.3) * (H - hy);
      out += `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="#ff7a2f" stroke-opacity="${(0.12 + z * 0.5).toFixed(2)}" stroke-width="${(1 + z * 3).toFixed(1)}"/>`;
    }
    for (let k = -12; k <= 12; k++) {
      out += `<line x1="${960 + k * 14}" y1="${hy}" x2="${960 + k * 200}" y2="${H}" stroke="#ff7a2f" stroke-opacity="0.28" stroke-width="2"/>`;
    }
  }
  // road
  out += `<path d="M900 ${hy} L1020 ${hy} L1640 ${H} L280 ${H}Z" fill="url(#road)"/>
    <path d="M900 ${hy} L280 ${H}" stroke="#ffb066" stroke-width="6"/><path d="M1020 ${hy} L1640 ${H}" stroke="#ffb066" stroke-width="6"/>`;
  // lane dashes
  for (const lx of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      const z0 = (((i / 9 + t * 0.55) % 1) + 1) % 1;
      const z1 = Math.min(1, z0 + 0.045);
      const y0 = hy + Math.pow(z0, 2.2) * (H - hy);
      const y1 = hy + Math.pow(z1, 2.2) * (H - hy);
      const x0 = 960 + lx * (20 + Math.pow(z0, 2.2) * 400) * 0.5;
      const x1 = 960 + lx * (20 + Math.pow(z1, 2.2) * 400) * 0.5;
      out += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#ffe6c7" stroke-width="${(2 + z0 * 10).toFixed(1)}" stroke-linecap="round"/>`;
    }
  }
  // roadside posts
  if (rich) {
    for (let i = 0; i < 6; i++) {
      const z = (((i / 6 + t * 0.55) % 1) + 1) % 1;
      const p = Math.pow(z, 2.2);
      const y = hy + p * (H - hy);
      const off = 80 + p * 760;
      const hgt = 10 + p * 120;
      for (const sgn of [-1, 1]) {
        const px = 960 + sgn * off;
        out += `<rect x="${(px - 3 - p * 6).toFixed(1)}" y="${(y - hgt).toFixed(1)}" width="${(6 + p * 12).toFixed(1)}" height="${hgt.toFixed(1)}" fill="#ffd2a1" opacity="${(0.3 + z * 0.6).toFixed(2)}"/>`;
      }
    }
  }
  // the car (rear view)
  const cx = 960 + lane * 300;
  const bob = Math.sin(t * 9) * 3;
  const cy = 905 + bob;
  if (rich) out += `<ellipse cx="${cx}" cy="${cy + 92}" rx="190" ry="26" fill="#000" opacity="0.55"/>`;
  out += `<g transform="translate(${cx} ${cy})">
    <path d="M-120 -70 L-80 -128 L80 -128 L120 -70Z" fill="#1d2a48"/>
    <path d="M-96 -76 L-66 -118 L66 -118 L96 -76Z" fill="#7cc4ff" opacity="0.55"/>
    <rect x="-170" y="-76" width="340" height="120" rx="26" fill="#e8edf4"/>
    <rect x="-170" y="-10" width="340" height="18" fill="#c7d0dc"/>
    <rect x="-150" y="-52" width="86" height="28" rx="8" fill="#ff3b30"/>
    <rect x="64" y="-52" width="86" height="28" rx="8" fill="#ff3b30"/>
    ${rich ? `<rect x="-160" y="-60" width="106" height="44" rx="14" fill="#ff3b30" opacity="0.55" filter="url(#glow)"/><rect x="54" y="-60" width="106" height="44" rx="14" fill="#ff3b30" opacity="0.55" filter="url(#glow)"/>` : ''}
    <rect x="-56" y="10" width="112" height="24" rx="4" fill="#0b1220"/>
    <text x="0" y="29" text-anchor="middle" font-family="${MONO}" font-size="18" font-weight="700" fill="#e8edf4">FIRE·LAB</text>
    <rect x="-160" y="40" width="54" height="30" rx="6" fill="#0b0f14"/><rect x="106" y="40" width="54" height="30" rx="6" fill="#0b0f14"/>
  </g>`;

  // HUD: score
  const score = Math.floor(((s.scoreBase || 0) + t * 37) % 1000000);
  const lapT = t % 84;
  out += `<g>
    <rect x="48" y="40" width="380" height="124" rx="14" fill="#000" opacity="0.38"/>
    <text x="76" y="84" font-size="22" letter-spacing="4" font-weight="700" fill="#ffcf9c">SCORE</text>
    <text x="76" y="140" font-family="${MONO}" font-size="54" font-weight="700" fill="#ffffff">${String(score).padStart(7, '0')}</text>
    <text x="398" y="84" text-anchor="end" font-family="${MONO}" font-size="22" fill="#ffffffaa">LAP 2/3</text>
    <text x="398" y="140" text-anchor="end" font-family="${MONO}" font-size="22" fill="#ffffffaa">${Math.floor(lapT / 60)}:${(lapT % 60).toFixed(1).padStart(4, '0')}</text>
  </g>`;

  // on-screen meter, as drawn by @firelab/perf
  out += perfMeter(s);

  if (s.paused) {
    out += `<rect width="${W}" height="${H}" fill="#05060a" opacity="0.6"/>
      <text x="960" y="540" text-anchor="middle" font-size="110" font-weight="800" letter-spacing="10" fill="#ffffff">PAUSED</text>
      <text x="960" y="610" text-anchor="middle" font-size="32" fill="#cfd6df">Press play/pause to resume</text>`;
  }
  return out;
}

function perfMeter(s) {
  const p = s.perf || {};
  const fps = p.fps ?? 0;
  const col = fps >= 29 ? '#5cf2a8' : fps >= 24 ? '#ffd166' : '#ff6b5e';
  const hist = (s.fpsHistory || []).slice(-40);
  let spark = '';
  if (hist.length > 1) {
    const pts = hist
      .map((v, i) => `${(1580 + (i / (hist.length - 1)) * 270).toFixed(1)},${(150 - Math.min(60, v) * 0.6).toFixed(1)}`)
      .join(' ');
    spark = `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="3" stroke-linejoin="round"/>`;
  }
  return `<g>
    <rect x="1556" y="40" width="318" height="134" rx="14" fill="#000" opacity="0.55"/>
    <text x="1580" y="100" font-family="${MONO}" font-size="56" font-weight="700" fill="${col}">${fps.toFixed(0)}</text>
    <text x="${1580 + String(fps.toFixed(0)).length * 34 + 10}" y="100" font-family="${MONO}" font-size="22" font-weight="700" fill="${col}">FPS</text>
    <text x="1850" y="74" text-anchor="end" font-family="${MONO}" font-size="20" fill="#ffffffcc">${esc(s.tier || 'tv')}</text>
    <text x="1850" y="100" text-anchor="end" font-family="${MONO}" font-size="20" fill="#ffffff99">×${(p.scale ?? 1).toFixed(2)}</text>
    <line x1="1580" y1="132" x2="1850" y2="132" stroke="#ffffff22"/>
    ${spark}
  </g>`;
}

/* --------------------------------------------------------------- splash */

function splash(s, now) {
  const a = (s.apps || []).find((x) => x.package === s.app) || { label: s.app || 'App', color: ['#334155', '#0f172a'] };
  const ang = ((now / 4) % 360).toFixed(1);
  return `<defs><linearGradient id="sp" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${a.color[0]}"/><stop offset="1" stop-color="${a.color[1]}"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#sp)"/>
    <rect width="${W}" height="${H}" fill="#000" opacity="0.25"/>
    <circle cx="960" cy="440" r="130" fill="#ffffff" opacity="0.14"/>
    <text x="960" y="482" text-anchor="middle" font-size="130" font-weight="800" fill="#ffffff">${esc((a.label || '?')[0])}</text>
    <text x="960" y="660" text-anchor="middle" font-size="56" font-weight="700" fill="#ffffff">${esc(a.label || a.package)}</text>
    <g transform="translate(960 790) rotate(${ang})"><circle r="34" fill="none" stroke="#ffffff33" stroke-width="8"/>
      <path d="M0 -34 A34 34 0 0 1 34 0" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/></g>`;
}

/* ------------------------------------------------------------- overlays */

function overlays(s, now) {
  const o = s.overlay || {};
  let out = '';
  if (o.volume && o.volume.until > now) {
    const lv = o.volume.level;
    const muted = o.volume.muted;
    out += `<g><rect x="1736" y="300" width="96" height="480" rx="48" fill="#0b0f14" opacity="0.85"/>
      <rect x="1772" y="${340 + (1 - lv / 15) * 340}" width="24" height="${(lv / 15) * 340}" rx="12" fill="${muted ? '#6b7280' : '#ffffff'}"/>
      <text x="1784" y="740" text-anchor="middle" font-size="30" font-weight="700" fill="#ffffff">${muted ? 'MUTE' : lv}</text></g>`;
  }
  if (o.menu && o.menu.until > now) {
    const items = ['Resume', 'Restart lap', `Quality: ${s.tier || 'tv'}`, 'Show FPS meter', 'Exit to home'];
    out += `<g><rect x="1340" y="200" width="520" height="${100 + items.length * 84}" rx="20" fill="#0b0f14" opacity="0.92"/>
      <text x="1380" y="262" font-size="26" letter-spacing="4" font-weight="700" fill="#9aa7b6">OPTIONS</text>`;
    items.forEach((it, i) => {
      if (i === 0) out += `<rect x="1364" y="${290 + i * 84}" width="472" height="70" rx="12" fill="#ffffff"/>`;
      out += `<text x="1392" y="${336 + i * 84}" font-size="32" font-weight="${i === 0 ? 700 : 500}" fill="${i === 0 ? '#0b1220' : '#e5e9ee'}">${esc(it)}</text>`;
    });
    out += `</g>`;
  }
  if (o.search && o.search.until > now) {
    out += `<g><rect x="360" y="60" width="1200" height="96" rx="48" fill="#f4f7fb"/>
      <circle cx="430" cy="106" r="20" fill="none" stroke="#0b1220" stroke-width="6"/><line x1="445" y1="121" x2="462" y2="138" stroke="#0b1220" stroke-width="6" stroke-linecap="round"/>
      <text x="490" y="120" font-size="38" fill="${o.search.text ? '#0b1220' : '#7b8794'}">${esc(o.search.text || 'Search apps, games and more')}</text></g>`;
  }
  if (o.toast && o.toast.until > now) {
    out += `<g><rect x="660" y="930" width="600" height="84" rx="42" fill="#0b0f14" opacity="0.88"/>
      <text x="960" y="984" text-anchor="middle" font-size="32" fill="#ffffff">${esc(o.toast.text)}</text></g>`;
  }
  return out;
}
