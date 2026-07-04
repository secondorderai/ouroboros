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

    def test_ambiguous_motion_requires_repeated_evidence(self) -> None:
        model = MovementModel()
        prev = player_grid(1, 1)
        prev[4][5] = 2
        nxt = player_grid(1, 2)
        nxt[5][5] = 2
        model.observe_transition(prev, nxt, ActionSpec(2), "changed")
        self.assertEqual(model.deltas, {})

        prev2 = player_grid(1, 2)
        prev2[5][5] = 2
        nxt2 = player_grid(1, 3)
        nxt2[6][5] = 2
        model.observe_transition(prev2, nxt2, ActionSpec(2), "changed")
        self.assertEqual(model.deltas[2], (0, 1))

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


class StepTowardTest(unittest.TestCase):
    def _model(self) -> MovementModel:
        model = MovementModel()
        model.deltas = {1: (0, -1), 2: (0, 1), 3: (-1, 0), 4: (1, 0)}
        model.current_position = (5, 5)
        return model

    def test_steps_toward_target(self) -> None:
        model = self._model()
        # target to the right -> action 4 (+1 x) reduces distance
        self.assertEqual(model.step_toward((9, 5), {1, 2, 3, 4}), 4)
        # target above -> action 1 (-1 y)
        self.assertEqual(model.step_toward((5, 1), {1, 2, 3, 4}), 1)

    def test_returns_none_at_target(self) -> None:
        model = self._model()
        self.assertIsNone(model.step_toward((5, 5), {1, 2, 3, 4}))

    def test_avoids_blocked_and_deadly_edges(self) -> None:
        model = self._model()
        model.blocked_edges.add(((5, 5), 4))  # the ideal move is blocked
        model.death_edges.add(((5, 5), 2))
        # 4 (toward target) blocked -> must not be chosen; falls to another
        self.assertNotEqual(model.step_toward((9, 5), {1, 2, 3, 4}), 4)

    def test_returns_none_without_deltas(self) -> None:
        model = MovementModel()
        self.assertIsNone(model.step_toward((1, 1), {1, 2, 3, 4}))
