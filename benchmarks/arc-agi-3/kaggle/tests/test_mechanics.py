from __future__ import annotations

import unittest

from ouro_arc import mechanics


class MechanicsLibraryTest(unittest.TestCase):
    def test_components_and_spatial_relations_are_coordinate_generic(self) -> None:
        grid = [
            [0, 2, 0, 3],
            [0, 2, 0, 3],
            [0, 0, 0, 0],
        ]
        components = mechanics.connected_components(grid)
        self.assertEqual([item["color"] for item in components], [2, 3])
        self.assertEqual([item["size"] for item in components], [2, 2])
        self.assertEqual(mechanics.translate(components[0]["cells"], 2, 0), components[1]["cells"])

    def test_move_collision_push_and_transport(self) -> None:
        grid = [[0, 2, 3, 0]]
        self.assertIsNone(mechanics.move_cells(grid, [(1, 0)], 1, 0, collision_colors={3}))
        self.assertEqual(mechanics.push_chain(grid, (1, 0), 1, 0), [[0, 0, 2, 3]])
        self.assertEqual(mechanics.transport(grid, (1, 0), (3, 0)), [[0, 0, 3, 2]])

    def test_recolor_swap_spawn_remove_toggle_and_carry(self) -> None:
        grid = [[0, 1], [2, 0]]
        self.assertEqual(mechanics.recolor(grid, 1, 4), [[0, 4], [2, 0]])
        self.assertEqual(mechanics.swap_colors(grid, 1, 2), [[0, 2], [1, 0]])
        self.assertEqual(mechanics.spawn(grid, [(0, 0)], 5), [[5, 1], [2, 0]])
        self.assertEqual(mechanics.remove(grid, [(1, 0)]), [[0, 0], [2, 0]])
        self.assertTrue(mechanics.toggle(False))
        self.assertEqual(mechanics.carry({"phase": 0}, "held", [1]), {"phase": 0, "held": [1]})

    def test_neighborhood_transform_and_composition(self) -> None:
        grid = [[0, 1, 0]]
        transformed = mechanics.map_neighborhood(
            grid,
            lambda value, neighbors, point: 2 if value == 0 and 1 in neighbors else value,
        )
        self.assertEqual(transformed, [[2, 1, 2]])
        result = mechanics.compose(
            {"count": 0},
            None,
            lambda state, action: {"count": state["count"] + 1},
            lambda state, action: {"count": state["count"] * 2},
        )
        self.assertEqual(result, {"count": 2})

    def test_graph_search_and_goal_helpers(self) -> None:
        path = mechanics.shortest_path((0, 0), {(2, 0)}, lambda point: 0 <= point[0] <= 2 and point[1] == 0)
        self.assertEqual(path, ((0, 0), (1, 0), (2, 0)))
        self.assertTrue(mechanics.grid_equals([[1]], [[1]]))
        self.assertTrue(mechanics.all_cells_match([[1, 1]], lambda value, point: value == 1))


if __name__ == "__main__":
    unittest.main()
