## FireLab Engine: dev.firelab.fireflylake

Fire TV Stick (3rd gen) · 3 min 00 s · 44 steps · 4 states · 2 deep · Go-Explore (seed 1)

| Severity | Finding | Repro | Keys |
|---|---|---|---|
| minor | Console error: Failed to load resource: the server responded with a status of 404 (Not Found) | not replayed | `(launch)` |

Replay one: `firelab replay ~/.firelab/explore/ex-20261019-194929-i9fw/traces/f-6ae183.trace.json --times 5`

<details><summary>Notes</summary>

- focus oracle off: no screen had focus information. Web apps: publish window.firelab.marks.focus (and window.firelab.focusables), or pass --focus-selector for apps that draw focus with a class. Native apps: focus comes from uiautomator dumps, which failed or found no focused view.

</details>

Full report: `~/.firelab/explore/ex-20261019-194929-i9fw/report.html`
