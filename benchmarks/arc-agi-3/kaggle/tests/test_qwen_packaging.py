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
            (source / "config.json").write_text(
                json.dumps({"model_type": "qwen3_5"}), encoding="utf-8"
            )
            (source / "model.safetensors.index.json").write_text(
                json.dumps(
                    {
                        "weight_map": {
                            "layer.0": "model.safetensors-00001-of-00002.safetensors",
                            "layer.1": "model.safetensors-00002-of-00002.safetensors",
                        }
                    }
                ),
                encoding="utf-8",
            )
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

    def test_qwen36_fp8_snapshot_is_separately_pinned_and_indexed(self) -> None:
        package = load_script("package_qwen_model.py")
        profile = package.PROFILES["qwen36-27b-fp8"]
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source"
            output = Path(tmp) / "output"
            source.mkdir()
            for index, name in enumerate(profile.required_files):
                (source / name).write_bytes(f"fixture-{index}".encode())
            (source / "layers-0.safetensors").write_bytes(b"fp8-layer")
            (source / "config.json").write_text(
                json.dumps(
                    {
                        "model_type": "qwen3_5",
                        "quantization_config": {"quant_method": "fp8"},
                    }
                ),
                encoding="utf-8",
            )
            (source / "model.safetensors.index.json").write_text(
                json.dumps(
                    {
                        "weight_map": {
                            "model.layers.0": "layers-0.safetensors",
                            "model.embed": "outside.safetensors",
                            "mtp": "mtp.safetensors",
                        }
                    }
                ),
                encoding="utf-8",
            )
            manifest = package.stage(
                output,
                owner="kinwochan",
                profile=profile,
                source=source,
            )
            model_metadata = json.loads(
                (output / "model" / "model-metadata.json").read_text()
            )

        self.assertEqual(manifest["profile"], "qwen36-27b-fp8")
        self.assertEqual(manifest["upstream_repo"], "Qwen/Qwen3.6-27B-FP8")
        self.assertEqual(
            manifest["upstream_revision"],
            "e89b16ebf1988b3d6befa7de50abc2d76f26eb09",
        )
        self.assertEqual(manifest["quantization_method"], "fp8")
        self.assertEqual(manifest["indexed_weight_file_count"], 3)
        self.assertTrue(model_metadata["isPrivate"])
        self.assertEqual(model_metadata["slug"], "qwen-3-6-27b-fp8")

    def test_snapshot_rejects_missing_required_file(self) -> None:
        package = load_script("package_qwen_model.py")
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "missing required files"):
                package.verify_snapshot(Path(tmp))

    def test_weight_staging_is_gitignored(self) -> None:
        ignored = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("notebooks/qwen-model/", ignored)
        self.assertIn("notebooks/qwen36-model/", ignored)
        self.assertIn("notebooks/qwen-runtime-wheels/", ignored)

    def test_resumable_model_upload_restores_generated_sdk_objects(self) -> None:
        publisher = load_script("publish_kaggle_model.py")

        class GeneratedType:
            @classmethod
            def from_dict(cls, value):
                return (cls.__name__, value)

        class Upload:
            def __init__(self, path, request, context):
                self.path = path
                self.request = request
                self.context = context
                self.timestamp = None
                self.start_blob_upload_response = None
                self.upload_complete = False

        record = {
            "path": "/tmp/model/layers-0.safetensors",
            "start_blob_upload_request": {"name": "layers-0.safetensors"},
            "timestamp": 123,
            "start_blob_upload_response": {"token": "opaque", "createUrl": "https://upload"},
            "upload_complete": True,
        }
        restored = publisher.restore_resumable_upload(
            record,
            "context",
            request_type=GeneratedType,
            response_type=GeneratedType,
            upload_type=Upload,
        )

        self.assertEqual(restored.request[1], record["start_blob_upload_request"])
        self.assertEqual(restored.start_blob_upload_response[1], record["start_blob_upload_response"])
        self.assertEqual(restored.timestamp, 123)
        self.assertTrue(restored.upload_complete)

    def test_kaggle_resume_patch_compares_generated_requests_by_value(self) -> None:
        publisher = load_script("publish_kaggle_model.py")

        class Request:
            def __init__(self, value):
                self.value = value

            def to_dict(self):
                return self.value

        class Upload:
            path = "/tmp/layer"
            timestamp = 950

            def __init__(self, request):
                self.start_blob_upload_request = request

        current = Upload(Request({"name": "layer.safetensors", "bytes": 8}))
        previous = Upload(Request({"name": "layer.safetensors", "bytes": 8}))
        self.assertNotEqual(current.start_blob_upload_request, previous.start_blob_upload_request)
        self.assertTrue(
            publisher.resumable_record_is_valid(
                current,
                previous,
                now=1000,
                expiry_seconds=100,
            )
        )

    def test_model_instance_reference_is_stable(self) -> None:
        publisher = load_script("publish_kaggle_model.py")
        self.assertEqual(
            publisher.instance_reference(
                {
                    "ownerSlug": "kinwochan",
                    "modelSlug": "qwen-3-6-27b-fp8",
                    "framework": "transformers",
                    "instanceSlug": "qwen-3-6-27b-fp8",
                }
            ),
            "kinwochan/qwen-3-6-27b-fp8/transformers/qwen-3-6-27b-fp8",
        )

    def test_empty_success_response_is_recovered_after_status_check(self) -> None:
        publisher = load_script("publish_kaggle_model.py")

        class HttpResponse:
            text = ""
            status_checked = False

            def raise_for_status(self):
                self.status_checked = True

        class Response:
            pass

        http_response = HttpResponse()
        recovered = publisher.recover_empty_json_response(Response, http_response)
        self.assertIsInstance(recovered, Response)
        self.assertTrue(http_response.status_checked)


if __name__ == "__main__":
    unittest.main()
