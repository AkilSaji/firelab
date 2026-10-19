# FireLab Engine: literature review

This review collects the research behind the FireLab Engine, FireLab's autonomous
testing engine for apps and games on Fire TV (Fire OS over adb + Chrome DevTools
Protocol) and, later, Vega OS (over `vda`). The design itself is in
[ENGINE.md](ENGINE.md); every design choice there points back to the numbered
references at the end of this file.

How the references were checked (2026-10-15): every DOI was resolved against
Crossref, and abstracts and numbers were read from OpenAlex, arXiv, the
publisher, or the authors' pages. Numbers quoted below come from those abstracts
or official pages. Where we could read only the abstract and not the full paper,
the entry says so. Platform documentation (Android, Amazon, W3C, vendor
engineering blogs) is listed separately from peer-reviewed work.

Each topic has the same layout: what the research found, then **What FireLab
takes from this**.

---

## 1. Automated GUI and Android app testing

**Findings.** The baseline is still hard to beat. Choudhary, Gorla and Orso's
comparison of Android input generators [1] scored the tools on code coverage,
fault detection, ease of use and multi-platform support. Zeng et al. [2] sum up
its headline result: Google's random Monkey outperformed every research tool in
the study. They then ran Monkey on WeChat (762 million monthly users) and found
it wastes much of its budget on unproductive events and on screens it has
already explored. That pattern, a random baseline that is cheap but blind, sets
up the rest of the field:
- **Model-based tools** learn a GUI state machine while testing and use it to aim:
  - DroidBot builds a UI transition graph without instrumenting the app [6];
  - Stoat builds a stochastic GUI model and refines it with Gibbs sampling; its models cover 17–31% more code than earlier modelling tools [3];
  - APE refines its *state abstraction* while it runs: it splits or merges abstract states when an action leads to inconsistent results. It beat the other tools on coverage and unique crashes across 15 large apps, and found 537 unique crashes in 1,316 popular apps [5].
- **Search-based testing:** Sapienz evolves short, fault-revealing event sequences with multi-objective search. It beat Monkey and Dynodroid on coverage in 7/10 experiments, on faults in 7/10, and on sequence length in 10/10. It found 558 previously unknown crashes in the top 1,000 Google Play apps [4].
- **State pool instead of mutation:** TimeMachine ("time-travel testing") points out that mutating a good event sequence often cuts the path that made it good. It therefore keeps a pool of interesting *states* and jumps back to the most progressive one when progress stalls. With this it beat Sapienz and Stoat on both coverage and crashes [8].

How a tool defines "the same screen" matters as much as how it picks actions.
Baek and Bae [10] show that GUI model-based testing changes a lot with the
comparison criterion. Coarse levels compare activity names, fine levels compare
widget trees and values, and each level trades model size against precision.

**Industrial practice:**
- ByteDance's Fastbot2 reuses a probabilistic model of which events reach which screens across runs, and guides testing with reinforcement learning. It beat Monkey, APE and Stoat on activity coverage and fault detection on Douyin and Toutiao. It reported 50.8% of the crash bugs developers fixed during nearly two years in CI [9].
- Humanoid learns from human interaction traces which UI elements people tend to use: 51.2% top-1 and 85.2% top-10 accuracy. Its authors are candid that the learned model was not the main source of its coverage gain [7].

**LLM-driven testing (2023–2024):**
- GPTDroid treats testing as a question-and-answer loop with a functionality-aware memory. On 93 apps it reported 32% more activity coverage and 31% more bugs than the best baseline, plus 53 new bugs, 35 of them fixed [11].
- DroidAgent sets its own testing goals and reached 61% average activity coverage versus 51% for the baselines on 15 apps [12].
- AutoDroid first explores an app offline. It then injects that "memory" into the LLM's prompts, reaching 71.3% task completion and 90.9% per-action accuracy with GPT-4 on 158 tasks [13].
- VisionDroid (arXiv, not yet peer reviewed at the time of writing) uses a multimodal LLM over screenshot sequences to catch *non-crash* functional bugs, which crash-only oracles miss. It reported 29 new bugs, 19 of them fixed [14].

On evaluation, the Themis benchmark [15] gives the sobering ground truth: 52
real, critical, reproducible crash bugs, 6 tools and over 10,920 CPU hours, and
18 of the bugs were found by no tool.

**What FireLab takes from this**
- Always compare against a random baseline. On a TV the random baseline is very cheap (11 keys), so the engine has to win on coverage *per hour*, not only in total [1, 2, 15].
- Keep a state-transition graph and use it to aim [3, 5, 6]. Keep an archive of states and return to promising ones instead of mutating sequences blindly [8].
- Treat the state abstraction as a tunable, layered choice [10]. Allow refinement when transitions look nondeterministic [5].
- Persist the model between runs so later runs start smart [9]. Use human traces as seeds, not as the main engine [7].
- An LLM is useful as a goal setter when coverage stalls [11, 12], and works best when it is given the explored graph as memory [13]. Treat visual LLM judgements of "non-crash" bugs as advisory [14].
- Measure against ground-truth bugs, not only coverage [15].

