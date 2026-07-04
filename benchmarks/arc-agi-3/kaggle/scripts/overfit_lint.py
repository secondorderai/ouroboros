"""Lint a git diff for lines that reintroduce game-specificity.

We stopped shipping heuristics tuned on the 25 public games; this linter catches
regressions of that discipline in added diff lines: bare public-id literals,
``GAME_ID_RE``/``FRAME_HASH_RE`` matches, per-game branching, and
coordinate-heavy hunks. It advises (does not fail) on new per-game env-knob
defaults. ``ouro_arc/holdout.py``, this linter, and test files are excluded --
they legitimately contain game ids.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro_arc.holdout import ALL_PUBLIC_GAMES  # noqa: E402
from ouro_arc.skills import FRAME_HASH_RE, GAME_ID_RE  # noqa: E402

PUBLIC_ID_LITERAL_RE = re.compile(
    r"['\"](" + "|".join(sorted(ALL_PUBLIC_GAMES)) + r")['\"]"
)
PER_GAME_LITERAL_RE = re.compile(r'==\s*["\'][a-z]{2}\d{2}["\']')
COORD_RE = re.compile(r'(?:\bx\s*=\s*\d+|\by\s*=\s*\d+|"x"\s*:\s*\d+|"y"\s*:\s*\d+)')
ENV_ADVISORY_RE = re.compile(
    r"OURO_ARC_LARGE_CLICK_REPLAY_|OURO_ARC_PAIRED_CONTROL_"
)

# Paths that legitimately contain game ids and are exempt from scanning.
EXCLUDED_SUFFIXES = ("ouro_arc/holdout.py", "scripts/overfit_lint.py")


def _is_excluded(path: str) -> bool:
    if not path:
        return False
    if "/tests/" in path or path.startswith("tests/"):
        return True
    return any(path.endswith(suffix) for suffix in EXCLUDED_SUFFIXES)


def lint_diff(diff_text: str) -> dict[str, list[str]]:
    """Return ``{"hard_fails": [...], "advisories": [...]}`` for a unified diff."""
    hard_fails: list[str] = []
    advisories: list[str] = []
    current_file = ""
    excluded = False
    added_lines: list[tuple[str, str]] = []  # (file, content)

    for raw in diff_text.splitlines():
        if raw.startswith("+++ "):
            target = raw[4:].strip()
            if target.startswith("b/"):
                target = target[2:]
            current_file = target
            excluded = _is_excluded(current_file)
            continue
        if raw.startswith("---") or raw.startswith("diff ") or raw.startswith("@@"):
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            content = raw[1:]
            if not excluded:
                added_lines.append((current_file, content))

    coord_added_text = "\n".join(content for _, content in added_lines)

    for file, content in added_lines:
        loc = file or "<unknown>"
        if PUBLIC_ID_LITERAL_RE.search(content):
            hard_fails.append(f"{loc}: bare public game-id literal: {content.strip()}")
            continue
        if GAME_ID_RE.search(content):
            hard_fails.append(f"{loc}: game id (GAME_ID_RE) added: {content.strip()}")
            continue
        if FRAME_HASH_RE.search(content):
            hard_fails.append(f"{loc}: frame hash (FRAME_HASH_RE) added: {content.strip()}")
            continue
        if "game_id" in content and ("==" in content or "in {" in content):
            hard_fails.append(f"{loc}: per-game branching on game_id: {content.strip()}")
            continue
        if PER_GAME_LITERAL_RE.search(content):
            hard_fails.append(f"{loc}: per-game literal comparison: {content.strip()}")
            continue
        if ENV_ADVISORY_RE.search(content):
            advisories.append(f"{loc}: per-game env default touched: {content.strip()}")

    coord_count = len(COORD_RE.findall(coord_added_text))
    if coord_count > 4:
        hard_fails.append(f"coordinate-heavy diff ({coord_count} literal coordinates)")

    return {"hard_fails": hard_fails, "advisories": advisories}


def _git_diff(base: str) -> str:
    cmd = [
        "git",
        "-C",
        str(ROOT),
        "diff",
        base,
        "--",
        "ouro_arc/*.py",
        "agent/*.py",
        "skills",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return out.stdout


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="HEAD")
    args = parser.parse_args(argv)

    diff_text = _git_diff(args.base)
    result: dict[str, Any] = lint_diff(diff_text)

    if result["advisories"]:
        print("advisories:")
        for item in result["advisories"]:
            print(f"  - {item}")
    if result["hard_fails"]:
        print("hard fails:")
        for item in result["hard_fails"]:
            print(f"  - {item}")
        return 1

    print("overfit lint: clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
