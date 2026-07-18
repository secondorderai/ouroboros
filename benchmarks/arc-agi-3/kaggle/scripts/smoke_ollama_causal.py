#!/usr/bin/env python3
"""Exercise Qwen physicist/critic authoring against one synthetic transition."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro_arc.actions import ActionSpec  # noqa: E402
from ouro_arc.advisor import ModelAdvisor  # noqa: E402
from ouro_arc.autonomous_model import AutonomousWorldModel  # noqa: E402
from ouro_arc.causal_advisor import CausalPhysicist  # noqa: E402
from ouro_arc.model_config import apply_qwen_config, load_qwen_config  # noqa: E402
from ouro_arc.shared_mechanics import SharedMechanicsRegistry  # noqa: E402
from ouro_arc.vlm_render import grid_to_png_bytes  # noqa: E402


def main() -> None:
    config_path = ROOT / "config" / "qwen_autonomous_candidate.json"
    apply_qwen_config(load_qwen_config(config_path), backend="ollama", overwrite=False)
    os.environ.setdefault("OURO_ARC_DISABLE_MODEL", "0")
    os.environ.setdefault("OURO_ARC_GENERATED_MODEL_DIR", str(ROOT / "logs" / "causal_smoke"))
    grid = [[0 for _ in range(8)] for _ in range(8)]
    grid[2][2] = 3
    advisor = ModelAdvisor(max_new_tokens=int(os.getenv("OURO_ARC_MODEL_MAX_NEW_TOKENS", "4096")))
    registry = SharedMechanicsRegistry()
    model = AutonomousWorldModel("smoke")
    model.observe(
        level=0,
        before_grid=grid,
        action=ActionSpec(1),
        after_grid=grid,
        before_state="NOT_FINISHED",
        after_state="NOT_FINISHED",
        goal=False,
    )
    try:
        result = CausalPhysicist(advisor, registry).deliberate(
            model,
            current_grid=grid,
            available_actions={1, 2, 3, 4},
            image=grid_to_png_bytes(grid),
        )
        report = {
            "accepted": result.accepted,
            "verdict": result.verdict,
            "issues": result.issues,
            "reason": result.reason,
            "model": model.summary(),
            "advisor": advisor.diagnostics(),
        }
        print(json.dumps(report, indent=2, sort_keys=True))
        if not model.candidates:
            raise SystemExit("causal smoke failed: no validated model entered the candidate beam")
        if advisor.call_successes < 2:
            print("WARNING: critic produced no final JSON; candidate remains critic-unapproved")
    finally:
        model.close()
        registry.close()


if __name__ == "__main__":
    main()
