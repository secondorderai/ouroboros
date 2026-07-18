"""Evaluation helpers for generalization-first ARC experiments."""

from __future__ import annotations

from typing import Any, Iterable

from .holdout import (
    ALL_PUBLIC_GAMES,
    GENERALIZATION_FOLDS,
    achieved_levels,
    normalize_game_id,
)


def _rows_by_game(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        normalize_game_id(str(row.get("game_id", ""))): row
        for row in result.get("games", []) or []
    }


def summarize_rows(rows: Iterable[dict[str, Any]]) -> dict[str, int | float]:
    materialized = list(rows)
    actions = sum(int(row.get("actions", 0) or 0) for row in materialized)
    levels = sum(achieved_levels(row) for row in materialized)
    solved = sum(1 for row in materialized if achieved_levels(row) > 0)
    prediction_attempts = 0
    prediction_correct = 0
    templates = 0
    observations = 0
    novel = 0
    probe_actions = 0
    probe_novel = 0
    for row in materialized:
        world = dict(row.get("world_model", {}) or {})
        prediction = dict(world.get("prediction", {}) or {})
        prediction_attempts += int(prediction.get("attempts", 0) or 0)
        prediction_correct += int(prediction.get("effect_correct", 0) or 0)
        templates += int(world.get("templates", 0) or 0)
        observations += int(world.get("observations", 0) or 0)
        novel += int(world.get("novel_observations", 0) or 0)
        probe = dict(world.get("probe_efficiency", {}) or {})
        probe_actions += int(probe.get("actions", 0) or 0)
        probe_novel += int(probe.get("novel", 0) or 0)
    return {
        "games": len(materialized),
        "levels": levels,
        "solved_games": solved,
        "actions": actions,
        "actions_per_level": actions / levels if levels else float(actions),
        "prediction_attempts": prediction_attempts,
        "effect_prediction_accuracy": (
            prediction_correct / prediction_attempts if prediction_attempts else 0.0
        ),
        "mechanic_templates": templates,
        "novel_observation_rate": novel / observations if observations else 0.0,
        "probe_efficiency": probe_novel / probe_actions if probe_actions else 0.0,
        "probe_actions": probe_actions,
    }


def summarize_generalization(result: dict[str, Any]) -> dict[str, Any]:
    index = _rows_by_game(result)
    folds = {
        name: summarize_rows(index[game_id] for game_id in sorted(game_ids) if game_id in index)
        for name, game_ids in GENERALIZATION_FOLDS.items()
    }
    missing = sorted(ALL_PUBLIC_GAMES - set(index))
    worst_fold = min(
        folds,
        key=lambda name: (
            int(folds[name]["levels"]),
            -int(folds[name]["actions"]),
            name,
        ),
    )
    return {
        "score": float(result.get("score", 0.0) or 0.0),
        "complete": not missing and len(index) == len(ALL_PUBLIC_GAMES),
        "missing_games": missing,
        "overall": summarize_rows(index.values()),
        "folds": folds,
        "worst_fold": worst_fold,
    }


def compare_runs(
    candidate: dict[str, Any],
    baseline: dict[str, Any],
) -> dict[str, Any]:
    candidate_summary = summarize_generalization(candidate)
    baseline_summary = summarize_generalization(baseline)
    candidate_index = _rows_by_game(candidate)
    baseline_index = _rows_by_game(baseline)
    regressions = []
    improvements = []
    for game_id, baseline_row in sorted(baseline_index.items()):
        before = achieved_levels(baseline_row)
        after = achieved_levels(candidate_index.get(game_id, {}))
        if after < before:
            regressions.append(f"{game_id}:{after}<{before}")
        elif after > before:
            improvements.append(f"{game_id}:{after}>{before}")
    fold_deltas = {
        name: {
            "levels": int(candidate_summary["folds"][name]["levels"])
            - int(baseline_summary["folds"][name]["levels"]),
            "actions": int(candidate_summary["folds"][name]["actions"])
            - int(baseline_summary["folds"][name]["actions"]),
        }
        for name in GENERALIZATION_FOLDS
    }
    return {
        "candidate": candidate_summary,
        "baseline": baseline_summary,
        "score_delta": candidate_summary["score"] - baseline_summary["score"],
        "level_delta": int(candidate_summary["overall"]["levels"])
        - int(baseline_summary["overall"]["levels"]),
        "action_delta": int(candidate_summary["overall"]["actions"])
        - int(baseline_summary["overall"]["actions"]),
        "fold_deltas": fold_deltas,
        "regressions": regressions,
        "improvements": improvements,
        "generalization_gate": (
            bool(candidate_summary["complete"])
            and not regressions
            and all(delta["levels"] >= 0 for delta in fold_deltas.values())
        ),
    }
