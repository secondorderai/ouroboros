from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro_arc.holdout import fold_of  # noqa: E402


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r") as f:
        return json.load(f)


def achieved_levels(row: dict[str, Any]) -> int:
    return max(
        int(row.get("levels_completed", 0)),
        int(row.get("max_level_reached", 0)),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarize local ARC-AGI-3 run results.")
    parser.add_argument("results", nargs="?", default="logs/local_results.json")
    parser.add_argument("--baseline", default="baselines/deterministic_public_v11.json")
    parser.add_argument("--fold", choices=["dev", "test", "quarantine"], default=None)
    args = parser.parse_args()

    results = load_json(Path(args.results))
    if args.fold is not None:
        results = dict(results)
        results["games"] = [
            row
            for row in results.get("games", [])
            if fold_of(str(row.get("game_id", ""))) == args.fold
        ]
    baseline_path = Path(args.baseline)
    baseline = load_json(baseline_path) if baseline_path.exists() else {"games": []}
    baseline_levels = {
        row["game_id"]: achieved_levels(row)
        for row in baseline.get("games", [])
    }

    print(f"score={results.get('score')}")
    regressions: list[str] = []
    loop_risks: list[str] = []
    for row in results.get("games", []):
        game_id = row["game_id"]
        final_levels = int(row.get("levels_completed", 0))
        levels = achieved_levels(row)
        actions = max(1, int(row.get("actions", 0)))
        solver_counts = row.get("solver_counts", {})
        dominant_solver = "?"
        dominant_ratio = 0.0
        if solver_counts:
            dominant_solver, count = max(solver_counts.items(), key=lambda item: int(item[1]))
            dominant_ratio = int(count) / actions
        if levels < baseline_levels.get(game_id, 0):
            regressions.append(f"{game_id}:{levels}<{baseline_levels[game_id]}")
        if dominant_ratio > 0.75:
            loop_risks.append(f"{game_id}:{dominant_solver}:{dominant_ratio:.2f}")
        print(
            f"{game_id:8} levels={levels:2} final={final_levels:2} resets={int(row.get('resets', 0)):3} "
            f"dominant={dominant_solver}:{dominant_ratio:.2f}"
        )

    if regressions:
        print("regressions=" + ",".join(regressions))
    if loop_risks:
        print("loop_risks=" + ",".join(loop_risks))


if __name__ == "__main__":
    main()
