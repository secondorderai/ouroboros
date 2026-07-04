from __future__ import annotations

import unittest
import tempfile
import os
from dataclasses import dataclass
from pathlib import Path

from ouro_arc.actions import ActionSpec
from ouro_arc.controller import ArcController, GraphNode
from ouro_arc.gemma import GemmaPlan
from ouro_arc.skills import SkillRegistry
from ouro_arc.telemetry import TelemetryWriter


@dataclass
class DummyFrame:
    frame: list[list[list[int]]]
    state: str
    levels_completed: int = 0
    win_levels: int = 2
    available_actions: list[int] | None = None


class FakeAdvisor:
    def __init__(self, action: ActionSpec) -> None:
        self.action = action
        self.prompts: list[str] = []

    def advise(self, prompt: str, available_actions: set[int]) -> GemmaPlan:
        self.prompts.append(prompt)
        return GemmaPlan(
            mode="exploit",
            actions=[self.action],
            hypothesis="use transition history",
            confidence=0.8,
        )


class NoPlanAdvisor:
    def __init__(self) -> None:
        self.prompts: list[str] = []

    def advise(self, prompt: str, available_actions: set[int]) -> None:
        self.prompts.append(prompt)
        return None


class RaisingAdvisor:
    def __init__(self) -> None:
        self.calls = 0

    def advise(self, prompt: str, available_actions: set[int]) -> GemmaPlan:
        self.calls += 1
        raise RuntimeError("advisor exploded")


def grid(player_y: int = 1) -> list[list[list[int]]]:
    base = [[0 for _ in range(64)] for _ in range(64)]
    base[player_y][1] = 3
    base[10][10] = 2
    return [base]


def click_grid(color: int = 2) -> list[list[list[int]]]:
    base = [[0 for _ in range(64)] for _ in range(64)]
    base[10][10] = color
    base[20][20] = 3
    return [base]


def region_grid(width: int, height: int, color: int = 5) -> list[list[list[int]]]:
    base = [[0 for _ in range(64)] for _ in range(64)]
    base[20][20] = 3
    for y in range(8, 8 + height):
        for x in range(8, 8 + width):
            base[y][x] = color
    return [base]


def paired_control_grid() -> list[list[list[int]]]:
    base = [[5 for _ in range(64)] for _ in range(64)]
    for y in range(20, 23):
        for x in range(38, 41):
            base[y][x] = 14
        for x in range(44, 47):
            base[y][x] = 14
    for y in range(37, 40):
        for x in range(23, 26):
            base[y][x] = 11
    for y in range(43, 46):
        for x in range(23, 26):
            base[y][x] = 11
    return [base]


class ControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self._old_trace = os.environ.get("OURO_ARC_TRACE")
        self._old_policy = os.environ.get("OURO_ARC_GEMMA_POLICY")
        self._old_interval = os.environ.get("OURO_ARC_GEMMA_INTERVAL")
        self._old_max_calls = os.environ.get("OURO_ARC_GEMMA_MAX_CALLS")
        self._old_backoff = os.environ.get("OURO_ARC_GEMMA_BACKOFF_ACTIONS")
        self._old_threshold = os.environ.get("OURO_ARC_GEMMA_FAILURE_THRESHOLD")
        self._old_summary = os.environ.get("OURO_ARC_SUMMARY_PATH")
        self._old_trace_frames = os.environ.get("OURO_ARC_TRACE_FRAMES")
        self._old_game_id = os.environ.get("OURO_ARC_GAME_ID")
        os.environ["OURO_ARC_TRACE"] = "0"
        os.environ["OURO_ARC_GEMMA_POLICY"] = "sparse"
        os.environ.pop("OURO_ARC_GEMMA_INTERVAL", None)
        os.environ.pop("OURO_ARC_GEMMA_MAX_CALLS", None)
        os.environ.pop("OURO_ARC_GEMMA_BACKOFF_ACTIONS", None)
        os.environ.pop("OURO_ARC_GEMMA_FAILURE_THRESHOLD", None)
        os.environ.pop("OURO_ARC_SUMMARY_PATH", None)

    def tearDown(self) -> None:
        if self._old_trace is None:
            os.environ.pop("OURO_ARC_TRACE", None)
        else:
            os.environ["OURO_ARC_TRACE"] = self._old_trace
        if self._old_policy is None:
            os.environ.pop("OURO_ARC_GEMMA_POLICY", None)
        else:
            os.environ["OURO_ARC_GEMMA_POLICY"] = self._old_policy
        for key, value in (
            ("OURO_ARC_GEMMA_INTERVAL", self._old_interval),
            ("OURO_ARC_GEMMA_MAX_CALLS", self._old_max_calls),
            ("OURO_ARC_GEMMA_BACKOFF_ACTIONS", self._old_backoff),
            ("OURO_ARC_GEMMA_FAILURE_THRESHOLD", self._old_threshold),
            ("OURO_ARC_SUMMARY_PATH", self._old_summary),
            ("OURO_ARC_TRACE_FRAMES", self._old_trace_frames),
            ("OURO_ARC_GAME_ID", self._old_game_id),
        ):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_gemma_defaults_are_conservative_for_submission(self) -> None:
        controller = ArcController()
        self.assertEqual(controller.gemma_policy, "sparse")
        self.assertEqual(controller.gemma_interval, 16)
        self.assertEqual(controller.max_model_calls, 12)
        self.assertEqual(controller.gemma_backoff_actions, 12)
        self.assertEqual(controller.gemma_failure_threshold, 3)

    def test_reset_on_not_played(self) -> None:
        controller = ArcController()
        action = controller.choose(DummyFrame(grid(), "NOT_PLAYED", available_actions=[]))
        self.assertEqual(action.action, 0)

    def test_game_over_reset_replays_learned_macro(self) -> None:
        controller = ArcController()
        controller.macros = [[ActionSpec(6, x=9, y=8, reason="learned", source="learned-macro")]]

        reset = controller.choose(DummyFrame(grid(), "GAME_OVER", available_actions=[]))
        replay = controller.choose(DummyFrame(grid(), "NOT_FINISHED", available_actions=[6]))

        self.assertEqual(reset.action, 0)
        self.assertEqual((replay.action, replay.x, replay.y), (6, 9, 8))
        self.assertEqual(replay.source, "learned-macro")

    def test_systematic_probe_uses_legal_action(self) -> None:
        controller = ArcController()
        action = controller.choose(DummyFrame(grid(), "NOT_FINISHED", available_actions=[2, 4]))
        self.assertIn(action.action, {2, 4})

    def test_structured_probe_tries_each_simple_action_before_repeating(self) -> None:
        controller = ArcController()
        first = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2, 3, 4]))
        second = controller.choose(DummyFrame(grid(2), "NOT_FINISHED", available_actions=[1, 2, 3, 4]))
        third = controller.choose(DummyFrame(grid(3), "NOT_FINISHED", available_actions=[1, 2, 3, 4]))
        self.assertEqual([first.action, second.action, third.action], [1, 2, 3])

    def test_learns_movement_delta_from_single_object_motion(self) -> None:
        controller = ArcController()
        controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        controller.choose(DummyFrame(grid(2), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertEqual(controller.movement_deltas[1], (0, 1))

    def test_noop_simple_action_is_not_repeated_for_same_frame(self) -> None:
        controller = ArcController()
        first = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        second = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertEqual(first.action, 1)
        self.assertEqual(second.action, 2)
        self.assertEqual(len(controller.noop_edges), 1)

    def test_no_legal_actions_falls_back_to_reset(self) -> None:
        controller = ArcController()
        action = controller.choose(DummyFrame(grid(), "NOT_FINISHED", available_actions=[]))
        self.assertEqual(action.action, 0)

    def test_click_only_without_targets_uses_fallback_click_sweep(self) -> None:
        controller = ArcController()
        empty = [[[0 for _ in range(64)] for _ in range(64)]]
        action = controller.choose(DummyFrame(empty, "NOT_FINISHED", available_actions=[6]))
        self.assertEqual(action.action, 6)
        self.assertIsNotNone(action.x)
        self.assertIsNotNone(action.y)

    def test_click_only_without_targets_can_use_model_coordinate(self) -> None:
        advisor = FakeAdvisor(ActionSpec(6, x=9, y=8, reason="advisor", source="model"))
        controller = ArcController(advisor=advisor)  # type: ignore[arg-type]
        empty = [[[0 for _ in range(64)] for _ in range(64)]]
        action = controller.choose(DummyFrame(empty, "NOT_FINISHED", available_actions=[6]))
        self.assertEqual((action.action, action.x, action.y), (6, 9, 8))
        self.assertEqual(len(advisor.prompts), 1)

    def test_advisor_exception_is_contained_and_run_continues(self) -> None:
        advisor = RaisingAdvisor()
        controller = ArcController(advisor=advisor)  # type: ignore[arg-type]
        empty = [[[0 for _ in range(64)] for _ in range(64)]]
        action = controller.choose(DummyFrame(empty, "NOT_FINISHED", available_actions=[6]))
        self.assertEqual(advisor.calls, 1)
        self.assertEqual(action.action, 6)
        self.assertEqual(controller.model_failure_total, 1)

    def test_click_targets_are_not_repeated_before_new_targets(self) -> None:
        controller = ArcController()
        first = controller.choose(DummyFrame(click_grid(2), "NOT_FINISHED", available_actions=[6]))
        second = controller.choose(DummyFrame(click_grid(4), "NOT_FINISHED", available_actions=[6]))
        self.assertEqual(first.action, 6)
        self.assertEqual(second.action, 6)
        self.assertNotEqual((first.x, first.y), (second.x, second.y))

    def test_large_board_changing_click_is_replayed_before_new_plans(self) -> None:
        controller = ArcController(skill_registry=SkillRegistry([]))
        before = controller._frame_view(DummyFrame(region_grid(1, 1), "NOT_FINISHED", available_actions=[6]))
        controller.last_view = before
        controller.last_action = ActionSpec(6, x=4, y=32, source="controller")

        replay = controller.choose(DummyFrame(region_grid(16, 10), "NOT_FINISHED", available_actions=[6]))

        self.assertEqual((replay.action, replay.x, replay.y), (6, 4, 32))
        self.assertEqual(replay.reason, "repeat large board-changing click (159 cells)")

    def test_small_board_changing_click_is_not_forced_into_replay(self) -> None:
        controller = ArcController(skill_registry=SkillRegistry([]))
        before = controller._frame_view(DummyFrame(region_grid(1, 1), "NOT_FINISHED", available_actions=[6]))
        controller.last_view = before
        controller.last_action = ActionSpec(6, x=4, y=32, source="controller")

        action = controller.choose(DummyFrame(region_grid(3, 3), "NOT_FINISHED", available_actions=[6]))

        self.assertNotEqual((action.x, action.y), (4, 32))
        self.assertIsNone(controller.large_click_replay)

    def test_click_only_paired_controls_repeat_positive_buttons_before_skills(self) -> None:
        controller = ArcController(skill_registry=SkillRegistry([]))

        action = controller.choose(DummyFrame(paired_control_grid(), "NOT_FINISHED", available_actions=[6]))
        view = controller._frame_view(DummyFrame(paired_control_grid(), "NOT_FINISHED", available_actions=[6]))
        plan = controller._paired_control_plan(view)

        self.assertEqual((action.action, action.x, action.y), (6, 45, 21))
        self.assertEqual(action.source, "paired-control")
        self.assertEqual([(step.x, step.y) for step in plan], [])
        self.assertEqual(len(controller.queue), 13)
        self.assertEqual([(step.x, step.y) for step in controller.queue[:6]], [(45, 21)] * 6)
        self.assertEqual([(step.x, step.y) for step in controller.queue[6:]], [(24, 44)] * 7)

    def test_paired_control_plan_requires_click_only_board(self) -> None:
        controller = ArcController(skill_registry=SkillRegistry([]))
        view = controller._frame_view(DummyFrame(paired_control_grid(), "NOT_FINISHED", available_actions=[2, 6]))

        self.assertEqual(controller._paired_control_plan(view), [])

    def test_click_sequence_planner_breaks_cycle_before_generic_clicks(self) -> None:
        controller = ArcController(skill_registry=SkillRegistry([]))
        view = controller._frame_view(DummyFrame(click_grid(2), "NOT_FINISHED", available_actions=[6]))
        other_key = "other"
        controller.click_sequence.recent_states[0] = [view.key, other_key, view.key, other_key, view.key]
        controller.click_sequence.tried_by_state[(0, view.key)] = {(10, 10)}

        action = controller.choose(DummyFrame(click_grid(2), "NOT_FINISHED", available_actions=[6]))

        self.assertEqual(action.source, "click-sequence")
        self.assertEqual((action.x, action.y), (20, 20))

    def test_generic_click_candidates_skip_observed_cycle_edge(self) -> None:
        controller = ArcController(skill_registry=SkillRegistry([]))
        view = controller._frame_view(DummyFrame(click_grid(2), "NOT_FINISHED", available_actions=[6]))
        other_key = "other"
        controller.click_sequence.recent_states[0] = [view.key, other_key, view.key, other_key, view.key]
        controller.click_sequence.observe_click(
            0,
            view.key,
            ActionSpec(6, x=10, y=10),
            other_key,
            "changed",
        )

        candidates = controller._candidate_actions(view)

        self.assertNotIn((6, 10, 10), [action.key for action in candidates])
        self.assertIn((6, 20, 20), [action.key for action in candidates])

    def test_gemma_receives_recent_transition_history_after_probe_evidence(self) -> None:
        advisor = FakeAdvisor(ActionSpec(2, reason="advisor", source="model"))
        controller = ArcController(advisor=advisor)  # type: ignore[arg-type]
        controller.source_demotions["explore-repeat"] = 99
        controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        controller.stagnation = 2
        chosen = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertNotEqual(chosen.source, "model")
        self.assertEqual(len(advisor.prompts), 1)
        self.assertIn("Recent action outcomes:", advisor.prompts[0])
        self.assertIn("no visible change", advisor.prompts[0])
        self.assertIn("Movement model:", advisor.prompts[0])
        self.assertIn("Click-board model:", advisor.prompts[0])
        self.assertIn("Click-sequence model:", advisor.prompts[0])
        self.assertIn("Distilled skill candidates:", advisor.prompts[0])
        self.assertIn("Recent failed skills:", advisor.prompts[0])

    def test_active_gemma_policy_does_not_preempt_valid_skill_plan(self) -> None:
        os.environ["OURO_ARC_GEMMA_POLICY"] = "active"
        advisor = FakeAdvisor(ActionSpec(2, reason="advisor", source="model"))
        controller = ArcController(advisor=advisor)  # type: ignore[arg-type]
        controller.level_probe_actions = {1, 2}
        controller.movement_model.current_position = (1, 1)
        controller.movement_model.deltas = {1: (0, -1), 2: (0, 1)}
        controller.movement_model.visited_positions = {(1, 1), (1, 0)}
        action = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertEqual(action.source, "movement-bfs")
        self.assertEqual(len(advisor.prompts), 0)

    def test_active_gemma_can_advise_stale_skill_plan(self) -> None:
        os.environ["OURO_ARC_GEMMA_POLICY"] = "active"
        advisor = FakeAdvisor(ActionSpec(2, reason="advisor", source="model"))
        controller = ArcController(advisor=advisor)  # type: ignore[arg-type]
        controller.source_demotions["explore-repeat"] = 99
        controller.level_probe_actions = {1, 2}
        controller.stagnation = 2
        controller.movement_model.current_position = (1, 1)
        controller.movement_model.deltas = {1: (0, -1), 2: (0, 1)}
        controller.movement_model.visited_positions = {(1, 1), (1, 0)}
        action = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertEqual(action.source, "model")
        self.assertEqual(len(advisor.prompts), 1)

    def test_gemma_no_plan_failures_enter_backoff(self) -> None:
        os.environ["OURO_ARC_GEMMA_POLICY"] = "active"
        os.environ["OURO_ARC_GEMMA_INTERVAL"] = "1"
        advisor = NoPlanAdvisor()
        controller = ArcController(advisor=advisor)  # type: ignore[arg-type]
        empty = [[[0 for _ in range(64)] for _ in range(64)]]

        for _ in range(3):
            action = controller.choose(DummyFrame(empty, "NOT_FINISHED", available_actions=[6]))
            self.assertNotEqual(action.source, "model")

        self.assertEqual(len(advisor.prompts), 3)
        self.assertGreater(controller.gemma_backoff_remaining, 0)

        controller.choose(DummyFrame(empty, "NOT_FINISHED", available_actions=[6]))
        self.assertEqual(len(advisor.prompts), 3)

    def test_controller_prefers_movement_bfs_after_probe_pass(self) -> None:
        controller = ArcController()
        controller.source_demotions["explore-repeat"] = 99
        controller.level_probe_actions = {1, 2}
        controller.movement_model.current_position = (1, 1)
        controller.movement_model.deltas = {1: (0, -1), 2: (0, 1)}
        controller.movement_model.visited_positions = {(1, 1), (1, 0)}
        action = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertEqual(action.source, "movement-bfs")

    def test_repeated_action_explore_runs_after_probe_pass(self) -> None:
        controller = ArcController()
        controller.level_probe_actions = {1, 2}
        controller.stagnation = controller.explore_min_stagnation
        controller.source_demotions["skill-frontier"] = 99
        action = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertEqual(action.source, "explore-repeat")
        self.assertGreater(len(controller.queue), 0)

    def test_explore_burst_stops_on_frame_change(self) -> None:
        controller = ArcController()
        controller.level_probe_actions = {1}
        controller.stagnation = controller.explore_min_stagnation
        controller.source_demotions["skill-frontier"] = 99
        first = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1]))
        self.assertEqual(first.source, "explore-repeat")
        second = controller.choose(DummyFrame(grid(2), "NOT_FINISHED", available_actions=[1]))
        self.assertNotEqual(second.source, "explore-repeat")
        self.assertFalse(controller.queue)

    def test_loop_breaker_demotes_repeated_source_action(self) -> None:
        controller = ArcController()
        frame = controller._frame_view(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1]))
        controller.nodes[frame.key] = GraphNode(frame.key)
        action = ActionSpec(1, source="skill-frontier")
        for _ in range(12):
            controller._observe_policy_outcome(frame, frame, action, "no visible change")
        self.assertIn("skill-frontier", controller.source_demotions)

    def test_loop_breaker_does_not_demote_core_click_sources(self) -> None:
        controller = ArcController()
        frame = controller._frame_view(DummyFrame(click_grid(), "NOT_FINISHED", available_actions=[6]))
        for source in ("controller", "click-board", "skill-salient-click"):
            action = ActionSpec(6, x=10, y=10, source=source)
            for _ in range(12):
                controller._observe_policy_outcome(frame, frame, action, "no visible change")
            self.assertNotIn(source, controller.source_demotions)

    def test_click_source_cooldown_suppresses_failing_controller_clicks(self) -> None:
        controller = ArcController(skill_registry=SkillRegistry([]))
        frame = controller._frame_view(DummyFrame(click_grid(), "NOT_FINISHED", available_actions=[6]))
        action = ActionSpec(6, x=10, y=10, source="controller")

        for _ in range(controller.click_source_failure_threshold):
            controller._observe_policy_outcome(frame, frame, action, "no visible change")

        self.assertTrue(controller._click_source_cooled(frame, "controller"))
        candidates = controller._candidate_actions(frame)
        self.assertEqual(candidates, [])

    def test_click_source_cooldown_does_not_suppress_click_board(self) -> None:
        controller = ArcController(skill_registry=SkillRegistry([]))
        frame = controller._frame_view(DummyFrame(click_grid(), "NOT_FINISHED", available_actions=[6]))
        action = ActionSpec(6, x=10, y=10, source="click-board")

        for _ in range(controller.click_source_failure_threshold):
            controller._observe_policy_outcome(frame, frame, action, "no visible change")

        self.assertFalse(controller._click_source_cooled(frame, "click-board"))

    def test_click_sequence_can_be_demoted_by_loop_breaker(self) -> None:
        controller = ArcController()
        frame = controller._frame_view(DummyFrame(click_grid(), "NOT_FINISHED", available_actions=[6]))
        controller.nodes[frame.key] = GraphNode(frame.key)
        action = ActionSpec(6, x=10, y=10, source="click-sequence")
        for _ in range(12):
            controller._observe_policy_outcome(frame, frame, action, "no visible change")
        self.assertIn("click-sequence", controller.source_demotions)

    def test_click_sequence_takes_frontier_when_click_sources_are_cooled(self) -> None:
        controller = ArcController(skill_registry=SkillRegistry([]))
        frame = controller._frame_view(DummyFrame(click_grid(), "NOT_FINISHED", available_actions=[6]))
        controller.click_source_cooldowns[(0, frame.key, "controller")] = 12
        controller.source_demotions["click-sequence"] = 12
        controller.click_sequence.tried_by_state[(0, frame.key)] = {(10, 10)}
        controller.click_sequence.observe_click(
            0,
            "known",
            ActionSpec(6, x=1, y=1),
            "other",
            "changed",
        )

        plan = controller._click_sequence_plan(frame)

        self.assertTrue(plan)
        self.assertEqual(plan[0].source, "click-sequence")
        self.assertEqual((plan[0].x, plan[0].y), (20, 20))

    def test_fallback_click_cycle_is_disabled_after_sweep(self) -> None:
        controller = ArcController()
        empty = [[[0 for _ in range(64)] for _ in range(64)]]
        view = controller._frame_view(DummyFrame(empty, "NOT_FINISHED", available_actions=[6]))
        controller.clicked_targets[0] = {
            (x, y)
            for y in (7, 15, 23, 31, 39, 47, 55)
            for x in (7, 15, 23, 31, 39, 47, 55)
        }
        self.assertIsNone(controller._fallback_non_reset(view))

    def test_exhausted_click_only_frame_uses_non_reset_escape(self) -> None:
        controller = ArcController()
        empty = [[[0 for _ in range(64)] for _ in range(64)]]
        view = controller._frame_view(DummyFrame(empty, "NOT_FINISHED", available_actions=[6]))
        controller.clicked_targets[0] = {
            (x, y)
            for y in (7, 15, 23, 31, 39, 47, 55)
            for x in (7, 15, 23, 31, 39, 47, 55)
        }
        action = controller._least_bad_non_reset(view)
        self.assertEqual(action.action, 6)
        self.assertEqual(action.source, "escape")

    def test_queued_explore_plan_aborts_on_prediction_mismatch(self) -> None:
        controller = ArcController()
        first_view = controller._frame_view(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1]))
        next_view = controller._frame_view(DummyFrame(grid(2), "NOT_FINISHED", available_actions=[1]))
        controller._enqueue(
            [ActionSpec(1, source="explore-repeat")],
            first_view,
            source="explore-repeat",
            abort_on_key_change=True,
        )
        self.assertIsNone(controller._pop_legal(next_view))
        self.assertFalse(controller.queue)

    def test_controller_writes_telemetry_for_transition(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["OURO_ARC_TRACE"] = "1"
            os.environ["OURO_ARC_TRACE_FRAMES"] = "1"
            os.environ["OURO_ARC_GAME_ID"] = "unit"
            path = Path(tmp) / "trace.jsonl"
            controller = ArcController(telemetry=TelemetryWriter(path=str(path)))
            controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1]))
            controller.choose(DummyFrame(grid(2), "NOT_FINISHED", available_actions=[1]))
            self.assertTrue(path.exists())
            contents = path.read_text()
            self.assertIn('"solver":"probe"', contents)
            self.assertIn('"policy":"sparse"', contents)
            self.assertIn('"max_calls":12', contents)
            self.assertIn('"interval":16', contents)
            self.assertIn('"game_id":"unit"', contents)
            self.assertIn('"frames"', contents)

    def test_runtime_summary_contains_required_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["OURO_ARC_TRACE"] = "1"
            os.environ["OURO_ARC_SUMMARY_PATH"] = str(Path(tmp) / "summary.json")
            controller = ArcController(
                telemetry=TelemetryWriter(path=str(Path(tmp) / "trace.jsonl"))
            )
            controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1]))
            controller.choose(DummyFrame(grid(2), "NOT_FINISHED", available_actions=[1]))
            controller.write_summary()
            summary = Path(os.environ["OURO_ARC_SUMMARY_PATH"]).read_text()
            self.assertIn('"action_count"', summary)
            self.assertIn('"gemma_calls"', summary)
            self.assertIn('"max_level_reached"', summary)
            self.assertIn('"solver_counts"', summary)

    def test_skill_cooldown_after_repeated_no_progress(self) -> None:
        controller = ArcController()
        for _ in range(3):
            controller._record_skill_failure(0, "movement-bfs-frontier", "no visible change")
        self.assertIn((0, "movement-bfs-frontier"), controller.skill_cooldowns)
        controller.level_probe_actions = {1, 2}
        controller.movement_model.current_position = (1, 1)
        controller.movement_model.deltas = {1: (0, -1), 2: (0, 1)}
        controller.movement_model.visited_positions = {(1, 1), (1, 0)}
        action = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertNotEqual(action.source, "movement-bfs")

    def test_skill_ban_after_game_over(self) -> None:
        controller = ArcController()
        controller._record_skill_failure(0, "movement-bfs-frontier", "game over")
        self.assertIn((0, "movement-bfs-frontier"), controller.banned_skills)
        controller.level_probe_actions = {1, 2}
        controller.movement_model.current_position = (1, 1)
        controller.movement_model.deltas = {1: (0, -1), 2: (0, 1)}
        controller.movement_model.visited_positions = {(1, 1), (1, 0)}
        action = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", available_actions=[1, 2]))
        self.assertNotEqual(action.source, "movement-bfs")

    def test_click_skill_game_over_uses_cooldown_not_ban(self) -> None:
        controller = ArcController()
        controller._record_skill_failure(0, "salient-click-probe", "game over")
        self.assertNotIn((0, "salient-click-probe"), controller.banned_skills)
        self.assertIn((0, "salient-click-probe"), controller.skill_cooldowns)

    def test_click_board_plan_stops_after_level_budget(self) -> None:
        controller = ArcController()
        controller.click_board_level_limit = 1
        view = controller._frame_view(DummyFrame(click_grid(), "NOT_FINISHED", available_actions=[6]))
        controller.click_board_actions_by_level[0] = 1
        self.assertEqual(controller._click_board_plan(view), [])

    def test_failed_macro_replay_is_disabled_after_game_over(self) -> None:
        controller = ArcController()
        first = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", 0, available_actions=[2]))
        self.assertEqual(first.action, 2)
        controller.choose(DummyFrame(grid(2), "NOT_FINISHED", 1, available_actions=[4]))
        self.assertEqual(len(controller.macros), 1)

        reset = controller.choose(DummyFrame(grid(2), "GAME_OVER", 1, available_actions=[]))
        self.assertEqual(reset.action, 0)

        replay = controller.choose(DummyFrame(grid(1), "NOT_FINISHED", 0, available_actions=[2]))
        self.assertFalse(controller.replaying)
        self.assertTrue(controller.macro_replay_disabled)


