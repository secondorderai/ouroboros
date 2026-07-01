from __future__ import annotations

import unittest

from ouro_arc.constraint_board import ConstraintBoardPlanner


def ft09_like_grid() -> list[list[int]]:
    grid = [[5 for _ in range(64)] for _ in range(64)]

    def fill(x0: int, y0: int, color: int, size: int = 6) -> None:
        for y in range(y0, y0 + size):
            for x in range(x0, x0 + size):
                grid[y][x] = color

    for y0 in (36, 44, 52):
        for x0 in (36, 44, 52):
            if (x0, y0) != (44, 44):
                fill(x0, y0, 9)

    clue = [
        [0, 2, 2],
        [0, 8, 0],
        [0, 2, 2],
    ]
    for row, values in enumerate(clue):
        for col, color in enumerate(values):
            fill(44 + col * 2, 44 + row * 2, color, size=2)
    return grid


class ConstraintBoardPlannerTest(unittest.TestCase):
    def test_plans_clicks_for_violated_3x3_clue_neighbors(self) -> None:
        planner = ConstraintBoardPlanner()
        plan = planner.plan(ft09_like_grid(), level=0, available_actions={6})
        self.assertEqual(
            [(action.x, action.y) for action in plan],
            [(38, 38), (38, 46), (54, 46), (38, 54)],
        )
        self.assertTrue(all(action.source == "constraint-board" for action in plan))

    def test_no_plan_without_click_action(self) -> None:
        planner = ConstraintBoardPlanner()
        self.assertEqual(planner.plan(ft09_like_grid(), level=0, available_actions={1}), [])


if __name__ == "__main__":
    unittest.main()
