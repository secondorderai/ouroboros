from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INIT = ROOT / "vendor" / "ARC-AGI-3-Agents" / "agents" / "__init__.py"

SLIM = '''\
"""Slimmed by scripts/slim_framework.py for local Ouroboros ARC-AGI-3 runs."""
from typing import Type

from dotenv import load_dotenv

from .agent import Agent, Playback
from .swarm import Swarm
from .templates.random_agent import Random

load_dotenv()

AVAILABLE_AGENTS: dict[str, Type[Agent]] = {
    "random": Random,
}

__all__ = [
    "Agent",
    "AVAILABLE_AGENTS",
    "Playback",
    "Random",
    "Swarm",
]
'''


def main() -> None:
    if not INIT.exists():
        raise SystemExit(f"Framework not found at {INIT}. Run `make setup` first.")
    INIT.write_text(SLIM)
    print(f"[slim_framework] Slimmed {INIT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
