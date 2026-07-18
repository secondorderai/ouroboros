from __future__ import annotations

import os
import unittest
from dataclasses import dataclass
from unittest.mock import patch

from ouro_arc.actions import ActionSpec
from ouro_arc.controller import ArcController, AutonomousPrediction, FrameView


SOURCE = '''
def parse_observation(grid, memory):
    return {"grid": [row[:] for row in grid], "goal": False}
def available_actions(state):
    return [{"action": 1}]
def step(state, action):
    return {"grid": [row[:] for row in state["grid"]], "goal": False}
def render(state):
    return state["grid"]
def is_goal(state):
    return state["goal"]
def canonicalize(state):
    return state
'''


@dataclass
class DummyFrame:
    frame: list[list[list[int]]]
    state: str = "NOT_FINISHED"
    levels_completed: int = 0
    win_levels: int = 2
    available_actions: list[int] | None = None


class FakeCausalAdvisor:
    disabled = False
    backend = "ollama"
    model = None

    def __init__(self) -> None:
        self.responses = [
            {"model_source": SOURCE, "notes": "noop", "experiment": {"action": 1}, "helpers": []},
            {"verdict": "accept", "issues": [], "counterexample_indexes": []},
        ]
        self.calls = 0

    def complete_json(self, *_args, **_kwargs):
        self.calls += 1
        return self.responses.pop(0)

    def diagnostics(self):
        return {"last_call_status": "success", "rejection_counts": {}, "repair_count": 0}


class AutonomousControllerTest(unittest.TestCase):
    def settings(self):
        return patch.dict(
            os.environ,
            {
                "OURO_ARC_WORLD_MODEL_MODE": "autonomous-python",
                "OURO_ARC_MODEL_POLICY": "world-model",
                "OURO_ARC_MODEL_VISION": "0",
                "OURO_ARC_MODEL_MAX_CALLS": "4",
                "OURO_ARC_MODEL_INTERVAL": "1",
                "OURO_ARC_DISCOVERY_ACTIONS": "1",
                "OURO_ARC_SHARED_MECHANICS": "0",
                "OURO_ARC_TRACE": "0",
            },
            clear=False,
        )

    def close(self, controller: ArcController) -> None:
        if controller.autonomous_model:
            controller.autonomous_model.close()
        if controller.private_mechanics_registry:
            controller.private_mechanics_registry.close()

    def test_world_model_policy_uses_physicist_and_critic_after_discovery(self) -> None:
        advisor = FakeCausalAdvisor()
        board = [[[0, 0], [0, 0]]]
        with self.settings():
            controller = ArcController(advisor=advisor, game_id="zz99")  # type: ignore[arg-type]
            try:
                first = controller.choose(DummyFrame(board, available_actions=[1]))
                self.assertEqual(first.action, 1)
                controller.choose(DummyFrame(board, available_actions=[1]))
                self.assertEqual(advisor.calls, 2)
                self.assertEqual(controller.model_calls, 2)
                self.assertTrue(controller.autonomous_model.best_certified)
                self.assertEqual(len(controller.autonomous_model.timeline), 1)
            finally:
                self.close(controller)

    def test_prediction_mismatch_aborts_remaining_plan(self) -> None:
        with self.settings():
            controller = ArcController(advisor=FakeCausalAdvisor(), game_id="zz99")  # type: ignore[arg-type]
            try:
                controller.queue = [ActionSpec(1, source="autonomous-plan")]
                controller.queue_source = "autonomous-plan"
                candidate = controller.autonomous_model.add_candidate(SOURCE)
                controller.autonomous_pending_prediction = AutonomousPrediction(
                    ActionSpec(1, source="autonomous-plan"),
                    {"grid": [[0]], "goal": False},
                    [[1]],
                    "expected",
                    {"grid": [[1]], "goal": False},
                    candidate.version,
                )
                view = FrameView([[0]], "NOT_FINISHED", 0, 2, {1}, "actual")
                controller._observe_autonomous_prediction(view)
                self.assertEqual(controller.queue, [])
                self.assertEqual(controller.autonomous_model.plan_aborts, 1)
                self.assertTrue(controller.autonomous_revision_pending)
            finally:
                self.close(controller)

    def test_reset_and_large_global_changes_do_not_train_movement(self) -> None:
        prev = FrameView([[0] * 10 for _ in range(10)], "GAME_OVER", 0, 2, {1}, "a")
        view = FrameView([[1] * 10 for _ in range(10)], "NOT_FINISHED", 0, 2, {1}, "b")
        self.assertFalse(ArcController._stable_motion_transition(prev, view, ActionSpec(0)))
        prev = FrameView([[0] * 64 for _ in range(64)], "NOT_FINISHED", 0, 2, {1}, "a")
        changed = [[0] * 64 for _ in range(64)]
        for x in range(100):
            changed[x // 64][x % 64] = 1
        view = FrameView(changed, "NOT_FINISHED", 0, 2, {1}, "b")
        self.assertFalse(ArcController._stable_motion_transition(prev, view, ActionSpec(1)))

    def test_autonomous_action_preempts_deterministic_queue(self) -> None:
        board = [[[0]]]
        with self.settings():
            controller = ArcController(advisor=FakeCausalAdvisor(), game_id="zz99")  # type: ignore[arg-type]
            controller.queue = [ActionSpec(2, source="movement-bfs")]
            controller.queue_source = "movement-bfs"
            with patch.object(
                controller,
                "_autonomous_action",
                return_value=ActionSpec(1, source="autonomous-probe"),
            ):
                action = controller.choose(DummyFrame(board, available_actions=[1, 2]))
            try:
                self.assertEqual(action.source, "autonomous-probe")
                self.assertEqual(controller.autonomous_actions, 1)
            finally:
                self.close(controller)

    def test_prediction_match_checks_grid_state_and_hash(self) -> None:
        with self.settings():
            controller = ArcController(advisor=FakeCausalAdvisor(), game_id="zz99")  # type: ignore[arg-type]
            try:
                candidate = controller.autonomous_model.add_candidate(SOURCE)
                state = {"grid": [[0]], "goal": False}
                state_hash = '{"goal":false,"grid":[[0]]}'
                controller.autonomous_pending_prediction = AutonomousPrediction(
                    ActionSpec(1, source="autonomous-plan"),
                    state,
                    [[0]],
                    state_hash,
                    state,
                    candidate.version,
                )
                view = FrameView([[0]], "NOT_FINISHED", 0, 2, {1}, "actual")
                controller._observe_autonomous_prediction(view)
                self.assertEqual(controller.autonomous_plan_matches, 1)
                self.assertEqual(controller.autonomous_model.plan_aborts, 0)
            finally:
                self.close(controller)

    def test_autonomous_mode_is_default_off(self) -> None:
        with patch.dict(os.environ, {"OURO_ARC_WORLD_MODEL_MODE": "observed"}, clear=False):
            controller = ArcController()
        self.assertFalse(controller.autonomous_enabled)
        self.assertIsNone(controller.autonomous_model)


if __name__ == "__main__":
    unittest.main()
