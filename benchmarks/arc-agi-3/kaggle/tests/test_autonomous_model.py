from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ouro_arc.actions import ActionSpec
from ouro_arc.autonomous_model import (
    AutonomousModelWorker,
    AutonomousWorldModel,
    CertificationResult,
    ReplayFailure,
    normalize_generated_protocol,
    validate_generated_source,
)


NOOP_SOURCE = '''
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

GOAL_SOURCE = NOOP_SOURCE.replace(
    'def step(state, action):\n    return {"grid": [row[:] for row in state["grid"]], "goal": False}',
    'def step(state, action):\n    out = {"grid": [row[:] for row in state["grid"]], "goal": True}\n    out["grid"][0][0] = 1\n    return out',
)


class SourceValidationTest(unittest.TestCase):
    def test_accepts_complete_pure_python_model(self) -> None:
        result = validate_generated_source(NOOP_SOURCE)
        self.assertTrue(result.valid, result.reason)
        self.assertGreater(result.ast_nodes, 0)

    def test_rejects_unsafe_import_and_sensitive_reference(self) -> None:
        for module in ("os", "subprocess", "socket", "ctypes", "sys", "importlib"):
            self.assertFalse(validate_generated_source(f"import {module}\n" + NOOP_SOURCE).valid)
        self.assertIn("sensitive reference", validate_generated_source(NOOP_SOURCE + '\nX="environment_files"').reason)

    def test_rejects_dunder_introspection(self) -> None:
        source = NOOP_SOURCE.replace("return state", "return state.__class__")
        self.assertIn("dunder", validate_generated_source(source).reason)
        source = NOOP_SOURCE.replace("return state", 'return getattr(state, "__class__")')
        self.assertFalse(validate_generated_source(source).valid)

    def test_rejects_missing_contract_function(self) -> None:
        source = NOOP_SOURCE.replace("def is_goal", "def renamed_goal")
        self.assertIn("missing functions", validate_generated_source(source).reason)

    def test_normalizes_qwen_v1_action_literals_to_protocol_v2(self) -> None:
        source = NOOP_SOURCE.replace(
            'return [{"action": 1}]',
            "return [1, 2]",
        ).replace(
            'return {"grid": [row[:] for row in state["grid"]], "goal": False}',
            'return state if action == 1 else state',
        )
        self.assertIn("ModelAction dictionary", validate_generated_source(source).reason)
        normalized = normalize_generated_protocol(source)
        self.assertTrue(validate_generated_source(normalized).valid)
        self.assertIn("action['action'] == 1", normalized)
        self.assertIn("{'action': 1}", normalized)


class AutonomousWorkerTest(unittest.TestCase):
    def test_validates_and_plans_in_worker(self) -> None:
        with AutonomousModelWorker(timeout_seconds=2) as worker:
            self.assertTrue(worker.request({"operation": "validate", "source": GOAL_SOURCE})["valid"])
            result = worker.request(
                {
                    "operation": "plan",
                    "source": GOAL_SOURCE,
                    "grid": [[0]],
                    "max_states": 10,
                    "max_depth": 3,
                }
            )
        self.assertTrue(result["found"])
        self.assertEqual(result["actions"], [{"action": 1}])
        self.assertEqual(result["predicted_grids"], [[[1]]])

    def test_blocks_file_traversal_and_disables_worker(self) -> None:
        source = NOOP_SOURCE.replace(
            "return state",
            'open("/etc/passwd").read()\n    return state',
        )
        with AutonomousModelWorker(timeout_seconds=2) as worker:
            with self.assertRaisesRegex(RuntimeError, "PermissionError"):
                worker.request({"operation": "predict", "source": source, "grid": [[0]], "action": {"action": 1}})
            self.assertTrue(worker.disabled)

    def test_allows_private_workspace_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = NOOP_SOURCE.replace(
                "return state",
                'open("notes.txt", "w").write("ok")\n    return state',
            )
            with AutonomousModelWorker(directory, timeout_seconds=2) as worker:
                worker.request({"operation": "predict", "source": source, "grid": [[0]], "action": {"action": 1}})
            self.assertEqual((Path(directory) / "notes.txt").read_text(), "ok")

    def test_infinite_loop_hits_limit_and_disables_worker(self) -> None:
        source = NOOP_SOURCE.replace(
            'return {"grid": [row[:] for row in grid], "goal": False}',
            "while True:\n        pass",
            1,
        )
        with AutonomousModelWorker(timeout_seconds=1) as worker:
            with self.assertRaisesRegex(RuntimeError, "TimeoutError"):
                worker.request({"operation": "predict", "source": source, "grid": [[0]], "action": {"action": 1}})
            self.assertTrue(worker.disabled)

    def test_output_limit_disables_worker(self) -> None:
        source = NOOP_SOURCE.replace(
            "def canonicalize(state):\n    return state",
            "def canonicalize(state):\n    return list(range(10000))",
        )
        with patch.dict(os.environ, {"OURO_ARC_WORLD_MODEL_MAX_OUTPUT_BYTES": "1024"}, clear=False):
            with AutonomousModelWorker(timeout_seconds=2) as worker:
                with self.assertRaisesRegex(RuntimeError, "OutputLimit"):
                    worker.request({"operation": "predict", "source": source, "grid": [[0]], "action": {"action": 1}})
                self.assertTrue(worker.disabled)

    def test_memory_exhaustion_is_contained(self) -> None:
        source = NOOP_SOURCE.replace(
            'def step(state, action):\n    return {"grid": [row[:] for row in state["grid"]], "goal": False}',
            'def step(state, action):\n    waste = [0] * 20000000\n    return {"grid": state["grid"], "goal": False}',
        )
        validation = validate_generated_source(source)
        self.assertFalse(validation.valid)
        self.assertIn("allocation", validation.reason)


class AutonomousWorldModelTest(unittest.TestCase):
    def _model_with_noop(self) -> AutonomousWorldModel:
        model = AutonomousWorldModel("test", worker=AutonomousModelWorker(timeout_seconds=2))
        model.observe(
            level=0,
            before_grid=[[0]],
            action=ActionSpec(1),
            after_grid=[[0]],
            before_state="NOT_FINISHED",
            after_state="NOT_FINISHED",
            goal=False,
        )
        return model

    def test_complete_history_certification(self) -> None:
        model = self._model_with_noop()
        try:
            candidate = model.add_candidate(NOOP_SOURCE, critic_approved=True)
            self.assertIsNotNone(candidate)
            self.assertTrue(candidate.certified)
            self.assertIsNotNone(model.best_certified)
        finally:
            model.close()

    def test_duplicate_source_counts_as_stalled_revision(self) -> None:
        model = self._model_with_noop()
        try:
            first = model.add_candidate(NOOP_SOURCE)
            duplicate = model.add_candidate(NOOP_SOURCE)
            self.assertIs(first, duplicate)
            self.assertEqual(len(model.candidates), 1)
            self.assertEqual(model.revisions, 2)
            self.assertEqual(model.stalled_revisions, 1)
        finally:
            model.close()

    def test_execution_failure_never_certifies_an_empty_timeline(self) -> None:
        result = CertificationResult(0, 0, (ReplayFailure(-1, "worker", "failed"),))
        self.assertFalse(result.certified)

    def test_persists_versioned_source_and_append_only_timeline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            worker = AutonomousModelWorker(Path(directory), timeout_seconds=2)
            model = AutonomousWorldModel("test", worker=worker)
            model.observe(
                level=0,
                before_grid=[[0]],
                action=ActionSpec(1),
                after_grid=[[0]],
                before_state="NOT_FINISHED",
                after_state="NOT_FINISHED",
                goal=False,
            )
            candidate = model.add_candidate(NOOP_SOURCE, critic_approved=True)
            try:
                artifacts = Path(directory) / ".trusted"
                self.assertTrue((artifacts / "timeline.jsonl").is_file())
                self.assertTrue((artifacts / "world_model.py").is_file())
                self.assertTrue((artifacts / "models" / f"world_model.{candidate.version}.py").is_file())
            finally:
                model.close()

    def test_replay_classifies_initial_round_trip_failure(self) -> None:
        model = self._model_with_noop()
        bad = NOOP_SOURCE.replace('return state["grid"]', "return [[9]]")
        try:
            candidate = model.add_candidate(bad, critic_approved=True)
            self.assertEqual(candidate.certification.failures[0].kind, "perception_rendering")
        finally:
            model.close()

    def test_replay_classifies_perception_transition_and_goal_failures(self) -> None:
        cases = {
            "perception": NOOP_SOURCE.replace(
                'return {"grid": [row[:] for row in grid], "goal": False}',
                'raise ValueError("bad perception")',
                1,
            ),
            "transition": NOOP_SOURCE.replace(
                'def step(state, action):\n    return {"grid": [row[:] for row in state["grid"]], "goal": False}',
                'def step(state, action):\n    raise ValueError("bad transition")',
            ),
            "goal": NOOP_SOURCE.replace('return state["goal"]', "return True"),
        }
        for expected, source in cases.items():
            model = self._model_with_noop()
            try:
                candidate = model.add_candidate(source, critic_approved=True)
                self.assertEqual(candidate.certification.failures[0].kind, expected)
            finally:
                model.close()

    def test_all_cpu_search_modes_use_the_certified_simulator(self) -> None:
        for algorithm in ("bfs", "astar", "backtracking"):
            model = AutonomousWorldModel("test", worker=AutonomousModelWorker(timeout_seconds=2))
            try:
                model.add_candidate(GOAL_SOURCE, critic_approved=True)
                plan = model.plan([[0]], algorithm=algorithm)
                self.assertIsNotNone(plan, algorithm)
                self.assertEqual(plan.predicted_grids, ([[1]],))
            finally:
                model.close()

    def test_progress_score_returns_single_replanning_action(self) -> None:
        source = NOOP_SOURCE.replace(
            'def step(state, action):\n    return {"grid": [row[:] for row in state["grid"]], "goal": False}',
            'def step(state, action):\n    value=state["grid"][0][0]+1\n    return {"grid": [[value]], "goal": False}',
        ) + '\ndef progress_score(state):\n    return state["grid"][0][0]\n'
        model = AutonomousWorldModel("test", worker=AutonomousModelWorker(timeout_seconds=2))
        try:
            model.add_candidate(source, critic_verdict="reject")
            plan = model.plan([[0]])
            self.assertIsNotNone(plan)
            self.assertEqual(plan.objective, "progress")
            self.assertEqual(len(plan.actions), 1)
            self.assertEqual(plan.predicted_grids, ([[1]],))
        finally:
            model.close()

    def test_promoted_helpers_execute_inside_model_namespace(self) -> None:
        source = NOOP_SOURCE.replace(
            'def step(state, action):\n    return {"grid": [row[:] for row in state["grid"]], "goal": False}',
            'def step(state, action):\n    return {"grid": [[helpers.bump(state["grid"][0][0])]], "goal": False}',
        )
        model = AutonomousWorldModel("test", worker=AutonomousModelWorker(timeout_seconds=2))
        model.set_helpers_source("def bump(value):\n    return value + 1\n")
        try:
            model.observe(
                level=0,
                before_grid=[[0]],
                action=ActionSpec(1),
                after_grid=[[1]],
                before_state="NOT_FINISHED",
                after_state="NOT_FINISHED",
                goal=False,
            )
            candidate = model.add_candidate(source)
            self.assertTrue(candidate.certified)
        finally:
            model.close()

    def test_exact_replay_model_can_plan_despite_critic_verdict(self) -> None:
        model = AutonomousWorldModel("test", worker=AutonomousModelWorker(timeout_seconds=2))
        try:
            candidate = model.add_candidate(GOAL_SOURCE, critic_approved=False)
            self.assertTrue(candidate.certified)
            plan = model.plan([[0]])
            self.assertIsNotNone(plan)
            self.assertEqual(plan.actions[0].source, "autonomous-plan")
        finally:
            model.close()

    def test_competing_models_choose_discriminating_probe(self) -> None:
        model = self._model_with_noop()
        try:
            model.add_candidate(NOOP_SOURCE, critic_approved=True)
            changed = NOOP_SOURCE.replace(
                'def step(state, action):\n    return {"grid": [row[:] for row in state["grid"]], "goal": False}',
                'def step(state, action):\n    out={"grid": [row[:] for row in state["grid"]], "goal": False}\n    if action["action"] == 2:\n        out["grid"][0][0]=1\n    return out',
            )
            model.add_candidate(changed, critic_approved=True)
            probe = model.discriminating_probe([[0]], [ActionSpec(2)])
            self.assertIsNotNone(probe)
            self.assertEqual(probe.disagreement, 2)
        finally:
            model.close()

    def test_replay_advances_latent_state_sequentially(self) -> None:
        source = '''
