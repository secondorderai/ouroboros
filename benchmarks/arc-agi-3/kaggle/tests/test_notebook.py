from __future__ import annotations

import importlib.util
import os
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
        self._old_gemma_flag = os.environ.pop("OURO_ARC_SUBMISSION_GEMMA", None)

    def tearDown(self) -> None:
        if self._old_gemma_flag is None:
            os.environ.pop("OURO_ARC_SUBMISSION_GEMMA", None)
        else:
            os.environ["OURO_ARC_SUBMISSION_GEMMA"] = self._old_gemma_flag

    def test_notebook_metadata_is_offline_rtx6000(self) -> None:
        notebook = load_builder().build()
        kaggle = notebook["metadata"]["kaggle"]
        self.assertFalse(kaggle["isInternetEnabled"])
        self.assertTrue(kaggle["isGpuEnabled"])
        self.assertEqual(kaggle["accelerator"], "nvidiaRtx6000")

    def test_kernel_metadata_has_no_model_inputs(self) -> None:
        metadata = (ROOT / "notebooks" / "kernel-metadata.json").read_text()
        self.assertIn('"model_sources": []', metadata)
        self.assertNotIn("gemma", metadata.lower().replace("ouroboros-arc-agi-3-gemma4", ""))

    def test_notebook_embeds_agent_package_and_no_secrets(self) -> None:
        notebook = load_builder().build()
        source = "\n".join(cell.get("source", "") for cell in notebook["cells"])
        self.assertIn("%%writefile /tmp/my_agent.py", source)
        self.assertIn("%%writefile /tmp/ouro_arc/controller.py", source)
        self.assertIn("%%writefile /tmp/ouro_arc/distilled_skills.json", source)
        # Default submission config: Gemma hard-disabled on every execution
        # path, competition reruns included. The Gemma variant is opt-in per
        # build via OURO_ARC_SUBMISSION_GEMMA=1.
        self.assertIn('os.environ["OURO_ARC_DISABLE_MODEL"] = "1"', source)
        self.assertIn('os.environ["OURO_ARC_GEMMA_POLICY"] = "off"', source)
        self.assertIn('os.environ["OURO_ARC_GEMMA_MAX_CALLS"] = "0"', source)
        self.assertNotIn('"active" if competition_rerun_detected else "sparse"', source)
        self.assertIn('os.environ.setdefault("OURO_ARC_GEMMA_INTERVAL", "16")', source)
        self.assertIn("def gateway_available", source)
        self.assertIn("competition_rerun_detected", source)
        self.assertIn("gateway_available=", source)
        self.assertIn('selected_execution_path = "arc-agent" if run_arc_agent else "dummy-submission"', source)
        self.assertIn('if not globals().get("run_arc_agent", False):', source)
        self.assertIn("/kaggle/input", source)
        self.assertIn('if "gemma" in root.lower():', source)
        self.assertIn("Found {len(found_gemma_paths)} Gemma-like directories", source)
        self.assertNotIn("ARC_API_KEY=", source.replace("ARC_API_KEY=test-key-123", ""))
        self.assertNotIn("__OURO_GEMMA_ENV_BLOCK__", source)

    def test_gemma_variant_uses_sparse_policy_and_attaches_model(self) -> None:
        os.environ["OURO_ARC_SUBMISSION_GEMMA"] = "1"
        module = load_builder()
        notebook = module.build()
        source = "\n".join(cell.get("source", "") for cell in notebook["cells"])
        self.assertIn('os.environ["OURO_ARC_GEMMA_POLICY"] = "sparse"', source)
        self.assertIn('os.environ["OURO_ARC_GEMMA_MAX_CALLS"] = "12"', source)
        self.assertNotIn('os.environ["OURO_ARC_DISABLE_MODEL"] = "1"', source)
        self.assertNotIn("__OURO_GEMMA_ENV_BLOCK__", source)
        meta = {"enable_gpu": True, "enable_internet": False, "model_sources": []}
        self.assertTrue(module.sync_metadata(meta))
        self.assertEqual(
            meta["model_sources"],
            ["google/gemma-4/transformers/gemma-4-12b-it/2"],
        )

    def test_deterministic_sync_detaches_model_sources(self) -> None:
        module = load_builder()
        meta = {
            "enable_gpu": True,
            "enable_internet": False,
            "model_sources": ["google/gemma-4/transformers/gemma-4-12b-it/2"],
        }
        self.assertTrue(module.sync_metadata(meta))
        self.assertEqual(meta["model_sources"], [])


if __name__ == "__main__":
    unittest.main()
