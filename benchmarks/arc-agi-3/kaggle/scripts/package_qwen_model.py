from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "notebooks" / "qwen-model"
UPSTREAM_REPO = "Qwen/Qwen3.5-4B"
UPSTREAM_REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
DEFAULT_OWNER = "kinwochan"
MODEL_SLUG = "qwen-3-5-4b"
INSTANCE_SLUG = "qwen-3-5-4b"
FRAMEWORK = "transformers"
REQUIRED_FILES = (
    "LICENSE",
    "chat_template.jinja",
    "config.json",
    "merges.txt",
    "model.safetensors-00001-of-00002.safetensors",
    "model.safetensors-00002-of-00002.safetensors",
    "model.safetensors.index.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "video_preprocessor_config.json",
    "vocab.json",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_snapshot(snapshot: Path) -> dict[str, Any]:
    missing = [name for name in REQUIRED_FILES if not (snapshot / name).is_file()]
    if missing:
        raise ValueError(f"Qwen snapshot is missing required files: {missing}")
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
        "upstream_repo": UPSTREAM_REPO,
        "upstream_revision": UPSTREAM_REVISION,
        "license": "Apache 2.0",
        "file_count": len(files),
        "total_bytes": sum(int(item["bytes"]) for item in files),
        "files": files,
    }


def model_metadata(owner: str) -> dict[str, Any]:
    return {
        "ownerSlug": owner,
        "title": "Qwen3.5-4B Official Mirror",
        "slug": MODEL_SLUG,
        "licenseName": "Apache 2.0",
        "subtitle": "Pinned private mirror of Qwen/Qwen3.5-4B for offline ARC-AGI-3 inference",
        "isPrivate": True,
        "description": (
            "# Model Summary\n\nOfficial Qwen3.5-4B multimodal checkpoint mirrored "
            f"from `{UPSTREAM_REPO}` at revision `{UPSTREAM_REVISION}`.\n\n"
            "# Provenance\n\nNo weights are modified. SHA-256 hashes are included in "
            "`qwen-model-manifest.json`.\n"
        ),
        "publishTime": "",
        "provenanceSources": UPSTREAM_REPO,
    }


def instance_metadata(owner: str) -> dict[str, Any]:
    return {
        "ownerSlug": owner,
        "modelSlug": MODEL_SLUG,
        "instanceSlug": INSTANCE_SLUG,
        "framework": FRAMEWORK,
        "overview": "Official Qwen3.5-4B Hugging Face Transformers checkpoint.",
        "usage": (
            "# Model Format\n\nHugging Face Transformers multimodal Safetensors.\n\n"
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
    source: Path | None = None,
    download: bool = False,
) -> dict[str, Any]:
    model_dir = output / "model"
    instance_dir = output / "instance"
    model_dir.mkdir(parents=True, exist_ok=True)
    if download:
        from huggingface_hub import snapshot_download  # type: ignore

        snapshot_download(
            repo_id=UPSTREAM_REPO,
            revision=UPSTREAM_REVISION,
            local_dir=instance_dir,
        )
    elif source is not None:
        if instance_dir.exists():
            shutil.rmtree(instance_dir)
        shutil.copytree(source, instance_dir)
    if not instance_dir.exists():
        raise ValueError("no staged Qwen snapshot; pass --download or --source")

    manifest = verify_snapshot(instance_dir)
    (model_dir / "model-metadata.json").write_text(
        json.dumps(model_metadata(owner), indent=2) + "\n",
        encoding="utf-8",
    )
    (instance_dir / "model-instance-metadata.json").write_text(
        json.dumps(instance_metadata(owner), indent=2) + "\n",
        encoding="utf-8",
    )
    (instance_dir / "qwen-model-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--owner", default=DEFAULT_OWNER)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--verify-only", type=Path)
    args = parser.parse_args()
    if args.verify_only:
        result = verify_snapshot(args.verify_only)
    else:
        result = stage(
            args.output,
            owner=args.owner,
            source=args.source,
            download=args.download,
        )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
