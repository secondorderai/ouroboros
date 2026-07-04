from __future__ import annotations

import unittest

from scripts.holdout_gate import evaluate_gate


def _results(test_rows: dict[str, int], dev_rows: dict[str, int] | None = None) -> dict:
    """Build a results dict from {game_id: achieved_levels} maps."""
    games = []
    for game_id, levels in test_rows.items():
        games.append(
            {"game_id": game_id, "levels_completed": levels, "max_level_reached": levels, "actions": 320}
        )
    for game_id, levels in (dev_rows or {}).items():
        games.append(
            {"game_id": game_id, "levels_completed": levels, "max_level_reached": levels, "actions": 320}
        )
    return {"score": 0.0, "games": games}


def _baseline(
    test_games: dict[str, int],
    dev_levels: int = 0,
    test_levels: int | None = None,
    test_score: float | None = None,
    dev_score: float | None = None,
) -> dict:
    entries = [
        {"game_id": gid, "achieved_levels": lv, "actions": 320}
        for gid, lv in test_games.items()
    ]
    return {
        "dev_levels": dev_levels,
        "test_levels": test_levels if test_levels is not None else sum(test_games.values()),
        "dev_score": dev_score,
        "test_score": test_score,
        "test_games": entries,
        "git_sha": "abc1234",
        "notes": "seed",
    }


class HoldoutGateTest(unittest.TestCase):
    def test_first_run_not_blocked_and_improved(self) -> None:
        results = _results({"vc33": 2, "tn36": 0})
        outcome = evaluate_gate(results, test_results=None, baseline=None)
        self.assertFalse(outcome["blocked"])
        self.assertTrue(outcome["improved"])
        self.assertEqual(outcome["new_baseline"]["test_levels"], 2)

    def test_test_per_game_level_regression_blocks(self) -> None:
        baseline = _baseline({"vc33": 2, "tn36": 1})
        results = _results({"vc33": 1, "tn36": 1})  # vc33 dropped 2 -> 1
        outcome = evaluate_gate(results, test_results=None, baseline=baseline)
        self.assertTrue(outcome["blocked"])
        self.assertTrue(any("vc33" in r for r in outcome["reasons"]))

    def test_test_aggregate_score_drop_blocks(self) -> None:
        baseline = _baseline({"vc33": 2}, test_score=0.50)
        results = _results({"vc33": 2})
        test_results = {"score": 0.49, "games": []}  # drop 0.01 > eps 0.005
        outcome = evaluate_gate(results, test_results=test_results, baseline=baseline)
        self.assertTrue(outcome["blocked"])
        self.assertTrue(any("score" in r for r in outcome["reasons"]))

    def test_score_drop_within_eps_not_blocked(self) -> None:
        baseline = _baseline({"vc33": 2}, test_score=0.50)
        results = _results({"vc33": 2})
        test_results = {"score": 0.4990, "games": []}  # drop 0.001 < eps
        outcome = evaluate_gate(results, test_results=test_results, baseline=baseline)
        self.assertFalse(outcome["blocked"])

    def test_dev_up_test_flat_warns_and_not_improved(self) -> None:
        baseline = _baseline({"vc33": 2}, dev_levels=5)
        results = _results({"vc33": 2}, dev_rows={"ft09": 4, "m0r0": 2, "sp80": 1})  # dev=7
        outcome = evaluate_gate(results, test_results=None, baseline=baseline)
        self.assertFalse(outcome["blocked"])
        self.assertTrue(outcome["overfit_warning"])
        self.assertFalse(outcome["improved"])

    def test_strict_test_level_improvement_improves(self) -> None:
        baseline = _baseline({"vc33": 2, "tn36": 0})
        results = _results({"vc33": 2, "tn36": 1})  # test_levels 2 -> 3
        outcome = evaluate_gate(results, test_results=None, baseline=baseline)
        self.assertFalse(outcome["blocked"])
        self.assertTrue(outcome["improved"])
        self.assertEqual(outcome["new_baseline"]["test_levels"], 3)
        self.assertGreater(outcome["new_baseline"]["test_levels"], baseline["test_levels"])

    def test_test_score_improvement_improves(self) -> None:
        baseline = _baseline({"vc33": 2}, test_score=0.40)
        results = _results({"vc33": 2})
        test_results = {"score": 0.50, "games": []}
        outcome = evaluate_gate(results, test_results=test_results, baseline=baseline)
        self.assertFalse(outcome["blocked"])
        self.assertTrue(outcome["improved"])

    def test_allow_regression_semantics(self) -> None:
        baseline = _baseline({"vc33": 2})
        results = _results({"vc33": 1})  # regression
        outcome = evaluate_gate(results, test_results=None, baseline=baseline)
        self.assertTrue(outcome["blocked"])
        # Apply the --allow-regression override the CLI performs.
        blocked = outcome["blocked"]
        allow_regression = True
        if blocked and allow_regression:
            blocked = False
        self.assertFalse(blocked)


if __name__ == "__main__":
    unittest.main()
