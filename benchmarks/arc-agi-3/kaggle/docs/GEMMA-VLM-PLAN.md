# Plan: Gemma-VLM Mechanic-Reasoning Advisor (Experiment)

Status: **proposed, not started.** Companion to [`IMPLEMENTATION-STATUS.md`](IMPLEMENTATION-STATUS.md)
and the `future-architecture-gemma.drawio` diagram. This is an **experiment with explicit
kill criteria**, not a committed feature — its purpose is to *measure* whether an offline
vision model adds any lift over the deterministic V11 floor, cheaply and without risking that floor.

## Context & the reframe

- V11 (deterministic: planner + color prior, Gemma off) is the submitted reference floor; expected LB ≈ 0.16.
- Seven deterministic levers were measured; none moved the generalization proxy (TEST fold flat at 0.10).
  The ceiling is **model mechanic-discovery capability**, not the harness.
- **The critical lesson:** tracing ls20's winning frame showed its level completion is a **terrain / mechanic
  transformation, not "reach cell X".** So the earlier "VLM names a goal → navigate to it" design is
  **architecturally mismatched**. Any VLM here must reason about the game's **rule/mechanic**, not just spot an object.
- The 12B Gemma is a **VLM**; today the agent feeds it a *text* grid render and never passes an image.
- **This path is a long shot** (frontier models score ~0.5% on ARC-AGI-3 mechanic discovery). The plan is
  designed so almost all work is **local and mockable**, so we learn the answer *before* spending GPU time or a submission.

## Objective & decision criteria

**Objective:** determine whether a sparse, image-based Gemma advisor — reasoning about game mechanics and
proposing actions the deterministic controller validates and executes — produces a **net TEST-fold lift**
at **acceptable rerun cost**, shipped **only** as a parallel A/B alongside V11.

**Ship criteria (all must hold):**
1. Real-weights smoke test passes (loads, one `advise()` round-trip returns parseable output).
2. Cost is affordable: `seconds_per_call × max_calls_per_game × games` fits the rerun wall-clock budget.
3. Local A/B (mock or recorded VLM) shows **no DEV regression** and the harness is correct.
4. GPU A/B shows a **TEST-fold ratchet advance** (per the holdout cadence rule).

