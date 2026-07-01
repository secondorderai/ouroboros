from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = Path(__file__).resolve().parent
for path in (ROOT, SCRIPT_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from compile_skills import compile_agent_skills, write_compiled_cards  # noqa: E402
from ouro_arc.skills import validate_skill_cards  # noqa: E402


@dataclass(frozen=True)
class SkillSeed:
    slug: str
    title: str
    description: str
    executor: str
    triggers: tuple[str, ...]
    priority: int
    body: str


BASE_SKILLS = [
    SkillSeed(
        slug="movement-bfs-frontier",
        title="Movement BFS Frontier",
        description="Use inferred direction deltas to search toward unvisited safe positions after simple action probes identify a controlled object.",
        executor="movement_bfs",
        triggers=("movement_deltas_known", "simple_actions_available"),
        priority=90,
        body="""# Movement BFS Frontier

Use this skill when simple action probes show that actions 1-4 move a stable
foreground object. Treat the moved object as the controlled object only after
the transition model has observed consistent deltas.

Plan by building a local movement graph from the current inferred position,
learned action deltas, blocked edges, death edges, and visited positions. Prefer
short paths to unvisited safe cells. Never choose an edge already observed to
cause `GAME_OVER` or no visible change from the same state.

This skill is intentionally generic. It must not store exact game ids, frame
hashes, solved-level walkthroughs, or fixed coordinates from public games.
""",
    ),
    SkillSeed(
        slug="click-board-toggle",
        title="Click Board Toggle",
        description="Detect regular rectangular board cells and click untried non-HUD cells while avoiding prior no-op, HUD-only, or death outcomes.",
        executor="click_board_toggle",
        triggers=("action6_available", "regular_board_detected"),
        priority=80,
        body="""# Click Board Toggle

Use this skill when `ACTION6` is available and the frame contains repeated
rectangular components arranged like a board. Candidate targets are cell
centers from regular non-HUD tiles.

Classify click outcomes as no-op, HUD-only, region-change, score-change, or
death. Prefer untried board cells that previously caused board-region changes
or have no outcome yet. Avoid cells that already produced no visible change,
HUD-only changes, or death.

This skill describes a board-solving strategy, not a memorized board solution.
Do not encode public-game ids, exact frame hashes, or static coordinate lists.
""",
    ),
    SkillSeed(
        slug="salient-click-probe",
        title="Salient Click Probe",
        description="When coordinate clicks are available but no board model is confident, probe visible compact non-HUD objects before raw fallback actions.",
        executor="salient_click_probe",
        triggers=("action6_available", "salient_objects_visible"),
        priority=55,
        body="""# Salient Click Probe

Use this skill when coordinate clicks are legal but the frame does not yet have
a confident regular-board model. Generate click probes from visible compact
foreground objects, preferring non-HUD objects with stable centers.

Skip coordinates that are known duds, known dangerous edges, or already tried
from the current state. This skill is for targeted probing only; it must not
perform blind coordinate sweeps.

Keep the skill generic. Do not include public-game walkthroughs or exact target
coordinates learned from previous public runs.
""",
    ),
    SkillSeed(
        slug="frontier-simple-explore",
        title="Frontier Simple Explore",
        description="Prefer safe untried simple actions from the current state when no higher-confidence solver has a plan.",
        executor="frontier_explore",
        triggers=("simple_actions_available", "untried_edges_exist"),
        priority=35,
        body="""# Frontier Simple Explore

Use this skill as a generic fallback when actions 1-5 or 7 are available and no
stronger movement or click-board plan is ready. Prefer simple actions that have
not yet been tried from the current frame hash.

Avoid actions known to be no-ops or dangerous from the same level and state.
This skill keeps exploration systematic while preserving budget for stronger
solvers and Gemma plan selection.

The skill must remain game-agnostic and must not contain public-game ids,
static macros, frame hashes, or fixed public-game action sequences.
""",
    ),
]


def trace_stats(episodes: list[dict[str, Any]]) -> tuple[int, int, int]:
    action6_count = 0
    simple_count = 0
    death_count = 0
    for episode in episodes:
        for action in episode.get("actions", []):
            if action.get("action") == 6:
                action6_count += 1
            elif action.get("action") in {1, 2, 3, 4, 5, 7}:
                simple_count += 1
            if action.get("outcome") == "death":
                death_count += 1
    return action6_count, simple_count, death_count


def distilled_seeds(episodes: list[dict[str, Any]]) -> list[SkillSeed]:
    action6_count, simple_count, death_count = trace_stats(episodes)
    seeds: list[SkillSeed] = []
    for seed in BASE_SKILLS:
        priority = seed.priority
        description = seed.description
        if seed.slug == "click-board-toggle" and action6_count > simple_count:
            priority = 88
        if seed.slug == "movement-bfs-frontier" and death_count:
            description += " Treat observed death edges as hard exclusions."
        seeds.append(
            SkillSeed(
                slug=seed.slug,
                title=seed.title,
                description=description,
                executor=seed.executor,
                triggers=seed.triggers,
                priority=priority,
                body=seed.body,
            )
        )
    return seeds


def skill_markdown(seed: SkillSeed) -> str:
    triggers = "\n".join(f"  - {trigger}" for trigger in seed.triggers)
    return f"""---
name: {seed.slug}
description: {seed.description}
license: Apache-2.0
executor: {seed.executor}
triggers:
{triggers}
priority: {seed.priority}
metadata:
  author: ouroboros-rsi
  version: "1.0"
---

{seed.body.strip()}
"""


def write_agent_skills(seeds: list[SkillSeed], skills_dir: Path) -> None:
    for seed in seeds:
        skill_dir = skills_dir / seed.slug
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(skill_markdown(seed))


def distill_skill_cards(episodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cards = [
        {
            "id": seed.slug,
            "name": seed.title,
            "description": seed.description,
            "executor": seed.executor,
            "triggers": list(seed.triggers),
            "priority": seed.priority,
        }
        for seed in distilled_seeds(episodes)
    ]
    errors = validate_skill_cards(cards)
    if errors:
        raise ValueError("; ".join(errors))
    return cards


def main() -> None:
    parser = argparse.ArgumentParser(description="Distill generic ARC Agent Skills from trace JSON.")
    parser.add_argument("trace_json", type=Path)
    parser.add_argument("--skills-dir", type=Path, default=ROOT / "skills")
    parser.add_argument("--out", type=Path, default=ROOT / "ouro_arc" / "distilled_skills.json")
    args = parser.parse_args()

    episodes = json.loads(args.trace_json.read_text())
    write_agent_skills(distilled_seeds(episodes), args.skills_dir)
    cards, errors = compile_agent_skills(args.skills_dir)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        raise SystemExit(1)
    write_compiled_cards(cards, args.out)
    print(f"wrote Agent Skills to {args.skills_dir}")
    print(f"compiled {len(cards)} skills to {args.out}")


if __name__ == "__main__":
    main()