---

## 2. Automated game testing and playtesting agents

**Findings.** EA SEED's deep-RL testing work [16] showed that agents rewarded
with a designer-defined signal raise test coverage. The agents also find
exploits and unintended mechanics, and can measure map difficulty in first-person
shooters. The follow-up [17] rewards *novelty* instead of winning: curious agents
learned to reach far parts of a complex 3D map and gave testers coverage data and
heatmaps. CCPT [18] combines curiosity with imitation learning, so agents explore
*near* trajectories that experts demonstrated. It reported more coverage and
more bugs found than baselines, and a visual analytics view that raised testers'
trust.

NetEase's Wuji [19] analysed 1,349 real bugs from four commercial games and
proposed four game oracles. It balances *winning* (to make progress) against
*exploring* (to find bugs) with evolutionary multi-objective search plus deep RL,
and found 3 previously unknown bugs in commercial games. That progress-versus-exploration
tension is central: many game bugs sit behind progress gates.

From RL research:
- Go-Explore [20] solved hard-exploration Atari games, including Montezuma's Revenge and Pitfall, with three principles:
  - remember the states you have visited, in an archive of "cells";
  - *first return* to a promising cell without exploring on the way;
  - *then explore* from it.
- Novelty search [22] showed that rewarding *new behaviour* alone, with no objective, beats objective-driven search on deceptive problems such as mazes. Many game bugs are deceptive in this sense: no score points towards them.
- Count-based exploration [21] gives a principled novelty bonus that shrinks with visits. It generalises to states that never repeat exactly through *pseudo-counts* from a density model.

Most of these agents need fast simulators, thousands of episodes and GPU
training. A Fire TV Stick gives perhaps one decision per second and no state
snapshots.

**What FireLab takes from this**
- Use the Go-Explore loop (archive, select, return, explore) as the explorer's skeleton [20]. It needs no neural network and works with discrete actions and expensive steps.
- Score cells by visit count (novelty) [21, 22] and by "interestingness" (closer to a bug signal, deeper progress), balancing progress and exploration as Wuji does [19].
- Seed the archive with human play from `firelab watch`, and explore near those trajectories as CCPT does [18].
- Skip deep RL for now. With roughly 2,000 actions per hour on a real device, the sample cost is wrong [16, 17]. Keep the curiosity idea; use counts in place of a learned predictor.
- Show coverage and findings visually (heatmaps of the state graph), because that is what builds testers' trust [17, 18].

---

## 3. Test oracles for games and graphics

**Findings.** Crash oracles miss most game bugs.
- EA SEED trained a ShuffleNetV2 to classify rendered frames as normal or as one of four glitch types: stretched, low-resolution, missing or placeholder textures. It reached 86.8% accuracy, caught 88% of glitches, and had an 8.7% false-positive rate [23].
- GLIB [24] (NetEase) detects game GUI glitches using code-based data augmentation to make training data. It reported 100% precision and 99.5% recall on 20 real games, and 48 of 53 newly reported bugs were confirmed and fixed.
- World of Bugs [25] is an open 3D platform with a catalogue of injected perceptual bugs, for example clipping through geometry and missing textures, built to train and evaluate detectors that see only the screen.
- GlitchBench [26] (CVPR 2024) evaluates large multimodal models on glitched game scenes. Its authors present it as a challenge that current models do not yet meet, which argues for treating LLM visual judgements as hints.

Cheap image fingerprints are the workhorse for state abstraction and for
"has the screen changed?" checks. Zauner [27] benchmarked perceptual image hashes
(DCT, Marr–Hildreth, radial variance and block mean) for robustness and speed.
Block-mean was the fastest in the follow-up benchmark, and none survived a
horizontal flip. Where the app can state what *should* be true, property-based
testing [28] offers a better oracle: the app declares invariants, random inputs
try to break them, and failing inputs are *shrunk* to small counterexamples.

**What FireLab takes from this**
- Rank oracles by cost, cheapest first:
  - crash, ANR and JS exception (free);
  - black and frozen screen from a downscaled frame plus a perceptual hash [27];
  - app-declared invariants over game state [28] (catches "character inside bench" and "two episodes running at once");
  - learned visual-glitch detectors [23, 24, 25];
  - LLM review [14, 26].
- A CNN detector needs training data in the target game's art style [23, 24]. That is a later tier; the MVP uses deterministic heuristics.
- LLM or LMM visual review only produces "suspected" findings for a human, never a pass/fail [26].
- Use perceptual hashes for the visual part of the state abstraction [27], with a distance threshold, never exact equality.

