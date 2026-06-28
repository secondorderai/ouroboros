from __future__ import annotations

import unittest
import tempfile
import os
from dataclasses import dataclass
from pathlib import Path

from ouro_arc.actions import ActionSpec
from ouro_arc.controller import ArcController
from ouro_arc.gemma import GemmaPlan
from ouro_arc.telemetry import TelemetryWriter


@dataclass
class DummyFrame:
    frame: list[list[list[int]]]
    state: str
    levels_completed: int = 0
    win_levels: int = 2
    available_actions: list[int] | None = None


class FakeAdvisor:
    def __init__(self, action: ActionSpec) -> None:
        self.action = action
        self.prompts: list[str] = []

    def advise(self, prompt: str, available_actions: set[int]) -> GemmaPlan:
        self.prompts.append(prompt)
        return GemmaPlan(
            mode="exploit",
            actions=[self.action],
            hypothesis="use transition history",
            confidence=0.8,
        )


def grid(player_y: int = 1) -> list[list[list[int]]]:
    base = [[0 for _ in range(64)] for _ in range(64)]
    base[player_y][1] = 3
    base[10][10] = 2
    return [base]


def click_grid(color: int = 2) -> list[list[list[int]]]:
    base = [[0 for _ in range(64)] for _ in range(64)]
    base[10][10] = color
    base[20][20] = 3
    return [base]


class ControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self._old_trace = os.environ.get("OURO_ARC_TRACE")
        os.environ["OURO_ARC_TRACE"] = "0"

    def tearDown(self) -> None:
        if self._old_trace is None:
            os.environ.pop("OURO_ARC_TRACE", None)
        else:
            os.environ["OURO_ARC_TRACE"] = self._old_trace

    def test_reset_on_not_played(self) -> None:
        controller = ArcController()
        action = controller.choose(DummyFrame(grid(), "NOT_PLAYED", available_actions=[]))
        self.assertEqual(action.action, 0)

    def test_systematic_probe_uses_legal_action(self) -> None:
        controller = ArcController()
        action = controller.choose(DummyFrame(grid(), "NOT_FINISHED", available_actions=[2, 4]))
        self.assertIn(action.action, {2, 4})

    def test_structured_probe_tries_each_simple_action_before_repeating(self) -> None:
        controller = ArcController()
        first = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2, 3, 4]))
        second = controller.choose(DummyFrame(grid(2), "NOT_FINISHED", available_actions=[1, 2, 3, 4]))
        third = controller.choose(DummyFrame(grid(3), "NOT_FINISHED", available_actions=[1, 2, 3, 4]))
        self.assertEqual([first.action, second.action, third.action], [1, 2, 3])

    def test_learns_movement_delta_from_single_object_motion(self) -> None:
        controller = ArcController()
        controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        controller.choose(DummyFrame(grid(2), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertEqual(controller.movement_deltas[1], (0, 1))

    def test_noop_simple_action_is_not_repeated_for_same_frame(self) -> None:
        controller = ArcController()
        first = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        second = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertEqual(first.action, 1)
        self.assertEqual(second.action, 2)
        self.assertEqual(len(controller.noop_edges), 1)

    def test_no_legal_actions_falls_back_to_reset(self) -> None:
        controller = ArcController()
        action = controller.choose(DummyFrame(grid(), "NOT_FINISHED", available_actions=[]))
        self.assertEqual(action.action, 0)

    def test_click_only_without_targets_resets_instead_of_invalid_action6(self) -> None:
        controller = ArcController()
        empty = [[[0 for _ in range(64)] for _ in range(64)]]
        action = controller.choose(DummyFrame(empty, "NOT_FINISHED", available_actions=[6]))
        self.assertEqual(action.action, 0)

    def test_click_only_without_targets_can_use_model_coordinate(self) -> None:
        advisor = FakeAdvisor(ActionSpec(6, x=9, y=8, reason="advisor", source="model"))
        controller = ArcController(advisor=advisor)  # type: ignore[arg-type]
        empty = [[[0 for _ in range(64)] for _ in range(64)]]
        action = controller.choose(DummyFrame(empty, "NOT_FINISHED", available_actions=[6]))
        self.assertEqual((action.action, action.x, action.y), (6, 9, 8))
        self.assertEqual(len(advisor.prompts), 1)

    def test_click_targets_are_not_repeated_before_new_targets(self) -> None:
        controller = ArcController()
        first = controller.choose(DummyFrame(click_grid(2), "NOT_FINISHED", available_actions=[6]))
        second = controller.choose(DummyFrame(click_grid(4), "NOT_FINISHED", available_actions=[6]))
        self.assertEqual(first.action, 6)
        self.assertEqual(second.action, 6)
        self.assertNotEqual((first.x, first.y), (second.x, second.y))

    def test_gemma_receives_recent_transition_history_after_probe_evidence(self) -> None:
        advisor = FakeAdvisor(ActionSpec(2, reason="advisor", source="model"))
        controller = ArcController(advisor=advisor)  # type: ignore[arg-type]
        controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        chosen = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertEqual(chosen.action, 2)
        self.assertEqual(len(advisor.prompts), 1)
        self.assertIn("Recent action outcomes:", advisor.prompts[0])
        self.assertIn("no visible change", advisor.prompts[0])
        self.assertIn("Movement model:", advisor.prompts[0])
        self.assertIn("Click-board model:", advisor.prompts[0])

    def test_controller_prefers_movement_bfs_after_probe_pass(self) -> None:
        controller = ArcController()
        controller.level_probe_actions = {1, 2}
        controller.movement_model.current_position = (1, 1)
        controller.movement_model.deltas = {1: (0, -1), 2: (0, 1)}
        controller.movement_model.visited_positions = {(1, 1), (1, 0)}
        action = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertEqual(action.source, "movement-bfs")

    def test_controller_writes_telemetry_for_transition(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["OURO_ARC_TRACE"] = "1"
            path = Path(tmp) / "trace.jsonl"
            controller = ArcController(telemetry=TelemetryWriter(path=str(path)))
            controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1]))
            controller.choose(DummyFrame(grid(2), "NOT_FINISHED", available_actions=[1]))
            self.assertTrue(path.exists())
            self.assertIn('"solver":"probe"', path.read_text())

    def test_records_macro_and_replays_after_game_over(self) -> None:
        controller = ArcController()
        first = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", 0, available_actions=[2]))
        self.assertEqual(first.action, 2)
        controller.choose(DummyFrame(grid(2), "NOT_FINISHED", 1, available_actions=[4]))
        self.assertEqual(len(controller.macros), 1)

        reset = controller.choose(DummyFrame(grid(2), "GAME_OVER", 1, available_actions=[]))
        self.assertEqual(reset.action, 0)

        replay = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", 0, available_actions=[2]))
        self.assertEqual(replay.action, 2)
        self.assertTrue(controller.replaying)


if __name__ == "__main__":
    unittest.main()
