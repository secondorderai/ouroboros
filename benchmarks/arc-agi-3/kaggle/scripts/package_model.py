"""Compatibility model check; new workflows use package_qwen_model.py."""

from __future__ import annotations

import argparse
from pathlib import Path

from package_qwen_model import verify_snapshot


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", required=True)
    args = parser.parse_args()
    result = verify_snapshot(Path(args.check))
    print(
        f"Verified Qwen3.5-4B snapshot at {args.check}: "
        f"{result['file_count']} files, {result['total_bytes']} bytes"
    )


if __name__ == "__main__":
    main()
