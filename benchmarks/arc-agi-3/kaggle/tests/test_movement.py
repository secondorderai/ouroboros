from __future__ import annotations

import unittest

from ouro_arc.actions import ActionSpec
from ouro_arc.movement import MovementModel


def player_grid(x: int, y: int, extra: bool = False) -> list[list[int]]:
    grid = [[0 for _ in range(8)] for _ in range(8)]
    grid[y][x] = 3
    if extra:
        grid[5][5] = 2
    return grid


class MovementModelTest(unittest.TestCase):
    def test_infers_delta_from_single_object_motion(self) -> None:
        model = MovementModel()
        model.observe_transition(player_grid(1, 1), player_grid(2, 1), ActionSpec(4), "changed")
        self.assertEqual(model.deltas[4], (1, 0))
        self.assertEqual(model.current_position, (2, 1))

    def test_prefers_current_object_when_multiple_objects_move(self) -> None:
        model = MovementModel(current_position=(1, 1))
        prev = player_grid(1, 1)
        prev[5][5] = 2
        nxt = player_grid(1, 2)
        nxt[6][5] = 2
        model.observe_transition(prev, nxt, ActionSpec(2), "changed")
        self.assertEqual(model.deltas[2], (0, 1))
        self.assertEqual(model.current_position, (1, 2))

    def test_bfs_finds_frontier_and_avoids_blocked_edge(self) -> None:
        model = MovementModel(
            deltas={1: (0, -1), 2: (0, 1), 4: (1, 0)},
            current_position=(1, 1),
            visited_positions={(1, 1), (1, 0)},
            blocked_edges={((1, 1), 2)},
        )
        plan = model.plan(width=5, height=5, available_actions={1, 2, 4})
        self.assertEqual([action.action for action in plan], [4])

    def test_ignores_bottom_status_motion(self) -> None:
        model = MovementModel(current_position=(3, 3))
        prev = [[0 for _ in range(8)] for _ in range(8)]
        nxt = [[0 for _ in range(8)] for _ in range(8)]
        prev[6][1] = 4
        nxt[6][2] = 4
        model.observe_transition(prev, nxt, ActionSpec(2), "changed")
        self.assertEqual(model.deltas, {})
        self.assertIn(((3, 3), 2), model.blocked_edges)


if __name__ == "__main__":
    unittest.main()
