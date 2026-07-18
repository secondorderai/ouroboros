import argparse
import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OWNER = "kinwochan"
FRAMEWORK = "transformers"


@dataclass(frozen=True)
class ModelProfile:
    name: str
    upstream_repo: str
    upstream_revision: str
    model_slug: str
    instance_slug: str
    title: str
    required_files: tuple[str, ...]
    expected_model_type: str
    expected_quant_method: str = ""

    @property
    def output(self) -> Path:
        directory = "qwen-model" if self.name == "qwen35-4b" else "qwen36-model"
        return ROOT / "notebooks" / directory


COMMON_REQUIRED_FILES = (
    "LICENSE",
    "chat_template.jinja",
    "config.json",
    "merges.txt",
    "model.safetensors.index.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "video_preprocessor_config.json",
    "vocab.json",
)

PROFILES = {
    "qwen35-4b": ModelProfile(
        name="qwen35-4b",
        upstream_repo="Qwen/Qwen3.5-4B",
        upstream_revision="851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
        model_slug="qwen-3-5-4b",
        instance_slug="qwen-3-5-4b",
        title="Qwen3.5-4B",
        required_files=COMMON_REQUIRED_FILES
        + (
            "model.safetensors-00001-of-00002.safetensors",
            "model.safetensors-00002-of-00002.safetensors",
        ),
        expected_model_type="qwen3_5",
    ),
    "qwen36-27b-fp8": ModelProfile(
        name="qwen36-27b-fp8",
        upstream_repo="Qwen/Qwen3.6-27B-FP8",
        upstream_revision="e89b16ebf1988b3d6befa7de50abc2d76f26eb09",
        model_slug="qwen-3-6-27b-fp8",
        instance_slug="qwen-3-6-27b-fp8",
        title="Qwen3.6-27B-FP8",
        required_files=COMMON_REQUIRED_FILES
        + (
            "configuration.json",
            "generation_config.json",
            "mtp.safetensors",
            "outside.safetensors",
        ),
        expected_model_type="qwen3_5",
        expected_quant_method="fp8",
    ),
}
DEFAULT_PROFILE = PROFILES["qwen35-4b"]

# Compatibility constants used by existing tests and scripts.
DEFAULT_OUTPUT = DEFAULT_PROFILE.output
UPSTREAM_REPO = DEFAULT_PROFILE.upstream_repo
UPSTREAM_REVISION = DEFAULT_PROFILE.upstream_revision
MODEL_SLUG = DEFAULT_PROFILE.model_slug
INSTANCE_SLUG = DEFAULT_PROFILE.instance_slug
REQUIRED_FILES = DEFAULT_PROFILE.required_files


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid {label}: {path.name}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"invalid {label}: {path.name} must contain an object")
    return value


