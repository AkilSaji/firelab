# Deep Quest: FireLab's depth benchmark

A small TV RPG driven only by the remote (arrows, OK = Enter, Back = Escape):
nested options dialogs, a town with a shop, an inn with save slots and a quest
board, and a 30-floor dungeon where a wrong door drops you back to the last camp
(every 5th floor). Reaching floor 30 takes about 100 key presses from launch.

```sh
node examples/web-game/serve.mjs --port 8095    # serves the repository root
# http://localhost:8095/examples/deep-quest/            the clean game
# http://localhost:8095/examples/deep-quest/?bugs=all   with six seeded bugs
firelab explore --driver browser --url "http://localhost:8095/examples/deep-quest/?bugs=all" --minutes 10
firelab bench --subjects deep-quest
```

`?bugs=all` (or a comma list) seeds six bugs at increasing depth:

| Bug | Presses from launch | What happens |
|---|---|---|
| `options` | ~9 | Options › Video › High › Apply, then Controls › Remap › OK throws a TypeError |
| `shop` | ~12 | buying the Old key, then resting at the inn, blanks the screen |
| `inn` | ~16 | saving to slot 3 twice traps the focus in the overwrite dialog (Back does nothing) |
| `chest` | ~40 | taking the floor-10 chest's loot while carrying the key throws |
| `freeze` | ~70 | the middle door on floor 20 stops the render loop |
| `boss` | ~100 | defending three times in a row against the floor-30 boss throws on every frame |

Ground truth for benchmarks: `window.firelabBugsHit[id]` is the time (ms since
load) a bug actually fired, and `window.firelabDepth.floor` the deepest floor
reached, whoever drove the game. `window.firelab.marks.scene` names the
current screen, and `window.deepQuest.game` holds the game state.

MIT licence, like the rest of FireLab.
