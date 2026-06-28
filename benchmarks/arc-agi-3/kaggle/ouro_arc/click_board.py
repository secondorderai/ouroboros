from __future__ import annotations

from dataclasses import dataclass, field

from .actions import ActionSpec
from .objects import HUD_ROWS, regular_click_targets
from .render import changed_cells


@dataclass(frozen=True)
class BoardTarget:
    x: int
    y: int
    label: str


@dataclass
class ClickOutcome:
    x: int
    y: int
    outcome: str
    changed: int


@dataclass
class ClickBoardModel:
    outcomes: dict[tuple[int, int], ClickOutcome] = field(default_factory=dict)
    tried_by_level: dict[int, set[tuple[int, int]]] = field(default_factory=dict)

    def detect_targets(self, grid: list[list[int]], limit: int = 64) -> list[BoardTarget]:
        return [
            BoardTarget(x=x, y=y, label=label)
            for x, y, label in regular_click_targets(grid, limit=limit)
        ]

    def classify(
        self,
        prev_grid: list[list[int]],
        next_grid: list[list[int]],
        prev_level: int,
        next_level: int,
        next_state: str,
    ) -> tuple[str, int]:
        if next_state == "GAME_OVER":
            return "death", 0
        if next_level > prev_level:
            return "score-change", 0
        changes = changed_cells(prev_grid, next_grid)
        if not changes:
            return "no-op", 0
        height = len(next_grid)
        if all(y < HUD_ROWS or y >= height - HUD_ROWS for _x, y, _old, _new in changes):
            return "hud-only", len(changes)
        return "region-change", len(changes)

    def observe_click(
        self,
        action: ActionSpec,
        prev_grid: list[list[int]],
        next_grid: list[list[int]],
        prev_level: int,
        next_level: int,
        next_state: str,
    ) -> None:
        if action.action != 6 or action.x is None or action.y is None:
            return
        outcome, changed = self.classify(prev_grid, next_grid, prev_level, next_level, next_state)
        self.outcomes[(action.x, action.y)] = ClickOutcome(action.x, action.y, outcome, changed)
        self.tried_by_level.setdefault(prev_level, set()).add((action.x, action.y))

    def plan(
        self,
        grid: list[list[int]],
        level: int,
        available_actions: set[int],
        max_actions: int = 12,
    ) -> list[ActionSpec]:
        if 6 not in available_actions:
            return []
        tried = self.tried_by_level.setdefault(level, set())
        actions: list[ActionSpec] = []
        for target in self.detect_targets(grid):
            point = (target.x, target.y)
            outcome = self.outcomes.get(point)
            if outcome and outcome.outcome in {"no-op", "hud-only", "death"}:
                continue
            spec = ActionSpec(
                6,
                x=target.x,
                y=target.y,
                reason=f"click-board {target.label}",
                source="click-board",
            )
            if point not in tried:
                actions.append(spec)
            if len(actions) >= max_actions:
                return actions
        return actions

    def summary(self) -> str:
        counts: dict[str, int] = {}
        for outcome in self.outcomes.values():
            counts[outcome.outcome] = counts.get(outcome.outcome, 0) + 1
        return f"outcomes={counts}; levels={ {k: len(v) for k, v in self.tried_by_level.items()} }"
