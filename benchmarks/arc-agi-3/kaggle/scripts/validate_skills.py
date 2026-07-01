from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = Path(__file__).resolve().parent
for path in (ROOT, SCRIPT_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from compile_skills import compile_agent_skills  # noqa: E402
from ouro_arc.skills import validate_skill_cards  # noqa: E402


def load_cards(path: Path) -> list[dict]:
    return json.loads(path.read_text())


def validate_json(path: Path) -> list[str]:
    return validate_skill_cards(load_cards(path))


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate ARC Agent Skills and compiled runtime cards.")
    parser.add_argument("--skills-dir", type=Path, default=ROOT / "skills")
    parser.add_argument("--compiled", type=Path, default=ROOT / "ouro_arc" / "distilled_skills.json")
    parser.add_argument("--json-only", type=Path, help="Validate only a compiled JSON card file.")
    args = parser.parse_args()

    if args.json_only:
        errors = validate_json(args.json_only)
        target = args.json_only
    else:
        _cards, errors = compile_agent_skills(args.skills_dir)
        if args.compiled.exists():
            errors.extend(validate_json(args.compiled))
        else:
            errors.append(f"{args.compiled}: compiled skill cards file is missing")
        target = args.skills_dir

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        raise SystemExit(1)
    print(f"validated {target}")


if __name__ == "__main__":
    main()
