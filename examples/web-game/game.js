// Firefly Lake: a small three.js game that uses @firelab/perf end to end.
//
// - chip detection picks a quality tier (?q=low|tv|tv-hd|high forces one),
// - perf.pick() turns the tier into scene settings,
// - adaptive resolution holds 30 fps on TVs (60 on desktops),
// - the meter shows with ?perf=1 or a double tap of rewind (` on a keyboard),
// - window.firelab carries the numbers for the FireLab tester and sweep,
// - the busy scene (?busy=1, the ⏩ button, B, or demo.setBusy(true)) gives a
//   sweep something heavy to measure.
import * as THREE from 'three';
import { createPerf, createFrameLimiter, TIER_IDS } from '@firelab/perf';
import { createWorld, LANES } from './world.js';

// What each tier draws. pick() falls back to the nearest lighter tier.
const QUALITY = {
  low: { antialias: false, shadows: 0, trees: 140, fireflies: 120, water: [20, 40], boatLight: false, extraLights: 0, fog: 0.02 },
  tv: { antialias: false, shadows: 0, trees: 300, fireflies: 360, water: [36, 72], boatLight: false, extraLights: 0, fog: 0.016 },
  'tv-hd': { antialias: true, shadows: 1024, trees: 600, fireflies: 800, water: [56, 112], boatLight: true, extraLights: 0, fog: 0.014 },
  high: { antialias: true, shadows: 2048, trees: 1200, fireflies: 1800, water: [80, 160], boatLight: true, extraLights: 0, fog: 0.012 },
};
/** The busy scene: much more geometry, big shadows, extra lights, more particles. */
const busyOf = (q) => ({ ...q, trees: q.trees * 8, fireflies: q.fireflies * 4, shadows: 2048, water: [q.water[0] * 2, q.water[1] * 2], boatLight: true, extraLights: 4 });

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

// ?bugs=freeze,black,throw,trap,grid (or all) loads bugs.js: seeded bugs for
// FireLab's game-testing engine. A seeded build starts every launch from the
// same quality tier, so runs and replays are repeatable.
const bugList = params.get('bugs');
if (bugList) for (const k of ['firelab-tier', 'firelab-tier:fallback']) safeRemove(k);
/** Where bugs.js plugs in. Empty in the normal game. */
const hooks = {};

// ---------- performance ----------
const fpsParam = Number(params.get('fps')) || 0;
const p = createPerf({
  // TVs: a steady 30 (every other refresh) looks smoother than an uneven 40.
  targetFps: (tier) => fpsParam || (tier === 'high' ? 60 : 30),
});
const targetFps = p.targetFps;
const limiter = createFrameLimiter(params.get('cap') === '0' ? 0 : targetFps);

let busy = params.get('busy') === '1';
// ?autoplay=1: the game plays itself (for sweeps and demos) until a key is pressed.
let autopilotOn = params.get('autoplay') === '1';
const quality = () => (busy ? busyOf(p.pick(QUALITY)) : p.pick(QUALITY));

// No WebGL2 (e.g. the Mali-450 sticks): say so instead of failing.
if (p.detection.webgl < 2) {
  $('nogl').hidden = false;
  $('nogl-gpu').textContent = p.detection.gpu || 'unknown GPU';
  throw new Error('WebGL2 not available');
}

// ---------- renderer and world ----------
const renderer = new THREE.WebGLRenderer({ antialias: p.pick(QUALITY).antialias, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.type = THREE.PCFShadowMap;
$('stage').appendChild(renderer.domElement);
p.attach(renderer); // adaptive resolution drives renderer.setPixelRatio()

const world = createWorld(renderer, quality());
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  world.resize();
});

// ---------- game state ----------
const state = {
  mode: 'title', // title | playing | paused | over
  lane: 1,
  x: 0,
  y: 0,
  vy: 0,
  speed: 14,
  distance: 0,
  score: 0,
  lanterns: 0,
  best: Number(safeGet('firefly-best') || 0),
  spawnIn: 0,
  crashT: 0,
  time: 0,
};

function reset() {
  Object.assign(state, { lane: 1, x: 0, y: 0, vy: 0, speed: 14, distance: 0, score: 0, lanterns: 0, spawnIn: 1.2, crashT: 0 });
  for (const r of world.rocks) deactivate(r, r.mesh);
  for (const l of world.lanterns) deactivate(l, l.obj);
  world.boat.rotation.set(0, 0, 0);
}
function deactivate(item, obj) {
  item.active = false;
  obj.visible = false;
}

