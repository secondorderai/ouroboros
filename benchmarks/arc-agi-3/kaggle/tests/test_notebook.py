from __future__ import annotations

import importlib.util
import ast
import json
import os
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_builder():
    spec = importlib.util.spec_from_file_location(
        "build_notebook",
        ROOT / "scripts" / "build_notebook.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NotebookTest(unittest.TestCase):
    def setUp(self) -> None:
        self._old_qwen_flag = os.environ.pop("OURO_ARC_SUBMISSION_QWEN", None)
        self._old_promotion_config = os.environ.pop("OURO_ARC_QWEN_PROMOTION_CONFIG", None)
        self._old_model_profile = os.environ.pop(
            "OURO_ARC_SUBMISSION_MODEL_PROFILE", None
        )

    def tearDown(self) -> None:
        if self._old_qwen_flag is None:
            os.environ.pop("OURO_ARC_SUBMISSION_QWEN", None)
        else:
            os.environ["OURO_ARC_SUBMISSION_QWEN"] = self._old_qwen_flag
        if self._old_promotion_config is None:
            os.environ.pop("OURO_ARC_QWEN_PROMOTION_CONFIG", None)
        else:
            os.environ["OURO_ARC_QWEN_PROMOTION_CONFIG"] = self._old_promotion_config
        if self._old_model_profile is None:
            os.environ.pop("OURO_ARC_SUBMISSION_MODEL_PROFILE", None)
        else:
            os.environ["OURO_ARC_SUBMISSION_MODEL_PROFILE"] = self._old_model_profile

    def _promoted_config(self, path: Path, think: bool = False) -> None:
        path.write_text(
            json.dumps(
                {
                    "backend": "transformers",
                    "policy": "hypothesis",
                    "vision": True,
                    "scientist_prompt": True,
                    "think": think,
                    "interval": 48,
                    "max_calls": 1,
                    "max_new_tokens": 4096,
                    "timeout_seconds": 300,
                    "time_budget_seconds": 900,
                    "dtype": "bf16",
                    "serialize_inference": True,
                }
            )
        )

    def _assert_code_cells_compile(self, notebook: dict) -> None:
        for index, cell in enumerate(notebook["cells"]):
            if cell.get("cell_type") != "code":
                continue
            lines = cell.get("source", "").splitlines()
            if lines and lines[0].startswith("%%writefile "):
                lines = lines[1:]
            transformed: list[str] = []
            skipping_shell = False
            for line in lines:
                stripped = line.lstrip()
                if skipping_shell:
                    skipping_shell = line.rstrip().endswith("\\")
                    continue
                if stripped.startswith("!"):
                    transformed.append(line[: len(line) - len(stripped)] + "pass")
                    skipping_shell = line.rstrip().endswith("\\")
                    continue
                transformed.append(line)
            try:
                ast.parse("\n".join(transformed))
            except SyntaxError as exc:
                self.fail(f"generated code cell {index} is invalid: {exc}")

    def test_notebook_metadata_is_offline_rtx6000(self) -> None:
        notebook = load_builder().build()
        kaggle = notebook["metadata"]["kaggle"]
        self.assertFalse(kaggle["isInternetEnabled"])
        self.assertTrue(kaggle["isGpuEnabled"])
        self.assertEqual(kaggle["accelerator"], "nvidiaRtx6000")

    def test_generated_default_code_cells_are_syntactically_valid(self) -> None:
        self._assert_code_cells_compile(load_builder().build())

    def test_kernel_metadata_has_no_model_inputs(self) -> None:
        metadata = json.loads((ROOT / "notebooks" / "kernel-metadata.json").read_text())
        self.assertEqual(metadata["model_sources"], [])
        self.assertEqual(metadata["dataset_sources"], [])

    def test_notebook_embeds_agent_package_and_no_secrets(self) -> None:
        notebook = load_builder().build()
        source = "\n".join(cell.get("source", "") for cell in notebook["cells"])
        self.assertIn("%%writefile /tmp/my_agent.py", source)
        self.assertIn("%%writefile /tmp/ouro_arc/controller.py", source)
        self.assertIn("%%writefile /tmp/ouro_arc/distilled_skills.json", source)
        # Default submission config: Qwen hard-disabled on every execution
        # path, competition reruns included. The Qwen variant is opt-in per
        # build via OURO_ARC_SUBMISSION_QWEN=1.
        self.assertIn('os.environ["OURO_ARC_DISABLE_MODEL"] = "1"', source)
        self.assertIn('os.environ["OURO_ARC_MODEL_POLICY"] = "off"', source)
        self.assertIn('os.environ["OURO_ARC_MODEL_MAX_CALLS"] = "0"', source)
        self.assertIn('os.environ["OURO_ARC_MODEL_VISION"] = "0"', source)
        self.assertIn('os.environ["OURO_ARC_WORLD_MODEL_MODE"] = "observed"', source)
        self.assertNotIn('os.environ["OURO_ARC_OLLAMA_MODEL"]', source)
        self.assertNotIn('os.environ["OURO_ARC_OLLAMA_URL"]', source)
        self.assertNotIn('"active" if competition_rerun_detected else "sparse"', source)
        self.assertIn('os.environ.setdefault("OURO_ARC_MODEL_INTERVAL", "16")', source)
        self.assertIn("def gateway_available", source)
        self.assertIn("competition_rerun_detected", source)
        self.assertIn("gateway_available=", source)
        self.assertIn('selected_execution_path = "arc-agent" if run_arc_agent else "dummy-submission"', source)
        self.assertIn('if not globals().get("run_arc_agent", False):', source)
        self.assertIn("/kaggle/input", source)
        self.assertIn('if "qwen-3-5-4b" in root.lower()', source)
        self.assertIn("Found {len(found_qwen_paths)} Qwen model directories", source)
        self.assertNotIn("ARC_API_KEY=", source.replace("ARC_API_KEY=test-key-123", ""))
        self.assertNotIn("__OURO_GEMMA_ENV_BLOCK__", source)

    def test_qwen_variant_uses_promoted_policy_and_attaches_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "promoted.json"
            self._promoted_config(config_path, think=True)
            os.environ["OURO_ARC_SUBMISSION_QWEN"] = "1"
            os.environ["OURO_ARC_QWEN_PROMOTION_CONFIG"] = str(config_path)
            module = load_builder()
            notebook = module.build()
        source = "\n".join(cell.get("source", "") for cell in notebook["cells"])
        self.assertIn("os.environ['OURO_ARC_MODEL_POLICY'] = 'hypothesis'", source)
        self.assertIn("os.environ['OURO_ARC_MODEL_MAX_CALLS'] = '1'", source)
        self.assertIn("os.environ['OURO_ARC_MODEL_VISION'] = '1'", source)
        self.assertIn("os.environ['OURO_ARC_MODEL_THINK'] = '1'", source)
        self.assertIn("os.environ['OURO_ARC_MODEL_SCIENTIST_PROMPT'] = '1'", source)
        self.assertIn("os.environ['OURO_ARC_MODEL_BACKEND'] = 'transformers'", source)
        self.assertNotIn('os.environ["OURO_ARC_OLLAMA_MODEL"]', source)
        self.assertNotIn('os.environ["OURO_ARC_OLLAMA_URL"]', source)
        self.assertNotIn('os.environ["OURO_ARC_DISABLE_MODEL"] = "1"', source)
        self.assertNotIn("__OURO_GEMMA_ENV_BLOCK__", source)
        meta = {"enable_gpu": True, "enable_internet": False, "model_sources": []}
        self.assertTrue(module.sync_metadata(meta))
        self.assertEqual(
            meta["model_sources"],
            ["kinwochan/qwen-3-5-4b/transformers/qwen-3-5-4b/1"],
        )
        self.assertEqual(meta["dataset_sources"], ["kinwochan/ouroboros-qwen-runtime-wheels"])

    def test_qwen_variant_requires_promotion_config(self) -> None:
        os.environ["OURO_ARC_SUBMISSION_QWEN"] = "1"
        with self.assertRaises(SystemExit):
            load_builder().build()

    def test_qwen36_variant_uses_fp8_runtime_and_separate_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "qwen36-promoted.json"
            config = json.loads(
                (ROOT / "config" / "qwen36_fp8_autonomous_candidate.json").read_text()
            )
            config.update(
                {
                    "backend": "transformers",
                    "think": True,
                    "max_calls": 1,
                    "max_new_tokens": 1024,
                    "discovery_barrier": True,
                    "discovery_participants": 25,
                }
            )
            config_path.write_text(json.dumps(config))
            os.environ["OURO_ARC_SUBMISSION_QWEN"] = "1"
            os.environ["OURO_ARC_SUBMISSION_MODEL_PROFILE"] = "qwen36-27b-fp8"
            os.environ["OURO_ARC_QWEN_PROMOTION_CONFIG"] = str(config_path)
            module = load_builder()
            notebook = module.build()
            metadata = {
                "enable_gpu": True,
                "enable_internet": False,
                "model_sources": [],
                "dataset_sources": [],
            }
            self.assertTrue(module.sync_metadata(metadata))
            self._assert_code_cells_compile(notebook)
        source = "\n".join(cell.get("source", "") for cell in notebook["cells"])
        self.assertEqual(
            notebook["metadata"]["kaggle"]["accelerator"], "NvidiaRtxPro6000"
        )
        self.assertIn("Qwen3.6-27B-FP8 Submission", source)
        self.assertIn('"transformers==5.14.1"', source)
        self.assertIn('"kernels==0.15.2"', source)
        self.assertIn("qwen3-6-27b-fp8", source)
        self.assertIn("kernels-community/finegrained-fp8=", source)
        self.assertIn("TRANSFORMERS_DISABLE_DEEPGEMM_LINEAR", source)
        self.assertIn("submission.parquet", source)
        self.assertIn("os.environ['OURO_ARC_MODEL_THINK'] = '1'", source)
        self.assertIn("os.environ['OURO_ARC_MODEL_MAX_CALLS'] = '1'", source)
        self.assertIn("os.environ['OURO_ARC_MODEL_MAX_NEW_TOKENS'] = '1024'", source)
        self.assertIn("os.environ['OURO_ARC_MODEL_REQUIRE_SCALED_FP8'] = '1'", source)
        self.assertEqual(
            metadata["model_sources"],
            ["michaelpoluektov/qwen3-6-27b-fp8/transformers/default/1"],
        )
        self.assertEqual(
            metadata["dataset_sources"],
            ["kinwochan/ouroboros-arc-gpu-validation-assets"],
        )
        self.assertEqual(metadata["machine_shape"], "NvidiaRtxPro6000")

    def test_qwen36_profile_rejects_qwen35_promotion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "promoted.json"
            self._promoted_config(config_path, think=True)
            config = json.loads(config_path.read_text())
            config["model_family"] = "qwen3.5-4b"
            config_path.write_text(json.dumps(config))
            os.environ["OURO_ARC_SUBMISSION_QWEN"] = "1"
            os.environ["OURO_ARC_SUBMISSION_MODEL_PROFILE"] = "qwen36-27b-fp8"
            os.environ["OURO_ARC_QWEN_PROMOTION_CONFIG"] = str(config_path)
            with self.assertRaises(SystemExit):
                load_builder().build()

    def test_autonomous_promoted_variant_enables_barrier_without_ollama(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "promoted.json"
            self._promoted_config(config_path, think=True)
            config = json.loads(config_path.read_text())
            config.update(
                {
                    "policy": "world-model",
                    "max_calls": 4,
                    "max_new_tokens": 2048,
                    "world_model_mode": "autonomous-python",
                    "world_model_beam": 4,
                    "critic": True,
                    "shared_mechanics": True,
                    "discovery_actions": 16,
                    "discovery_barrier_seconds": 720,
                    "discovery_barrier": True,
                    "discovery_participants": 25,
                }
            )
            config_path.write_text(json.dumps(config))
            os.environ["OURO_ARC_SUBMISSION_QWEN"] = "1"
            os.environ["OURO_ARC_QWEN_PROMOTION_CONFIG"] = str(config_path)
            notebook = load_builder().build()
        source = "\n".join(cell.get("source", "") for cell in notebook["cells"])
        self.assertIn("os.environ['OURO_ARC_WORLD_MODEL_MODE'] = 'autonomous-python'", source)
        self.assertIn("os.environ['OURO_ARC_DISCOVERY_BARRIER_ENABLED'] = '1'", source)
        self.assertIn("os.environ['OURO_ARC_DISCOVERY_PARTICIPANTS'] = '25'", source)
        self.assertNotIn('os.environ["OURO_ARC_OLLAMA_MODEL"]', source)

    def test_deterministic_sync_detaches_model_sources(self) -> None:
        module = load_builder()
        meta = {
            "enable_gpu": True,
            "enable_internet": False,
            "model_sources": ["kinwochan/qwen-3-5-4b/transformers/qwen-3-5-4b/1"],
            "dataset_sources": ["kinwochan/ouroboros-qwen-runtime-wheels"],
        }
        self.assertTrue(module.sync_metadata(meta))
        self.assertEqual(meta["model_sources"], [])
        self.assertEqual(meta["dataset_sources"], [])


if __name__ == "__main__":
    unittest.main()
