# FireLab engine vs Random and Monkey: Firefly Lake and Deep Quest

5 runs × 10 min per strategy and game · Chrome/155.0.8059.84 (headless, Fire TV viewport) · 2026-10-18

**Distinct seeded bugs triggered (of 11) in 5 × 10 min runs: FireLab 5, FireLab (MVP) 5, Random 4, Monkey 5**

## Firefly Lake (three.js arcade game, 5 seeded bugs)

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

## Deep Quest (TV RPG with nested dialogs and a 30-floor dungeon, 6 seeded bugs)

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

