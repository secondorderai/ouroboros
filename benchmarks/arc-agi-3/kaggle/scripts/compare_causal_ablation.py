#!/usr/bin/env python3
"""Compare deterministic, rank-only Qwen, and autonomous-model result files."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

BASELINES = {
    "deterministic": 1.0228557578743325,
    "qwen-rank-only": 1.0228011132697703,
}


def summarize(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    games = payload.get("games", [])
    return {
        "path": str(path),
        "score": float(payload.get("score", 0.0)),
        "levels": sum(max(int(row.get("levels_completed", 0)), int(row.get("max_level_reached", 0))) for row in games),
        "actions": sum(int(row.get("actions", 0)) for row in games),
        "model_calls": sum(int(row.get("model_calls", 0)) for row in games),
        "certified_games": sum(bool(row.get("autonomous_world_model", {}).get("certified")) for row in games),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", nargs="+", type=Path)
    args = parser.parse_args()
    rows = [summarize(path) for path in args.results]
    print("# Autonomous Causal World Model Ablation\n")
    print("| Run | Score | vs deterministic | Levels | Actions | Model calls | Certified games |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for row in rows:
        print(
            f"| {row['path']} | {row['score']:.9f} | "
            f"{row['score'] - BASELINES['deterministic']:+.9f} | {row['levels']} | "
            f"{row['actions']} | {row['model_calls']} | {row['certified_games']} |"
        )
    best = max(rows, key=lambda row: row["score"])
    accepted = best["score"] >= BASELINES["deterministic"] + 0.005
    print(f"\nPromotion gate: {'PASS' if accepted else 'FAIL'}; best={best['score']:.9f}")


if __name__ == "__main__":
    main()
