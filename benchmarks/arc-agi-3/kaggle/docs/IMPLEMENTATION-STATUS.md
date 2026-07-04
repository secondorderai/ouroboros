# ARC-AGI-3 Kaggle — Implementation Status (2026-07-04)

Current state of the offline Kaggle agent after the planner / holdout / efficiency
investigation. The two `future-architecture-*.drawio` files in this folder are the
original *design proposals*; this doc records what was actually **built and measured**
against them, and each diagram now carries a `0 Current Status` tab summarizing the same.

## TL;DR

- **Submitted:** kernel **version 11** (deterministic reference floor: planner + color-prior,
  Gemma off, goal-nav off). Expected LB ≈ **0.16** — a deliberate checkpoint, not a score play.
- **Best local (25 public games, official scorer):** **1.0229** / 12 levels — best to date, no regressions.
- **Generalization proxy (TEST fold, held out from all tuning):** **0.10, flat across every version.**
- **Determination:** the ARC-AGI-3 score ceiling here is bound by **model mechanic-discovery
  capability**, not by the harness/planner/algorithm. No offline-runnable, locally-validatable
  lever moved the generalization proxy.

## Score history (full 25 public games, official local scorecard)

| Build | Score | Levels |
|---|---|---|
| Pre-enhancement deterministic (frozen baseline) | 0.2421 | 8 |
| Enhancements, pre-planner | ~1.011 | 12 |
| Planner build (no color prior) | 1.0147 | 12 |
| **Current — planner + color prior (V11)** | **1.0229** | 12 |
| DEV fold (13 games, tunable) | 1.8947 | 9 |
| TEST fold (9 games, LB proxy — never tuned on) | 0.1044 | 3 |
| Public leaderboard (V9/V10, hidden games) | 0.16 | — |

**Key gap:** local 1.02 vs LB 0.16 is overfitting to the public set. The TEST fold (0.10) is the
honest LB stand-in, and it did not move — public-game gains don't transfer to hidden games.

## What was built this session

| Component | Files | Ship state | Measured effect |
|---|---|---|---|
| Transition graph (consumes dead `transition_memory`) | `ouro_arc/transition_graph.py` | on | neutral (feeds planner) |
| Symbolic planner (`_planner_plan`, BFS to score/frontier) | `controller.py` | **on** (`OURO_ARC_PLANNER_MIN_NODES=6`, kill-switch `OURO_ARC_DISABLE_PLANNER`) | 0% (fires 1–9%, augments not monopolizes) |
| Cross-level color prior (learn click outcome by color) | `click_board.py` | **on** | **+0.8% DEV**, TEST flat |
| Object-graph state key | `objects.py`, `render.py`, `controller.py` | **off** (`OURO_ARC_STATE_KEY=pixel`) | 0% (neutral on public games) |
| Goal-directed navigation (actuator + heuristic goal) | `objects.goal_targets`, `movement.step_toward`, `_goal_nav_plan` | **off** (`OURO_ARC_GOAL_NAV`) | **negative** — regressed ls20 to 0 |
| Holdout harness (frozen DEV/TEST/QUARANTINE split) | `ouro_arc/holdout.py`, `scripts/holdout_gate.py`, `baselines/holdout_best.json` | tooling | gate blocks `make notebook` on TEST regression |
| Overfit linter (game-id/coord leakage) | `scripts/overfit_lint.py` | tooling | wired into `make test` |
| Efficiency diagnostic (per-level baseline vs actual) | `scripts/level_efficiency.py` | tooling | revealed the headroom analysis |

141 unit tests green; overfit-lint clean; notebook rebuilt (deterministic variant).

## Levers measured, and why the ceiling holds

Seven distinct levers, all neutral-to-negative on the generalization proxy:

1. Transition-graph planner — **0%**
2. Object-graph state key — **0%**
3. Cross-level color prior — **+0.8% DEV** (kept), TEST flat
4. Goal-directed navigation — **negative** (heuristic goal detection is unreliable)
5. State-cycling / novelty bias — **no score benefit** (the cycling waste is on levels that never complete)
6. Budget `MAX_ACTIONS 320→640` — **0% new levels** (ft09 L4: 475 actions still fails; ls20 L1: 336 still fails) → **capability-bound, not budget-bound**
7. Constraint-board improvement — **overfit** (it's a hardcoded solver for one game's grammar; no TEST-fold game uses it)

### Why efficiency can't be captured here
The scorecard is quadratic in per-level efficiency, `(baseline/actions_for_level)² × 100`, and
level-weighted (level 0 weight 1, level 1 weight 2, …). So:
- The **accessible** headroom (level-0 efficiency on movement games) is **low-weight**.
- The **high-weight** headroom (completing levels 1+) is **capability-bound**.
- Level-0 wandering (ls20: 305 actions vs baseline 22) is **near-optimal blind search** — 301
  distinct states, only 19 revisits — because the agent cannot perceive *where the goal is*.

### The ls20 finding that reshapes the VLM plan
Tracing ls20's winning frame: at level completion the player moved **and terrain transformed at
row 5 simultaneously**. The win is a **mechanic / terrain transformation, not "reach cell X."**
So a "VLM names a goal → navigate to it" design is **architecturally mismatched** to such games —
the model would have to reason about the game's *rule*, which is the core ARC-AGI-3 capability
(frontier models ≈ 0.5%).

## Gemma-VLM status: ~0% implemented

- `GemmaAdvisor` (`gemma.py`) is **hardened** (fail-open, never aborts a run) but has **never run
  with real weights** — `gemma_calls` is 0 in every local run.
- It accepts an `image` param, but **no image/VLM path is wired** (`_ask_gemma` never passes one).
- **Not built:** image rendering → VLM prompt → goal/action output → actuator plumbing.
- **Blocker:** cannot be validated locally (no GPU, no weights). Everything past "build the plumbing"
  needs the GPU environment.
- **Caveat:** even validated, the ls20 mechanic finding means goal-detection alone won't help
  mechanic games; keep expectations calibrated.

## Anti-overfitting discipline (in force)

- Frozen split — **DEV(13):** ft09 m0r0 sp80 s5i5 ls20 lp85 cn04 tr87 sb26 sk48 bp35 r11l tu93;
  **TEST(9):** vc33 lf52 su15 sc25 g50t wa30 ka59 dc22 tn36; **QUARANTINE(3):** ar25 re86 cd82.
- Tune on DEV only; TEST is read-only proxy; QUARANTINE untouched until a final calibration.
- `make notebook` is blocked on any TEST-fold regression; submit only on a TEST ratchet advance.

## Recommended next steps

1. **Accept the capability ceiling** with V11 as the reference floor (evidence-backed default).
2. **Build the Gemma-VLM plumbing** (image prompt → VLM advise → actuator) for GPU validation —
   scoped to *mechanic* reasoning, not just goal detection. Detailed plan: [`GEMMA-VLM-PLAN.md`](GEMMA-VLM-PLAN.md).
3. **A materially stronger vision-reasoning model** that fits the offline rerun is the only input
   that could plausibly move the ceiling; the 12B Gemma is unlikely to suffice.
