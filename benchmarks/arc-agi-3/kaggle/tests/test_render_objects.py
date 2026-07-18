from __future__ import annotations

import os
import unittest

from ouro_arc.objects import compact_control_targets, salient_click_targets, segment_objects, summarize_objects, summarize_scene_graph
from ouro_arc.render import frame_hash, object_frame_hash, render_diff, render_full


def _board(cells: dict[tuple[int, int], int]) -> list[list[int]]:
    grid = [[0 for _ in range(64)] for _ in range(64)]
    for (x, y), color in cells.items():
        grid[y][x] = color
    return grid


class RenderObjectsTest(unittest.TestCase):
    def test_last_grid_accepts_array_like_frames(self) -> None:
        class ArrayLike:
            def tolist(self) -> list[list[list[int]]]:
                return [[[1]], [[2]]]

        from ouro_arc.render import last_grid

        self.assertEqual(last_grid(ArrayLike()), [[2]])  # type: ignore[arg-type]

    def test_segment_objects_matches_typescript_summary_shape(self) -> None:
        grid = [
            [0, 0, 0, 0],
            [0, 3, 3, 0],
            [0, 3, 3, 0],
            [0, 0, 2, 0],
        ]
        objects = segment_objects(grid)
        self.assertEqual(len(objects), 3)
        summary = summarize_objects(grid)
        self.assertIn("bg=0", summary)
        self.assertIn("color 3 2x2 rect (4 cells) at (1,1)..(2,2)", summary)
        self.assertIn("color 2 1x1 (1 cell) at (2,3)", summary)

    def test_scene_graph_shape_ids_ignore_translation_and_report_contact(self) -> None:
        grid = [[0 for _ in range(8)] for _ in range(8)]
        grid[2][1] = grid[2][2] = 2
        grid[3][2] = 3
        grid[5][5] = grid[5][6] = 2

        objects = [obj for obj in segment_objects(grid) if obj.color != 0]
        summary = summarize_scene_graph(grid)

        self.assertEqual(objects[0].shape_hash, objects[2].shape_hash)
        self.assertIn("edges=[n0-n1]", summary)

    def test_render_full_and_diff_are_compact(self) -> None:
        a = [[0, 0], [0, 1]]
        b = [[0, 2], [0, 1]]
        self.assertIn("00 00", render_full(a))
        self.assertEqual(render_diff(a, b), "changed 1 cell: (1,0) 0->2")

    def test_frame_hash_masks_hud_rows(self) -> None:
        a = [[0 for _ in range(64)] for _ in range(64)]
        b = [[0 for _ in range(64)] for _ in range(64)]
        a[0][0] = 1
        b[0][0] = 2
        self.assertEqual(frame_hash(a), frame_hash(b))
        b[10][10] = 3
        self.assertNotEqual(frame_hash(a), frame_hash(b))

    def test_salient_click_targets_prefers_regular_tile_centers(self) -> None:
        grid = [[0 for _ in range(64)] for _ in range(64)]
        for y0 in (10, 18):
            for x0 in (20, 28, 36):
                for y in range(y0, y0 + 6):
                    for x in range(x0, x0 + 6):
                        grid[y][x] = 8

        targets = salient_click_targets(grid, limit=6)
        self.assertEqual(
            [(x, y) for x, y, _label in targets],
            [(22, 12), (30, 12), (38, 12), (22, 20), (30, 20), (38, 20)],
        )

    def test_compact_control_targets_find_small_non_rectangular_components(self) -> None:
        grid = [[0 for _ in range(64)] for _ in range(64)]
        for y in range(10, 14):
            for x in range(20, 24):
                grid[y][x] = 8
        for x in range(40, 43):
            grid[30][x] = 5
        grid[29][41] = 5

        targets = compact_control_targets(grid, limit=4)

        self.assertEqual([(x, y) for x, y, _label in targets], [(41, 29)])
        self.assertIn("compact control", targets[0][2])


class ObjectStateKeyTest(unittest.TestCase):
    def test_object_key_stable_across_hud_change(self) -> None:
        # Identical gameplay object; grid_b additionally lights a top HUD-row cell.
        grid_a = _board({(10, 10): 2})
        grid_b = _board({(10, 10): 2, (0, 0): 7})
        # The raw-pixel key already masks the HUD band here, but the object key
        # must also treat the HUD cell as irrelevant.
        self.assertEqual(object_frame_hash(grid_a), object_frame_hash(grid_b))

    def test_object_key_distinguishes_structural_change(self) -> None:
        grid_a = _board({(10, 10): 2})
        grid_b = _board({(15, 15): 2})
        self.assertNotEqual(object_frame_hash(grid_a), object_frame_hash(grid_b))

    def test_frame_view_uses_object_key_only_when_flagged(self) -> None:
        from ouro_arc.controller import ArcController

        class _Frame:
            def __init__(self, grid: list[list[int]]) -> None:
                self.frame = [grid]
                self.state = "NOT_FINISHED"
                self.available_actions = [1, 2, 3, 4]
                self.levels_completed = 0

        old = os.environ.get("OURO_ARC_STATE_KEY")

        def restore() -> None:
            if old is None:
                os.environ.pop("OURO_ARC_STATE_KEY", None)
            else:
                os.environ["OURO_ARC_STATE_KEY"] = old

        self.addCleanup(restore)

        board = _board({(10, 10): 2})
        os.environ.pop("OURO_ARC_STATE_KEY", None)
        controller = ArcController()
        self.assertFalse(controller._frame_view(_Frame(board)).key.startswith("obj:"))

        os.environ["OURO_ARC_STATE_KEY"] = "object"
        controller = ArcController()
        self.assertTrue(controller._frame_view(_Frame(board)).key.startswith("obj:"))


class GoalTargetsTest(unittest.TestCase):
    def test_prefers_rarest_compact_object_and_excludes_player(self) -> None:
        from ouro_arc.objects import goal_targets
        grid = [[0 for _ in range(32)] for _ in range(32)]
        # walls: many color-4 blocks (common); player: color-3; goal: single color-8
        for cx in (6, 12, 18):
            for y in range(6, 9):
                for x in range(cx, cx + 3):
                    grid[y][x] = 4
        grid[20][20] = 3   # player
        grid[24][24] = 8   # rare distinct goal
        targets = goal_targets(grid, exclude_colors=frozenset({3}))
        self.assertTrue(targets)
        self.assertEqual(targets[0][2], 8)                 # rarest color first
        self.assertNotIn(3, [c for _x, _y, c in targets])  # player excluded


if __name__ == "__main__":
    unittest.main()
