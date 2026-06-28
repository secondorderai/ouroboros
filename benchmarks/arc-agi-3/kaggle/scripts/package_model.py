from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro_arc.gemma import DEFAULT_MODEL_CANDIDATES


def check_model(path: str | None) -> Path:
    candidates = [path] if path else list(DEFAULT_MODEL_CANDIDATES)
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            resolved = Path(candidate)
            required_any = ["config.json", "model.safetensors.index.json", "tokenizer.json"]
            if not any((resolved / name).exists() for name in required_any):
                raise SystemExit(
                    f"{resolved} exists but does not look like a Hugging Face/Kaggle model directory"
                )
            print(f"Model directory found: {resolved}")
            return resolved
    raise SystemExit(
        "Gemma 4 12B Unified model directory was not found. "
        "Attach the Kaggle model input or set OURO_ARC_MODEL_PATH."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate or stage Gemma model metadata.")
    parser.add_argument("--check", default=None, help="Model directory to validate")
    parser.add_argument("--copy-to", default=None, help="Optional local staging directory")
    parser.add_argument("--metadata", default=None, help="Optional Kaggle dataset metadata path")
    args = parser.parse_args()

    model_dir = check_model(args.check)
    if args.copy_to:
        target = Path(args.copy_to)
        target.mkdir(parents=True, exist_ok=True)
        if target.resolve() == model_dir.resolve():
            raise SystemExit("--copy-to must differ from the source directory")
        for item in model_dir.iterdir():
            dest = target / item.name
            if item.is_dir():
                shutil.copytree(item, dest, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dest)
        print(f"Copied model files to {target}")

    if args.metadata:
        metadata_path = Path(args.metadata)
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        metadata = {
            "title": "Gemma 4 12B Unified for ARC-AGI-3",
            "id": "REPLACE_WITH_YOUR_USERNAME/gemma-4-12b-unified-arc",
            "licenses": [{"name": "Apache 2.0"}],
        }
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
        print(f"Wrote {metadata_path}")


if __name__ == "__main__":
    main()
