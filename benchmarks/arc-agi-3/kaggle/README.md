# Ouroboros ARC-AGI-3 Kaggle Submission

This directory contains the offline Kaggle submission and local public-game
validation harness for ARC Prize 2026 ARC-AGI-3.

The default agent is deterministic: scene perception, mechanic induction, an
executable transition model, and CPU search select every action. Qwen3.5-4B is
an opt-in hypothesis advisor. It can rank CPU-generated mechanic hypotheses
after deterministic induction is stuck, but it cannot enqueue actions.

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

Useful commands:

```bash
make score-local-deterministic
make replay-world-model TRACE=logs/ouro_arc_trace.jsonl
make generalization-report
make holdout
```

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

After smoke passes, run `GPU_STAGE=pilot`. The pilot compares thinking off and
on over `ls20`, `ft09`, `vc33`, and `tn36`. Run `GPU_STAGE=full` with the
selected `GPU_SELECTED_MODE`. The artifacts are `qwen_gpu_validation.json`,
`qwen_gpu_validation.md`, and failed-game traces.

The generated kernel requests Kaggle's canonical `NvidiaRtxPro6000` machine
shape by default. Its hardware gate rejects P100, CPU fallback, and model
offload before the validation stages run.

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
