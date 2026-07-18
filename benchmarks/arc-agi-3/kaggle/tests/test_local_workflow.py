from __future__ import annotations

import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_play_local():
    spec = importlib.util.spec_from_file_location(
        "play_local", ROOT / "scripts" / "play_local.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LocalQwenWorkflowTest(unittest.TestCase):
    def test_public_results_are_labeled_as_optimization(self) -> None:
        source = (ROOT / "scripts" / "play_local.py").read_text()
        self.assertIn('"evaluation_scope": "public-set-optimization"', source)

    def test_score_target_freezes_qwen_baseline_policy(self) -> None:
        makefile = (ROOT / "Makefile").read_text()
        self.assertIn("score-local-qwen:", makefile)
        for setting in (
            "LOCAL_OLLAMA_MODEL ?= qwen3.5:4b-mlx",
            "LOCAL_OLLAMA_THINK ?= 1",
            "LOCAL_OLLAMA_NUM_PREDICT ?= 4096",
            "OURO_ARC_MODEL_CONFIG=config/qwen_candidate.json",
            "OURO_ARC_MODEL_BACKEND=ollama",
            "replay-world-model:",
            "generalization-report:",
            "baselines/deterministic_public_v11.json",
        ):
            self.assertIn(setting, makefile)
        candidate = json.loads((ROOT / "config" / "qwen_candidate.json").read_text())
        self.assertEqual(candidate["policy"], "hypothesis")
        self.assertTrue(candidate["vision"])
        self.assertEqual(candidate["max_calls"], 1)
        self.assertEqual(candidate["max_new_tokens"], 4096)

    def test_result_metadata_records_effective_qwen_config(self) -> None:
        env = {
            "OURO_ARC_MODEL_BACKEND": "ollama",
            "OURO_ARC_OLLAMA_MODEL": "qwen3.5:4b-mlx",
            "OURO_ARC_MODEL_POLICY": "hypothesis",
            "OURO_ARC_MODEL_VISION": "1",
            "OURO_ARC_MODEL_SCIENTIST_PROMPT": "1",
            "OURO_ARC_MODEL_THINK": "1",
            "OURO_ARC_MODEL_MAX_CALLS": "1",
            "OURO_ARC_MODEL_NUM_PREDICT": "2048",
            "OURO_ARC_MODEL_TIME_BUDGET_SECONDS": "900",
            "OURO_ARC_INDUCTION_STUCK_ACTIONS": "48",
            "OURO_ARC_INDUCTION_NOVELTY_PATIENCE": "12",
        }
        with patch.dict(os.environ, env, clear=False):
            config = load_play_local().model_run_config(True)

        self.assertEqual(config["model"], "qwen3.5:4b-mlx")
        self.assertEqual(config["max_calls"], 1)
        self.assertTrue(config["thinking"])
        self.assertEqual(config["policy"], "hypothesis")
        self.assertEqual(config["induction_stuck_actions"], 48)
        self.assertTrue(config["vision"])
        self.assertTrue(config["scientist_prompt"])

    def test_autonomous_workflows_use_separate_candidate_and_ablation(self) -> None:
        makefile = (ROOT / "Makefile").read_text()
        for setting in (
            "trace-causal-game:",
            "smoke-ollama-causal:",
            "score-local-qwen-causal:",
            "score-local-qwen-causal-no-transfer:",
            "compare-causal-ablation:",
            "audit-generated-model:",
            "config/qwen_autonomous_candidate.json",
        ):
            self.assertIn(setting, makefile)
        candidate = json.loads((ROOT / "config" / "qwen_autonomous_candidate.json").read_text())
        self.assertEqual(candidate["world_model_mode"], "autonomous-python")
        self.assertEqual(candidate["policy"], "world-model")
        self.assertTrue(candidate["think"])


if __name__ == "__main__":
    unittest.main()
