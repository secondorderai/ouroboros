# Ouroboros ARC-AGI-3 Kaggle Submission

This directory contains the offline Kaggle submission and local public-game
validation harness for ARC Prize 2026 ARC-AGI-3.

The default agent remains deterministic: scene perception, mechanic induction,
an observed-transition model, and CPU search select every action. Two opt-in
Qwen3.5-4B experiments are available: the existing hypothesis ranker and an
autonomous causal world model that writes isolated per-game Python simulators.

## Local Setup

```bash
cd benchmarks/arc-agi-3/kaggle
make setup
make test
make verify-local
```

Local play is model-free unless `--model` is supplied. The shared behavior is
defined by `config/qwen_candidate.json`; both local Ollama and Kaggle
Transformers consume this file.

```bash
ollama pull qwen3.5:4b-mlx
python3 scripts/smoke_ollama_vlm.py
make score-local-qwen
```

The local Qwen baseline uses `qwen3.5:4b-mlx`, thinking enabled, one call per
game, vision enabled, greedy generation, and a 4096-token output budget. These
can be overridden with model-neutral `OURO_ARC_MODEL_*` variables. Legacy
`OURO_ARC_GEMMA_*` names remain temporary fallback aliases.

For structured thinking calls, `max_new_tokens` is the usable answer allowance.
The runtime reserves an equal private-reasoning allowance, so the default causal
transport limit is 8192 generated tokens while the answer contract remains 4096.

Useful commands:

```bash
make score-local-deterministic
make replay-world-model TRACE=logs/ouro_arc_trace.jsonl
make generalization-report
make holdout
```

## Autonomous Causal Model

`config/qwen_autonomous_candidate.json` enables the Schema-style loop:

```text
observe -> revise retained model -> sequential replay -> critic -> probe/CPU plan -> verify
```

Generated code implements `parse_observation`, `available_actions`, `step`,
`render`, `is_goal`, and `canonicalize`. It runs in a separate constrained
process with a private workspace. Game source, repository files, environment
variables, networking, child processes, native loading, and unsafe imports are
blocked. Deterministic exact replay authorizes multi-action planning; the critic
remains advisory for planning and mandatory for helper promotion. Partial models
remain available for one-step discriminating probes. The controller aborts on
the first predicted-grid, state, or canonical-hash mismatch.

Evidence contains the complete compact timeline, action-conditioned rigid-object
tracks, exact changed-cell tuples, separate connected change-region crops, and
spatial effect signatures. This keeps distant changes from being collapsed into
an unchanged crop and distinguishes identical color flows moving in different
directions.

```bash
make trace-causal-game GAME=ls20 STEPS=120
make score-local-qwen-causal-no-transfer
make score-local-qwen-causal
make score-local-qwen-causal-transfer
make compare-causal-ablation
make audit-generated-model SOURCE=/path/to/world_model.py
```

The full causal run deliberately optimizes all 25 public games. Its output must
be described as public-set optimization, not evidence of hidden-game
generalization. The core candidate disables transfer. Generic helpers can
transfer in the separate transfer candidate only after exact replay, critic,
source, and host-generated metamorphic checks.

The world model keeps exact observed transitions as the only executable rules.
It also induces coordinate-free mechanic templates from scene composition and
semantic action targets. Those templates rank safe, high-information CPU probes
and expose support, contradictions, prequential prediction accuracy, calibration,
and probe efficiency in local and Kaggle result artifacts.

`make generalization-report` compares the current run with the frozen V11
baseline across five fixed folds. Promotion requires complete coverage, no
per-game regression, and no fold-level loss. The DEV/TEST/QUARANTINE discipline
remains the stronger tuning boundary; the five-way report is for ablations and
variance detection.

## Qwen Model Packaging

Kaggle uses the official `Qwen/Qwen3.5-4B` Transformers checkpoint pinned to
revision `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`. Weights are downloaded into
a gitignored staging directory, verified, hashed, and published as a private
Kaggle Model. Ollama and MLX files are never packaged.

