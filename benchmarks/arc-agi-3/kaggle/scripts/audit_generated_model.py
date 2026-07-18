#!/usr/bin/env python3
"""Validate and execute a generated world-model source without ARC."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro_arc.autonomous_model import AutonomousModelWorker, validate_generated_source  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    source = args.source.read_text(encoding="utf-8")
    validation = validate_generated_source(source)
    result: dict[str, object] = {
        "valid": validation.valid,
        "reason": validation.reason,
        "ast_nodes": validation.ast_nodes,
        "functions": validation.function_names,
    }
    if validation.valid:
        with AutonomousModelWorker() as worker:
            result["worker"] = worker.request({"operation": "validate", "source": source})
    print(json.dumps(result, indent=2, sort_keys=True))
    if not validation.valid:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
