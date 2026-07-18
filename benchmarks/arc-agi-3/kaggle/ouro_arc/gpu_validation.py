from __future__ import annotations

import math
from statistics import median
from typing import Any

from .holdout import ALL_PUBLIC_GAMES, normalize_game_id
from .generalization import compare_runs


PILOT_GAMES = ("ls20", "ft09", "vc33", "tn36")
PUBLIC_GAMES = tuple(sorted(ALL_PUBLIC_GAMES))
BASELINE_SCORE = 1.0228557578743325
LOCAL_QWEN_SCORE = 1.0228557578743325
# Compatibility alias for previously recorded Gemma reports.
LOCAL_OLLAMA_SCORE = LOCAL_QWEN_SCORE


def gpu_matches_expectation(hardware: dict[str, object], expected: str) -> bool:
    """Return true when CUDA is available and the expected GPU name is present."""
    if not bool(hardware.get("cuda_available")):
        return False
    actual = str(hardware.get("gpu", "")).casefold()
    expected_tokens = expected.casefold().split()
    return bool(expected_tokens) and all(token in actual for token in expected_tokens)


def model_is_cuda_only(model: dict[str, object]) -> bool:
    """Reject unloaded, CPU-offloaded, or disk-offloaded model diagnostics."""
    device = str(model.get("device", "")).casefold()
    if not device.startswith("cuda"):
        return False
    raw_map = model.get("device_map", {})
    if not isinstance(raw_map, dict):
        return False
    values = [str(value).casefold() for value in raw_map.values()]
    return all(value.startswith("cuda") or value.isdigit() for value in values)
PROMOTION_EPSILON = 0.005
MAX_PROJECTED_MODEL_SECONDS = 2 * 60 * 60
MAX_FULL_RUNTIME_SECONDS = 5 * 60 * 60


def achieved_levels(row: dict[str, Any]) -> int:
    return max(
        int(row.get("levels_completed", 0) or 0),
        int(row.get("max_level_reached", 0) or 0),
    )


def percentile(values: list[float], percentile_value: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(value) for value in values)
    rank = max(0, min(len(ordered) - 1, math.ceil(percentile_value * len(ordered)) - 1))
    return ordered[rank]


def summarize_run(result: dict[str, Any]) -> dict[str, Any]:
    games = list(result.get("games", []) or [])
    model = dict(result.get("model", {}) or {})
    attempts = int(model.get("call_attempts", 0) or 0)
    successes = int(model.get("call_successes", 0) or 0)
    latencies = [float(value) for value in model.get("call_latencies", []) or []]
    game_count = max(1, len(games))
    projected_seconds = sum(latencies) * len(PUBLIC_GAMES) / game_count
    return {
        "game_count": len(games),
        "levels": sum(achieved_levels(row) for row in games),
        "score": float(result.get("score", 0.0) or 0.0),
        "actions": sum(int(row.get("actions", 0) or 0) for row in games),
        "call_attempts": attempts,
        "call_successes": successes,
        "parse_rate": successes / attempts if attempts else 0.0,
        "median_latency": median(latencies) if latencies else 0.0,
        "p95_latency": percentile(latencies, 0.95),
        "model_seconds": sum(latencies),
        "projected_model_seconds": projected_seconds,
        "fatal_model_failures": int(result.get("fatal_model_failures", 0) or 0),
        "oom_failures": int(result.get("oom_failures", 0) or 0),
    }


def select_pilot_mode(results: dict[str, dict[str, Any]]) -> dict[str, Any]:
    summaries = {mode: summarize_run(result) for mode, result in results.items()}
    eligible: list[str] = []
    reasons: dict[str, list[str]] = {}
    for mode, summary in summaries.items():
        mode_reasons: list[str] = []
        if summary["fatal_model_failures"]:
            mode_reasons.append("fatal model failure")
        if summary["oom_failures"]:
            mode_reasons.append("GPU out of memory")
        if summary["parse_rate"] < 0.80:
            mode_reasons.append(f"parse rate {summary['parse_rate']:.3f} < 0.800")
        if summary["projected_model_seconds"] > MAX_PROJECTED_MODEL_SECONDS:
            mode_reasons.append("projected model time exceeds two hours")
        reasons[mode] = mode_reasons
        if not mode_reasons:
            eligible.append(mode)

    if not eligible:
        return {
            "selected_mode": None,
            "eligible": [],
            "summaries": summaries,
            "reasons": reasons,
        }

    def ranking(mode: str) -> tuple[float, float, float, float, float, int]:
        summary = summaries[mode]
        return (
            float(summary["levels"]),
            float(summary["score"]),
            -float(summary["actions"]),
            -float(summary["median_latency"]),
            -float(summary["p95_latency"]),
            1 if mode == "thinking_off" else 0,
        )

    selected = max(eligible, key=ranking)
    return {
        "selected_mode": selected,
        "eligible": eligible,
        "summaries": summaries,
        "reasons": reasons,
    }


def evaluate_promotion(
    result: dict[str, Any],
    baseline: dict[str, Any],
) -> dict[str, Any]:
    games = list(result.get("games", []) or [])
    baseline_games = list(baseline.get("games", []) or [])
    result_index = {
        normalize_game_id(str(row.get("game_id", ""))): row
        for row in games
    }
    baseline_index = {
        normalize_game_id(str(row.get("game_id", ""))): row
        for row in baseline_games
    }
    reasons: list[str] = []
    missing = sorted(set(PUBLIC_GAMES) - set(result_index))
    if missing or len(result_index) != len(PUBLIC_GAMES):
        reasons.append(f"full run incomplete; missing={missing}")

    score = float(result.get("score", 0.0) or 0.0)
    baseline_score = float(baseline.get("score", BASELINE_SCORE) or BASELINE_SCORE)
    if score <= baseline_score + PROMOTION_EPSILON:
        reasons.append(
            f"score {score:.6f} does not exceed baseline {baseline_score:.6f} "
            f"by {PROMOTION_EPSILON:.3f}"
        )

    regressions: list[str] = []
    for game_id, baseline_row in sorted(baseline_index.items()):
        baseline_levels = achieved_levels(baseline_row)
        if baseline_levels <= 0:
            continue
        candidate_levels = achieved_levels(result_index.get(game_id, {}))
        if candidate_levels < baseline_levels:
            regressions.append(f"{game_id}:{candidate_levels}<{baseline_levels}")
    if regressions:
        reasons.append("solved-game regressions: " + ",".join(regressions))

    if int(result.get("fatal_model_failures", 0) or 0):
        reasons.append("fatal model failures recorded")
    if int(result.get("oom_failures", 0) or 0):
        reasons.append("GPU out-of-memory failures recorded")
    runtime_seconds = float(result.get("runtime_seconds", 0.0) or 0.0)
    if runtime_seconds > MAX_FULL_RUNTIME_SECONDS:
        reasons.append("full runtime exceeds five hours")

    generalization = compare_runs(result, baseline)
    return {
        "promote": not reasons,
        "reasons": reasons,
        "score": score,
        "baseline_score": baseline_score,
        "score_delta": score - baseline_score,
        "levels": sum(achieved_levels(row) for row in games),
        "baseline_levels": sum(achieved_levels(row) for row in baseline_games),
        "regressions": regressions,
        "fold_deltas": generalization["fold_deltas"],
        "generalization_gate": generalization["generalization_gate"],
        "world_model": generalization["candidate"]["overall"],
    }
