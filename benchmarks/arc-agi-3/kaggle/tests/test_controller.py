from __future__ import annotations

import unittest
from dataclasses import dataclass

from ouro_arc.controller import ArcController


@dataclass
class DummyFrame:
    frame: list[list[list[int]]]
    state: str
    levels_completed: int = 0
    win_levels: int = 2
    available_actions: list[int] | None = None


def grid(player_y: int = 1) -> list[list[list[int]]]:
    base = [[0 for _ in range(64)] for _ in range(64)]
    base[player_y][1] = 3
    base[10][10] = 2
    return [base]


class ControllerTest(unittest.TestCase):
    def test_reset_on_not_played(self) -> None:
        controller = ArcController()
        action = controller.choose(DummyFrame(grid(), "NOT_PLAYED", available_actions=[]))
        self.assertEqual(action.action, 0)

    def test_systematic_probe_uses_legal_action(self) -> None:
        controller = ArcController()
        action = controller.choose(DummyFrame(grid(), "NOT_FINISHED", available_actions=[2, 4]))
        self.assertIn(action.action, {2, 4})

    def test_no_legal_actions_falls_back_to_reset(self) -> None:
        controller = ArcController()
        action = controller.choose(DummyFrame(grid(), "NOT_FINISHED", available_actions=[]))
        self.assertEqual(action.action, 0)

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
