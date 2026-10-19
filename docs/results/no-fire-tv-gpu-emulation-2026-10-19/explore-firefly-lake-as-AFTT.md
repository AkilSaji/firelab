## FireLab Engine: web.127.0.0.1_8080

Chrome/155.0.8059.84 (headless, Fire TV viewport) · 1 min 00 s · 118 steps · 1 states · 0 deep · Go-Explore (seed 1)

| Severity | Finding | Repro | Keys |
|---|---|---|---|
| critical | The render loop stopped in "0545176c14f7" | not replayed | `rewind fastforward ok:long left playpause menu menu*8 up right down left down up right left*6 playpause … (+81)` |
| major | Uncaught: Error: WebGL2 not available | not replayed | `(launch)` |
| major | getContext("webgl2") fails on AFTT: returned null: no WebGL2 on Mali-450 MP4 | not replayed | `(launch)` |

Replay one: `firelab replay /tmp/gpu-explore/traces/f-21bdf1.trace.json --times 5`

<details><summary>Notes</summary>

- focus oracle off: no screen had focus information. Web apps: publish window.firelab.marks.focus (and window.firelab.focusables), or pass --focus-selector for apps that draw focus with a class. Native apps: focus comes from uiautomator dumps, which failed or found no focused view.
- WebGL under the Fire TV Stick (2nd gen) / Basic Edition (AFTT, Mali-450 MP4) profile (features and limits, not speed): 1 call failed (getContext("webgl2") returned null: no WebGL2 on Mali-450 MP4); 0 capability checks came back empty.
- gpu: GPU class: Mali-400/450/470 (Utgard), OpenGL ES 2: no WebGL2, no highp in fragment shaders, no vertex texture fetch, no instancing, no 32-bit indices.
- gpu: Features and limits only: the frame rate under this shim is your machine's, not the stick's.

</details>

Full report: `/tmp/gpu-explore/report.html`
