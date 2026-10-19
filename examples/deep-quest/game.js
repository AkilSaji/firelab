// Deep Quest: a small TV RPG made as a depth benchmark for FireLab's engine.
//
// Everything is driven by the remote (arrows, Enter = OK, Escape = Back): a
// title screen with nested options dialogs, a town with a shop, an inn with
// save slots and a quest board, and a 30-floor dungeon. Each floor has an
// antechamber and three doors; the wrong door sends you back to the last camp
// (every 5th floor), as roguelike checkpoints do. Floors 5, 10, ... have a
// chest dialog. Reaching floor 30 takes about 100 key presses from launch.
//
// ?bugs=all (or a list) seeds six bugs at increasing depth (key presses from
// launch, roughly):
//
//   options   ~9   Options > Video > High > Apply, then Controls > Remap > OK throws a TypeError
//   shop      ~12  buying the Key, then resting at the inn blanks the screen (black)
//   inn       ~16  saving to slot 3 twice traps the focus in the overwrite dialog (Back does nothing)
//   chest     ~40  taking the floor-10 chest's loot while carrying the Key throws
//   freeze    ~70  the middle door on floor 20 stops the render loop (the picture freezes)
//   boss      ~100 defending three times in a row against the floor-30 boss throws on every frame
//
// Ground truth for benchmarks: window.firelabBugsHit[id] = ms since load when a
// bug first fired; window.firelabDepth = deepest floor and dialog depth reached.
// The FireLab hook (window.firelab) publishes the scene and the focused control.

