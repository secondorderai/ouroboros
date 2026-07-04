"""Gate a build against the frozen TEST fold (the honest LB proxy).

The pure core is :func:`evaluate_gate`; the CLI is a thin wrapper that loads
result/baseline JSON, prints a readable report, and (optionally) advances the
rolling baseline. A build is BLOCKED when a TEST game regresses in achieved
levels or when the TEST aggregate score drops beyond epsilon. Ratchet advances
rewrite ``baselines/holdout_best.json`` only on a strict TEST improvement.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro_arc.holdout import (  # noqa: E402
    TEST_GAMES,
    achieved_levels,
    fold_levels,
    fold_of,
    normalize_game_id,
)

DEFAULT_RESULTS = "logs/local_results.json"
DEFAULT_BASELINE = "baselines/holdout_best.json"
HISTORY_PATH = "logs/holdout_history.jsonl"
DEFAULT_EPS = 0.005


def _test_games_index(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Map normalized game id -> row for the TEST-fold rows in ``rows``."""
    index: dict[str, dict[str, Any]] = {}
    for row in rows:
        game_id = str(row.get("game_id", ""))
        if fold_of(game_id) == "test":
            index[normalize_game_id(game_id)] = row
    return index


def _baseline_test_index(baseline: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Map normalized game id -> baseline test_games entry."""
    index: dict[str, dict[str, Any]] = {}
    for entry in baseline.get("test_games", []) or []:
        game_id = str(entry.get("game_id", ""))
        if game_id:
            index[normalize_game_id(game_id)] = entry
    return index


def _test_games_snapshot(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build the per-game TEST-fold snapshot stored in a baseline."""
    snapshot: list[dict[str, Any]] = []
    for game_id in sorted(TEST_GAMES):
        row = None
        for candidate in rows:
            if normalize_game_id(str(candidate.get("game_id", ""))) == game_id:
                row = candidate
                break
        if row is None:
            snapshot.append({"game_id": game_id, "achieved_levels": 0, "actions": 0})
            continue
        snapshot.append(
            {
                "game_id": game_id,
                "achieved_levels": achieved_levels(row),
                "actions": int(row.get("actions", 0)),
            }
        )
    return snapshot


def evaluate_gate(
    results: dict[str, Any],
    test_results: Optional[dict[str, Any]] = None,
    baseline: Optional[dict[str, Any]] = None,
    eps: float = DEFAULT_EPS,
    git_sha: str = "",
    notes: str = "",
) -> dict[str, Any]:
    """Pure gate decision. No I/O, no git calls.

    ``results`` is the full 25-game run (its rows carry ``achieved_levels`` used
    for the per-game TEST regression check). ``test_results`` is an optional
    dedicated TEST-fold run whose top-level ``score`` is the official aggregate.
    """
    rows = list(results.get("games", []) or [])
    dev_levels = fold_levels(rows, "dev")
    test_levels = fold_levels(rows, "test")

    test_score: Optional[float] = None
    if test_results is not None and test_results.get("score") is not None:
        test_score = float(test_results["score"])
    dev_score: Optional[float] = None

    new_baseline = {
        "dev_levels": dev_levels,
        "test_levels": test_levels,
        "dev_score": dev_score,
        "test_score": test_score,
        "test_games": _test_games_snapshot(rows),
        "git_sha": git_sha,
        "notes": notes,
    }

    # First run: nothing to compare against.
    if baseline is None:
        return {
            "blocked": False,
            "reasons": [],
            "overfit_warning": False,
            "improved": True,
            "new_baseline": new_baseline,
            "dev_levels": dev_levels,
            "test_levels": test_levels,
            "test_score": test_score,
            "dev_score": dev_score,
        }

    reasons: list[str] = []

    # Per-game TEST level regression (from the full-run rows).
    new_index = _test_games_index(rows)
    base_index = _baseline_test_index(baseline)
    for game_id, base_entry in base_index.items():
        base_levels = int(base_entry.get("achieved_levels", 0))
        new_row = new_index.get(game_id)
        new_levels = achieved_levels(new_row) if new_row is not None else 0
        if new_levels < base_levels:
            reasons.append(
                f"TEST regression {game_id}: levels {new_levels} < baseline {base_levels}"
            )

    # Aggregate TEST-score regression beyond epsilon.
    base_test_score = baseline.get("test_score")
    if test_score is not None and base_test_score is not None:
        if test_score < float(base_test_score) - eps:
            reasons.append(
                f"TEST score regression: {test_score:.6f} < baseline "
                f"{float(base_test_score):.6f} - eps({eps})"
            )

    blocked = bool(reasons)

    # Overfit warning: DEV rises while TEST is flat-or-down.
    base_dev_levels = baseline.get("dev_levels")
    base_dev_score = baseline.get("dev_score")
    base_test_levels = baseline.get("test_levels")
    dev_levels_up = base_dev_levels is not None and dev_levels - int(base_dev_levels) >= 1
    dev_score_up = (
        base_dev_score is not None
        and dev_score is not None
        and dev_score - float(base_dev_score) > 2
    )
    test_levels_flat_or_down = (
        base_test_levels is None or test_levels <= int(base_test_levels)
    )
    test_score_flat_or_down = (
        base_test_score is None
        or test_score is None
        or test_score <= float(base_test_score)
    )
    overfit_warning = bool(
        (dev_levels_up or dev_score_up)
        and test_levels_flat_or_down
        and test_score_flat_or_down
    )

    # Improvement: no TEST regression AND TEST strictly advances.
    test_levels_up = base_test_levels is not None and test_levels > int(base_test_levels)
    test_score_up = (
        test_score is not None
        and base_test_score is not None
        and test_score > float(base_test_score) + eps
    )
    improved = not blocked and (test_levels_up or test_score_up)

    return {
        "blocked": blocked,
        "reasons": reasons,
        "overfit_warning": overfit_warning,
        "improved": improved,
        "new_baseline": new_baseline,
        "dev_levels": dev_levels,
        "test_levels": test_levels,
        "test_score": test_score,
        "dev_score": dev_score,
    }


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r") as f:
        return json.load(f)


def _git_short_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return ""


def _format_score(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value:.6f}"


def _print_report(outcome: dict[str, Any]) -> None:
    print("===== holdout gate =====")
    print(
        f"dev_levels={outcome['dev_levels']} test_levels={outcome['test_levels']} "
        f"dev_score={_format_score(outcome['dev_score'])} "
        f"test_score={_format_score(outcome['test_score'])}"
    )
    if outcome["reasons"]:
        print("BLOCKED:")
        for reason in outcome["reasons"]:
            print(f"  - {reason}")
    else:
        print("no TEST regression")
    if outcome["overfit_warning"]:
        print("OVERFIT WARNING: DEV improved while TEST stayed flat-or-down")
    print(f"improved={outcome['improved']} blocked={outcome['blocked']}")


def _append_history(entry: dict[str, Any]) -> None:
    path = ROOT / HISTORY_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", default=DEFAULT_RESULTS)
    parser.add_argument("--test-results", default=None)
    parser.add_argument("--baseline", default=DEFAULT_BASELINE)
    parser.add_argument("--eps", type=float, default=DEFAULT_EPS)
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Gate only; exit nonzero if blocked, never write a baseline.",
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="On improved & not blocked, rewrite the baseline and append history.",
    )
    parser.add_argument(
        "--allow-regression",
        action="store_true",
        help="Override a block (loud banner, recorded in history).",
    )
    parser.add_argument(
        "--seed",
        action="store_true",
        help="Write an initial baseline from --results (+ --test-results) and exit.",
    )
    parser.add_argument("--notes", default="")
    args = parser.parse_args(argv)

    results_path = ROOT / args.results if not Path(args.results).is_absolute() else Path(args.results)
    results = _load_json(results_path)
    test_results = None
    if args.test_results:
        tr_path = (
            ROOT / args.test_results
            if not Path(args.test_results).is_absolute()
            else Path(args.test_results)
        )
        test_results = _load_json(tr_path)

    baseline_path = (
        ROOT / args.baseline if not Path(args.baseline).is_absolute() else Path(args.baseline)
    )

    if args.seed:
        outcome = evaluate_gate(
            results,
            test_results,
            baseline=None,
            eps=args.eps,
            git_sha=_git_short_sha(),
            notes=args.notes or "seed",
        )
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(
            json.dumps(outcome["new_baseline"], indent=2, sort_keys=True) + "\n"
        )
        _print_report(outcome)
        print(f"Seeded baseline: {baseline_path}")
        return 0

    baseline = _load_json(baseline_path) if baseline_path.exists() else None
    outcome = evaluate_gate(
        results,
        test_results,
        baseline=baseline,
        eps=args.eps,
        git_sha=_git_short_sha(),
        notes=args.notes,
    )
    _print_report(outcome)

    blocked = outcome["blocked"]
    override = False
    if blocked and args.allow_regression:
        print("=" * 60, file=sys.stderr)
        print("!! --allow-regression: OVERRIDING A BLOCKED HOLDOUT GATE !!", file=sys.stderr)
        for reason in outcome["reasons"]:
            print(f"!!   {reason}", file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        blocked = False
        override = True

    if args.check_only:
        return 1 if blocked else 0

    if args.update and outcome["improved"] and not outcome["blocked"]:
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(
            json.dumps(outcome["new_baseline"], indent=2, sort_keys=True) + "\n"
        )
        print(f"Ratchet advanced: wrote {baseline_path}")

    if args.update or override:
        _append_history(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "git_sha": outcome["new_baseline"]["git_sha"],
                "dev_levels": outcome["dev_levels"],
                "test_levels": outcome["test_levels"],
                "dev_score": outcome["dev_score"],
                "test_score": outcome["test_score"],
                "improved": outcome["improved"],
                "blocked": outcome["blocked"],
                "overfit_warning": outcome["overfit_warning"],
                "override": override,
                "reasons": outcome["reasons"],
                "notes": args.notes,
            }
        )

    return 1 if blocked else 0


if __name__ == "__main__":
    raise SystemExit(main())