function spawnRow() {
  // One or two rocks, never all three lanes; lanterns in a free lane.
  const blocked = new Set([Math.floor(Math.random() * 3)]);
  if (Math.random() < 0.35 + Math.min(0.3, state.distance / 4000)) blocked.add(Math.floor(Math.random() * 3));
  if (blocked.size === 3) blocked.delete(1);
  const z = -130;
  for (const lane of blocked) {
    const r = world.rocks.find((x) => !x.active);
    if (!r) break;
    r.active = true;
    r.lane = lane;
    r.mesh.visible = true;
    r.mesh.position.set(LANES[lane], 0.15, z);
    r.mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    r.mesh.scale.setScalar(0.85 + Math.random() * 0.45);
  }
  const free = [0, 1, 2].filter((l) => !blocked.has(l));
  if (free.length && Math.random() < 0.85) {
    const lane = free[Math.floor(Math.random() * free.length)];
    for (let i = 0; i < 3; i++) {
      const l = world.lanterns.find((x) => !x.active);
      if (!l) break;
      l.active = true;
      l.lane = lane;
      l.obj.visible = true;
      l.obj.position.set(LANES[lane], 0.9, z - 6 - i * 4);
    }
  }
}

/** Title-screen autopilot: dodges rocks so the attract mode (and a sweep) shows real gameplay. */
function autopilot() {
  const ahead = (lane) => world.rocks.some((r) => r.active && r.lane === lane && r.mesh.position.z > -26 && r.mesh.position.z < 2);
  if (!ahead(state.lane)) return;
  const options = [state.lane - 1, state.lane + 1].filter((l) => l >= 0 && l <= 2 && !ahead(l));
  if (options.length) state.lane = options[0];
  else if (state.y === 0) jump();
}

function jump() {
  if (state.y === 0) state.vy = 9;
}

function update(dt) {
  state.time += dt;
  const playing = state.mode === 'playing';
  const moving = playing || state.mode === 'title';
  if (state.mode === 'title' || (playing && autopilotOn)) autopilot();
  let dz = 0;
  if (moving) {
    state.speed = Math.min(26, state.speed + dt * (playing ? 0.25 : 0));
    dz = state.speed * dt;
    state.distance += dz;
    state.spawnIn -= dt;
    if (state.spawnIn <= 0) {
      spawnRow();
      state.spawnIn = Math.max(0.55, 1.25 - state.distance / 3000) + Math.random() * 0.4;
    }
    // Boat: slide to the lane, jump arc, a little roll.
    state.x += (LANES[state.lane] - state.x) * Math.min(1, dt * 10);
    state.vy -= 26 * dt;
    state.y = Math.max(0, state.y + state.vy * dt);
    if (state.y === 0) state.vy = 0;
    world.boat.position.set(state.x, state.y + Math.sin(state.time * 2.2) * 0.06, 0);
    world.boat.rotation.z = (state.x - LANES[state.lane]) * 0.12 + Math.sin(state.time * 1.7) * 0.03;
    world.boat.rotation.x = state.vy * -0.02;
    // Move rocks and lanterns toward the camera; collide.
    for (const r of world.rocks) {
      if (!r.active) continue;
      r.mesh.position.z += dz;
      if (r.mesh.position.z > 12) deactivate(r, r.mesh);
      else if (Math.abs(r.mesh.position.z) < 1.1 && Math.abs(r.mesh.position.x - state.x) < 1.25 && state.y < 0.7) {
        if (playing && !autopilotOn) return crash();
        state.y = 0.01; // attract mode and autoplay: hop over instead
        state.vy = 9;
      }
    }
    for (const l of world.lanterns) {
      if (!l.active) continue;
      l.obj.position.z += dz;
      if (l.obj.position.z > 12) deactivate(l, l.obj);
      else if (Math.abs(l.obj.position.z) < 1.2 && Math.abs(l.obj.position.x - state.x) < 1.3 && Math.abs(l.obj.position.y - (state.y + 0.9)) < 1.3) {
        deactivate(l, l.obj);
        if (playing) {
          state.lanterns++;
          state.score += 10;
          pulse('hud-lanterns');
          hooks.lantern?.(state.lanterns);
        }
      }
    }
    if (playing) state.score += dz * 0.5;
  } else if (state.mode === 'over') {
    state.crashT += dt;
    world.boat.rotation.z = Math.min(0.9, state.crashT * 2);
    world.boat.position.y = -Math.min(0.5, state.crashT * 0.6);
  }
  world.tick(state.time, dz, renderer.getPixelRatio());
}

