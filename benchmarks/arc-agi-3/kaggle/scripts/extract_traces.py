from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


ACTION_RE = re.compile(r"#\d+\s+ACTION(?P<action>\d)(?:\((?P<x>\d+),(?P<y>\d+)\))?\s+→\s+(?P<changed>\d+)")
GAME_RE = re.compile(r"\[(?P<game>[a-z]{2}\d{2}-[0-9a-f]{8})\]")
SUMMARY_RE = re.compile(r"state=(?P<state>[A-Z_]+)\s+score=(?P<score>\d+)")


@dataclass
class TraceAction:
    action: int
    x: int | None = None
    y: int | None = None
    changed: int = 0
    outcome: str = "changed"


@dataclass
class TraceEpisode:
    source: str
    game: str | None = None
    actions: list[TraceAction] = field(default_factory=list)
    score: int | None = None
    state: str | None = None

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def parse_run_log(text: str, source: str = "run.log") -> TraceEpisode:
    episode = TraceEpisode(source=source)
    for line in text.splitlines():
        if episode.game is None:
            game_match = GAME_RE.search(line)
            if game_match:
                episode.game = game_match.group("game")
        if "tool< mcp__arc__act:" in line:
            for match in ACTION_RE.finditer(line):
                outcome = "changed"
                if "GAME_OVER" in line:
                    outcome = "death"
                elif "score" in line or "state → WIN" in line:
                    outcome = "score-or-state"
                elif int(match.group("changed")) == 0:
                    outcome = "no-op"
                episode.actions.append(
                    TraceAction(
                        action=int(match.group("action")),
                        x=int(match.group("x")) if match.group("x") is not None else None,
                        y=int(match.group("y")) if match.group("y") is not None else None,
                        changed=int(match.group("changed")),
                        outcome=outcome,
                    )
                )
        summary = SUMMARY_RE.search(line)
        if summary:
            episode.state = summary.group("state")
            episode.score = int(summary.group("score"))
    return episode


def parse_results(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def extract_paths(paths: list[Path]) -> list[dict[str, Any]]:
    episodes: list[dict[str, Any]] = []
    for path in paths:
        if path.suffix == ".log":
            episodes.append(parse_run_log(path.read_text(errors="replace"), str(path)).to_json())
        elif path.suffix == ".json":
            episodes.append({"source": str(path), "results": parse_results(path)})
    return episodes


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract structured ARC traces from full Ouroboros logs.")
    parser.add_argument("paths", type=Path, nargs="+")
    args = parser.parse_args()
    print(json.dumps(extract_paths(args.paths), indent=2))


if __name__ == "__main__":
    main()
