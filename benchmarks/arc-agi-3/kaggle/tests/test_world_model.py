from __future__ import annotations

import unittest

from ouro_arc.world_model import (
    ExecutableWorldModel,
    MechanicHypothesis,
    TransitionRecord,
    perceive_grid,
)


A1 = (1, None, None)
A2 = (2, None, None)


def scene(player_x: int = 1) -> list[list[int]]:
    grid = [[0 for _ in range(8)] for _ in range(8)]
    grid[2][player_x] = 3
    grid[6][6] = 2
    return grid


class PerceptionTest(unittest.TestCase):
    def test_perception_is_canonical_and_repeatable(self) -> None:
        first = perceive_grid(scene())
        second = perceive_grid([row[:] for row in scene()])

        self.assertEqual(first, second)
        self.assertEqual(first.pixel_key, second.pixel_key)
        self.assertEqual(first.scene_key, second.scene_key)
        self.assertEqual(tuple(sorted(first.objects, key=lambda obj: (obj.color, obj.bounds))), first.objects)

    def test_background_ties_use_lowest_color(self) -> None:
        perception = perceive_grid([[2, 1], [1, 2]])
        self.assertEqual(perception.background, 1)

    def test_non_integer_color_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "grid colors must be integers"):
            perceive_grid([[0, "bad"]])  # type: ignore[list-item]

    def test_scene_signature_ignores_absolute_object_position(self) -> None:
        first = perceive_grid(scene(1))
        shifted = perceive_grid(scene(3))

        self.assertNotEqual(first.scene_key, shifted.scene_key)
        self.assertEqual(
            ExecutableWorldModel.scene_signature(first),
            ExecutableWorldModel.scene_signature(shifted),
        )


