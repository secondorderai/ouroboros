from __future__ import annotations

import argparse
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
    candidate = report.get("candidate_config", {})
    config: dict[str, object] = {
        "backend": "transformers",
        "model_family": candidate.get("model_family", "qwen3.5-4b"),
        "upstream_repo": candidate.get("upstream_repo", "Qwen/Qwen3.5-4B"),
        "upstream_revision": candidate.get(
            "upstream_revision", "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
        ),
        "policy": candidate.get("policy", "hypothesis"),
        "vision": bool(candidate.get("vision", True)),
        "scientist_prompt": bool(candidate.get("scientist_prompt", True)),
        "think": think,
        "interval": int(candidate.get("interval", 48)),
        "max_calls": int(candidate.get("max_calls", 1)),
        "max_new_tokens": int(candidate.get("max_new_tokens", 4096)),
        "timeout_seconds": int(candidate.get("timeout_seconds", 300)),
        "time_budget_seconds": int(candidate.get("time_budget_seconds", 900)),
        "dtype": candidate.get("dtype", "bf16"),
        "serialize_inference": bool(candidate.get("serialize_inference", True)),
        "validation_score": float(report["full"]["score"]),
        "validation_mode": selected,
    }
    for key in (
        "kaggle_model_source",
        "expected_quant_method",
        "do_sample",
        "temperature",
        "top_p",
        "top_k",
        "seed",
        "fp8_fix_gate_proj",
        "require_scaled_fp8",
    ):
        if key in candidate:
            config[key] = candidate[key]
    if candidate.get("world_model_mode") == "autonomous-python":
        for key in (
            "world_model_mode",
            "world_model_beam",
            "worker_timeout_seconds",
            "worker_memory_mb",
            "search_states",
            "search_depth",
            "critic",
            "shared_mechanics",
            "discovery_actions",
            "max_stalled_revisions",
            "prompt_max_chars",
            "discovery_barrier_seconds",
        ):
            if key in candidate:
                config[key] = candidate[key]
        config["discovery_barrier"] = True
        config["discovery_participants"] = 25
    return config


def promotion_result(
    report: dict,
    baseline: dict,
    *,
    allow_failed_validation: bool = False,
) -> tuple[dict[str, object], dict]:
    full = report.get("full")
    if not isinstance(full, dict):
        raise ValueError("validation report has no full run")
    gate = evaluate_promotion(full, baseline)
    if not gate["promote"] and not allow_failed_validation:
        raise ValueError("Qwen submission promotion blocked")
    config = promoted_config(report)
    config["validation_gate_passed"] = bool(gate["promote"])
    config["validation_gate_reasons"] = list(gate["reasons"])
    config["baseline_study_override"] = bool(
        allow_failed_validation and not gate["promote"]
    )
    return config, gate


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", nargs="?", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("output", nargs="?", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--allow-failed-validation",
        action="store_true",
        help="promote a failed run only for an explicitly approved baseline study",
    )
    args = parser.parse_args()
    report_path = args.report
    output_path = args.output
    report = json.loads(report_path.read_text(encoding="utf-8"))
    baseline = json.loads(DEFAULT_BASELINE.read_text(encoding="utf-8"))
    try:
        config, gate = promotion_result(
            report,
            baseline,
            allow_failed_validation=args.allow_failed_validation,
        )
    except ValueError as exc:
        gate = evaluate_promotion(report.get("full", {}), baseline)
        for reason in gate["reasons"]:
            print(f"BLOCKED: {reason}")
        raise SystemExit(str(exc)) from exc
    if not gate["promote"]:
        for reason in gate["reasons"]:
            print(f"BASELINE STUDY OVERRIDE: {reason}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote promoted Qwen config: {output_path}")


if __name__ == "__main__":
    main()
