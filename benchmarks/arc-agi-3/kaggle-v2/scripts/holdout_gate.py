"""Holdout gate + overfit lint.

- gate: blocks notebook builds when the TEST fold regresses vs the
  ratcheted baseline (baselines/holdout_best.json); --update ratchets it
  on strict improvement.
- lint: no public game-id literals outside ouro2/holdout.py.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro2.holdout import ALL_PUBLIC_GAMES, gate  # noqa: E402

BASELINE = ROOT / "baselines" / "holdout_best.json"
LINT_TARGETS = ["ouro2", "agent", "scripts"]
LINT_EXEMPT = {"ouro2/holdout.py"}


def lint() -> list[str]:
    pattern = re.compile(
        r"[\"'](" + "|".join(sorted(ALL_PUBLIC_GAMES)) + r")[\"']"
    )
    problems = []
    for target in LINT_TARGETS:
        for path in sorted((ROOT / target).rglob("*.py")):
            rel = path.relative_to(ROOT).as_posix()
            if rel in LINT_EXEMPT:
                continue
            for lineno, line in enumerate(path.read_text().splitlines(), 1):
                if pattern.search(line):
                    problems.append(f"{rel}:{lineno}: game-id literal: {line.strip()}")
    return problems


def source_hash() -> str:
    """Fingerprint of the agent source a fold run was produced from."""
    h = hashlib.sha256()
    for target in ("ouro2", "agent"):
        for path in sorted((ROOT / target).rglob("*.py")):
            h.update(path.relative_to(ROOT).as_posix().encode())
            h.update(path.read_bytes())
    return h.hexdigest()[:16]


def staleness(results: dict) -> str | None:
    """--check-only gates on a CACHED fold run; without this binding, edit
    ouro2, skip `make holdout`, and the gate compares stale numbers to
    themselves and prints ok."""
    recorded = results.get("source_hash")
    current = source_hash()
    if recorded != current:
        return (
            f"stale TEST run (source {recorded or 'unrecorded'} != {current}); "
            "run `make holdout` first"
        )
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test", default=None, help="TEST fold results JSON")
    parser.add_argument("--dev", default=None, help="DEV fold results JSON (reported only)")
    parser.add_argument("--update", action="store_true", help="Ratchet baseline on improvement")
    parser.add_argument("--check-only", action="store_true", help="Gate on last recorded TEST run")
    parser.add_argument("--lint-only", action="store_true")
    args = parser.parse_args()

    problems = lint()
    if problems:
        print("\n".join(problems))
        raise SystemExit(f"overfit lint: {len(problems)} problem(s)")
    if args.lint_only:
        print("overfit lint clean")
        return

    baseline = json.loads(BASELINE.read_text()) if BASELINE.exists() else {
        "score": 0.0,
        "levels": {},
    }
    if args.check_only:
        latest = ROOT / "baselines" / "test_latest.json"
        if not latest.exists():
            raise SystemExit("no TEST run recorded; run `make holdout` first")
        args.test = str(latest)

    if not args.test:
        print("nothing to gate (pass --test or --check-only)")
        return
    test_results = json.loads(Path(args.test).read_text())
    if args.check_only:
        stale = staleness(test_results)
        if stale:
            raise SystemExit(f"holdout gate: {stale}")
    if args.dev:
        dev = json.loads(Path(args.dev).read_text())
        print(f"DEV score {dev.get('score', 0.0):.4f} levels {sum(dev.get('levels', {}).values())}")
    result = gate(test_results, baseline)
    print(
        f"TEST score {test_results.get('score', 0.0):.4f} "
        f"(baseline {baseline.get('score', 0.0):.4f})"
    )
    if not result.ok:
        print("\n".join(result.reasons))
        raise SystemExit("holdout gate: BLOCKED")
    print("holdout gate: ok")
    if args.update:
        improved = test_results.get("score", 0.0) > baseline.get("score", 0.0)
        if improved:
            BASELINE.parent.mkdir(parents=True, exist_ok=True)
            BASELINE.write_text(
                json.dumps(
                    {
                        "score": test_results.get("score", 0.0),
                        "levels": test_results.get("levels", {}),
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            print(f"ratcheted baseline -> {test_results.get('score', 0.0):.4f}")


if __name__ == "__main__":
    main()
