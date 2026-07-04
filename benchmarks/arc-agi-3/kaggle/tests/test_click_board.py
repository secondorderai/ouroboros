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

    def test_dud_tracking_is_frame_family_scoped(self) -> None:
        model = ClickBoardModel()
        grid = board_grid()
        model.observe_click(
            ActionSpec(6, x=9, y=9),
            grid,
            grid,
            0,
            0,
            "NOT_FINISHED",
            frame_family="a",
        )
        same_family = model.plan(grid, level=0, available_actions={6}, frame_family="a")
        other_family = model.plan(grid, level=0, available_actions={6}, frame_family="b")
        self.assertNotEqual((same_family[0].x, same_family[0].y), (9, 9))
        self.assertEqual((other_family[0].x, other_family[0].y), (9, 9))

    def test_plan_yields_when_all_targets_were_tried(self) -> None:
        model = ClickBoardModel()
        grid = board_grid()
        for target in model.detect_targets(grid):
            model.tried_by_level.setdefault(0, set()).add((target.x, target.y))
        self.assertEqual(model.plan(grid, level=0, available_actions={6}), [])

    def test_color_prior_transfers_across_levels(self) -> None:
        # Two colored regions; a color-5 click scored on level 0. On level 1
        # (no coordinate history) color-5 targets must be ranked before color-3.
        grid = [[0 for _ in range(32)] for _ in range(32)]
        for y0, x0, color in [(8, 8, 5), (8, 16, 5), (16, 8, 3), (16, 16, 3)]:
            for y in range(y0, y0 + 4):
                for x in range(x0, x0 + 4):
                    grid[y][x] = color
        model = ClickBoardModel()
        model.observe_click(ActionSpec(6, x=9, y=9), grid, grid, 0, 1, "NOT_FINISHED")
        self.assertEqual(model.feature_priority(5), -1)
        self.assertIsNone(model.feature_priority(3))

        plan = model.plan(grid, level=1, available_actions={6}, max_actions=8)
        self.assertTrue(plan)
        self.assertEqual(grid[plan[0].y][plan[0].x], 5)

    def test_feature_priority_deprioritizes_dead_colors(self) -> None:
        grid = [[0 for _ in range(32)] for _ in range(32)]
        model = ClickBoardModel()
        for _ in range(3):
            model.observe_click(ActionSpec(6, x=5, y=5), grid, grid, 0, 0, "NOT_FINISHED")  # no-op
        self.assertEqual(model.feature_priority(grid[5][5]), 8)


if __name__ == "__main__":
    unittest.main()
