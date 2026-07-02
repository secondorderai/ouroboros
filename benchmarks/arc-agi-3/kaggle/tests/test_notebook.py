from __future__ import annotations

import importlib.util
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
        # Deterministic submission config: Gemma must be hard-disabled on every
        # execution path, competition reruns included (Gemma-active reruns
        # scored 0.00 on Kaggle because advisor failures are fatal there).
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


if __name__ == "__main__":
    unittest.main()