```bash
make qwen-model-stage
make qwen-model-push
make qwen-runtime-wheels-push
```

The expected private model source is
`kinwochan/qwen-3-5-4b/transformers/qwen-3-5-4b/1`. Kaggle inference is BF16,
CUDA-only, SDPA, serialized, greedy, and offline.

Qwen3.6-27B-FP8 is a separate Kaggle-only candidate because its 30.9 GB
checkpoint does not fit the local 16 GB machine. It is pinned to revision
`e89b16ebf1988b3d6befa7de50abc2d76f26eb09` and published separately:

```bash
make qwen36-model-stage
make qwen36-model-check
make qwen36-model-push
```

The RTX validation notebook defaults to the ready public Kaggle mirror
`michaelpoluektov/qwen3-6-27b-fp8/transformers/default/1`. Its file names and
byte sizes match the pinned Hugging Face snapshot. The private model targets
remain available when an account-owned mirror is required.

The Qwen3.6 verifier checks the model index, every referenced Safetensor shard,
the `qwen3_5` architecture tag, and the fine-grained `fp8` quantization marker.
It never packages Ollama or MLX data.

## RTX Validation

The private validation kernel runs sequentially against all 25 packaged public
games with seed 0. It is isolated from the competition submission notebook.

```bash
make kaggle-gpu-assets-push
make kaggle-gpu-push GPU_STAGE=smoke
make kaggle-gpu-status
make kaggle-gpu-pull
make kaggle-gpu-analyze
```

Use `make kaggle-gpu-push-causal GPU_STAGE=smoke` for the autonomous candidate.
After validation and promotion, its competition configuration uses a fixed
16-action discovery phase, stable game-ID inference ordering, deterministic
helper merge, and a two-phase barrier. A 12-minute timeout releases every game
with the pre-discovery library rather than exposing a partial order-dependent
merge.

After smoke passes, run `GPU_STAGE=pilot`. The pilot compares thinking off and
on over `ls20`, `ft09`, `vc33`, and `tn36`. Run `GPU_STAGE=full` with the
selected `GPU_SELECTED_MODE`. The artifacts are `qwen_gpu_validation.json`,
`qwen_gpu_validation.md`, and failed-game traces.

The generated kernel requests Kaggle's canonical `NvidiaRtxPro6000` machine
shape by default. Its hardware gate rejects P100, CPU fallback, and model
offload before the validation stages run.

The Qwen3.6 experiment uses a separate private notebook and Transformers 5.14.1:

```bash
make kaggle-gpu-assets-push
make kaggle-qwen36-gpu-push GPU_STAGE=smoke
make kaggle-qwen36-gpu-status
make kaggle-qwen36-gpu-pull
make kaggle-qwen36-gpu-analyze
```

Its smoke additionally requires compute capability 8.9 or newer, active FP8
modules, no unscaled FP8 linear layers, no FP8-to-BF16 expansion, CUDA-only parameters, strict multimodal JSON,
and peak allocated VRAM below 80 GiB. Only a passing smoke should advance to
`GPU_STAGE=pilot`, followed by `GPU_STAGE=full` with the frozen selected mode.

## Promotion and Submission

The deterministic notebook remains model-free. A Qwen submission can only be
built after a full validation report passes the score, regression, failure,
memory, and runtime gates:

```bash
make kaggle-gpu-promote
OURO_ARC_SUBMISSION_QWEN=1 make submit
```

Promotion writes `config/qwen_promoted.json`. The Qwen notebook then attaches
the private Qwen model and offline runtime-wheel dataset. Plain `make submit`
detaches both and disables model inference on every path.

The promotion threshold is a score above `1.0278557578743325`, with no lost
levels on previously solved games, no fatal model or OOM failures, all 25 games
completed, and acceptable runtime.

## Verification

Changes under this benchmark run:

```bash
python3 -m unittest discover -s tests
cd /Users/henry/workspace/ouroboros
bun run lint
bun run ts-check
bun run test:cli
```

Desktop E2E is intentionally skipped for benchmark-only changes.
