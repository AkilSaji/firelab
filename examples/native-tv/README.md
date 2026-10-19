# Native TV focus fixture

A tiny native Android TV app (plain `Button`s, no WebView, no Gradle). It is
used to check that `firelab explore` finds focus bugs in native apps, where
focus comes from `uiautomator dump` and not from the in-page probe
(docs/ENGINE.md 5.1, 7.3).

It has an explicit D-pad focus graph with three seeded bugs:

| Bug | What happens | Expected finding |
| --- | --- | --- |
| Non-spatial move | right from **Movies** jumps to **Card 3** (expected **Shows**) | `non-spatial-move` (major) |
| Focus trap | down from **Settings** enters **Advanced A / B**: up/down do nothing, Back is swallowed | `focus-trap` (critical) |
| Unreachable | **Credits** is focusable, but no move leads to it | `unreachable-control` (major) |

## Build, install, explore

```bash
examples/native-tv/build.sh
```

```bash
adb -s 192.168.1.194:5555 install -r examples/native-tv/out/nativefixture.apk
```

```bash
npx tsx src/cli.ts explore --package dev.firelab.nativefixture -d 192.168.1.194 --minutes 8 --out reports/native-fixture
```

What to check in `reports/native-fixture/report.html` (or `--json`):

- the notes say `focus comes from uiautomator dumps`, and there is no `focus oracle off`;
- the findings include the three kinds above, with ids like `Button:Movies`;
- `run.json` counters show `dumps` well below `steps` and `dumpHits` > 0 (one dump per new picture, 2-3 s each).

You can also try your own native app (never `com.sunsetvilla.tv`), for
example `--package com.example.tvapp`. Its states should be level 3 with a
`focus` key read from the Flutter semantics tree.

Remove the fixture afterwards:

```bash
adb -s 192.168.1.194:5555 uninstall dev.firelab.nativefixture
```
