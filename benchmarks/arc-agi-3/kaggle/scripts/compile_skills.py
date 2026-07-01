from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ouro_arc.skills import validate_skill_cards  # noqa: E402


GAME_ID_RE = re.compile(r"\b[a-z]{2}\d{2}-[0-9a-f]{8}\b")
FRAME_HASH_RE = re.compile(r"\b[0-9a-f]{32}\b")
ACTION_SEQUENCE_RE = re.compile(r"\bA(?:CTION)?[1-7](?:\([^)]*\))?(?:\s+A(?:CTION)?[1-7](?:\([^)]*\))?){5,}")
COORDINATE_RE = re.compile(r"\(\s*\d{1,2}\s*,\s*\d{1,2}\s*\)")
REQUIRED_FIELDS = {"name", "description", "license", "executor", "triggers", "priority", "metadata"}


@dataclass
class AgentSkill:
    path: Path
    frontmatter: dict[str, Any]
    body: str

    def card(self) -> dict[str, Any]:
        display_name = next(
            (
                line.removeprefix("#").strip()
                for line in self.body.splitlines()
                if line.startswith("# ")
            ),
            _title_from_slug(str(self.frontmatter["name"])),
        )
        return {
            "id": str(self.frontmatter["name"]),
            "name": display_name,
            "description": str(self.frontmatter["description"]),
            "executor": str(self.frontmatter["executor"]),
            "triggers": list(self.frontmatter["triggers"]),
            "priority": int(self.frontmatter["priority"]),
        }


def _title_from_slug(value: str) -> str:
    return " ".join(part.capitalize() for part in value.replace("_", "-").split("-"))


def _parse_scalar(value: str) -> Any:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    if value.isdigit() or (value.startswith("-") and value[1:].isdigit()):
        return int(value)
    if value in {"true", "false"}:
        return value == "true"
    return value


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    trimmed = text.strip()
    if not trimmed.startswith("---"):
        raise ValueError("SKILL.md must start with frontmatter")
    end = trimmed.find("\n---", 3)
    if end == -1:
        raise ValueError("SKILL.md missing closing frontmatter delimiter")
    raw = trimmed[3:end].strip().splitlines()
    body = trimmed[end + len("\n---") :].strip()
    frontmatter: dict[str, Any] = {}
    current_key: str | None = None
    for raw_line in raw:
        if not raw_line.strip():
            continue
        if raw_line.startswith("  - "):
            if current_key is None:
                raise ValueError("list item without key")
            parent = frontmatter.setdefault(current_key, [])
            if parent == []:
                frontmatter[current_key] = parent
            if not isinstance(parent, list):
                raise ValueError(f"cannot append list item under non-list key {current_key}")
            parent.append(_parse_scalar(raw_line[4:]))
            continue
        if raw_line.startswith("  "):
            if current_key is None:
                raise ValueError("nested value without key")
            parent = frontmatter.setdefault(current_key, {})
            if parent == []:
                parent = {}
                frontmatter[current_key] = parent
            if not isinstance(parent, dict):
                raise ValueError(f"cannot nest under non-dict key {current_key}")
            key, sep, value = raw_line.strip().partition(":")
            if not sep:
                raise ValueError(f"invalid nested frontmatter line: {raw_line}")
            parent[key] = _parse_scalar(value)
            continue
        key, sep, value = raw_line.partition(":")
        if not sep:
            raise ValueError(f"invalid frontmatter line: {raw_line}")
        current_key = key.strip()
        if value.strip():
            frontmatter[current_key] = _parse_scalar(value)
        else:
            frontmatter[current_key] = []
    return frontmatter, body


def load_agent_skill(path: Path) -> AgentSkill:
    frontmatter, body = parse_frontmatter(path.read_text())
    return AgentSkill(path=path, frontmatter=frontmatter, body=body)


def discover_skill_paths(skills_dir: Path) -> list[Path]:
    return sorted(path / "SKILL.md" for path in skills_dir.iterdir() if (path / "SKILL.md").exists())


def validate_agent_skill(skill: AgentSkill) -> list[str]:
    errors: list[str] = []
    fm = skill.frontmatter
    missing = sorted(REQUIRED_FIELDS - set(fm))
    if missing:
        errors.append(f"{skill.path}: missing fields {missing}")
    metadata = fm.get("metadata")
    if not isinstance(metadata, dict):
        errors.append(f"{skill.path}: metadata must be a mapping")
    else:
        if not metadata.get("author"):
            errors.append(f"{skill.path}: metadata.author is required")
        if not metadata.get("version"):
            errors.append(f"{skill.path}: metadata.version is required")
    if fm.get("license") != "Apache-2.0":
        errors.append(f"{skill.path}: license must be Apache-2.0")
    if not isinstance(fm.get("triggers"), list) or not fm.get("triggers"):
        errors.append(f"{skill.path}: triggers must be a non-empty list")
    try:
        int(fm.get("priority"))
    except (TypeError, ValueError):
        errors.append(f"{skill.path}: priority must be an integer")
    if not str(fm.get("name", "")).strip():
        errors.append(f"{skill.path}: name is required")
    if not str(fm.get("description", "")).strip():
        errors.append(f"{skill.path}: description is required")
    if not skill.body:
        errors.append(f"{skill.path}: body is required")

    text = skill.path.read_text()
    name = str(fm.get("name", skill.path.parent.name))
    if GAME_ID_RE.search(text):
        errors.append(f"{name}: contains game id")
    if FRAME_HASH_RE.search(text):
        errors.append(f"{name}: contains frame hash")
    if ACTION_SEQUENCE_RE.search(text) or re.search(r"\bL\d+\s+macro\b", text, re.I):
        errors.append(f"{name}: contains static macro-like action sequence")
    if len(COORDINATE_RE.findall(text)) > 4:
        errors.append(f"{name}: contains too many exact coordinates")
    return errors


def compile_agent_skills(skills_dir: Path) -> tuple[list[dict[str, Any]], list[str]]:
    cards: list[dict[str, Any]] = []
    errors: list[str] = []
    for path in discover_skill_paths(skills_dir):
        try:
            skill = load_agent_skill(path)
        except ValueError as exc:
            errors.append(f"{path}: {exc}")
            continue
        errors.extend(validate_agent_skill(skill))
        cards.append(skill.card())
    errors.extend(validate_skill_cards(cards))
    return cards, errors


def write_compiled_cards(cards: list[dict[str, Any]], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(cards, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Compile Agent Skills into Kaggle runtime skill cards.")
    parser.add_argument("--skills-dir", type=Path, default=ROOT / "skills")
    parser.add_argument("--out", type=Path, default=ROOT / "ouro_arc" / "distilled_skills.json")
    parser.add_argument("--check", action="store_true", help="Validate without writing output.")
    args = parser.parse_args()

    cards, errors = compile_agent_skills(args.skills_dir)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        raise SystemExit(1)
    if not args.check:
        write_compiled_cards(cards, args.out)
        print(f"compiled {len(cards)} skills to {args.out}")
    else:
        print(f"validated {len(cards)} Agent Skills from {args.skills_dir}")


if __name__ == "__main__":
    main()