class PlannerTest(unittest.TestCase):
    def _set_env(self, key: str, value: str) -> None:
        old = os.environ.get(key)
        os.environ[key] = value

        def restore() -> None:
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old

        self.addCleanup(restore)

    def _view(self, controller: ArcController, available=(1, 2, 3, 4)):
        frame = DummyFrame(grid(), "NOT_FINISHED", 0, available_actions=list(available))
        return controller._frame_view(frame)

    def test_planner_noop_on_sparse_graph(self) -> None:
        controller = ArcController()
        view = self._view(controller)
        # Default min-nodes is 6; an empty graph must not plan, so the cascade
        # falls through to the existing solvers exactly as before.
        self.assertEqual(controller._planner_plan(view), [])

    def test_planner_disabled_by_env(self) -> None:
        self._set_env("OURO_ARC_DISABLE_PLANNER", "1")
        self._set_env("OURO_ARC_PLANNER_MIN_NODES", "1")
        controller = ArcController()
        view = self._view(controller)
        controller.transition_graph.observe(view.key, (2, None, None), "t", "score increased", 0)
        self.assertEqual(controller._planner_plan(view), [])

    def test_planner_replays_known_score_transition(self) -> None:
        self._set_env("OURO_ARC_PLANNER_MIN_NODES", "1")
        controller = ArcController()
        frame = DummyFrame(grid(), "NOT_FINISHED", 0, available_actions=[1, 2, 3, 4])
        view = controller._frame_view(frame)
        controller.transition_graph.observe(view.key, (2, None, None), "t", "score increased", 0)
        # Force the earlier cascade stages (probe / paired-control) to yield so the
        # planner is the stage that answers, proving the cascade wiring.
        controller.level_probe_actions = {1, 2, 3, 4, 5, 7}
        action = controller.choose(frame)
        self.assertEqual(action.action, 2)
        self.assertEqual(action.source, "planner")

    def test_planner_prefers_safe_score_edge(self) -> None:
        self._set_env("OURO_ARC_PLANNER_MIN_NODES", "1")
        controller = ArcController()
        view = self._view(controller)
        controller.transition_graph.observe(view.key, (2, None, None), "t2", "score increased", 0)
        controller.transition_graph.observe(view.key, (3, None, None), "t3", "score increased", 0)
        controller.dangerous_edges.add((0, view.key, (2, None, None)))
        plan = controller._planner_plan(view)
        self.assertTrue(plan)
        self.assertEqual(plan[0].action, 3)

    def test_planner_respects_source_demotion(self) -> None:
        self._set_env("OURO_ARC_PLANNER_MIN_NODES", "1")
        controller = ArcController()
        view = self._view(controller)
        controller.transition_graph.observe(view.key, (2, None, None), "t", "score increased", 0)
        controller.source_demotions["planner"] = 5
        self.assertEqual(controller._planner_plan(view), [])

    def test_planner_defers_when_local_frontier_exists(self) -> None:
        # With no score route and untried local actions still available, the
        # planner defers to the existing solvers instead of monopolizing.
        self._set_env("OURO_ARC_PLANNER_MIN_NODES", "1")
        controller = ArcController()
        view = self._view(controller, available=(1, 2, 3, 4))
        controller.transition_graph.observe(view.key, (1, None, None), "other", "changed", 0)
        self.assertEqual(controller._planner_plan(view), [])


if __name__ == "__main__":
    unittest.main()
