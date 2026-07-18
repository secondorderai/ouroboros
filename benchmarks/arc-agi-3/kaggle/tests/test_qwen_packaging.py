from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / name)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class QwenPackagingTest(unittest.TestCase):
    def test_snapshot_manifest_is_pinned_and_hashed(self) -> None:
        package = load_script("package_qwen_model.py")
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source"
            output = Path(tmp) / "output"
            source.mkdir()
            for index, name in enumerate(package.REQUIRED_FILES):
                (source / name).write_bytes(f"fixture-{index}".encode())
            manifest = package.stage(output, owner="kinwochan", source=source)
            metadata = json.loads(
                (output / "instance" / "model-instance-metadata.json").read_text()
            )
        self.assertEqual(manifest["upstream_repo"], "Qwen/Qwen3.5-4B")
        self.assertEqual(
            manifest["upstream_revision"],
            "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
        )
        self.assertEqual(manifest["file_count"], len(package.REQUIRED_FILES))
        self.assertTrue(all(len(item["sha256"]) == 64 for item in manifest["files"]))
        self.assertEqual(metadata["framework"], "transformers")
        self.assertEqual(metadata["licenseName"], "Apache 2.0")
        self.assertEqual(metadata["modelInstanceType"], "Unspecified")
        self.assertNotIn("baseModelInstance", metadata)
        self.assertNotIn("externalBaseModelUrl", metadata)

    def test_snapshot_rejects_missing_required_file(self) -> None:
        package = load_script("package_qwen_model.py")
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "missing required files"):
                package.verify_snapshot(Path(tmp))

    def test_weight_staging_is_gitignored(self) -> None:
        ignored = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("notebooks/qwen-model/", ignored)
        self.assertIn("notebooks/qwen-runtime-wheels/", ignored)


if __name__ == "__main__":
    unittest.main()
