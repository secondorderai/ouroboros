# Ouroboros ARC-AGI-3 Kaggle Submission

This directory contains the offline Kaggle submission path for ARC Prize 2026
ARC-AGI-3. It is separate from the live scorecard harness one level up.

The submitted agent is a Python `MyAgent` for the official
`ARC-AGI-3-Agents` framework. Local full Ouroboros runs with a remote
high-effort model can be used as the teacher for skill distillation; the Kaggle
runtime is the offline student. In Kaggle reruns, Gemma 4 12B Unified is used
actively on GPU to choose among distilled skills and solver plans, while the
deterministic controller executes and validates actions.

## Layout

- `agent/my_agent.py`: framework adapter copied into the Kaggle notebook.
- `ouro_arc/`: testable strategy package: render/object summaries, graph
  exploration, macro replay, action validation, and Gemma prompting.
- `skills/`: Agent Skills source of truth for distilled ARC strategies.
- `scripts/play_local.py`: local ARC-AGI-3 runner using `arc-agi`.
- `scripts/compile_skills.py`: compiles Agent Skills into Kaggle runtime JSON.
- `scripts/build_notebook.py`: generates `notebooks/submission.ipynb`.
- `scripts/package_model.py`: validates or stages the attached Gemma model.
- `tests/`: deterministic unit tests that do not need `arc-agi` or Gemma.

## Local Loop

```bash
cd benchmarks/arc-agi-3/kaggle
make setup
make test
make compile-skills
make verify-local
make notebook
```

`make setup`, `make verify-local`, `make play-local`, and `make list-games`
rewrite the vendored framework's `agents/__init__.py` to avoid optional
template imports such as `langsmith`, `langgraph`, and `smolagents`.

Local play disables Gemma by default with `OURO_ARC_DISABLE_MODEL=1`, so smoke
tests can run without a 12B model. Kaggle reruns default to
`OURO_ARC_GEMMA_POLICY=active`; local runs default to sparse unless you set the
policy explicitly. To test with a local model:

```bash
OURO_ARC_DISABLE_MODEL=0 OURO_ARC_GEMMA_POLICY=active \
  OURO_ARC_MODEL_PATH=/path/to/gemma-4-12b \
  make play-local GAME=ls20 STEPS=200
```

Use `OURO_ARC_GEMMA_POLICY=every` only for short experiments; it asks Gemma after
the opening probes on nearly every state and can burn the action budget on slow
hardware.

## Skill Distillation

Distilled strategy lives as Agent Skills under `skills/*/SKILL.md`. The Kaggle
runtime loads the compact compiled artifact at `ouro_arc/distilled_skills.json`.
After editing or generating skills, compile and validate before building the
notebook:

```bash
python3 scripts/extract_traces.py ../*-run.log > /tmp/ouro_traces.json
python3 scripts/distill_skills.py /tmp/ouro_traces.json
make compile-skills
```

Validation rejects game ids, frame hashes, static public-game macros, and
coordinate-heavy walkthroughs so the submitted artifact remains generic.

## Kaggle Model Input

Official competition reruns have internet disabled. Attach Gemma 4 12B Unified
as a Kaggle model or dataset input and set `OURO_ARC_MODEL_PATH` if its path is
not one of the defaults:

- `/kaggle/input/gemma-4/transformers/gemma-4-12b/1`
- `/kaggle/input/gemma-4/transformers/gemma-4-12b-unified/1`
- `/kaggle/input/gemma-4/transformers/gemma-4-12b-it/1`
- `/kaggle/input/gemma-4`

During `KAGGLE_IS_COMPETITION_RERUN`, missing model weights are a hard error.

## Submission

Edit `notebooks/kernel-metadata.json` and replace
`REPLACE_WITH_YOUR_USERNAME`, then:

```bash
mkdir -p .kaggle
printf '%s\n' 'KGAT_...' > .kaggle/access_token
chmod 600 .kaggle/access_token
make submit
make status
```

The generated notebook uses the `rtx6000` accelerator, disables internet, and
loads all authored code from generated cells plus model weights from
`/kaggle/input`.