def verify_snapshot(
    snapshot: Path,
    profile: ModelProfile = DEFAULT_PROFILE,
) -> dict[str, Any]:
    missing = [name for name in profile.required_files if not (snapshot / name).is_file()]
    if missing:
        raise ValueError(f"Qwen snapshot is missing required files: {missing}")

    config = _read_json(snapshot / "config.json", "model config")
    if config.get("model_type") != profile.expected_model_type:
        raise ValueError(
            f"unexpected model_type {config.get('model_type')!r}; "
            f"expected {profile.expected_model_type!r}"
        )
    quantization = config.get("quantization_config", {})
    if profile.expected_quant_method:
        actual_method = quantization.get("quant_method") if isinstance(quantization, dict) else None
        if actual_method != profile.expected_quant_method:
            raise ValueError(
                f"unexpected quantization method {actual_method!r}; "
                f"expected {profile.expected_quant_method!r}"
            )

    index = _read_json(snapshot / "model.safetensors.index.json", "weight index")
    weight_map = index.get("weight_map")
    if not isinstance(weight_map, dict) or not weight_map:
        raise ValueError("model.safetensors.index.json has no weight_map")
    indexed_weights = sorted({str(name) for name in weight_map.values()})
    missing_weights = [name for name in indexed_weights if not (snapshot / name).is_file()]
    if missing_weights:
        raise ValueError(f"Qwen snapshot is missing indexed weights: {missing_weights}")

    files = []
    for path in sorted(item for item in snapshot.iterdir() if item.is_file()):
        if path.name in {"model-instance-metadata.json", "qwen-model-manifest.json"}:
            continue
        files.append(
            {
                "name": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
        )
    return {
        "profile": profile.name,
        "upstream_repo": profile.upstream_repo,
        "upstream_revision": profile.upstream_revision,
        "license": "Apache 2.0",
        "model_type": profile.expected_model_type,
        "quantization_method": profile.expected_quant_method or "none",
        "indexed_weight_file_count": len(indexed_weights),
        "file_count": len(files),
        "total_bytes": sum(int(item["bytes"]) for item in files),
        "files": files,
    }


def model_metadata(owner: str, profile: ModelProfile = DEFAULT_PROFILE) -> dict[str, Any]:
    quantized = " FP8" if profile.expected_quant_method else ""
    return {
        "ownerSlug": owner,
        "title": f"{profile.title} Official Mirror",
        "slug": profile.model_slug,
        "licenseName": "Apache 2.0",
        "subtitle": (
            f"Pinned private mirror of {profile.upstream_repo}{quantized} "
            "for offline ARC-AGI-3 inference"
        ),
        "isPrivate": True,
        "description": (
            f"# Model Summary\n\nOfficial {profile.title} multimodal checkpoint mirrored "
            f"from `{profile.upstream_repo}` at revision `{profile.upstream_revision}`.\n\n"
            "# Provenance\n\nNo weights are modified. SHA-256 hashes are included in "
            "`qwen-model-manifest.json`.\n"
        ),
        "publishTime": "",
        "provenanceSources": profile.upstream_repo,
    }


def instance_metadata(owner: str, profile: ModelProfile = DEFAULT_PROFILE) -> dict[str, Any]:
    precision = "fine-grained FP8" if profile.expected_quant_method else "Safetensors"
    return {
        "ownerSlug": owner,
        "modelSlug": profile.model_slug,
        "instanceSlug": profile.instance_slug,
        "framework": FRAMEWORK,
        "overview": f"Official {profile.title} Hugging Face Transformers checkpoint.",
        "usage": (
            f"# Model Format\n\nHugging Face Transformers multimodal {precision}.\n\n"
            "# Model Inputs\n\nStructured image and text chat messages.\n\n"
            "# Model Outputs\n\nGenerated assistant tokens.\n"
        ),
        "licenseName": "Apache 2.0",
        "fineTunable": False,
        "trainingData": [],
        "modelInstanceType": "Unspecified",
    }


def stage(
    output: Path,
    *,
    owner: str,
    profile: ModelProfile = DEFAULT_PROFILE,
    source: Path | None = None,
    download: bool = False,
) -> dict[str, Any]:
    model_dir = output / "model"
    instance_dir = output / "instance"
    model_dir.mkdir(parents=True, exist_ok=True)
    if download:
        from huggingface_hub import snapshot_download  # type: ignore

        snapshot_download(
            repo_id=profile.upstream_repo,
            revision=profile.upstream_revision,
            local_dir=instance_dir,
            allow_patterns=[*profile.required_files, "*.safetensors"],
        )
        shutil.rmtree(instance_dir / ".cache", ignore_errors=True)
    elif source is not None:
        if instance_dir.exists():
            shutil.rmtree(instance_dir)
        shutil.copytree(source, instance_dir)
    if not instance_dir.exists():
        raise ValueError("no staged Qwen snapshot; pass --download or --source")

    manifest = verify_snapshot(instance_dir, profile)
    (model_dir / "model-metadata.json").write_text(
        json.dumps(model_metadata(owner, profile), indent=2) + "\n",
        encoding="utf-8",
    )
    (instance_dir / "model-instance-metadata.json").write_text(
        json.dumps(instance_metadata(owner, profile), indent=2) + "\n",
        encoding="utf-8",
    )
    (instance_dir / "qwen-model-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=sorted(PROFILES), default=DEFAULT_PROFILE.name)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--owner", default=DEFAULT_OWNER)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--verify-only", type=Path)
    args = parser.parse_args()
    profile = PROFILES[args.profile]
    output = args.output or profile.output
    if args.verify_only:
        result = verify_snapshot(args.verify_only, profile)
    else:
        result = stage(
            output,
            owner=args.owner,
            profile=profile,
            source=args.source,
            download=args.download,
        )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
