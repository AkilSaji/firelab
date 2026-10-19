// Seeded bugs for FireLab's game-testing engine (docs/ENGINE.md 12.4).
//
// Loaded only with ?bugs=<list> (game.js); the normal game never imports this
// file. Each bug mirrors a kind of bug real TV games ship with:
//
//   freeze  after the 2nd lantern of a run, the render loop is not rescheduled
//           (the picture freezes; window.firelab still says "not paused")
//   black   OK again within 300 ms of choosing Resume blanks the screen
//           (Sunset Villa's "two episodes started at once" black screen)
//   throw   in the pause menu, ◀ on Quality after ▶ on it throws a TypeError
//   trap    once focus has visited Quality, ▲▼ only cycle Busy/Quality/Meter
//           and Back does nothing (a D-pad focus trap)
//   grid    the menu is drawn in two columns with a 6th "Credits" cell, but
//           ▲▼ still move ±1 in list order and wrap before Credits (moves
//           that ignore the layout, and a cell the D-pad can never reach)
//
//   ?bugs=all  turns all five on.
//
// Ground truth for benchmarks: window.firelabBugsHit[id] is the time (ms since
// page load) a bug first fired, whoever drove the game (FireLab, Monkey, a
// person). A tester is scored on what it reported, not on this.
export const BUGS = ['freeze', 'black', 'throw', 'trap', 'grid'];

const hit = (id) => {
  const h = (window.firelabBugsHit ??= {});
  if (h[id] === undefined) h[id] = Math.round(performance.now());
};

export function install(api, list) {
  const on = new Set(String(list).split(',').map((s) => s.trim()).filter(Boolean));
  if (on.has('all')) for (const b of BUGS) on.add(b);
  const { state, menuItems, menu, renderMenu, renderer, hooks, $ } = api;
  const keyHooks = [];
  const current = () => menuItems[menu.index]?.id;

  if (on.has('freeze')) {
    hooks.lantern = (n) => {
      if (n >= 2) {
        hit('freeze');
        renderer.setAnimationLoop(null); // the bug: the loop is never rescheduled
      }
    };
  }

  if (on.has('black')) {
    let resumedAt = -Infinity;
    hooks.resume = () => {
      resumedAt = performance.now();
    };
    keyHooks.push((action) => {
      if (action === 'ok' && state.mode === 'playing' && performance.now() - resumedAt < 300) {
        for (const id of ['stage', 'hud', 'badge', 'toast']) {
          const el = $(id);
          if (el) el.style.visibility = 'hidden';
        }
        document.body.style.background = '#000';
        hit('black');
      }
      return false;
    });
  }

  if (on.has('throw')) {
    let turned = false;
    keyHooks.push((action) => {
      if (state.mode !== 'paused') return false;
      if (current() !== 'quality') {
        turned = false;
        return false;
      }
      if (action === 'right') turned = true;
      else if (action === 'left' && turned) {
        hit('throw');
        const previous = menuItems.find((it) => it.id === 'quality-previous');
        return previous.label() === ''; // TypeError: Cannot read properties of undefined (reading 'label')
      }
      return false;
    });
  }

  if (on.has('trap')) {
    let visited = false;
    const ring = ['busy', 'quality', 'meter'];
    keyHooks.push((action) => {
      if (state.mode !== 'paused') {
        visited = false;
        return false;
      }
      if (current() === 'quality') visited = true;
      if (!visited) return false;
      if (action === 'up' || action === 'down' || action === 'back') hit('trap');
      if (action === 'up' || action === 'down') {
        const at = Math.max(0, ring.indexOf(current()));
        const next = ring[(at + (action === 'down' ? 1 : -1) + ring.length) % ring.length];
        menu.index = menuItems.findIndex((it) => it.id === next);
        renderMenu();
        return true;
      }
      return action === 'back' || action === 'menu' || action === 'playpause'; // swallowed: Back does nothing
    });
  }

  if (on.has('grid')) {
    const style = document.createElement('style');
    style.textContent =
      '#menu-list.grid{display:grid;grid-template-columns:1fr 1fr;gap:.4em;min-width:34em}' +
      '#menu-list.grid li{white-space:nowrap}';
    document.head.appendChild(style);
    hooks.renderMenu = (list) => {
      list.classList.add('grid');
      const credits = document.createElement('li');
      credits.textContent = 'Credits';
      list.appendChild(credits); // drawn, but ▲▼ wrap over the first five items only
      hit('grid');
    };
    if (state.mode === 'paused') renderMenu();
  }

  if (keyHooks.length) hooks.key = (action, repeat) => keyHooks.some((h) => h(action, repeat) === true);
  window.firelabBugs = [...on].filter((b) => BUGS.includes(b));
  console.info(`[firefly-lake] seeded bugs on: ${window.firelabBugs.join(', ') || 'none'}`);
}
