from __future__ import annotations

import unittest

from scripts.analyze_local_results import achieved_levels


class AnalyzeLocalResultsTest(unittest.TestCase):
    def test_achieved_levels_uses_max_level_when_final_drops(self) -> None:
        row = {"levels_completed": 0, "max_level_reached": 1}

        self.assertEqual(achieved_levels(row), 1)

    def test_achieved_levels_supports_older_baseline_rows(self) -> None:
        row = {"levels_completed": 2}

        self.assertEqual(achieved_levels(row), 2)


if __name__ == "__main__":
    unittest.main()
