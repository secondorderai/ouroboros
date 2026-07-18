from __future__ import annotations

import os
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ouro_arc.advisor import DEFAULT_OLLAMA_MODEL, ModelAdvisor
from ouro_arc.model_config import apply_qwen_config, load_qwen_config, model_flag
from ouro_arc.vlm_render import grid_to_png_bytes


def synthetic_grid() -> list[list[int]]:
    grid: list[list[int]] = []
    for y in range(64):
        row: list[int] = []
        for x in range(64):
            if x < 32 and y < 32:
                row.append(2)
            elif x >= 32 and y < 32:
                row.append(3)
            elif x < 32:
                row.append(1)
            else:
                row.append(4)
        grid.append(row)
    return grid


def main() -> None:
    apply_qwen_config(load_qwen_config(), backend="ollama", overwrite=False)
    os.environ.setdefault("OURO_ARC_MODEL_BACKEND", "ollama")
    os.environ.setdefault("OURO_ARC_OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL)
    os.environ.setdefault("OURO_ARC_MODEL_TIMEOUT_SECONDS", "300")

    advisor = ModelAdvisor(max_new_tokens=4096)
    prompt = (
        "Image is attached. Rank these deterministic mechanic hypotheses: "
        "h-a1-xn-yn means action 1 changes the scene; "
        "h-a2-xn-yn means action 2 changes the scene. "
        "Return a hypothesis-only AdvisorPlan using only those ids."
    )
    started = time.monotonic()
    plan = advisor.advise(prompt, {1}, image=grid_to_png_bytes(synthetic_grid()))
    elapsed = time.monotonic() - started

    if plan is None:
        raise SystemExit("Ollama VLM smoke failed: no parseable Qwen AdvisorPlan")
    if plan.mode != "hypothesis" or not plan.ranked_hypotheses:
        raise SystemExit(f"Ollama VLM smoke failed: unexpected plan {plan!r}")
    print(
        "Ollama VLM smoke passed "
        f"model={os.getenv('OURO_ARC_OLLAMA_MODEL')} "
        f"think={int(model_flag('THINK'))} "
        f"seconds={elapsed:.2f} "
        f"ranked_hypotheses={list(plan.ranked_hypotheses)} "
        f"confidence={plan.confidence:.2f}"
    )


if __name__ == "__main__":
    main()