**Kill criteria (any triggers stop / don't ship):**
- Too slow to fit the rerun budget even at minimal gating.
- Net-negative or flat on DEV/TEST (like goal-nav, which regressed).
- Load/inference instability that the fail-open path can't fully absorb.

If killed, we keep the plumbing behind a default-off flag and V11 remains the floor.

## Architecture (neuro-symbolic: neural proposes, symbolic disposes)

```
board grid --render--> PNG image  ┐
object inventory + recent transitions + available actions + candidate solver plans ┼--> Gemma VLM
                                   ┘         (sparse, stagnation-gated, capped, fail-open)
                                                       │  strict JSON: {mode, actions[], hypothesis, confidence}
                                                       ▼
                                        parse -> filter to LEGAL + SAFE ActionSpecs
                                                       ▼
                                   enqueue as source="model"  ->  ArcController executes & validates
                                        (auto-demotes if it makes no progress; abort-on-key-change)
```

- The VLM is a **consultant**, not the policy. It only fires when the deterministic cascade is dry
  (stagnation), within a per-game call cap, with failure backoff — reusing the existing `GemmaAdvisor`
  safety machinery (fail-open, latch-off on load failure).
- Output is an **action plan** (reuse the existing `parse_model_plan` → legal `ActionSpec` path). This is
  strictly more general than goal-coordinates and matches the mechanic-reasoning framing.
- Optional secondary path: if the VLM returns a `goal:[x,y]` for a clearly navigational game, feed the
  existing `MovementModel.step_toward` actuator. Kept behind its own sub-flag; not the primary mode.

## Phases

### Phase 1 — Local plumbing (NO GPU; fully unit-testable)
1. **Image render** — `ouro_arc/vlm_render.py`: `grid_to_png(grid) -> bytes` (64×64 cells → color-palette
   PNG, optional coordinate ruler). Pure, deterministic, testable byte output. No heavy deps beyond what
   Kaggle provides (PIL/`matplotlib` Agg, or hand-rolled PNG to avoid a dep).
2. **Image-advise mode** — extend `GemmaAdvisor.advise(...)` to actually pass the image to the processor
   (the `image` arg already exists but is never used); add a mechanic-reasoning **system prompt** and an
   image + structured-context **user prompt** (object inventory, last N transitions with outcomes, available
   actions, top candidate solver plans). Keep the strict-JSON contract and `parse_model_plan`.
3. **Controller wiring** — a `_should_ask_gemma` gate already exists; ensure `_ask_gemma` builds the image
   prompt when `OURO_ARC_GEMMA_VISION=1`. No new fatal paths (advisor exceptions already contained).
4. **Mock/oracle harness** — a `MockVLM` (returns scripted plans) for tests, and an oracle mode
   (`OURO_ARC_VLM_ORACLE`) that injects a fixed plan, so the end-to-end loop is validated with zero weights.
5. **Tests** — `tests/test_vlm_render.py` (PNG shape/palette determinism), `tests/test_gemma.py`
   (image passed to processor; mechanic-prompt built; MockVLM plan parsed → legal ActionSpec; fail-open on
   image-render error). Everything green under `python3 -m unittest`.

### Phase 2 — GPU validation (NEEDS the user's GPU + Gemma weights)
1. **Real-weights smoke test** — interactive Kaggle GPU session (or local GPU): attach Gemma-4-12b,
   `load()` + one image `advise()` round-trip. **This has never happened** (`gemma_calls` = 0 to date).
2. **Cost measurement** — seconds/call on rtx6000 with a realistic image prompt; compute the max affordable
   `OURO_ARC_GEMMA_MAX_CALLS` given the rerun wall-clock budget. This number alone may kill the idea.
3. **Mechanic-reasoning spot check** — on 3–4 DEV games (incl. a mechanic game like ls20 and a click game
   like ft09), does the VLM's suggestion correlate with progress at all? Qualitative go/no-go.

### Phase 3 — Local A/B (mock or recorded VLM) & the holdout gate
1. Record VLM outputs from the Phase-2 GPU session to a fixture, or use the mock, and run the DEV fold
   with vision on vs off. Confirm **no DEV regression** and correct gating (calls fire only on stagnation,
   within cap).
2. Run the TEST fold; require a **ratchet advance** (`scripts/holdout_gate.py`). Flat/negative → do not ship.

### Phase 4 — Ship decision (only if Phases 2–3 pass)
1. Build the **gemma-sparse variant** via the existing `OURO_ARC_SUBMISSION_GEMMA=1` build switch
   (`build_notebook.py` already attaches `model_sources`, enables GPU, sets sparse policy + call cap).
2. Submit **alongside** V11, never replacing it. Log `{git_sha, dev_score, test_score, LB}` in the ledger.

## Reuse (already built — do not rebuild)

- `GemmaAdvisor` fail-open machinery (latch-off, backoff, `parse_model_plan`, `filter_legal_actions`).
- `_ask_gemma` / `_should_ask_gemma` gating + `OURO_ARC_GEMMA_POLICY` / `_INTERVAL` / `_MAX_CALLS` / backoff knobs.
- `build_notebook.py` `OURO_ARC_SUBMISSION_GEMMA` variant switch + `sync_metadata` (model_sources / GPU).
- `MovementModel.step_toward` + `objects.goal_targets` (optional navigational sub-path, currently flag-off).
- Holdout gate + overfit lint + `level_efficiency.py` for measurement.

## Cost model (the make-or-break constraint)

Rerun wall-clock is the binding limit. Rough budget check to run in Phase 2:

```
total_vlm_seconds ≈ seconds_per_call × avg_calls_per_game × num_games
```

Keep it a small fraction of the notebook's max runtime. Gate hard: stagnation-only trigger, low
`MAX_CALLS` (e.g. 4–8/game), backoff on failure, and a global wall-clock guard that disables the advisor
if it has already consumed its time budget. If seconds/call is large (a 12B VLM can be slow), the idea may
be viable only at very sparse gating — which also caps its upside.

## Risks

- **Capability** (most likely): the 12B can't reason about ARC mechanics reliably → neutral/negative, killed in Phase 3.
- **Latency**: too slow for the rerun budget → killed in Phase 2.
- **Displacement**: bad suggestions preempt working solvers → mitigated by validated-enqueue + auto-demotion + gating.
- **Instability**: load/inference crashes → fully absorbed by the existing fail-open path (V7/V8 zero-out mode is fixed).

## Honest expectation

This is the **only credible path** to a real score gain, but its probability of clearing the Phase-3 TEST
gate is low given 12B capability limits and the mechanic-reasoning demand the ls20 evidence exposed. The
value of the plan is that it **spends ~1 GPU session to get a definitive answer** while keeping V11 safe —
far cheaper than guessing. Treat a null result as a valid, informative outcome, not a failure.
