# FireLab engine benchmark

How well does `firelab explore` find bugs compared with the testers people
already use? `firelab bench` answers that on games with seeded bugs, with
repeated runs and standard statistics, on a laptop, without a TV.

```sh
firelab bench                                              # both games, 4 strategies, 5 runs x 10 min
firelab bench --subjects deep-quest --runs 10 --minutes 20 --parallel 4
firelab bench --subject mygame=https://my-game.example/    # any web game: coverage, screens, findings
firelab bench report ~/.firelab/bench/<id>                 # re-render the report
```

Output goes to `~/.firelab/bench/<id>/`: `bench.json` (every run), a
self-contained `report.html` (coverage curves, per-bug table, statistics),
`report.md`, and each run's own FireLab report under `runs/`. The dashboard's
Reports page lists them.

## What is compared

| Strategy | What it is |
|---|---|
| **FireLab** | the engine as shipped: Go-Explore archive, widget-level actions, frontier and depth selection, episode stretch, coverage reward, focus walks (ENGINE.md 6.7) |
| **FireLab (MVP)** | ablation: the first engine version (`deep: false`) |
| **Random** | uniform random remote keys |
| **Monkey** | Android Monkey's D-pad event mix: arrows 60%, OK/Back/Menu 35%, system keys 5%, as `adb shell monkey --pct-nav 60 --pct-majornav 35 --pct-syskeys 5` sends it |

Monkey is the baseline that matters: in the largest independent studies it
matched or beat research tools on coverage (AndroTest, an industrial study) and
came second on real bugs (Themis: Ape 24, Monkey 22 of 52). Every strategy gets
the same game, wall-clock budget, keys and passive checks (crash, JS exception,
black or frozen screen, stopped render loop); only FireLab walks the D-pad
focus. Runs are interleaved across strategies so machine load is shared.

## The games

- **Firefly Lake** (`examples/web-game`, three.js): five bugs modelled on bugs a
  shipped TV game had, 3-8 presses from launch: a menu grid the arrows ignore
  with an unreachable cell, a focus trap, a TypeError in the quality menu, a black
  screen from a double OK, a render loop that stops after the 2nd lantern.
- **Deep Quest** (`examples/deep-quest`): a TV RPG made for depth. Nested
  dialogs (options › video › apply, shop › buy › confirm, inn › save slot ›
  overwrite) and a 30-floor dungeon where a wrong door drops you back to the
  last camp. Six bugs from ~9 to ~100 presses deep: a TypeError behind a
  setting, a black screen after buying the key and resting, a focus trap in the
  save dialog, a TypeError at the floor-10 chest, a frozen render loop on floor
  20, and a crash at the floor-30 boss.

Both games record each seeded bug **in the page** when it fires
(`window.firelabBugsHit`), whoever is driving. *Triggered* counts those (ground
truth, the same yardstick for every strategy); *reported* also needs a finding
of the matching kind from the tester. Deep Quest also records the deepest floor.

The runs use FireLab's browser driver: headless Chrome at the Fire TV WebView's
960×540 viewport, keys delivered the way FireLab's TV wrapper delivers them.
For FireLab the Firefly Lake and Deep Quest subjects pass a `--state-expr`, the
documented way a developer tells FireLab what game state matters; the
baselines don't use states, so it can't help them.

## Metrics and statistics

