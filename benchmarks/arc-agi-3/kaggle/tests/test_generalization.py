from __future__ import annotations

import unittest

from ouro_arc.generalization import compare_runs, summarize_generalization
from ouro_arc.holdout import ALL_PUBLIC_GAMES, GENERALIZATION_FOLDS


def result(level_overrides: dict[str, int] | None = None) -> dict[str, object]:
    overrides = level_overrides or {}
    return {
        "score": 1.0,
        "games": [
            {
                "game_id": game_id,
                "levels_completed": overrides.get(game_id, 0),
                "actions": 10,
                "world_model": {
                    "observations": 4,
                    "novel_observations": 2,
                    "templates": 2,
                    "prediction": {"attempts": 2, "effect_correct": 1},
                },
            }
            for game_id in sorted(ALL_PUBLIC_GAMES)
        ],
    }


class GeneralizationTest(unittest.TestCase):
    def test_fixed_folds_cover_every_public_game_once(self) -> None:
        flattened = [
            game_id
            for game_ids in GENERALIZATION_FOLDS.values()
            for game_id in game_ids
        ]
        self.assertEqual(set(flattened), set(ALL_PUBLIC_GAMES))
        self.assertEqual(len(flattened), len(set(flattened)))
        self.assertEqual({len(items) for items in GENERALIZATION_FOLDS.values()}, {5})

    def test_summary_reports_world_model_quality_by_fold(self) -> None:
        summary = summarize_generalization(result())

        self.assertTrue(summary["complete"])
        self.assertEqual(summary["overall"]["prediction_attempts"], 50)
        self.assertEqual(summary["overall"]["effect_prediction_accuracy"], 0.5)
        self.assertEqual(set(summary["folds"]), set(GENERALIZATION_FOLDS))

    def test_gate_rejects_any_per_game_or_fold_regression(self) -> None:
        game_id = sorted(GENERALIZATION_FOLDS["fold_1"])[0]
        baseline = result({game_id: 1})
        candidate = result()

        report = compare_runs(candidate, baseline)

        self.assertFalse(report["generalization_gate"])
        self.assertEqual(report["regressions"], [f"{game_id}:0<1"])
        self.assertEqual(report["fold_deltas"]["fold_1"]["levels"], -1)


if __name__ == "__main__":
    unittest.main()
