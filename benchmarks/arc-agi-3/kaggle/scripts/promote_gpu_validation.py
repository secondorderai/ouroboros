from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro_arc.gpu_validation import evaluate_promotion  # noqa: E402


DEFAULT_REPORT = ROOT / "logs" / "kaggle-qwen-validation" / "qwen_gpu_validation.json"
DEFAULT_BASELINE = ROOT / "baselines" / "deterministic_public_v11.json"
DEFAULT_OUTPUT = ROOT / "config" / "qwen_promoted.json"


def promoted_config(report: dict) -> dict[str, object]:
    selected = str(report.get("selection", {}).get("selected_mode", ""))
    if selected not in {"thinking_off", "thinking_on"}:
        raise ValueError("validation report has no selected thinking mode")
    think = selected == "thinking_on"
    return {
        "backend": "transformers",
        "model_family": "qwen3.5-4b",
        "upstream_repo": "Qwen/Qwen3.5-4B",
        "upstream_revision": "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
        "policy": "hypothesis",
        "vision": True,
        "scientist_prompt": True,
        "think": think,
        "interval": 48,
        "max_calls": 1,
        "max_new_tokens": 4096,
        "timeout_seconds": 300,
        "time_budget_seconds": 900,
        "dtype": "bf16",
        "serialize_inference": True,
        "validation_score": float(report["full"]["score"]),
        "validation_mode": selected,
    }


def main() -> None:
    report_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_REPORT
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUTPUT
    report = json.loads(report_path.read_text(encoding="utf-8"))
    baseline = json.loads(DEFAULT_BASELINE.read_text(encoding="utf-8"))
    full = report.get("full")
    if not isinstance(full, dict):
        raise SystemExit("validation report has no full run")
    gate = evaluate_promotion(full, baseline)
    if not gate["promote"]:
        for reason in gate["reasons"]:
            print(f"BLOCKED: {reason}")
        raise SystemExit("Qwen submission promotion blocked")
    config = promoted_config(report)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote promoted Qwen config: {output_path}")


if __name__ == "__main__":
    main()