const params = new URLSearchParams(location.search);
const BUGS = ['options', 'shop', 'inn', 'chest', 'freeze', 'boss'];
const bugs = new Set((params.get('bugs') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
if (bugs.has('all')) for (const b of BUGS) bugs.add(b);
window.firelabBugs = BUGS.filter((b) => bugs.has(b));
window.firelabBugsHit = {};
window.firelabDepth = { floor: 0, dialogs: 0 };
const hit = (id) => {
  if (window.firelabBugsHit[id] === undefined) window.firelabBugsHit[id] = Math.round(performance.now());
};

const FLOORS = 30;
/** The right door on a floor: 0 left, 1 middle, 2 right (fixed, so a run can learn it). */
const rightDoor = (f) => (f * 5 + 2) % 3;
const ITEMS = [
  { id: 'potion', name: 'Potion', price: 10 },
  { id: 'ether', name: 'Ether', price: 25 },
  { id: 'key', name: 'Old key', price: 50 },
  { id: 'map', name: 'Dungeon map', price: 80 },
];

const game = {
  gold: 100,
  inventory: [],
  quality: 'medium',
  appliedHigh: false,
  floor: 0,
  camp: 1,
  saves: {},
  slot3Saves: 0,
  defends: 0,
  bossHp: 3,
  quests: [],
};

// ---------- screens ----------
// A screen: { id, title, text, buttons: [{ label, act }], layout: 'col' | 'row', back() }.
// The stack holds the town/dungeon screen at the bottom and dialogs above it.

const stack = [];
let focus = 0;

const $ = (id) => document.getElementById(id);
const scene = () => stack[stack.length - 1];

function push(s) {
  stack.push(s);
  focus = s.focus ?? 0;
  window.firelabDepth.dialogs = Math.max(window.firelabDepth.dialogs, stack.length);
  render();
}
function pop() {
  if (stack.length > 1) stack.pop();
  focus = 0;
  render();
}
function replace(s) {
  stack.length = 0;
  push(s);
}

function dialog(title, text, buttons, extra = {}) {
  return { id: `dialog-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, title, text, buttons, layout: 'row', dialog: true, back: pop, ...extra };
}
const ok = (title, text, then = pop) => push(dialog(title, text, [{ label: 'OK', act: then }]));
const confirm = (title, text, yes, no = pop) => push(dialog(title, text, [{ label: 'Yes', act: yes }, { label: 'No', act: no }]));

// ---------- title and options ----------

function title() {
  return {
    id: 'title',
    title: 'Deep Quest',
    text: 'A FireLab depth benchmark',
    layout: 'col',
    buttons: [
      { label: 'New game', act: () => replace(town()) },
      { label: 'Options', act: () => push(options()) },
      { label: 'Credits', act: () => push(dialog('Credits', 'Made for FireLab. MIT licence.', [{ label: 'Close', act: pop }])) },
    ],
    back: () => {},
  };
}

function options() {
  return {
    id: 'options',
    title: 'Options',
    layout: 'col',
    dialog: true,
    buttons: [
      { label: 'Audio', act: () => push(dialog('Audio', 'Music and effects', [{ label: 'Loud', act: pop }, { label: 'Quiet', act: pop }])) },
      { label: `Video (${game.quality})`, act: () => push(video()) },
      { label: 'Controls', act: () => push(controls()) },
      { label: 'Close', act: pop },
    ],
    back: pop,
  };
}

function video() {
  const pick = (q) => () =>
    confirm('Apply video settings', `Switch to ${q} quality?`, () => {
      game.quality = q;
      if (q === 'high') game.appliedHigh = true;
      stack.length = Math.max(1, stack.length - 2);
      render();
    });
  return { id: 'video', title: 'Video', layout: 'row', dialog: true, buttons: ['low', 'medium', 'high'].map((q) => ({ label: q, act: pick(q) })), back: pop };
}

function controls() {
  return {
    id: 'controls',
    title: 'Controls',
    layout: 'col',
    dialog: true,
    buttons: [
      {
        label: 'Remap',
        act: () =>
          push(
            dialog('Remap', 'Press OK to remap the OK button', [
              {
                label: 'OK',
                act: () => {
                  if (bugs.has('options') && game.appliedHigh) {
                    const preset = { low: { ok: 'Enter' }, medium: { ok: 'Enter' } }[game.quality];
                    if (!preset) hit('options');
                    console.log(preset.ok); // TypeError while the high preset (no remap table) is on
                  }
                  pop();
                },
              },
            ]),
          ),
      },
      { label: 'Back', act: pop },
    ],
    back: pop,
  };
}

// ---------- town ----------

function town() {
  return {
    id: 'town',
    title: 'Town',
    text: () => `Gold ${game.gold} · ${game.inventory.map((i) => i.name).join(', ') || 'empty bag'}`,
    layout: 'col',
    buttons: [
      { label: 'Shop', act: () => push(shop()) },
      { label: 'Inn', act: () => push(inn()) },
      { label: 'Quest board', act: () => push(quests()) },
      { label: 'Dungeon', act: () => enterFloor(game.camp) },
      { label: 'Save and quit', act: () => confirm('Quit', 'Back to the title screen?', () => replace(title())) },
    ],
    back: () => confirm('Quit', 'Back to the title screen?', () => replace(title())),
  };
}

function shop() {
  return {
    id: 'shop',
    title: 'Shop',
    text: () => `Gold ${game.gold}`,
    layout: 'col',
    dialog: true,
    buttons: [
      ...ITEMS.map((it) => ({
        label: `${it.name} (${it.price} g)`,
        act: () =>
          game.gold < it.price
            ? ok('Not enough gold', `${it.name} costs ${it.price} g.`)
            : confirm('Buy', `Buy ${it.name} for ${it.price} g?`, () => {
                game.gold -= it.price;
                game.inventory.push(it);
                pop();
                ok('Bought', `${it.name} is in your bag.`);
              }),
      })),
      { label: 'Leave', act: pop },
    ],
    back: pop,
  };
}

function inn() {
  return {
    id: 'inn',
    title: 'Inn',
    layout: 'col',
    dialog: true,
    buttons: [
      {
        label: 'Rest (5 g)',
        act: () =>
          ok('Rest', 'You sleep well.', () => {
            pop();
            if (bugs.has('shop') && game.inventory.some((i) => i.id === 'key')) {
              hit('shop');
              $('app').style.visibility = 'hidden'; // the bug: the fade-in after resting never runs
              document.body.style.background = '#000';
            }
            ok('Morning', 'A new day.');
          }),
      },
      { label: 'Save', act: () => push(slots()) },
      { label: 'Leave', act: pop },
    ],
    back: pop,
  };
}

function slots() {
  const save = (n) => () => {
    const write = () => {
      game.saves[n] = { floor: game.camp, gold: game.gold };
      if (n === 3) game.slot3Saves++;
      stack.length = Math.max(1, stack.length - 2);
      render();
      ok('Saved', `Saved to slot ${n}.`);
    };
    if (!game.saves[n]) return write();
    if (bugs.has('inn') && n === 3 && game.slot3Saves >= 1) {
      hit('inn');
      // The bug: the overwrite dialog of slot 3 never closes and swallows Back.
      return push(dialog('Overwrite', 'Overwrite slot 3?', [{ label: 'Yes', act: () => {} }, { label: 'No', act: () => {} }], { back: () => {} }));
    }
    confirm('Overwrite', `Overwrite slot ${n}?`, write);
  };
  return { id: 'slots', title: 'Save slot', layout: 'row', dialog: true, buttons: [1, 2, 3].map((n) => ({ label: `Slot ${n}${game.saves[n] ? ' *' : ''}`, act: save(n) })), back: pop };
}

function quests() {
  const qs = ['Clear floor 5', 'Find the old key', 'Defeat the boss'];
  return {
    id: 'quests',
    title: 'Quest board',
    layout: 'col',
    dialog: true,
    buttons: [
      ...qs.map((q) => ({ label: `${game.quests.includes(q) ? '✓ ' : ''}${q}`, act: () => (game.quests.includes(q) ? ok('Quest', 'Already accepted.') : confirm('Accept quest', q, () => (game.quests.push(q), pop()))) })),
      { label: 'Leave', act: pop },
    ],
    back: pop,
  };
}

// ---------- dungeon ----------

function enterFloor(f) {
  game.floor = f;
  window.firelabDepth.floor = Math.max(window.firelabDepth.floor, f);
  if (f % 5 === 0) game.camp = f;
  replace(f === FLOORS ? boss() : antechamber(f));
  if (f % 5 === 0 && f < FLOORS) push(chest(f));
}

function antechamber(f) {
  return {
    id: `floor-${f}-hall`,
    title: `Floor ${f}`,
    text: f % 5 === 0 ? 'A camp. You can come back here.' : 'A quiet hall.',
    layout: 'col',
    buttons: [
      { label: 'Continue', act: () => replace(doors(f)) },
      { label: 'Leave dungeon', act: () => confirm('Leave', 'Go back to town?', () => replace(town())) },
    ],
    back: () => confirm('Leave', 'Go back to town?', () => replace(town())),
  };
}

function doors(f) {
  const hasMap = game.inventory.some((i) => i.id === 'map');
  const pick = (d) => () => {
    if (bugs.has('freeze') && f === 20 && d === 1) {
      hit('freeze');
      frozen = true; // the bug: the torch animation's frame callback is dropped
    }
    if (d === rightDoor(f)) enterFloor(f + 1);
    else {
      game.floor = game.camp;
      replace(antechamber(game.camp));
      ok('Trap', `A trap door! You land on floor ${game.camp}.`);
    }
  };
  return {
    id: `floor-${f}-doors`,
    title: `Floor ${f}: three doors`,
    text: hasMap ? `Your map marks the ${['left', 'middle', 'right'][rightDoor(f)]} door.` : 'Which way?',
    layout: 'row',
    buttons: ['Left door', 'Middle door', 'Right door'].map((label, d) => ({ label, act: pick(d) })),
    back: () => replace(antechamber(f)),
  };
}

function chest(f) {
  return dialog('Chest', `A chest on floor ${f}.`, [
    {
      label: 'Open',
      act: () => {
        pop();
        push(
          dialog('Loot', 'Gold and a gem.', [
            {
              label: 'Take',
              act: () => {
                if (bugs.has('chest') && f === 10 && game.inventory.some((i) => i.id === 'key')) {
                  hit('chest');
                  game.inventory.find((i) => i.id === 'gem').count++; // TypeError: no gem yet
                }
                game.gold += 20 * (f / 5);
                pop();
              },
            },
            { label: 'Leave it', act: pop },
          ]),
        );
      },
    },
    { label: 'Ignore', act: pop },
  ]);
}

function boss() {
  const round = () =>
    push(
      dialog('Battle', `The warden has ${game.bossHp} HP.`, [
        {
          label: 'Attack',
          act: () => {
            game.defends = 0;
            game.bossHp--;
            pop();
            if (game.bossHp <= 0) ok('Victory', 'The dungeon is quiet. You win!', () => replace(town()));
            else round();
          },
        },
        {
          label: 'Defend',
          act: () => {
            game.defends++;
            pop();
            if (bugs.has('boss') && game.defends >= 3) {
              hit('boss');
              brokenFrame = true; // the bug: the shield effect reads a missing sprite every frame
            }
            round();
          },
        },
      ]),
    );
  return {
    id: 'floor-30-boss',
    title: 'Floor 30: the warden',
    text: 'The last guardian blocks the way.',
    layout: 'row',
    buttons: [
      { label: 'Fight', act: round },
      { label: 'Flee', act: () => ((game.floor = game.camp), replace(antechamber(game.camp)), ok('Fled', `Back to floor ${game.camp}.`)) },
    ],
    back: () => {},
  };
}

// ---------- rendering and input ----------

function render() {
  const s = scene();
  if (!s) return;
  $('title').textContent = s.title;
  const text = typeof s.text === 'function' ? s.text() : (s.text ?? '');
  $('text').textContent = text;
  const list = $('buttons');
  list.className = s.layout === 'row' ? 'row' : 'col';
  list.replaceChildren(
    ...s.buttons.map((b, i) => {
      const el = document.createElement('button');
      el.textContent = b.label;
      el.id = `${s.id}-b${i}`;
      el.tabIndex = -1;
      if (i === focus) el.classList.add('focused');
      return el;
    }),
  );
  $('panel').classList.toggle('dialog', !!s.dialog);
  $('crumbs').textContent = stack.map((x) => x.title).join(' › ');
  const f = list.children[focus];
  if (f) f.focus({ preventScroll: true });
  window.firelab.marks.scene = s.id;
  window.firelab.marks.depth = stack.length;
}

function onKey(e) {
  const s = scene();
  if (!s) return;
  const n = s.buttons.length;
  const prev = s.layout === 'row' ? 'ArrowLeft' : 'ArrowUp';
  const next = s.layout === 'row' ? 'ArrowRight' : 'ArrowDown';
  let used = true;
  if (e.key === prev) focus = Math.max(0, focus - 1);
  else if (e.key === next) focus = Math.min(n - 1, focus + 1);
  else if (e.key === 'Enter') return void (e.preventDefault(), s.buttons[focus]?.act());
  else if (e.key === 'Escape') {
    // At the title, Back leaves the app (the wrapper closes it); everywhere else the game uses it.
    if (s.id === 'title') return;
    e.preventDefault();
    return void s.back();
  } else used = false;
  if (used) {
    e.preventDefault();
    render();
  }
}

// The torch: an animated canvas, so frozen pictures and stopped render loops are visible.
let frozen = false;
let brokenFrame = false;
const torch = $('torch');
const ctx = torch.getContext('2d');
function frame(t) {
  if (brokenFrame) {
    document.body.style.background = '#000';
    $('app').style.visibility = 'hidden';
    throw new TypeError("Cannot read properties of undefined (reading 'shield')");
  }
  const w = torch.width;
  const h = torch.height;
  ctx.clearRect(0, 0, w, h);
  const flicker = 0.75 + 0.25 * Math.sin(t / 90) * Math.sin(t / 37);
  const g = ctx.createRadialGradient(w / 2, h * 0.7, 2, w / 2, h * 0.7, h * 0.7 * flicker);
  g.addColorStop(0, '#ffd27a');
  g.addColorStop(0.4, '#ff7a1a');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#c9d1e6';
  ctx.font = '14px system-ui';
  ctx.fillText(game.floor ? `floor ${game.floor}` : 'town', 10, 20);
  if (!frozen) requestAnimationFrame(frame);
}

window.firelab = { marks: {}, paused: false };
window.deepQuest = { game, stack, rightDoor, bugs: [...bugs] };
document.addEventListener('keydown', onKey);
replace(title());
requestAnimationFrame(frame);
