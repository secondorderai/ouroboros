from __future__ import annotations

import unittest

from ouro_arc.holdout import (
    ALL_PUBLIC_GAMES,
    DEV_GAMES,
    QUARANTINE_GAMES,
    TEST_GAMES,
    achieved_levels,
    fold_levels,
    fold_of,
    fold_rows,
    normalize_game_id,
)

# Minimal mechanism map used only to assert each fold spans movement + click.
# (Not authoritative game logic; just enough to guard the split's diversity.)
MOVEMENT_GAMES = {
    "ls20", "wa30", "sk48", "bp35", "tu93", "ka59", "g50t", "sb26", "r11l",
    "tr87", "ar25", "re86",
}
CLICK_GAMES = {
    "ft09", "s5i5", "cn04", "vc33", "lf52", "su15", "sc25", "dc22", "lp85",
    "m0r0", "sp80", "cd82",
}


class HoldoutSplitTest(unittest.TestCase):
    def test_folds_are_pairwise_disjoint(self) -> None:
        self.assertEqual(DEV_GAMES & TEST_GAMES, frozenset())
        self.assertEqual(DEV_GAMES & QUARANTINE_GAMES, frozenset())
        self.assertEqual(TEST_GAMES & QUARANTINE_GAMES, frozenset())

    def test_union_is_25_ids(self) -> None:
        self.assertEqual(ALL_PUBLIC_GAMES, DEV_GAMES | TEST_GAMES | QUARANTINE_GAMES)
        self.assertEqual(len(ALL_PUBLIC_GAMES), 25)
        self.assertEqual(len(DEV_GAMES), 13)
        self.assertEqual(len(TEST_GAMES), 9)
        self.assertEqual(len(QUARANTINE_GAMES), 3)

    def test_normalize_game_id(self) -> None:
        self.assertEqual(normalize_game_id("vc33-ab12cd34"), "vc33")
        self.assertEqual(normalize_game_id("VC33"), "vc33")
        self.assertEqual(normalize_game_id("  ft09  "), "ft09")

    def test_fold_of_handles_suffixed_ids(self) -> None:
        self.assertEqual(fold_of("vc33-ab12cd34"), "test")
        self.assertEqual(fold_of("ft09-00000000"), "dev")
        self.assertEqual(fold_of("ar25-deadbeef"), "quarantine")

    def test_fold_of_bare_ids(self) -> None:
        self.assertEqual(fold_of("ft09"), "dev")
        self.assertEqual(fold_of("vc33"), "test")
        self.assertEqual(fold_of("re86"), "quarantine")

    def test_fold_of_unknown_id_is_none(self) -> None:
        self.assertIsNone(fold_of("zz99"))
        self.assertIsNone(fold_of("zz99-ffffffff"))

    def test_fold_rows_filters(self) -> None:
        rows = [
            {"game_id": "ft09", "levels_completed": 4},
            {"game_id": "vc33-ab12cd34", "levels_completed": 2},
            {"game_id": "zz99", "levels_completed": 9},
        ]
        dev = fold_rows(rows, "dev")
        self.assertEqual([r["game_id"] for r in dev], ["ft09"])
        test = fold_rows(rows, "test")
        self.assertEqual([r["game_id"] for r in test], ["vc33-ab12cd34"])

    def test_fold_levels_hand_computed(self) -> None:
        rows = [
            {"game_id": "ft09", "levels_completed": 4, "max_level_reached": 4},  # dev
            {"game_id": "m0r0", "levels_completed": 0, "max_level_reached": 1},  # dev
            {"game_id": "vc33", "levels_completed": 2, "max_level_reached": 2},  # test
            {"game_id": "tn36", "levels_completed": 0, "max_level_reached": 3},  # test
            {"game_id": "ar25", "levels_completed": 1},  # quarantine
            {"game_id": "zz99", "levels_completed": 5},  # unknown -> ignored
        ]
        self.assertEqual(fold_levels(rows, "dev"), 4 + 1)
        self.assertEqual(fold_levels(rows, "test"), 2 + 3)
        self.assertEqual(fold_levels(rows, "quarantine"), 1)

    def test_achieved_levels_uses_max(self) -> None:
        self.assertEqual(achieved_levels({"levels_completed": 0, "max_level_reached": 2}), 2)
        self.assertEqual(achieved_levels({"levels_completed": 3}), 3)

    def test_each_fold_has_movement_and_click_game(self) -> None:
        for fold_set in (DEV_GAMES, TEST_GAMES, QUARANTINE_GAMES):
            with self.subTest(fold=sorted(fold_set)):
                self.assertTrue(
                    fold_set & MOVEMENT_GAMES,
                    "fold missing a movement game",
                )
                self.assertTrue(
                    fold_set & CLICK_GAMES,
                    "fold missing a click game",
                )


if __name__ == "__main__":
    unittest.main()
