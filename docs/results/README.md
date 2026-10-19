# Results

Real outputs from FireLab runs, kept so anyone can check the numbers in the
README. Local paths and LAN addresses have been replaced with `~` and
`192.168.x.x`.

| Folder | What it is |
|---|---|
| [benchmark-2026-10-18/](benchmark-2026-10-18/) | `firelab bench`: FireLab vs FireLab (MVP) vs Random vs Monkey on Firefly Lake and Deep Quest, 5 runs × 10 min each, headless Chrome at the Fire TV viewport. `report.html` (open it in a browser), `report.md` and the raw `bench.json`. Discussed in [../BENCHMARK.md](../BENCHMARK.md). |
| [firetv-stick-3rd-gen-2026-10-19/](firetv-stick-3rd-gen-2026-10-19/) | On a real Fire TV Stick (3rd gen, 1 GB, Fire OS 7): a 3-minute `firelab explore` of Firefly Lake with its seeded bugs on (`explore-firefly-lake.html` / `.md`), and the dashboard's GPU check imitating a Fire TV Stick 2nd gen's Mali-450 (`gpu-check-as-AFTT.json`). |
| [no-fire-tv-gpu-emulation-2026-10-19/](no-fire-tv-gpu-emulation-2026-10-19/) | **No Fire TV:** a 1-minute `firelab explore --driver browser --emulate-gpu AFTT` of Firefly Lake in headless Chrome on a Mac, imitating a Fire TV Stick 2nd gen's Mali-450. It found that the game breaks on that stick: WebGL2 refused, `Error: WebGL2 not available`, render loop stopped. |
| [../sample-run/](../sample-run/) | A 10-minute `firelab explore` of Firefly Lake on a Fire TV Stick 4K Plus, with every finding's trace. |

To view an HTML report straight from GitHub, open it through
`https://htmlpreview.github.io/?` followed by the file's GitHub URL, or
download the repository and open the file.