---

## 4. Performance-testing statistics

**Findings.** Performance numbers are noisy in ways that fool people:
- Georges, Buytaert and Eeckhout [29] showed that common "best of N" or single-run reporting can lead to wrong conclusions. They argue for confidence intervals over repeated runs, and for separating start-up from steady-state measurement.
- Kalibera and Jones [30] show that variation sits at several levels (builds, process launches, iterations within a run). They argue that repetitions belong at the level with the most variance, and give a way to choose repetition counts for a target precision. On a TV this means the *app launch* is the unit of replication, not the individual frame.
- Barrett et al. [31] found that only 43.3–56.5% of (VM, benchmark) pairs follow the textbook "warm up, then steady state" shape. Some never stabilise, and some slow down. They detect steady state with changepoint analysis rather than a fixed warm-up period.
- MongoDB [32] replaced threshold alerts with E-Divisive changepoint detection over CI performance histories. This cut false positives sharply and caught smaller regressions sooner.
- PELT [33] finds multiple changepoints exactly, in linear expected time, by minimising a penalised cost.

On *what* to measure for smoothness:
- Liu, Kuwahara, Scovell and Claypool (CHI 2023, 33 players, three games) [34] found that average frame rate alone predicts experience poorly. Frame-rate *variation* matters even when the average is high. The "95% frame-rate floor", the bottom 5% of frame rates, predicted experience well, both overall and per game.
- Android vitals [35] classes frames slower than 16 ms as slow and frames over 700 ms as *frozen*, and treats more than 5 s as an ANR.

For comparing two configurations:
- Arcuri and Briand [36] recommend non-parametric tests (Mann–Whitney U) plus an effect size (Vargha–Delaney Â12) over enough independent runs.
- Klees et al. [37] showed how fuzzing papers mislead with too few trials, no statistics and poorly chosen baselines.
- Cliff's delta [38] is the ordinal effect size (Â12 = (δ + 1) / 2).
- The bootstrap [39] gives confidence intervals for medians and percentiles without normality assumptions.
- Theil–Sen [40] estimates a robust slope, the median of pairwise slopes, for trends such as memory growth.

**What FireLab takes from this**
- Record frame *times*, not only fps. Report p50/p95 frame time, the 95% fps floor [34], slow frames, and frozen frames over 700 ms [35].
- Detect warm-up with a changepoint method (PELT [33]) and do not assume a fixed warm-up period [31].
- When comparing builds, tiers or devices, use per-launch medians as samples [30]. Run at least 5 launches per side, compute a bootstrap CI of the difference [39], and run Mann–Whitney U with Cliff's δ [36, 38]. Never report "best of N" [29].
- For regressions across a build history, use changepoint detection rather than thresholds [32, 33].
- Engine evaluations follow Klees et al. [37]: several trials, a fair baseline, and effect sizes.

---

## 5. Memory leaks in JS/web apps and Android

**Findings.**
- BLeak [41] relies on users returning repeatedly to the same visual state. Heap growth across such round trips is a strong leak signal. With a short driver script (17–73 lines) per app, it found and helped fix over 50 leaks in apps and libraries (Airbnb, Google Maps SDK, jQuery and others). It reported a median precision of 100%, and the fixes cut heap growth by 94% on average.
- Meta's MemLab [42] takes three heap snapshots: page A, target page B, then back to A. It reports objects allocated on B that survive the return, filtered by framework knowledge (for example, detached React Fiber nodes). Meta credits its memory work with a 50% drop in Facebook.com OOM crashes in early 2021.
- LeakCanary [43] watches objects that *should* be gone (destroyed activities and fragments). It waits 5 s, forces a GC, and treats survivors as retained. It dumps the heap only after a threshold of retained objects (5 while the app is visible).
- Yan, Yang and Rountev [44] built test generation around *neutral cycles*: GUI event sequences that should leave resource use unchanged, such as open then close, or rotate then rotate back. On 8 apps this exposed 18 resource leaks, 12 of them new.

**What FireLab takes from this**
- The explorer's state graph contains neutral cycles for free: any key path that returns to the same abstract state. Use them as leak probes [41, 44].
- Force a GC (CDP `HeapProfiler.collectGarbage`) before each measurement, as LeakCanary does [43]. Fit a Theil–Sen slope over 8 or more cycles, with a bootstrap CI [39, 40].
- Do not take full heap snapshots on a 1 GB TV: a snapshot of a three.js game can be a large fraction of the free memory. Do MemLab-style snapshot diffing [42] on a desktop Chromium replay of the same trace, after the device has *flagged* the leak with cheap counters.

---

## 6. Failure minimisation, record and replay, and flakiness

