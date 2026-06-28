from __future__ import annotations

import unittest

from ouro_arc.objects import salient_click_targets, segment_objects, summarize_objects
from ouro_arc.render import frame_hash, render_diff, render_full


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


if __name__ == "__main__":
    unittest.main()