- seeded bugs triggered and reported per run, and per bug: k of n runs, median time to trigger, Fisher's exact test against FireLab;
- V8 block coverage of the game's own scripts (engine-independent);
- game progress (Deep Quest's deepest floor);
- FireLab's own screen count and deepest screen, for context only (engine-defined).

Medians with IQR; two-sided Mann-Whitney U with Vargha-Delaney Â12 (0.71+ =
large), following Arcuri and Briand (ICSE 2011) and Klees et al. (CCS 2018).
Five runs per cell is a laptop budget; treat p-values as indicative (Klees et
al. recommend 30 runs; 10+ is accepted practice).

## Results

Run on 18 Oct 2026 with `firelab bench` (defaults). The full report, the raw data and the Markdown are in [docs/results/benchmark-2026-10-18/](results/benchmark-2026-10-18/).

**In short:** on Firefly Lake FireLab *reports* 4 of 5 seeded bugs where Monkey reports 2 and Random 1 (Â12 = 1.00, p ≈ 0.01), and runs about 50% more of the game's code. It doesn't *trigger* many more bugs than Monkey; the difference is that its oracles recognise what they see. On Deep Quest it reaches 246 distinct screens against Monkey's 70 and gets 36 keys deep. The deepest Deep Quest bugs (40 to 100 keys) stayed out of reach for every tester.

5 runs × 10 min per strategy and game · Chrome/155.0.8059.84 (headless, Fire TV viewport) · 2026-10-18

**Distinct seeded bugs triggered (of 11) in 5 × 10 min runs: FireLab 5, FireLab (MVP) 5, Random 4, Monkey 5**

### Firefly Lake (three.js arcade game, 5 seeded bugs)

| Metric | FireLab | FireLab (MVP) | Random | Monkey |
|---|---|---|---|---|
| Seeded bugs triggered | 4 (4–4) | 5 (4–5) | 3 (3–4) | 4 (4–4) |
| Seeded bugs reported | 4 (3–4) | 5 (4–5) | 1 (1–2) | 2 (2–2) |
| JS blocks covered | 120 (120–123) | 121 (119–125) | 74 (74–76) | 79 (78–79) |
| Deepest screen (keys) (engine-defined) | 2 (2–3) | 2 (2–2) | 3 (3–3) | 3 (3–3) |
| Distinct screens (engine-defined) | 8 (8–8) | 8 (8–8) | 7 (7–8) | 8 (8–8) |

| Seeded bug | FireLab | FireLab (MVP) | Random | Monkey |
|---|---|---|---|---|
| grid (~3 keys) | 5/5 triggered, 5/5 reported | 5/5 triggered, 5/5 reported | 5/5 triggered, 0/5 reported | 5/5 triggered, 0/5 reported |
| trap (~5 keys) | 5/5 triggered, 5/5 reported | 5/5 triggered, 5/5 reported | 5/5 triggered, 0/5 reported | 5/5 triggered, 0/5 reported |
| throw (~6 keys) | 0/5 triggered, 0/5 reported | 5/5 triggered, 5/5 reported | 5/5 triggered, 5/5 reported | 5/5 triggered, 5/5 reported |
| black (~6 keys) | 5/5 triggered, 4/5 reported | 5/5 triggered, 4/5 reported | 0/5 triggered, 0/5 reported | 0/5 triggered, 0/5 reported |
| freeze (~8 keys) | 4/5 triggered, 4/5 reported | 3/5 triggered, 3/5 reported | 2/5 triggered, 2/5 reported | 5/5 triggered, 4/5 reported |

| Metric | Pair | Medians | Â12 | p |
|---|---|---|---|---|
| Seeded bugs triggered | FireLab vs FireLab (MVP) | 4 vs 5 | 0.16 (large) | 0.056 |
| Seeded bugs triggered | FireLab vs Random | 4 vs 3 | 0.70 (medium) | 0.270 |
| Seeded bugs triggered | FireLab vs Monkey | 4 vs 4 | 0.40 (small) | 0.424 |
| Seeded bugs reported | FireLab vs FireLab (MVP) | 4 vs 5 | 0.22 (large) | 0.150 |
| Seeded bugs reported | FireLab vs Random | 4 vs 1 | 1.00 (large) | 0.010 |
| Seeded bugs reported | FireLab vs Monkey | 4 vs 2 | 1.00 (large) | 0.009 |
| JS blocks covered | FireLab vs FireLab (MVP) | 120 vs 121 | 0.42 (small) | 0.752 |
| JS blocks covered | FireLab vs Random | 120 vs 74 | 1.00 (large) | 0.011 |
| JS blocks covered | FireLab vs Monkey | 120 vs 79 | 1.00 (large) | 0.011 |

### Deep Quest (TV RPG with nested dialogs and a 30-floor dungeon, 6 seeded bugs)

| Metric | FireLab | FireLab (MVP) | Random | Monkey |
|---|---|---|---|---|
| Seeded bugs triggered | 0.5 (0–1) | 0 (0–0) | 0 (0–0) | 0 (0–0.3) |
| Seeded bugs reported | 0.5 (0–1) | 0 (0–0) | 0 (0–0) | 0 (0–0.3) |
| JS blocks covered | 77 (76.5–77) | 59 (59–65) | 50 (44.8–55.8) | 43 (41.8–46.5) |
| Game progress | 1 (1–1.5) | 1 (1–2) | 0.5 (0–1) | 0 (0–0) |
| Deepest screen (keys) (engine-defined) | 36 (31.3–37.5) | 16 (16–17) | 17.5 (15–19.8) | 13.5 (11.5–16.8) |
| Distinct screens (engine-defined) | 246 (233–261) | 108 (96–111) | 82 (77–92.8) | 69.5 (65.3–77.8) |

| Seeded bug | FireLab | FireLab (MVP) | Random | Monkey |
|---|---|---|---|---|
| options (~9 keys) | 0/4 triggered, 0/4 reported | 0/5 triggered, 0/5 reported | 0/4 triggered, 0/4 reported | 0/4 triggered, 0/4 reported |
| shop (~12 keys) | 2/4 triggered, 2/4 reported | 0/5 triggered, 0/5 reported | 0/4 triggered, 0/4 reported | 1/4 triggered, 1/4 reported |
| inn (~16 keys) | 0/4 triggered, 0/4 reported | 0/5 triggered, 0/5 reported | 0/4 triggered, 0/4 reported | 0/4 triggered, 0/4 reported |
| chest (~40 keys) | 0/4 triggered, 0/4 reported | 0/5 triggered, 0/5 reported | 0/4 triggered, 0/4 reported | 0/4 triggered, 0/4 reported |
| freeze (~70 keys) | 0/4 triggered, 0/4 reported | 0/5 triggered, 0/5 reported | 0/4 triggered, 0/4 reported | 0/4 triggered, 0/4 reported |
| boss (~100 keys) | 0/4 triggered, 0/4 reported | 0/5 triggered, 0/5 reported | 0/4 triggered, 0/4 reported | 0/4 triggered, 0/4 reported |

| Metric | Pair | Medians | Â12 | p |
|---|---|---|---|---|
| Seeded bugs triggered | FireLab vs FireLab (MVP) | 0.5 vs 0 | 0.75 (large) | 0.128 |
| Seeded bugs triggered | FireLab vs Random | 0.5 vs 0 | 0.75 (large) | 0.181 |
| Seeded bugs triggered | FireLab vs Monkey | 0.5 vs 0 | 0.63 (small) | 0.608 |
| Seeded bugs reported | FireLab vs FireLab (MVP) | 0.5 vs 0 | 0.75 (large) | 0.128 |
| Seeded bugs reported | FireLab vs Random | 0.5 vs 0 | 0.75 (large) | 0.181 |
| Seeded bugs reported | FireLab vs Monkey | 0.5 vs 0 | 0.63 (small) | 0.608 |
| JS blocks covered | FireLab vs FireLab (MVP) | 77 vs 59 | 1.00 (large) | 0.017 |
| JS blocks covered | FireLab vs Random | 77 vs 50 | 1.00 (large) | 0.027 |
| JS blocks covered | FireLab vs Monkey | 77 vs 43 | 1.00 (large) | 0.027 |
| Game progress | FireLab vs FireLab (MVP) | 1 vs 1 | 0.53 (negligible) | 1.000 |
| Game progress | FireLab vs Random | 1 vs 0.5 | 0.81 (large) | 0.134 |
| Game progress | FireLab vs Monkey | 1 vs 0 | 1.00 (large) | 0.018 |

## Limits

- Two games, both with bugs seeded by FireLab's authors (Firefly Lake's bugs
  were written before the engine was tuned on them; Deep Quest was written for
  this benchmark). Use `--subject` to add others.
- Headless Chrome on a laptop, not a Fire TV: a TV is 3-4x slower per key press,
  so the same budget reaches less. Run on the device with
  `firelab explore --strategy monkey|random|explore` to compare there.
- Monkey here is Monkey's event mix through FireLab's driver, not the
  `monkey` binary (which needs an Android device): same key distribution, same
  pace and checks.
- No TV or HTML5-game exploration benchmark has been published, so there is
  no external number to compare with directly; the Themis and AndroTest numbers
  above are Android-app results, quoted for context.