**Findings.**
- Delta debugging (ddmin) [45] reduces a failing input to a 1-minimal one, where removing any single element makes the failure go away. It needs O(n²) tests in the worst case and far fewer in practice.
- Clapp, Bastani, Anand and Aiken [46] adapted ddmin to Android GUI traces, which are *nondeterministic*. They test each candidate several times and accept it when it reproduces with high probability, getting Monkey traces down to under 2% of their original length on average.
- RERAN [47] records and replays Android's low-level input event stream with precise timing. It replayed 86 of the top 100 apps and reproduced real bugs, which showed that *timing* is part of the input.
- Luo et al. [48] studied 201 flaky-test fixes in 51 projects and classified the root causes; asynchronous waits and concurrency are prominent.
- Romano et al. [49] studied 235 flaky *UI* tests across web and Android. UI tests are flakier, and rerunning them costs more, because of async rendering, animation and environment differences.

**What FireLab takes from this**
- Every finding ships with a trace of keys plus timing [47], and a *reproduction rate* measured by replaying it k times. A finding that does not reproduce is labelled flaky, not hidden [48, 49].
- Minimise with probabilistic ddmin [45, 46]:
  - first cut loops from the state path (cheap);
  - then run ddmin, where a candidate "still fails" if it reproduces in at least 1 of m replays;
  - then shrink the gaps between keys.
- Wait for the screen to settle before each observation, because async waits cause most UI flakiness [48, 49].

---

## 7. Device fragmentation and compatibility

**Findings.**
- Wei, Liu and Cheung [50] studied 191 real fragmentation-induced compatibility issues in open-source Android apps and characterised their symptoms, root causes and fix patterns. Their static checker, FicFinder, found known and new issues in 27 large apps. Many issues are triggered by a specific device model or OS version together with a specific API.
- PRADA [51] ranks the device models to test *for a specific app* using large-scale usage data (3.86 million users, 14,000 device models), rather than general market share.

**What FireLab takes from this**
- Treat the device as a test parameter. A finding that appears on a Fire TV Stick 3rd gen (GE8300, 1 GB) but not on a 4K Max (GE9215) is a *compatibility* finding, and the report should say so [50].
- Replay the same minimised trace on every connected device (differential testing) and feed the results to `firelab fit`.
- Rank devices by the app's real audience when it is known, otherwise by the low end first [51].

---

## 8. TV, 10-foot UI and D-pad navigation testing

**Findings.** Research on TV apps is thin. Ahmed, Gargantini and Bures [52]
argue that mobile and desktop model-building does not fit smart TV apps, where
the only input is a remote that moves *focus*. They build a model of focus
transitions by driving the remote, and generate test paths from sub-models
("model separation"). Their approach built more complete models faster than
manual exploratory testing, and its tests killed TV-specific mutants (abstract
only; we did not read the full paper). The closest well-developed body of work is
keyboard accessibility on the web, because keyboard-only navigation has the same
shape as D-pad navigation. Chiou, Alotaibi and Halfond [53] detect and localise
keyboard accessibility failures in web apps, where functions can't be reached
or focus can't escape, with high precision and recall on real sites (abstract
only).

The relevant standards and platform rules:
- **W3C CSS Spatial Navigation** [54] defines how arrow keys should move focus: to the nearest candidate in the pressed direction, based on on-screen geometry rather than source order.
- **Android TV's navigation guide** [55] requires that every visible control be reachable with the D-pad, that focus always be visible, and that focus movement be predictable. It tells developers to test with a D-pad.
- **Vega OS** exposes devices through `vda` [56]: install, logs (`loggingctl`), screenshots (`gwsi-tool-screenshooter`) and memory (`ace_memusage`). Remote input goes through `inputd-cli` (`button_press`, `button_hold`/`button_release`, `KEY_UP`... `KEY_ENTER`) [57].

**What FireLab takes from this**
- A D-pad app's state includes *where focus is*. The explorer should model focus transitions explicitly [52].
- Focus oracles come straight from the platform rules:
  - **unreachable control:** a visible control is not in the D-pad reachable set [55];
  - **focus trap:** a set of focus states with no way out except Home [53];
  - **non-spatial move:** a key moves focus to an element that is not the nearest one in that direction [54]. This is exactly the Sunset Villa grid bug.
  - **lost focus:** nothing visible has focus [55].
- The same engine can drive Vega through `inputd-cli` and `vda` [56, 57]. A Vega app has no Android WebView, so the JS state probe has to come from an in-app bridge rather than CDP. ENGINE.md marks that as an optional driver capability.

## 9. Going deep and measuring it (October 2026 additions)

What changed the engine (ENGINE.md 6.7) and the benchmark (BENCHMARK.md):

