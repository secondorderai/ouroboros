from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ouro_arc.gpu_validation import (
    PUBLIC_GAMES,
    evaluate_promotion,
    gpu_matches_expectation,
    model_is_cuda_only,
    select_pilot_mode,
)


ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pilot_result(*, levels: int, score: float, latencies: list[float], successes: int) -> dict:
    games = [
        {"game_id": game_id, "levels_completed": 1 if index < levels else 0, "actions": 100}
        for index, game_id in enumerate(("ls20", "ft09", "vc33", "tn36"))
    ]
    return {
        "score": score,
        "games": games,
        "model": {
            "call_attempts": 4,
            "call_successes": successes,
            "call_latencies": latencies,
        },
    }


class GpuValidationTest(unittest.TestCase):
    def test_smoke_executes_explicit_multimodal_advisor_call(self) -> None:
        runner = load_script("run_gpu_validation.py")

        class Advisor:
            def __init__(self) -> None:
                self.calls = []

            def advise(self, prompt, available_actions, image=None):
                self.calls.append((prompt, available_actions, image))
                return SimpleNamespace(
                    mode="hypothesis",
                    hypothesis="h-a1-xn-yn",
                    ranked_hypotheses=("h-a1-xn-yn", "h-a2-xn-yn"),
                    confidence=0.75,
                )

            def diagnostics(self):
                return {
                    "call_attempts": 1,
                    "call_successes": 1,
                    "device": "cuda:0",
                    "device_map": {"": "cuda:0"},
                }

        advisor = Advisor()
        grid = [[0 for _ in range(8)] for _ in range(8)]
        result = runner.advisor_smoke_payload(advisor, grid, {1, 2})

        self.assertTrue(result["parseable"])
        self.assertEqual(result["plan"]["hypothesis"], "h-a1-xn-yn")
        self.assertEqual(len(advisor.calls), 1)
        prompt, available, image = advisor.calls[0]
        self.assertIn("Game=ls20", prompt)
        self.assertEqual(available, {1, 2})
        self.assertIsInstance(image, bytes)
        self.assertTrue(image.startswith(b"\x89PNG"))

    def test_mode_uses_bounded_tokens_for_thinking_ab(self) -> None:
        runner = load_script("run_gpu_validation.py")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            config = json.loads(
                (ROOT / "config" / "qwen_candidate.json").read_text(encoding="utf-8")
            )
            config["max_new_tokens"] = 4096
            path.write_text(
                json.dumps(config),
                encoding="utf-8",
            )
            with patch.dict(
                "os.environ", {"OURO_ARC_MODEL_CONFIG": str(path)}, clear=False
            ):
                runner.configure_mode(False, 1)
                self.assertEqual(os.environ["OURO_ARC_MODEL_MAX_NEW_TOKENS"], "256")
                runner.configure_mode(True, 1)
                self.assertEqual(os.environ["OURO_ARC_MODEL_MAX_NEW_TOKENS"], "2048")

    def test_pilot_selection_disqualifies_empty_thinking_and_selects_off(self) -> None:
        selection = select_pilot_mode(
            {
                "thinking_off": pilot_result(
                    levels=1, score=0.2, latencies=[2, 2, 2, 2], successes=4
                ),
                "thinking_on": pilot_result(
                    levels=4, score=0.9, latencies=[30, 30, 30, 30], successes=0
                ),
            }
        )
        self.assertEqual(selection["selected_mode"], "thinking_off")
        self.assertIn("parse rate", selection["reasons"]["thinking_on"][0])

    def test_pilot_tie_prefers_thinking_off(self) -> None:
        result = pilot_result(levels=1, score=0.2, latencies=[2, 2, 2, 2], successes=4)
        selection = select_pilot_mode({"thinking_on": result, "thinking_off": result})
        self.assertEqual(selection["selected_mode"], "thinking_off")

    def test_promotion_gate_accepts_score_lift_without_regressions(self) -> None:
        baseline_games = [
            {"game_id": game_id, "levels_completed": 1 if game_id == "ls20" else 0}
            for game_id in PUBLIC_GAMES
        ]
        candidate_games = [dict(row) for row in baseline_games]
        candidate_games[0]["levels_completed"] = max(1, candidate_games[0]["levels_completed"])
        gate = evaluate_promotion(
            {"score": 1.04, "games": candidate_games, "runtime_seconds": 100},
            {"score": 1.0228557578743325, "games": baseline_games},
        )
        self.assertTrue(gate["promote"])
        self.assertTrue(gate["generalization_gate"])
        self.assertEqual(set(gate["fold_deltas"]), {f"fold_{index}" for index in range(1, 6)})

    def test_promotion_gate_blocks_regression_incomplete_run_and_oom(self) -> None:
        baseline_games = [
            {"game_id": game_id, "levels_completed": 1 if game_id == "ls20" else 0}
            for game_id in PUBLIC_GAMES
        ]
        gate = evaluate_promotion(
            {
                "score": 2.0,
                "games": [{"game_id": "ls20", "levels_completed": 0}],
                "oom_failures": 1,
            },
            {"score": 1.0, "games": baseline_games},
        )
        self.assertFalse(gate["promote"])
        self.assertTrue(any("incomplete" in reason for reason in gate["reasons"]))
        self.assertTrue(any("regressions" in reason for reason in gate["reasons"]))
        self.assertTrue(any("out-of-memory" in reason for reason in gate["reasons"]))

    def test_gpu_notebook_is_private_offline_rtx6000_and_isolated(self) -> None:
        builder = load_script("build_gpu_validation_notebook.py")
        notebook = builder.build_notebook("kinwochan/assets")
        metadata = builder.build_metadata("kinwochan/kernel", "kinwochan/assets")
        kaggle = notebook["metadata"]["kaggle"]
        source = "\n".join(cell.get("source", "") for cell in notebook["cells"])
        self.assertEqual(kaggle["accelerator"], "NvidiaRtxPro6000")
        self.assertFalse(kaggle["isInternetEnabled"])
        self.assertTrue(metadata["is_private"])
        self.assertEqual(metadata["machine_shape"], "NvidiaRtxPro6000")
        self.assertEqual(metadata["model_sources"], [builder.MODEL_SOURCE])
        self.assertIn("scripts/run_gpu_validation.py", source)
        self.assertIn("qwen_gpu_preflight.json", source)
        self.assertIn("RTX PRO 6000 hardware gate failed", source)
        self.assertIn("wheelhouse.zip", source)
        self.assertIn("validation-assets.zip", source)
        self.assertIn("shutil.unpack_archive", source)
        self.assertIn("expanded_wheels", source)
        self.assertIn("expanded_runners", source)
        self.assertIn("shutil.copytree(expanded_assets", source)
        self.assertIn("transformers-5.12.0-py3-none-any.whl", source)
        self.assertIn('OURO_ARC_VALIDATION_STAGE"] = "smoke"', source)
        self.assertIn("arc-agi arcengine", source)
        self.assertIn('"transformers==5.12.0"', source)
        self.assertIn('OURO_ARC_VALIDATION_EXPECT_GPU"] = "RTX PRO 6000"', source)
        self.assertNotIn("OLLAMA", source)

    def test_gpu_expectation_rejects_cuda_fallback(self) -> None:
        self.assertTrue(
            gpu_matches_expectation(
                {"cuda_available": True, "gpu": "NVIDIA RTX PRO 6000 Blackwell"},
                "RTX PRO 6000",
            )
        )
        self.assertFalse(
            gpu_matches_expectation(
                {"cuda_available": True, "gpu": "Tesla P100-PCIE-16GB"},
                "RTX PRO 6000",
            )
        )

    def test_gpu_push_uses_kaggle_rtx_pro_6000_machine_shape(self) -> None:
        makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
        self.assertIn("--accelerator NvidiaRtxPro6000", makefile)
        self.assertNotIn("--accelerator NVIDIA_RTX_PRO_6000", makefile)

    def test_model_cuda_only_rejects_cpu_and_disk_offload(self) -> None:
        self.assertTrue(
            model_is_cuda_only({"device": "cuda:0", "device_map": {"": "cuda:0"}})
        )
        self.assertTrue(model_is_cuda_only({"device": "cuda:0", "device_map": {"": 0}}))
        self.assertFalse(
            model_is_cuda_only(
                {"device": "cuda:0", "device_map": {"model": "cuda:0", "head": "cpu"}}
            )
        )
        self.assertFalse(
            model_is_cuda_only({"device": "cuda:0", "device_map": {"head": "disk"}})
        )
        self.assertFalse(model_is_cuda_only({"device": "cpu", "device_map": {}}))
        self.assertFalse(
            gpu_matches_expectation(
                {"cuda_available": False, "gpu": "NVIDIA RTX PRO 6000"},
                "RTX PRO 6000",
            )
        )

    def test_gpu_notebook_can_freeze_each_validation_stage(self) -> None:
        builder = load_script("build_gpu_validation_notebook.py")
        for stage in ("smoke", "pilot", "full"):
            notebook = builder.build_notebook("kinwochan/assets", stage)
            source = "\n".join(cell.get("source", "") for cell in notebook["cells"])
            self.assertIn(f'OURO_ARC_VALIDATION_STAGE"] = "{stage}"', source)
            preflight = next(
                cell["source"]
                for cell in notebook["cells"]
                if "qwen_gpu_preflight.json" in cell.get("source", "")
            )
            compile(preflight, f"gpu-validation-preflight-{stage}", "exec")
            for index, cell in enumerate(notebook["cells"]):
                if cell["cell_type"] == "code" and "!pip" not in cell["source"]:
                    compile(
                        cell["source"],
                        f"gpu-validation-{stage}-cell-{index}",
                        "exec",
                    )
        with self.assertRaises(ValueError):
            builder.build_notebook("kinwochan/assets", "unknown")

    def test_full_notebook_can_freeze_pilot_mode(self) -> None:
        builder = load_script("build_gpu_validation_notebook.py")
        notebook = builder.build_notebook(
            "kinwochan/assets", "full", "thinking_off"
        )
        source = "\n".join(cell.get("source", "") for cell in notebook["cells"])
        self.assertIn(
            'OURO_ARC_VALIDATION_SELECTED_MODE"] = "thinking_off"', source
        )
        with self.assertRaises(ValueError):
            builder.build_notebook("kinwochan/assets", "full", "invalid")

    def test_asset_builder_packages_all_25_environments(self) -> None:
        builder = load_script("build_gpu_validation_assets.py")
        with tempfile.TemporaryDirectory() as tmp:
            old_output, old_stage, old_wheels = builder.OUTPUT, builder.STAGE, builder.WHEELHOUSE
            try:
                builder.OUTPUT = Path(tmp)
                builder.STAGE = Path(tmp) / "bundle"
                builder.WHEELHOUSE = Path(tmp) / "wheels"
                manifest = builder.build("kinwochan/assets", include_wheels=False)
            finally:
                builder.OUTPUT, builder.STAGE, builder.WHEELHOUSE = old_output, old_stage, old_wheels
        self.assertEqual(manifest["environment_count"], 25)
        self.assertGreater(manifest["archive_bytes"], 0)

    def test_asset_builder_packages_agent_framework(self) -> None:
        builder = load_script("build_gpu_validation_assets.py")
        with tempfile.TemporaryDirectory() as tmp:
            old_output, old_stage, old_wheels = builder.OUTPUT, builder.STAGE, builder.WHEELHOUSE
            try:
                builder.OUTPUT = Path(tmp)
                builder.STAGE = Path(tmp) / "bundle"
                builder.WHEELHOUSE = Path(tmp) / "wheels"
                builder.build("kinwochan/assets", include_wheels=False)
                self.assertTrue((builder.STAGE / "agents" / "agent.py").is_file())
                self.assertFalse((builder.STAGE / "agents" / "__pycache__").exists())
            finally:
                builder.OUTPUT, builder.STAGE, builder.WHEELHOUSE = old_output, old_stage, old_wheels

    def test_promoted_config_uses_selected_mode_exactly(self) -> None:
        promote = load_script("promote_gpu_validation.py")
        config = promote.promoted_config(
            {"selection": {"selected_mode": "thinking_on"}, "full": {"score": 1.2}}
        )
        self.assertTrue(config["think"])
        self.assertEqual(config["max_new_tokens"], 4096)
        self.assertEqual(config["policy"], "hypothesis")
        self.assertEqual(config["max_calls"], 1)


if __name__ == "__main__":
    unittest.main()
