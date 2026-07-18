from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "notebooks" / "gpu-validation" / "assets"
STAGE = OUTPUT / "bundle"
WHEELHOUSE = OUTPUT / "wheels"
REQUIREMENTS = ROOT / "gpu-validation-requirements.txt"
DEFAULT_DATASET_ID = "kinwochan/ouroboros-arc-gpu-validation-assets"
FP8_KERNEL_REPO = "kernels-community/finegrained-fp8"
FP8_KERNEL_REVISION = "7cdb05d472d6c954c7d03182ed836ebfd4610df0"
FP8_KERNEL_PATH = Path("kernels") / "finegrained-fp8"


def copy_assets() -> None:
    shutil.rmtree(STAGE, ignore_errors=True)
    STAGE.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / "ouro_arc", STAGE / "ouro_arc")
    shutil.copytree(ROOT / "environment_files", STAGE / "environment_files")
    shutil.copytree(
        ROOT / "vendor" / "ARC-AGI-3-Agents" / "agents",
        STAGE / "agents",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    (STAGE / "agent").mkdir()
    shutil.copy2(ROOT / "agent" / "my_agent.py", STAGE / "agent" / "my_agent.py")
    (STAGE / "scripts").mkdir()
    shutil.copy2(
        ROOT / "scripts" / "run_gpu_validation.py",
        STAGE / "scripts" / "run_gpu_validation.py",
    )
    (STAGE / "baselines").mkdir()
    shutil.copy2(
        ROOT / "baselines" / "deterministic_public_v11.json",
        STAGE / "baselines" / "deterministic_public_v11.json",
    )
    (STAGE / "config").mkdir()
    shutil.copy2(
        ROOT / "config" / "qwen_candidate.json",
        STAGE / "config" / "qwen_candidate.json",
    )
    shutil.copy2(
        ROOT / "config" / "qwen_autonomous_candidate.json",
        STAGE / "config" / "qwen_autonomous_candidate.json",
    )
    shutil.copy2(
        ROOT / "config" / "qwen36_fp8_autonomous_candidate.json",
        STAGE / "config" / "qwen36_fp8_autonomous_candidate.json",
    )


def download_wheels() -> None:
    shutil.rmtree(WHEELHOUSE, ignore_errors=True)
    WHEELHOUSE.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "download",
            "--only-binary=:all:",
            "--no-deps",
            "--platform=manylinux2014_x86_64",
            "--python-version=312",
            "--implementation=cp",
            "--abi=cp312",
            "--dest",
            str(WHEELHOUSE),
            "--requirement",
            str(REQUIREMENTS),
        ],
        check=True,
    )


def download_fp8_kernel() -> None:
    from huggingface_hub import snapshot_download  # type: ignore

    target = STAGE / FP8_KERNEL_PATH
    snapshot_download(
        repo_id=FP8_KERNEL_REPO,
        repo_type="kernel",
        revision=FP8_KERNEL_REVISION,
        local_dir=target,
        allow_patterns=["build/torch-cuda/*"],
    )
    shutil.rmtree(target / ".cache", ignore_errors=True)
    required = (
        target / "build" / "torch-cuda" / "__init__.py",
        target / "build" / "torch-cuda" / "metadata.json",
    )
    missing = [str(path.relative_to(target)) for path in required if not path.is_file()]
    if missing:
        raise ValueError(f"fine-grained FP8 kernel is incomplete: {missing}")


def write_bundle() -> Path:
    archive = OUTPUT / "validation-assets.zip"
    if archive.exists():
        archive.unlink()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(STAGE.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                bundle.write(path, path.relative_to(STAGE))
    return archive


def write_wheelhouse() -> Path:
    archive = OUTPUT / "wheelhouse.zip"
    if archive.exists():
        archive.unlink()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(WHEELHOUSE.glob("*.whl")):
            bundle.write(path, path.name)
    return archive


def build(dataset_id: str, include_wheels: bool) -> dict[str, object]:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    copy_assets()
    if include_wheels:
        download_wheels()
        download_fp8_kernel()
    archive = write_bundle()
    wheelhouse = write_wheelhouse()
    metadata = {
        "id": dataset_id,
        "title": "Ouroboros ARC GPU Validation Assets",
        "licenses": [{"name": "other"}],
        "isPrivate": True,
    }
    (OUTPUT / "dataset-metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "dataset_id": dataset_id,
        "archive": archive.name,
        "archive_bytes": archive.stat().st_size,
        "wheelhouse": wheelhouse.name,
        "wheelhouse_bytes": wheelhouse.stat().st_size,
        "environment_count": len(list((STAGE / "environment_files").glob("*/"))),
        "wheel_count": len(list(WHEELHOUSE.glob("*.whl"))),
        "fp8_kernel_repo": FP8_KERNEL_REPO if include_wheels else "",
        "fp8_kernel_revision": FP8_KERNEL_REVISION if include_wheels else "",
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-id", default=DEFAULT_DATASET_ID)
    parser.add_argument("--download-wheels", action="store_true")
    args = parser.parse_args()
    manifest = build(args.dataset_id, args.download_wheels)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
