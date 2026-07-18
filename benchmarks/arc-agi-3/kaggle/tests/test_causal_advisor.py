from __future__ import annotations

import unittest

from ouro_arc.actions import ActionSpec
from ouro_arc.autonomous_model import AutonomousModelWorker, AutonomousWorldModel
from ouro_arc.causal_advisor import (
    CausalPhysicist,
    MODEL_CRITIQUE_SCHEMA,
    MODEL_PROPOSAL_SCHEMA,
    _change_summary,
    _effect_signature,
)
from ouro_arc.shared_mechanics import SharedMechanicsRegistry


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


class FakeStructuredAdvisor:
    disabled = False

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def complete_json(self, prompt, schema, **kwargs):
        self.calls.append((prompt, schema, kwargs))
        return self.responses.pop(0) if self.responses else None


class CausalPhysicistTest(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = SharedMechanicsRegistry(AutonomousModelWorker(timeout_seconds=2))
        self.model = AutonomousWorldModel("zz99", worker=AutonomousModelWorker(timeout_seconds=2))
        self.model.observe(
            level=0,
            before_grid=[[0]],
            action=ActionSpec(1),
            after_grid=[[0]],
            before_state="NOT_FINISHED",
            after_state="NOT_FINISHED",
            goal=False,
        )

    def tearDown(self) -> None:
        self.model.close()
        self.registry.close()

    def test_physicist_and_critic_accept_certified_source(self) -> None:
        advisor = FakeStructuredAdvisor(
            [
                {"model_source": SOURCE, "notes": "noop", "experiment": {"action": 1}, "helpers": []},
                {"verdict": "accept", "issues": [], "counterexample_indexes": []},
            ]
        )
        result = CausalPhysicist(advisor, self.registry).deliberate(
            self.model,
            current_grid=[[0]],
            available_actions={1},
            image=None,
        )
        self.assertTrue(result.accepted)
        self.assertEqual(result.calls, 2)
        self.assertEqual(result.experiment.action, 1)
        self.assertTrue(self.model.best_certified)
        self.assertIs(advisor.calls[0][1], MODEL_PROPOSAL_SCHEMA)
        self.assertIs(advisor.calls[1][1], MODEL_CRITIQUE_SCHEMA)
        self.assertIn('"action":{"action":1}', advisor.calls[0][0])
        self.assertIn('"object_tracks":[]', advisor.calls[0][0])

    def test_critic_rejection_is_retained_for_revision(self) -> None:
        advisor = FakeStructuredAdvisor(
            [
                {"model_source": SOURCE, "notes": "", "experiment": None, "helpers": []},
                {"verdict": "reject", "issues": ["special case"], "counterexample_indexes": [0]},
            ]
        )
        result = CausalPhysicist(advisor, self.registry).deliberate(
            self.model,
            current_grid=[[0]],
            available_actions={1},
            image=None,
        )
        self.assertTrue(result.accepted)
        self.assertEqual(len(self.model.candidates), 1)
        self.assertEqual(self.model.candidates[0].critic_verdict, "reject")
        self.assertEqual(self.model.candidates[0].critic_issues, ("special case",))

    def test_critic_revision_keeps_unapproved_candidate_for_next_round(self) -> None:
        broken = SOURCE.replace("return state[\"grid\"]", "return [[9]]")
        advisor = FakeStructuredAdvisor(
            [
                {"model_source": broken, "notes": "", "experiment": None, "helpers": []},
                {"verdict": "revise", "issues": ["renderer mismatch"], "counterexample_indexes": [0]},
            ]
        )
        result = CausalPhysicist(advisor, self.registry).deliberate(
            self.model,
            current_grid=[[0]],
            available_actions={1},
            image=None,
        )
        self.assertTrue(result.accepted)
        self.assertEqual(result.verdict, "revise")
        self.assertIsNone(self.model.best_certified)
        self.assertEqual(len(self.model.candidates), 1)

    def test_physicist_failure_is_fail_open(self) -> None:
        result = CausalPhysicist(FakeStructuredAdvisor([None]), self.registry).deliberate(
            self.model,
            current_grid=[[0]],
            available_actions={1},
            image=None,
        )
        self.assertFalse(result.accepted)
        self.assertEqual(result.calls, 1)

    def test_critic_approved_generic_helper_is_promoted(self) -> None:
        helper = {
            "name": "generic_identity",
            "source": "def generic_identity(value):\n    return value\n",
            "tests": [
                {"kind": "color", "args": [3], "expected": 3},
                {"kind": "coordinate", "args": [[2, 4]], "expected": [2, 4]},
                {"kind": "shape", "args": [[[1, 2], [3, 4]]], "expected": [[1, 2], [3, 4]]},
                {"kind": "size", "args": [[1, 2]], "expected": [1, 2]},
                {"kind": "count", "args": [[1, 2]], "expected": [1, 2]},
            ],
        }
        advisor = FakeStructuredAdvisor(
            [
                {"model_source": SOURCE, "notes": "", "experiment": None, "helpers": [helper]},
                {
                    "verdict": "accept",
                    "issues": [],
                    "counterexample_indexes": [],
                    "approved_helpers": ["generic_identity"],
                },
            ]
        )
        result = CausalPhysicist(advisor, self.registry).deliberate(
            self.model,
            current_grid=[[0]],
            available_actions={1},
            image=None,
        )
        self.assertEqual(result.helper_results, ("generic_identity:promoted",))
        self.assertEqual(self.registry.version, 1)

    def test_next_revision_prompt_contains_rejected_source_and_critic_feedback(self) -> None:
        broken = SOURCE.replace('return state["grid"]', "return [[9]]")
        advisor = FakeStructuredAdvisor(
            [
                {"model_source": broken, "notes": "first", "experiment": None, "helpers": []},
                {"verdict": "reject", "issues": ["wrong rendering"], "counterexample_indexes": [0]},
                {"model_source": SOURCE, "notes": "fixed", "experiment": None, "helpers": []},
                {"verdict": "accept", "issues": [], "counterexample_indexes": []},
            ]
        )
        physicist = CausalPhysicist(advisor, self.registry)
        physicist.deliberate(
            self.model,
            current_grid=[[0]],
            available_actions={1},
            image=None,
        )
        physicist.deliberate(
            self.model,
            current_grid=[[0]],
            available_actions={1},
            image=None,
        )
        second_prompt = advisor.calls[2][0]
        self.assertIn("return [[9]]", second_prompt)
        self.assertIn("wrong rendering", second_prompt)
        self.assertIn("perception_rendering", second_prompt)
        self.assertNotIn("movement-bfs", second_prompt)
        self.assertLess(len(second_prompt), 40000)
        self.assertEqual(self.model.best.source_parent, self.model.candidates[1].version)

    def test_disjoint_changes_get_distinct_nonempty_causal_crops(self) -> None:
        before = [[0 for _ in range(12)] for _ in range(6)]
        after = [row[:] for row in before]
        after[1][1] = 3
        after[4][10] = 7
        summary = _change_summary(before, after, include_crops=True)
        self.assertEqual(summary["changed_count"], 2)
        self.assertEqual(len(summary["changed_regions"]), 2)
        self.assertEqual(summary["delta_cells"], [[1, 1, 0, 3], [10, 4, 0, 7]])
        for region in summary["changed_regions"]:
            self.assertNotEqual(region["before"], region["after"])
        self.assertEqual(
            {(item["from"], item["to"]) for item in summary["color_flows"]},
            {(0, 3), (0, 7)},
        )
        self.assertEqual(_effect_signature(before, after), "0>3:1;0>7:1")

        moved_before = [[0, 0, 0], [0, 3, 0], [0, 0, 0]]
        moved_after = [[0, 0, 0], [0, 0, 3], [0, 0, 0]]
        self.assertEqual(
            _effect_signature(moved_before, moved_after),
            "0>3:1;3>0:1|move3:1,0",
        )


if __name__ == "__main__":
    unittest.main()