- **Benchmarks with published numbers.** On Themis's 52 real crash bugs (6 h × 5 runs) the tools found: Ape 24, Monkey 22, ComboDroid 21, Stoat 19, Humanoid 18, TimeMachine 15, Q-testing 10 [15]. 18 bugs were found by no tool, and 12 of those need more than 5 distinct page transitions: depth is the open problem. On AndroTest (68 apps, 1 h × 10 runs) Monkey had the best coverage, and every tool plateaued within 5–10 minutes [1]; in industrial apps Monkey again led on coverage while Stoat found the most crashes [62]. No TV, D-pad or HTML5-game exploration benchmark exists; the nearest are GBGallery (76 bugs in 5 games) [63] and injected canvas bugs [64].
- **Ideas adopted.** Fire every widget (DroidBot, APE [5, 6]); prefer states with unexplored actions (Stoat, APE [3, 5]); count progress as an objective next to novelty (Wuji [19]); leave a stalled episode at once (TimeMachine [8]); share action effects between similar states (APE, Fastbot [5, 9, 58]); use V8 block coverage as reward and as an unbiased metric [59] (it de-optimises JS, so never during perf runs). Curiosity relative to recent memory (Q-testing [60]) and a DFA built online (WebExplor [61]) are close to the archive + graph FireLab already has.
- **LLM explorers.** They beat classic tools in their own papers; no independent comparison exists. The pattern that holds up is a cheap explorer by default with the LLM as a plateau breaker (LLMDroid: +26% coverage over classic tools at low cost [65]), which is ENGINE 6.5.
- **Baselines.** Monkey with D-pad events must include `--pct-majornav` (Enter, Back, Menu); `--pct-nav 100` alone sends only arrows [66].
- **Method.** Report coverage *and* bugs: they correlate but rank tools differently [67]. Mann-Whitney U with Vargha-Delaney Â12 (0.56/0.64/0.71 = small/medium/large) [36, 68]; at least 10 trials is accepted practice, 30 recommended [37, 69]. Seeded faults are a valid proxy for real ones [70].

---

## References

Peer-reviewed papers, theses and preprints are [1]–[34] and [36]–[41], [44]–[53].
Platform documentation and standards are [35], [42], [43], [54]–[57]. "Abstract
only" means we verified the bibliographic record and abstract but did not read
the full text.

**Automated GUI and Android testing**

1. S. R. Choudhary, A. Gorla, A. Orso. *Automated Test Input Generation for Android: Are We There Yet?* ASE 2015. https://doi.org/10.1109/ASE.2015.89 (preprint arXiv:1503.07217)
2. X. Zeng, D. Li, W. Zheng, F. Xia, Y. Deng, W. Lam, W. Yang, T. Xie. *Automated Test Input Generation for Android: Are We Really There Yet in an Industrial Case?* FSE 2016 (industry). https://doi.org/10.1145/2950290.2983958
3. T. Su, G. Meng, Y. Chen, K. Wu, W. Yang, Y. Yao, G. Pu, Y. Liu, Z. Su. *Guided, Stochastic Model-Based GUI Testing of Android Apps* (Stoat). ESEC/FSE 2017. https://doi.org/10.1145/3106237.3106298
4. K. Mao, M. Harman, Y. Jia. *Sapienz: Multi-objective Automated Testing for Android Applications.* ISSTA 2016. https://doi.org/10.1145/2931037.2931054
5. T. Gu, C. Sun, X. Ma, C. Cao, C. Xu, Y. Yao, Q. Zhang, J. Lu, Z. Su. *Practical GUI Testing of Android Applications via Model Abstraction and Refinement* (APE). ICSE 2019. https://doi.org/10.1109/ICSE.2019.00042
6. Y. Li, Z. Yang, Y. Guo, X. Chen. *DroidBot: A Lightweight UI-Guided Test Input Generator for Android.* ICSE 2017 Companion. https://doi.org/10.1109/ICSE-C.2017.8
7. Y. Li, Z. Yang, Y. Guo, X. Chen. *Humanoid: A Deep Learning-Based Approach to Automated Black-box Android App Testing.* ASE 2019 (tool demo). https://doi.org/10.1109/ASE.2019.00104 (arXiv:1901.02633)
8. Z. Dong, M. Böhme, L. Cojocaru, A. Roychoudhury. *Time-travel Testing of Android Apps* (TimeMachine). ICSE 2020, ACM SIGSOFT Distinguished Paper. https://doi.org/10.1145/3377811.3380402
9. Z. Lv, C. Peng, Z. Zhang, T. Su, K. Liu, P. Yang. *Fastbot2: Reusable Automated Model-based GUI Testing for Android Enhanced by Reinforcement Learning.* ASE 2022 (industry showcase). https://doi.org/10.1145/3551349.3559505
10. Y. M. Baek, D.-H. Bae. *Automated Model-Based Android GUI Testing Using Multi-Level GUI Comparison Criteria.* ASE 2016. https://doi.org/10.1145/2970276.2970313 (abstract only)
11. Z. Liu, C. Chen, J. Wang, M. Chen, B. Wu, X. Che, D. Wang, Q. Wang. *Make LLM a Testing Expert: Bringing Human-like Interaction to Mobile GUI Testing via Functionality-aware Decisions* (GPTDroid). ICSE 2024. https://doi.org/10.1145/3597503.3639180 (arXiv:2310.15780)
12. J. Yoon, R. Feldt, S. Yoo. *Intent-Driven Mobile GUI Testing with Autonomous Large Language Model Agents* (DroidAgent). ICST 2024. https://doi.org/10.1109/ICST60714.2024.00020 (arXiv:2311.08649)
13. H. Wen, Y. Li, G. Liu, S. Zhao, T. Yu, T. J.-J. Li, S. Jiang, Y. Liu, Y. Zhang, Y. Liu. *AutoDroid: LLM-powered Task Automation in Android.* MobiCom 2024. https://doi.org/10.1145/3636534.3649379 (arXiv:2308.15272)
14. Z. Liu, C. Li, C. Chen, J. Wang, B. Wu, Y. Wang, J. Hu, Q. Wang. *Vision-driven Automated Mobile GUI Testing via Multimodal Large Language Model* (VisionDroid). arXiv:2407.03037, 2024 (preprint, not peer reviewed). https://arxiv.org/abs/2407.03037
15. T. Su, J. Wang, Z. Su. *Benchmarking Automated GUI Testing for Android against Real-World Bugs* (Themis). ESEC/FSE 2021. https://doi.org/10.1145/3468264.3468620

