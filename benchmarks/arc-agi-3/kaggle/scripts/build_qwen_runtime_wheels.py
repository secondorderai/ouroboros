from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "notebooks" / "qwen-runtime-wheels"
REQUIREMENTS = ROOT / "qwen-runtime-requirements.txt"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(dataset_id: str, *, download: bool = True) -> dict:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if download:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "download",
                "--only-binary=:all:",
                "--no-deps",
                "--dest",
                str(OUTPUT),
                "-r",
                str(REQUIREMENTS),
            ],
            check=True,
        )
    wheels = sorted(OUTPUT.glob("*.whl"))
    expected = [line.strip().split("==", 1)[0].replace("-", "_").lower()
                for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.startswith("#")]
    normalized = [path.name.replace("-", "_").lower() for path in wheels]
    missing = [name for name in expected if not any(item.startswith(name + "_") for item in normalized)]
    if missing:
        raise ValueError(f"Qwen runtime wheelhouse is missing: {missing}")
    manifest = {
        "requirements": REQUIREMENTS.read_text(encoding="utf-8").splitlines(),
        "wheels": [
            {"name": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)}
            for path in wheels
        ],
    }
    (OUTPUT / "dataset-metadata.json").write_text(
        json.dumps(
            {
                "title": "Ouroboros Qwen Runtime Wheels",
                "id": dataset_id,
                "licenses": [{"name": "other"}],
                "isPrivate": True,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset-id", default="kinwochan/ouroboros-qwen-runtime-wheels"
    )
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    print(json.dumps(build(args.dataset_id, download=not args.verify_only), indent=2))


if __name__ == "__main__":
    main()
