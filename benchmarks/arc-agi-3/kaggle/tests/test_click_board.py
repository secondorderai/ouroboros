from __future__ import annotations

import unittest

from ouro_arc.actions import ActionSpec
from ouro_arc.click_board import ClickBoardModel


def board_grid() -> list[list[int]]:
    grid = [[0 for _ in range(32)] for _ in range(32)]
    for y0 in (8, 16):
        for x0 in (8, 16):
            for y in range(y0, y0 + 4):
                for x in range(x0, x0 + 4):
                    grid[y][x] = 5
    for x in range(32):
        grid[0][x] = 7
    return grid


class ClickBoardModelTest(unittest.TestCase):
    def test_detects_regular_targets_and_ignores_hud(self) -> None:
        model = ClickBoardModel()
        targets = model.detect_targets(board_grid())
        self.assertEqual([(target.x, target.y) for target in targets[:4]], [(9, 9), (17, 9), (9, 17), (17, 17)])
        self.assertNotIn((15, 0), [(target.x, target.y) for target in targets])

    def test_classifies_click_outcomes(self) -> None:
        model = ClickBoardModel()
        prev = board_grid()
        same = [row[:] for row in prev]
        hud = [row[:] for row in prev]
        hud[0][31] = 4
        region = [row[:] for row in prev]
        region[9][9] = 6
        self.assertEqual(model.classify(prev, same, 0, 0, "NOT_FINISHED")[0], "no-op")
        self.assertEqual(model.classify(prev, hud, 0, 0, "NOT_FINISHED")[0], "hud-only")
        self.assertEqual(model.classify(prev, region, 0, 0, "NOT_FINISHED")[0], "region-change")
        self.assertEqual(model.classify(prev, region, 0, 1, "NOT_FINISHED")[0], "score-change")
        self.assertEqual(model.classify(prev, region, 0, 0, "GAME_OVER")[0], "death")

    def test_plan_skips_failed_targets(self) -> None:
        model = ClickBoardModel()
        grid = board_grid()
        model.observe_click(ActionSpec(6, x=9, y=9), grid, grid, 0, 0, "NOT_FINISHED")
        plan = model.plan(grid, level=0, available_actions={6})
        self.assertTrue(plan)
        self.assertNotEqual((plan[0].x, plan[0].y), (9, 9))

    def test_plan_yields_when_all_targets_were_tried(self) -> None:
        model = ClickBoardModel()
        grid = board_grid()
        for target in model.detect_targets(grid):
            model.tried_by_level.setdefault(0, set()).add((target.x, target.y))
        self.assertEqual(model.plan(grid, level=0, available_actions={6}), [])


if __name__ == "__main__":
    unittest.main()