function crash() {
  state.mode = 'over';
  state.crashT = 0;
  const score = Math.floor(state.score);
  if (score > state.best) {
    state.best = score;
    safeSet('firefly-best', String(score));
  }
  $('over-score').textContent = String(score);
  $('over-best').textContent = String(state.best);
  showScreen('over');
  p.mark('scene', 'over');
}

// ---------- screens and menu ----------
function showScreen(id) {
  for (const s of ['title', 'menu', 'over']) $(s).hidden = s !== id;
  $('hud').hidden = !(id === null || id === 'menu') || state.mode === 'title';
}

const menuItems = [
  { id: 'resume', label: () => 'Resume', run: () => resume() },
  { id: 'busy', label: () => `Busy scene: ${busy ? 'on' : 'off'}`, run: () => setBusy(!busy) },
  { id: 'quality', label: () => `Quality: ${p.source === 'auto' || p.source === 'fallback' ? `auto (${p.tier})` : p.tier}`, run: (dir = 1) => cycleQuality(dir) },
  { id: 'meter', label: () => `Perf meter: ${p.meter.visible ? 'on' : 'off'}`, run: () => p.meter.toggle() },
  { id: 'quit', label: () => 'Back to title', run: () => toTitle() },
];
let menuIndex = 0;
function renderMenu() {
  const list = $('menu-list');
  list.replaceChildren(
    ...menuItems.map((it, i) => {
      const li = document.createElement('li');
      li.textContent = it.label();
      li.className = i === menuIndex ? 'focused' : '';
      if (it.id === 'quality') li.classList.add('cycle');
      return li;
    }),
  );
  hooks.renderMenu?.(list);
}
function openMenu() {
  state.mode = 'paused';
  menuIndex = 0;
  renderMenu();
  showScreen('menu');
  p.pause('menu'); // the frozen world under a menu is not representative gameplay
  p.mark('scene', 'menu');
}
function resume() {
  hooks.resume?.();
  state.mode = 'playing';
  showScreen(null);
  p.resume('menu');
  p.mark('scene', 'playing');
}
function startGame() {
  reset();
  state.mode = 'playing';
  showScreen(null);
  p.resume('menu');
  p.mark('scene', 'playing');
}
function toTitle() {
  reset();
  state.mode = 'title';
  showScreen('title');
  p.resume('menu');
  p.mark('scene', 'title');
}

function cycleQuality(dir) {
  const order = ['auto', ...TIER_IDS];
  const now = p.source === 'auto' || p.source === 'fallback' ? 'auto' : p.tier;
  const next = order[(order.indexOf(now) + dir + order.length) % order.length];
  p.setTier(next); // persists; fires 'tier', which rebuilds the scene below
  renderMenu();
}
p.on('tier', ({ tier }) => {
  world.applyQuality(quality());
  updateBadge();
  toast(`Quality: ${tier}${p.pick(QUALITY).antialias !== renderer.getContextAttributes().antialias ? ' (edge smoothing changes on restart)' : ''}`);
});

function setBusy(on) {
  busy = on;
  world.applyQuality(quality());
  p.mark('busy', busy);
  updateBadge();
  if (state.mode === 'paused') renderMenu();
  toast(busy ? 'Busy scene: 8× trees, 2048 shadows, 4 extra lights' : 'Busy scene off');
}

p.on('fallback', ({ from, to, persisted }) => {
  if (busy) {
    // The busy scene is a stress test, not the real game: don't let it
    // lower the tier for the next launch.
    if (persisted) p.clearFallback();
    toast(`The busy scene is too heavy for "${from}" here: a real game would drop to "${to}".`);
  } else if (persisted) toast(`"${from}" is too heavy for this device: "${to}" from the next launch.`);
  else toast(`"${from}" can't hold ${targetFps} fps here even at the lowest resolution: "${to}" would.`);
});

// ---------- input: D-pad, OK, Back, media keys ----------
const KEYS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  Enter: 'ok', ' ': 'ok', Escape: 'back', Backspace: 'back', GoBack: 'back', BrowserBack: 'back',
  ContextMenu: 'menu', MediaPlayPause: 'playpause', MediaFastForward: 'busy', b: 'busy', B: 'busy', m: 'menu', p: 'playpause',
};
const KEYCODES = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 27: 'back', 8: 'back', 461: 'back', 10009: 'back', 93: 'menu', 179: 'playpause', 228: 'busy', 417: 'busy' };

