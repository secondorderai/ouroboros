from __future__ import annotations

import unittest

from scripts.overfit_lint import lint_diff


def _diff(path: str, added: list[str]) -> str:
    lines = [
        f"diff --git a/{path} b/{path}",
        "index 1111111..2222222 100644",
        f"--- a/{path}",
        f"+++ b/{path}",
        f"@@ -1,1 +1,{len(added) + 1} @@",
    ]
    lines.extend("+" + line for line in added)
    return "\n".join(lines) + "\n"


class OverfitLintTest(unittest.TestCase):
    def test_per_game_branching_hard_fails(self) -> None:
        diff = _diff("ouro_arc/controller.py", ['    if game_id == "s5i5":'])
        result = lint_diff(diff)
        self.assertTrue(result["hard_fails"])

    def test_bare_id_literal_list_hard_fails(self) -> None:
        diff = _diff("ouro_arc/controller.py", ['GAMES = ["lp85", "ft09"]'])
        result = lint_diff(diff)
        self.assertTrue(result["hard_fails"])

    def test_coordinate_heavy_hard_fails(self) -> None:
        diff = _diff(
            "ouro_arc/controller.py",
            [
                "    a = x=10",
                "    b = y=20",
                "    c = x=30",
                "    d = y=40",
                "    e = x=50",
            ],
        )
        result = lint_diff(diff)
        self.assertTrue(
            any("coordinate-heavy" in msg for msg in result["hard_fails"]),
            result,
        )

    def test_clean_diff_passes(self) -> None:
        diff = _diff("ouro_arc/controller.py", ["    threshold = compute_from_grid(grid)"])
        result = lint_diff(diff)
        self.assertEqual(result["hard_fails"], [])
        self.assertEqual(result["advisories"], [])

    def test_holdout_file_excluded(self) -> None:
        diff = _diff(
            "ouro_arc/holdout.py",
            ['    DEV_GAMES = frozenset({"lp85", "ft09"})'],
        )
        result = lint_diff(diff)
        self.assertEqual(result["hard_fails"], [])

    def test_tests_dir_excluded(self) -> None:
        diff = _diff(
            "tests/test_something.py",
            ['    if game_id == "s5i5":'],
        )
        result = lint_diff(diff)
        self.assertEqual(result["hard_fails"], [])

    def test_paired_control_env_default_is_advisory(self) -> None:
        diff = _diff(
            "ouro_arc/controller.py",
            ['    limit = int(os.environ.get("OURO_ARC_PAIRED_CONTROL_REPLAY_LIMIT", "8"))'],
        )
        result = lint_diff(diff)
        self.assertEqual(result["hard_fails"], [])
        self.assertTrue(result["advisories"])


if __name__ == "__main__":
    unittest.main()
