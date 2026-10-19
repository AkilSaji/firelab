# Shared knowledge: teach FireLab what you found

Every FireLab run that finds a bug can make the next run, on anyone's game,
better. A **knowledge pack** is a small JSON file `firelab learn export` writes
from your explore runs. FireLab loads every pack in this folder (and in
`~/.firelab/knowledge`) when it explores, and tries the patterns in them early.

## What a pack contains

- **Bug patterns**: the last remote keys (at most 6) of each *confirmed, shrunk*
  finding, with the finding's kind. For example `ok*3 -> black-screen` (a fast
  triple OK blanked the screen) or `down down back -> focus-trap`.
- **Key priors**: how often each remote key changed the app's state, so keys
  that TV games usually ignore cost fewer presses on a new game.
- **Feedback**: findings you marked as not a bug (`--reject`) lower a pattern's
  weight.
- Counts, and hashed game ids so merged packs count each game once.

**Never in a pack**: URLs, package names, screen or button names, text,
screenshots, code. `firelab learn export` prints the whole pack before you
share anything, and FireLab uploads nothing on its own (there is no telemetry).

## Contribute

```sh
firelab explore --package <your app> --minutes 20      # or from your AI assistant (explore_start), or in CI
firelab learn export                                  # the 5 latest runs; or pass run directories
firelab learn export --reject f-1a2b3c                # a finding that wasn't a bug
```

Then fork this repository, put the file in `knowledge/`, and open a pull
request. From an AI assistant, the MCP tool `learn_export` does the same. In CI,
after `firelab explore`, run `firelab learn export --out knowledge/<name>.json`
and open the pull request with your usual action (e.g. peter-evans/create-pull-request);
make it opt-in for your project.

Maintainers review packs like any change: a pattern is only a hint (it is tried
on new screens; it can't stop the explorer from doing anything else), packs are
validated on load (unknown keys and kinds are dropped), and rejections lower a
pattern's weight. `firelab learn merge knowledge/*.json --out knowledge/firelab.json`
folds contributed packs together.

## Check what FireLab knows

```sh
firelab learn show
firelab explore ... --no-knowledge           # turn it off for a run
FIRELAB_NO_KNOWLEDGE=1 firelab explore ...   # or from the environment
```

Does it help? `firelab bench --knowledge <pack.json>` adds a "FireLab + knowledge"
strategy. Learn the pack on *other* games than the ones you benchmark, or the
result means nothing (docs/BENCHMARK.md).