**Game testing and exploration**

16. J. Bergdahl, C. Gordillo, K. Tollmar, L. Gisslén. *Augmenting Automated Game Testing with Deep Reinforcement Learning.* IEEE CoG 2020. https://doi.org/10.1109/CoG47356.2020.9231552 (arXiv:2103.15819)
17. C. Gordillo, J. Bergdahl, K. Tollmar, L. Gisslén. *Improving Playtesting Coverage via Curiosity Driven Reinforcement Learning Agents.* IEEE CoG 2021. https://doi.org/10.1109/CoG52621.2021.9619048 (arXiv:2103.13798)
18. A. Sestini, L. Gisslén, J. Bergdahl, K. Tollmar, A. D. Bagdanov. *Automated Gameplay Testing and Validation With Curiosity-Conditioned Proximal Trajectories* (CCPT). IEEE Transactions on Games (online 2022). https://doi.org/10.1109/TG.2022.3226910 (arXiv:2202.10057)
19. Y. Zheng, X. Xie, T. Su, L. Ma, J. Hao, Z. Meng, Y. Liu, R. Shen, Y. Chen, C. Fan. *Wuji: Automatic Online Combat Game Testing Using Evolutionary Deep Reinforcement Learning.* ASE 2019, Distinguished Paper. https://doi.org/10.1109/ASE.2019.00077
20. A. Ecoffet, J. Huizinga, J. Lehman, K. O. Stanley, J. Clune. *First return, then explore* (Go-Explore). Nature 590, 580–586, 2021. https://doi.org/10.1038/s41586-020-03157-9
21. M. G. Bellemare, S. Srinivasan, G. Ostrovski, T. Schaul, D. Saxton, R. Munos. *Unifying Count-Based Exploration and Intrinsic Motivation.* NeurIPS (NIPS) 2016. https://arxiv.org/abs/1606.01868
22. J. Lehman, K. O. Stanley. *Abandoning Objectives: Evolution Through the Search for Novelty Alone.* Evolutionary Computation 19(2), 189–223, 2011. https://doi.org/10.1162/EVCO_a_00025

**Oracles for games and graphics**

23. C. García Ling, K. Tollmar, L. Gisslén. *Using Deep Convolutional Neural Networks to Detect Rendered Glitches in Video Games.* AIIDE 2020. https://doi.org/10.1609/aiide.v16i1.7409
24. K. Chen, Y. Li, Y. Chen, C. Fan, Z. Hu, W. Yang. *GLIB: Towards Automated Test Oracle for Graphically-Rich Applications.* ESEC/FSE 2021. https://doi.org/10.1145/3468264.3468586 (arXiv:2106.10507)
25. B. Wilkins, K. Stathis. *World of Bugs: A Platform for Automated Bug Detection in 3D Video Games.* IEEE CoG 2022. https://doi.org/10.1109/CoG51982.2022.9893616 (arXiv:2206.11037)
26. M. R. Taesiri, T. Feng, A. Nguyen, C.-P. Bezemer. *GlitchBench: Can Large Multimodal Models Detect Video Game Glitches?* CVPR 2024. https://arxiv.org/abs/2312.05291 (abstract only)
27. C. Zauner. *Implementation and Benchmarking of Perceptual Image Hash Functions.* Master's thesis, Upper Austria University of Applied Sciences, Hagenberg, 2010. https://phash.org/docs/pubs/thesis_zauner.pdf
28. K. Claessen, J. Hughes. *QuickCheck: A Lightweight Tool for Random Testing of Haskell Programs.* ICFP 2000. https://doi.org/10.1145/351240.351266

