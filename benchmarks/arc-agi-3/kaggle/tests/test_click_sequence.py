from __future__ import annotations

import unittest

from ouro_arc.actions import ActionSpec
from ouro_arc.click_sequence import ClickSequencePlanner


class ClickSequencePlannerTest(unittest.TestCase):
    def test_breaks_recent_cycle_with_untried_current_frontier(self) -> None:
        planner = ClickSequencePlanner()
        for key in ("a", "b", "a", "b", "a"):
            planner.observe_state(0, key, [(1, 1), (2, 2)])
        planner.observe_click(0, "a", ActionSpec(6, x=1, y=1), "b", "changed")

        plan = planner.plan(0, "a", {6}, [(1, 1), (2, 2)])

        self.assertEqual([(action.x, action.y) for action in plan], [(2, 2)])
        self.assertEqual(plan[0].source, "click-sequence")

    def test_navigates_known_toggle_path_to_state_with_frontier(self) -> None:
        planner = ClickSequencePlanner()
        planner.observe_state(0, "a", [(1, 1)])
        planner.observe_state(0, "b", [(2, 2)])
        planner.observe_click(0, "a", ActionSpec(6, x=1, y=1), "b", "changed")

        plan = planner.plan(0, "a", {6}, [(1, 1)])

        self.assertEqual([(action.x, action.y) for action in plan], [(1, 1), (2, 2)])

    def test_ignores_death_edges_when_planning(self) -> None:
        planner = ClickSequencePlanner()
        planner.observe_state(0, "a", [(1, 1)])
        planner.observe_state(0, "b", [(2, 2)])
        planner.observe_click(0, "a", ActionSpec(6, x=1, y=1), "b", "game over")

        self.assertEqual(planner.plan(0, "a", {6}, [(1, 1)]), [])

    def test_identifies_current_cycle_points(self) -> None:
        planner = ClickSequencePlanner()
        for key in ("a", "b", "a", "b", "a"):
            planner.observe_state(0, key, [])
        planner.observe_click(0, "a", ActionSpec(6, x=1, y=1), "b", "changed")
        planner.observe_click(0, "b", ActionSpec(6, x=2, y=2), "a", "changed")

        self.assertEqual(planner.cycle_points(0, "a"), {(1, 1)})
        planner.observe_state(0, "b", [])
        self.assertEqual(planner.cycle_points(0, "b"), {(2, 2)})

    def test_tracks_repeated_safe_transition_points(self) -> None:
        planner = ClickSequencePlanner()
        planner.observe_click(0, "a", ActionSpec(6, x=1, y=1), "b", "changed")
        self.assertEqual(planner.repeated_points(0, "a"), set())
        planner.observe_click(0, "a", ActionSpec(6, x=1, y=1), "b", "changed")
        self.assertEqual(planner.repeated_points(0, "a"), {(1, 1)})


if __name__ == "__main__":
    unittest.main()