class ExecutableWorldModelTest(unittest.TestCase):
    def test_stable_transition_is_searchable(self) -> None:
        model = ExecutableWorldModel()
        before = perceive_grid(scene(1))
        middle = perceive_grid(scene(2))
        after = perceive_grid(scene(3))
        model.observe(0, "a", A1, "b", "changed", "gameplay-change", before, middle)
        model.observe(0, "b", A2, "c", "score increased", "progress", middle, after)

        path = model.search(
            "a",
            candidate_provider=lambda _key: [],
            max_depth=4,
            is_blocked=lambda _action: False,
        )

        self.assertEqual(path, [A1, A2])

    def test_conflicting_transition_is_not_executable(self) -> None:
        model = ExecutableWorldModel()
        before = perceive_grid(scene(1))
        first = perceive_grid(scene(2))
        second = perceive_grid(scene(3))
        model.observe(0, "a", A1, "b", "score increased", "progress", before, first)
        model.observe(0, "a", A1, "c", "changed", "gameplay-change", before, second)

        self.assertFalse(model.graph.neighbors("a")[A1].stable)
        self.assertIsNone(
            model.search(
                "a",
                candidate_provider=lambda _key: [],
                max_depth=4,
                is_blocked=lambda _action: False,
            )
        )

    def test_hypothesis_order_is_deterministic(self) -> None:
        model = ExecutableWorldModel()
        hypotheses = model.hypotheses(
            0,
            "a",
            [A2, A1],
            is_blocked=lambda _action: False,
        )
        self.assertEqual([item.id for item in hypotheses], ["h-a1-xn-yn", "h-a2-xn-yn"])

    def test_hypotheses_include_causal_predictions_and_information(self) -> None:
        model = ExecutableWorldModel()
        before = perceive_grid(scene(1))
        after = perceive_grid(scene(2))
        model.observe(0, "a", A1, "b", "changed", "gameplay-change", before, after)

        hypothesis = model.hypotheses(
            0,
            "a",
            [A1],
            is_blocked=lambda _action: False,
        )[0]

        self.assertEqual(hypothesis.predicted_effects, ("gameplay-change",))
        self.assertEqual(hypothesis.predicted_score_change, False)
        self.assertEqual(hypothesis.supporting_observations, 1)
        self.assertIn("when=", hypothesis.prompt_line())
        self.assertIn("information=", hypothesis.prompt_line())

    def test_information_gain_prefers_unobserved_action_after_stuck(self) -> None:
        model = ExecutableWorldModel()
        perception = perceive_grid(scene())
        model.observe(
            0,
            "a",
            A1,
            "a",
            "no visible change",
            "no-visible-change",
            perception,
            perception,
        )

        path = model.search(
            "a",
            candidate_provider=lambda _key: [A1, A2],
            max_depth=4,
            is_blocked=lambda _action: False,
            level=0,
            allow_local_information_probe=True,
        )

        self.assertEqual(path, [A2])
        self.assertGreater(
            model.action_evaluation(0, "a", A2).information_gain,
            model.action_evaluation(0, "a", A1).information_gain,
        )

    def test_global_no_progress_saturates_repeated_action(self) -> None:
        model = ExecutableWorldModel()
        perception = perceive_grid(scene())
        for index in range(20):
            model.observe(
                0,
                f"state-{index}",
                A1,
                f"state-{index}",
                "no visible change",
                "no-visible-change",
                perception,
                perception,
            )

        repeated = model.action_evaluation(0, "new-state", A1)
        genuinely_new = model.action_evaluation(0, "new-state", A2)

        self.assertEqual(repeated.global_visits, 20)
        self.assertLess(repeated.total, genuinely_new.total)

    def test_hypotheses_drop_globally_saturated_actions_when_alternatives_exist(self) -> None:
        model = ExecutableWorldModel()
        perception = perceive_grid(scene())
        for index in range(24):
            model.observe(
                0,
                f"state-{index}",
                A1,
                f"state-{index}",
                "no visible change",
                "no-visible-change",
                perception,
                perception,
            )

        hypotheses = model.hypotheses(
            0,
            "new-state",
            [A1, A2],
            is_blocked=lambda _action: False,
        )

        self.assertEqual([hypothesis.action_key for hypothesis in hypotheses], [A2])

    def test_replay_round_trip_reconstructs_identical_induction(self) -> None:
        original = ExecutableWorldModel()
        before = perceive_grid(scene(1))
        after = perceive_grid(scene(2))
        original.observe(0, "a", A1, "b", "changed", "gameplay-change", before, after)
        serialized = [record.to_json() for record in original.records]

        replayed = ExecutableWorldModel()
        replayed.replay(serialized)

        self.assertEqual(replayed.graph.edges, original.graph.edges)
        self.assertEqual(replayed.effects, original.effects)
        self.assertEqual(replayed.records, original.records)
        self.assertIsInstance(TransitionRecord.from_json(serialized[0]), TransitionRecord)

    def test_coordinate_free_rule_predicts_shifted_scene_in_later_level(self) -> None:
        model = ExecutableWorldModel()
        before = perceive_grid(scene(1))
        after = perceive_grid(scene(2))
        shifted = perceive_grid(scene(3))
        model.observe(0, "a", A1, "b", "changed", "gameplay-change", before, after)

        prediction = model.predict(4, "unseen", A1, shifted)

        self.assertIsNotNone(prediction)
        assert prediction is not None
        self.assertEqual(prediction.source, "context")
        self.assertEqual(prediction.effect, "entity-moved")

        model.observe(4, "unseen", A1, "next", "changed", "gameplay-change", shifted, before)
        metrics = model.prediction_metrics()
        self.assertEqual(metrics["attempts"], 1)
        self.assertEqual(metrics["effect_accuracy"], 1.0)
        self.assertEqual(metrics["brier_score"], 0.0)
        self.assertEqual(metrics["calibration"]["80-100"]["correct"], 1)

    def test_click_action_schema_follows_shifted_target(self) -> None:
        first = perceive_grid(scene(1))
        shifted = perceive_grid(scene(3))

        self.assertEqual(
            ExecutableWorldModel.action_schema(first, (6, 1, 2)),
            ExecutableWorldModel.action_schema(shifted, (6, 3, 2)),
        )

    def test_contradictions_count_observations_outside_majority(self) -> None:
        model = ExecutableWorldModel()
        before = perceive_grid(scene(1))
        moved = perceive_grid(scene(2))
        for index in range(3):
            model.observe(
                0, f"a-{index}", A1, f"b-{index}", "changed", "gameplay-change", before, moved
            )
        model.observe(1, "score", A1, "next", "score increased", "progress", before, moved)
        model.register("new", perceive_grid(scene(3)))

        hypothesis = model.hypotheses(
            2, "new", [A1], is_blocked=lambda _action: False
        )[0]

        self.assertEqual(hypothesis.supporting_observations, 4)
        self.assertEqual(hypothesis.contradicting_observations, 1)

    def test_best_probe_avoids_generalized_terminal_risk(self) -> None:
        model = ExecutableWorldModel()
        perception = perceive_grid(scene())
        model.observe(0, "a", A1, None, "game over", "unsafe", perception, perception)
        model.register("new", perception)

        probe = model.best_probe(1, "new", [A1, A2])

        self.assertIsNotNone(probe)
        assert probe is not None
        self.assertEqual(probe.action_key, A2)

    def test_external_ranking_requires_competing_uncertain_hypotheses(self) -> None:
        decisive = MechanicHypothesis("a", A1, "", "", 4000, information_gain=0)
        weak = MechanicHypothesis("b", A2, "", "", 1000, information_gain=0)
        ambiguous = MechanicHypothesis("c", A2, "", "", 3900, information_gain=800)

        self.assertFalse(ExecutableWorldModel.needs_external_ranking([decisive]))
        self.assertFalse(ExecutableWorldModel.needs_external_ranking([decisive, weak]))
        self.assertTrue(ExecutableWorldModel.needs_external_ranking([decisive, ambiguous]))


if __name__ == "__main__":
    unittest.main()