**Performance statistics**

29. A. Georges, D. Buytaert, L. Eeckhout. *Statistically Rigorous Java Performance Evaluation.* OOPSLA 2007. https://doi.org/10.1145/1297027.1297033
30. T. Kalibera, R. Jones. *Rigorous Benchmarking in Reasonable Time.* ISMM 2013. https://doi.org/10.1145/2464157.2464160 (abstract only)
31. E. Barrett, C. F. Bolz-Tereick, R. Killick, S. Mount, L. Tratt. *Virtual Machine Warmup Blows Hot and Cold.* OOPSLA 2017 (PACMPL 1). https://doi.org/10.1145/3133876 (arXiv:1602.00602)
32. D. Daly, W. Brown, H. Ingo, J. O'Leary, D. Bradford. *The Use of Change Point Detection to Identify Software Performance Regressions in a Continuous Integration System.* ICPE 2020. https://doi.org/10.1145/3358960.3375791 (arXiv:2003.00584)
33. R. Killick, P. Fearnhead, I. A. Eckley. *Optimal Detection of Changepoints With a Linear Computational Cost* (PELT). Journal of the American Statistical Association 107(500), 2012. https://doi.org/10.1080/01621459.2012.737745
34. S. Liu, A. Kuwahara, J. Scovell, M. Claypool. *The Effects of Frame Rate Variation on Game Player Quality of Experience.* CHI 2023. https://doi.org/10.1145/3544548.3580665
35. Android Developers. *Slow rendering* (Android vitals: slow frames, frozen frames). https://developer.android.com/topic/performance/vitals/frozen (platform documentation)
36. A. Arcuri, L. Briand. *A Practical Guide for Using Statistical Tests to Assess Randomized Algorithms in Software Engineering.* ICSE 2011. https://doi.org/10.1145/1985793.1985795
37. G. Klees, A. Ruef, B. Cooper, S. Wei, M. Hicks. *Evaluating Fuzz Testing.* ACM CCS 2018. https://doi.org/10.1145/3243734.3243804
38. N. Cliff. *Dominance Statistics: Ordinal Analyses to Answer Ordinal Questions.* Psychological Bulletin 114(3), 1993. https://doi.org/10.1037/0033-2909.114.3.494
39. B. Efron. *Bootstrap Methods: Another Look at the Jackknife.* Annals of Statistics 7(1), 1979. https://doi.org/10.1214/aos/1176344552
40. P. K. Sen. *Estimates of the Regression Coefficient Based on Kendall's Tau.* Journal of the American Statistical Association 63(324), 1968. https://doi.org/10.1080/01621459.1968.10480934

**Memory leaks**

41. J. Vilk, E. D. Berger. *BLeak: Automatically Debugging Memory Leaks in Web Applications.* PLDI 2018. https://doi.org/10.1145/3192366.3192376
42. L. Gong, G. Conner. *MemLab: An open source framework for finding JavaScript memory leaks.* Meta Engineering blog, 2022-09-12. https://engineering.fb.com/2022/09/12/open-source/memlab/ (industry report; code: https://github.com/facebook/memlab)
43. Square. *How LeakCanary works.* LeakCanary documentation. https://square.github.io/leakcanary/fundamentals-how-leakcanary-works/ (tool documentation)
44. D. Yan, S. Yang, A. Rountev. *Systematic Testing for Resource Leaks in Android Applications.* ISSRE 2013. https://doi.org/10.1109/ISSRE.2013.6698894

**Minimisation, replay and flakiness**

45. A. Zeller, R. Hildebrandt. *Simplifying and Isolating Failure-Inducing Input* (delta debugging). IEEE TSE 28(2), 2002. https://doi.org/10.1109/32.988498
46. L. Clapp, O. Bastani, S. Anand, A. Aiken. *Minimizing GUI Event Traces.* FSE 2016. https://doi.org/10.1145/2950290.2950342 (abstract only)
47. L. Gomez, I. Neamtiu, T. Azim, T. Millstein. *RERAN: Timing- and Touch-Sensitive Record and Replay for Android.* ICSE 2013. https://doi.org/10.1109/ICSE.2013.6606553
48. Q. Luo, F. Hariri, L. Eloussi, D. Marinov. *An Empirical Analysis of Flaky Tests.* FSE 2014. https://doi.org/10.1145/2635868.2635920
49. A. Romano, Z. Song, S. Grandhi, W. Yang, W. Wang. *An Empirical Analysis of UI-Based Flaky Tests.* ICSE 2021. https://doi.org/10.1109/ICSE43902.2021.00141

