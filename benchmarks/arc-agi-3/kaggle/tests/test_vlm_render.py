from __future__ import annotations

import struct
import unittest

from ouro_arc.vlm_render import grid_to_png_bytes


class VlmRenderTest(unittest.TestCase):
    def test_grid_to_png_bytes_is_deterministic_png_with_expected_size(self) -> None:
        grid = [[0, 1], [2, 3]]
        first = grid_to_png_bytes(grid, cell_size=4)
        second = grid_to_png_bytes(grid, cell_size=4)

        self.assertEqual(first, second)
        self.assertTrue(first.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(first[12:16], b"IHDR")
        width, height = struct.unpack(">II", first[16:24])
        self.assertEqual((width, height), (8, 8))

    def test_grid_to_png_bytes_rejects_invalid_grids(self) -> None:
        with self.assertRaises(ValueError):
            grid_to_png_bytes([])
        with self.assertRaises(ValueError):
            grid_to_png_bytes([[0], [0, 1]])
        with self.assertRaises(ValueError):
            grid_to_png_bytes([[16]])
        with self.assertRaises(ValueError):
            grid_to_png_bytes([[0]], cell_size=0)


if __name__ == "__main__":
    unittest.main()