def parse_observation(grid, memory):
    return {"grid": [row[:] for row in grid], "counter": 0}
def available_actions(state):
    return [{"action": 1}]
def step(state, action):
    counter = state["counter"] + 1
    return {"grid": [[counter]], "counter": counter}
def render(state):
    return state["grid"]
def is_goal(state):
    return False
def canonicalize(state):
    return state
'''
        model = AutonomousWorldModel("test", worker=AutonomousModelWorker(timeout_seconds=2))
        try:
            model.observe(
                episode=0,
                level=0,
                before_grid=[[0]],
                action=ActionSpec(1, reason="controller detail", source="movement-bfs"),
                after_grid=[[1]],
                before_state="NOT_FINISHED",
                after_state="NOT_FINISHED",
                goal=False,
            )
            model.observe(
                episode=0,
                level=0,
                before_grid=[[1]],
                action=ActionSpec(1),
                after_grid=[[2]],
                before_state="NOT_FINISHED",
                after_state="NOT_FINISHED",
                goal=False,
            )
            candidate = model.add_candidate(source, critic_verdict="reject")
            self.assertTrue(candidate.certified)
            self.assertEqual(candidate.certification.passed_indexes, (0, 1))
            self.assertEqual(candidate.certification.final_state, {"counter": 2, "grid": [[2]]})
            self.assertEqual(model.timeline[0].action, {"action": 1})
        finally:
            model.close()

    def test_episode_failure_stops_only_that_episode_prefix(self) -> None:
        model = AutonomousWorldModel("test", worker=AutonomousModelWorker(timeout_seconds=2))
        try:
            for episode, before, after in ((0, [[0]], [[1]]), (1, [[0]], [[0]])):
                model.observe(
                    episode=episode,
                    level=0,
                    before_grid=before,
                    action=ActionSpec(1),
                    after_grid=after,
                    before_state="NOT_FINISHED",
                    after_state="NOT_FINISHED",
                    goal=False,
                )
            candidate = model.add_candidate(NOOP_SOURCE)
            self.assertEqual(candidate.certification.passed_indexes, (1,))
            self.assertEqual(candidate.certification.failures[0].episode, 0)
            self.assertEqual(candidate.certification.failures[0].kind, "transition_or_latent")
        finally:
            model.close()


if __name__ == "__main__":
    unittest.main()
