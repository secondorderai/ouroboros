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
    outcomes_by_context: dict[tuple[int, str, int, int], ClickOutcome] = field(default_factory=dict)
    tried_by_context: dict[tuple[int, str], set[tuple[int, int]]] = field(default_factory=dict)

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
        frame_family: str = "*",
    ) -> None:
        if action.action != 6 or action.x is None or action.y is None:
            return
        outcome, changed = self.classify(prev_grid, next_grid, prev_level, next_level, next_state)
        click_outcome = ClickOutcome(action.x, action.y, outcome, changed)
        self.outcomes[(action.x, action.y)] = click_outcome
        self.outcomes_by_context[(prev_level, frame_family, action.x, action.y)] = click_outcome
        self.tried_by_level.setdefault(prev_level, set()).add((action.x, action.y))
        self.tried_by_context.setdefault((prev_level, frame_family), set()).add((action.x, action.y))

    def plan(
        self,
        grid: list[list[int]],
        level: int,
        available_actions: set[int],
        max_actions: int = 12,
        frame_family: str = "*",
    ) -> list[ActionSpec]:
        if 6 not in available_actions:
            return []
        tried = set(self.tried_by_context.setdefault((level, frame_family), set()))
        if frame_family == "*":
            tried |= self.tried_by_level.setdefault(level, set())
        actions: list[ActionSpec] = []
        targets = self.detect_targets(grid)

        def target_rank(target: BoardTarget) -> tuple[int, int, int]:
            outcome = self.outcomes_by_context.get((level, frame_family, target.x, target.y))
            if outcome is None:
                global_outcome = self.outcomes.get((target.x, target.y))
                if global_outcome and global_outcome.outcome in {"region-change", "score-change"}:
                    outcome = global_outcome
            if outcome and outcome.outcome == "region-change":
                priority = 0
            elif outcome and outcome.outcome == "score-change":
                priority = -1
            elif outcome and outcome.outcome in {"no-op", "hud-only", "death"}:
                priority = 9
            else:
                priority = 2
            return (priority, target.y, target.x)

        for target in sorted(targets, key=target_rank):
            point = (target.x, target.y)
            context_outcome = self.outcomes_by_context.get((level, frame_family, target.x, target.y))
            if context_outcome and context_outcome.outcome in {"no-op", "hud-only", "death"}:
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
