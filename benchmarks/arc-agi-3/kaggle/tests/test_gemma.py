from __future__ import annotations

import os
import tempfile
import unittest

from ouro_arc.gemma import GemmaAdvisor, parse_model_plan


class GemmaTest(unittest.TestCase):
    def test_parse_model_plan_returns_legal_actions_only(self) -> None:
        plan = parse_model_plan(
            '{"mode":"probe","actions":[{"action":1},{"action":6,"x":9,"y":8},{"action":4}],'
            '"hypothesis":"move then click","confidence":0.8}',
            {1, 6},
        )
        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertEqual([action.action for action in plan.actions], [1, 6])
        self.assertEqual(plan.confidence, 0.8)

    def test_missing_required_model_fails_fast(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "missing")
            advisor = GemmaAdvisor(model_path=missing, require_model=True)
            with self.assertRaises(FileNotFoundError):
                advisor.ensure_available()

    def test_disable_model_allows_missing_path(self) -> None:
        old = os.environ.get("OURO_ARC_DISABLE_MODEL")
        os.environ["OURO_ARC_DISABLE_MODEL"] = "1"
        try:
            advisor = GemmaAdvisor(model_path="/does/not/exist", require_model=True)
            self.assertIsNone(advisor.ensure_available())
        finally:
            if old is None:
                os.environ.pop("OURO_ARC_DISABLE_MODEL", None)
            else:
                os.environ["OURO_ARC_DISABLE_MODEL"] = old


if __name__ == "__main__":
    unittest.main()