**Fragmentation**

50. L. Wei, Y. Liu, S.-C. Cheung. *Taming Android Fragmentation: Characterizing and Detecting Compatibility Issues for Android Apps* (FicFinder). ASE 2016, Distinguished Paper. https://doi.org/10.1145/2970276.2970312
51. X. Lu, X. Liu, H. Li, T. Xie, Q. Mei, D. Hao, G. Huang, F. Feng. *PRADA: Prioritizing Android Devices for Apps by Mining Large-Scale Usage Data.* ICSE 2016. https://doi.org/10.1145/2884781.2884828

**TV and D-pad navigation**

52. B. S. Ahmed, A. Gargantini, M. Bures. *An Automated Testing Framework for Smart TV Apps Based on Model Separation.* ICST 2020 workshops (INTUITESTBEDS). arXiv:2002.00404. https://arxiv.org/abs/2002.00404 (abstract only)
53. P. T. Chiou, A. S. Alotaibi, W. G. J. Halfond. *Detecting and Localizing Keyboard Accessibility Failures in Web Applications.* ESEC/FSE 2021. https://doi.org/10.1145/3468264.3468581 (abstract only)
54. W3C. *CSS Spatial Navigation Level 1.* Working Draft, 26 November 2019. https://www.w3.org/TR/css-nav-1/ (standard draft)
55. Android Developers. *TV navigation.* https://developer.android.com/training/tv/get-started/navigation (platform documentation)
56. Amazon. *VDA Reference* (Vega OS). https://developer.amazon.com/docs/vega/0.24/vda-tools.html (platform documentation)
57. Amazon. *Simulate Device Input with inputd-cli* (Vega OS). https://developer.amazon.com/docs/vega/0.24/inputdcli.html (platform documentation)

**Additions, October 2026**

58. Z. Lv et al. / ByteDance. *Fastbot: A Multi-Agent Model-Based Test Generation System.* AST 2020. (abstract only; cited by Fastbot2 [9])
59. V8 team. *JavaScript code coverage* (2017) and the Chrome DevTools Protocol Profiler domain. https://v8.dev/blog/javascript-code-coverage (platform documentation)
60. M. Pan, A. Huang, G. Wang, T. Zhang, X. Li. *Reinforcement Learning Based Curiosity-Driven Testing of Android Applications* (Q-testing). ISSTA 2020. https://doi.org/10.1145/3395363.3397354 (abstract only)
61. Y. Zheng et al. *Automatic Web Testing Using Curiosity-Driven Reinforcement Learning* (WebExplor). ICSE 2021. https://arxiv.org/abs/2103.06018 (abstract only)
62. W. Wang, D. Li, W. Yang, Y. Cao, Z. Zhang, Y. Deng, T. Xie. *An Empirical Study of Android Test Generation Tools in Industrial Cases.* ASE 2018. https://doi.org/10.1145/3238147.3240465
63. Z. Li, Y. Wu, L. Ma, X. Xie, Y. Chen, C. Fan. *GBGallery: A Benchmark and Framework for Game Testing.* EMSE 27(6), 2022. https://doi.org/10.1007/s10664-022-10158-x (abstract only)
64. F. Macklon et al. *Automatically Detecting Visual Bugs in HTML5 canvas Games.* ASE 2022. https://arxiv.org/abs/2208.02335 (abstract only)
65. C. Wang, T. Liu, Y. Zhao, M. Yang, H. Wang. *LLMDroid: Enhancing Automated Mobile App GUI Testing Coverage with LLM Guidance.* FSE 2025. https://doi.org/10.1145/3715763 (abstract only; its cost figures differ between versions)
66. Android Developers. *UI/Application Exerciser Monkey.* https://developer.android.com/studio/test/other-testing-tools/monkey (platform documentation)
67. M. Böhme, L. Szekeres, J. Metzman. *On the Reliability of Coverage-Based Fuzzer Benchmarking.* ICSE 2022. https://research.google/pubs/on-the-reliability-of-coverage-based-fuzzer-benchmarking/ (abstract only)
68. A. Vargha, H. D. Delaney. *A Critique and Improvement of the CL Common Language Effect Size Statistics.* J. Educational and Behavioral Statistics 25(2), 2000. https://doi.org/10.3102/10769986025002101
69. M. Schloegel et al. *SoK: Prudent Evaluation Practices for Fuzzing.* IEEE S&P 2024. (abstract only)
70. R. Just et al. *Are Mutants a Valid Substitute for Real Faults in Software Testing?* FSE 2014. https://doi.org/10.1145/2635868.2635929 (abstract only)