addEventListener('keydown', (e) => {
  const action = KEYS[e.key] || KEYCODES[e.keyCode];
  if (!action) return;
  if (hooks.key?.(action, e.repeat) === true) return e.preventDefault();
  const handled = handle(action, e.repeat);
  if (handled) e.preventDefault(); // Back at the title is not handled: the TV app may exit
});

function handle(action, repeat) {
  if (autopilotOn && state.mode === 'playing' && action !== 'busy') autopilotOn = false; // a player took over
  if (action === 'busy') {
    if (!repeat) setBusy(!busy);
    return true;
  }
  switch (state.mode) {
    case 'title':
      if (action === 'ok' || action === 'playpause') return startGame(), true;
      if (action === 'menu') return openMenu(), true;
      return false;
    case 'playing':
      if (action === 'left') state.lane = Math.max(0, state.lane - 1);
      else if (action === 'right') state.lane = Math.min(2, state.lane + 1);
      else if (action === 'up' || action === 'ok') jump();
      else if (action === 'back' || action === 'menu' || action === 'playpause') openMenu();
      else return false;
      return true;
    case 'paused':
      if (action === 'up') menuIndex = (menuIndex + menuItems.length - 1) % menuItems.length;
      else if (action === 'down') menuIndex = (menuIndex + 1) % menuItems.length;
      else if (action === 'left' && menuItems[menuIndex].id === 'quality') menuItems[menuIndex].run(-1);
      else if (action === 'right' && menuItems[menuIndex].id === 'quality') menuItems[menuIndex].run(1);
      else if (action === 'ok') menuItems[menuIndex].run();
      else if (action === 'back' || action === 'menu' || action === 'playpause') resume();
      else return true;
      if (state.mode === 'paused') renderMenu();
      return true;
    case 'over':
      if (action === 'ok') return startGame(), true;
      if (action === 'back' || action === 'menu') return toTitle(), true;
      return true;
  }
  return false;
}

// ---------- HUD ----------
function updateBadge() {
  const src = p.source === 'auto' ? 'auto' : p.source;
  $('badge-tier').textContent = `${p.tier} · ${src}`;
  $('badge-gpu').textContent = p.detection.gpu || 'GPU hidden';
  $('badge-busy').hidden = !busy;
}
function pulse(id) {
  const el = $(id);
  el.classList.remove('pulse');
  void el.offsetWidth; // restart the animation (only on a pickup, never per frame)
  el.classList.add('pulse');
}
let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
let hudScore = -1;
let hudLanterns = -1;
function drawHud() {
  // Touch the DOM only when a number changes.
  const s = Math.floor(state.score);
  if (s !== hudScore) $('hud-score').textContent = String((hudScore = s));
  if (state.lanterns !== hudLanterns) $('hud-lanterns').textContent = String((hudLanterns = state.lanterns));
}

// ---------- main loop ----------
let last = 0;
renderer.setAnimationLoop((t) => {
  if (!limiter.ready(t)) return;
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 1 / targetFps;
  last = t;
  update(dt);
  renderer.render(world.scene, world.camera);
  p.frame(); // after rendering: counts this frame for fps, adaptive resolution and window.firelab
  if (state.mode === 'playing') drawHud();
});

// ---------- start ----------
updateBadge();
$('best').textContent = String(state.best);
p.mark('scene', 'title');
p.mark('busy', busy);
toTitle();
if (params.get('autoplay') === '1') startGame();
$('loading').remove();

// A small handle for FireLab sweeps and the console.
window.demo = {
  perf: p,
  get busy() {
    return busy;
  },
  setBusy,
  start: startGame,
  title: toTitle,
  menu: openMenu,
  get state() {
    return { ...state };
  },
  /** The small UI state FireLab's engine keys states on: `firelab explore --state-expr demo.ui`. */
  get ui() {
    return { mode: state.mode, item: state.mode === 'paused' ? menuItems[menuIndex].id : null, lanterns: Math.min(state.lanterns, 9) };
  },
};

if (bugList) {
  import('./bugs.js')
    .then((m) => m.install({ state, menuItems, menu: { get index() { return menuIndex; }, set index(i) { menuIndex = i; } }, renderMenu, renderer, perf: p, hooks, $ }, bugList))
    .catch((e) => console.error('bugs.js failed to load', e));
}

function safeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeRemove(k) {
  try {
    localStorage.removeItem(k);
  } catch {
    /* private mode */
  }
}
function safeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}
