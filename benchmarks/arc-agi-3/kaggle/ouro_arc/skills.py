from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from importlib import resources
from typing import Any, Iterable

from .actions import ActionSpec
from .objects import salient_click_targets


GAME_ID_RE = re.compile(r"\b[a-z]{2}\d{2}-[0-9a-f]{8}\b")
FRAME_HASH_RE = re.compile(r"\b[0-9a-f]{32}\b")


@dataclass(frozen=True)
class SkillCard:
    id: str
    name: str
    description: str
    executor: str
    triggers: tuple[str, ...]
    priority: int = 0

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "SkillCard":
        return cls(
            id=str(value["id"]),
            name=str(value["name"]),
            description=str(value.get("description", "")),
            executor=str(value["executor"]),
            triggers=tuple(str(item) for item in value.get("triggers", [])),
            priority=int(value.get("priority", 0)),
        )

    def summary(self) -> str:
        return f"{self.id}:{self.executor} priority={self.priority} triggers={','.join(self.triggers)}"


@dataclass
class SkillPlan:
    card: SkillCard
    score: float
    actions: list[ActionSpec]
    reason: str

    def prompt_line(self) -> str:
        return (
            f"{self.card.id} score={self.score:.2f} executor={self.card.executor}: "
            f"{self.reason}; actions={[action.to_json() for action in self.actions[:5]]}"
        )


@dataclass
class SkillContext:
    grid: list[list[int]]
    level: int
    available_actions: set[int]
    movement_model: Any
    click_board: Any
    node_tried: set[tuple[int, int | None, int | None]]
    dud_clicks: set[tuple[int, int]]
    dangerous_edges: set[tuple[int, str, tuple[int, int | None, int | None]]]
    noop_edges: set[tuple[int, str, tuple[int, int | None, int | None]]]
    state_key: str
    clicked_targets: set[tuple[int, int]] = field(default_factory=set)
    stagnation: int = 0
    cooled_skills: set[str] = field(default_factory=set)
    banned_skills: set[str] = field(default_factory=set)


def load_distilled_skill_cards() -> list[SkillCard]:
    try:
        with resources.files(__package__).joinpath("distilled_skills.json").open("r") as f:
            raw = json.load(f)
    except (FileNotFoundError, ModuleNotFoundError):
        return []
    return [SkillCard.from_json(item) for item in raw]


def validate_skill_cards(cards: Iterable[dict[str, Any] | SkillCard]) -> list[str]:
    errors: list[str] = []
    for index, card in enumerate(cards):
        raw = card if isinstance(card, dict) else card.__dict__
        text = json.dumps(raw, sort_keys=True)
        card_id = str(raw.get("id", f"#{index}"))
        if GAME_ID_RE.search(text):
            errors.append(f"{card_id}: contains game id")
        if FRAME_HASH_RE.search(text):
            errors.append(f"{card_id}: contains frame hash")
        if "game_id" in raw or "frame_hash" in raw:
            errors.append(f"{card_id}: contains brittle key field")
        if raw.get("executor") == "macro_replay" and raw.get("actions"):
            errors.append(f"{card_id}: contains static macro actions")
        if len(re.findall(r"ACTION6?\(|\"x\"\s*:", text)) > 4:
            errors.append(f"{card_id}: contains too many exact coordinates")
    return errors


class SkillRegistry:
    def __init__(self, cards: list[SkillCard] | None = None) -> None:
        self.cards = cards if cards is not None else load_distilled_skill_cards()

    @classmethod
    def from_json(cls, values: list[dict[str, Any]]) -> "SkillRegistry":
        return cls([SkillCard.from_json(value) for value in values])

    def ranked_plans(self, context: SkillContext, limit: int = 4) -> list[SkillPlan]:
        plans: list[SkillPlan] = []
        for card in self.cards:
            if card.id in context.cooled_skills or card.id in context.banned_skills:
                continue
            plan = self._plan_for(card, context)
            if plan:
                plans.append(plan)
        plans.sort(key=lambda plan: (-plan.score, -plan.card.priority, plan.card.id))
        return plans[:limit]

    def _plan_for(self, card: SkillCard, context: SkillContext) -> SkillPlan | None:
        if card.executor == "movement_bfs":
            return self._movement_bfs(card, context)
        if card.executor == "click_board_toggle":
            return self._click_board_toggle(card, context)
        if card.executor == "salient_click_probe":
            return self._salient_click_probe(card, context)
        if card.executor == "frontier_explore":
            return self._frontier_explore(card, context)
        return None

    def _movement_bfs(self, card: SkillCard, context: SkillContext) -> SkillPlan | None:
        width = max((len(row) for row in context.grid), default=0)
        height = len(context.grid)
        actions = context.movement_model.plan(width, height, context.available_actions)
        actions = [action for action in actions if self._safe(context, action)]
        if not actions:
            return None
        known = len(getattr(context.movement_model, "deltas", {}))
        score = card.priority + min(known, 4) * 4 - context.stagnation
        return SkillPlan(card, float(score), actions, f"movement deltas known={known}")

    def _click_board_toggle(self, card: SkillCard, context: SkillContext) -> SkillPlan | None:
        actions = [
            action
            for action in context.click_board.plan(
                context.grid,
                context.level,
                context.available_actions,
            )
            if self._safe(context, action) and (action.x, action.y) not in context.dud_clicks
        ]
        if not actions:
            return None
        targets = len(context.click_board.detect_targets(context.grid))
        score = card.priority + min(targets, 12)
        return SkillPlan(card, float(score), actions, f"regular board targets={targets}")

    def _salient_click_probe(self, card: SkillCard, context: SkillContext) -> SkillPlan | None:
        if 6 not in context.available_actions:
            return None
        actions: list[ActionSpec] = []
        for x, y, label in salient_click_targets(context.grid, limit=12):
            spec = ActionSpec(6, x=x, y=y, reason=f"skill salient click {label}", source="skill-salient-click")
            if (
                spec.key in context.node_tried
                or (x, y) in context.dud_clicks
                or (x, y) in context.clicked_targets
                or not self._safe(context, spec)
            ):
                continue
            actions.append(spec)
            if len(actions) >= 4:
                break
        if not actions:
            return None
        return SkillPlan(card, float(card.priority), actions, f"salient targets={len(actions)}")

    def _frontier_explore(self, card: SkillCard, context: SkillContext) -> SkillPlan | None:
        actions: list[ActionSpec] = []
        for action in (1, 2, 3, 4, 5, 7):
            spec = ActionSpec(action, reason="skill frontier explore", source="skill-frontier")
            if action not in context.available_actions:
                continue
            if spec.key in context.node_tried or not self._safe(context, spec):
                continue
            actions.append(spec)
        if not actions:
            return None
        score = card.priority - context.stagnation
        return SkillPlan(card, float(score), actions[:4], f"untried simple actions={len(actions)}")

    def _safe(self, context: SkillContext, action: ActionSpec) -> bool:
        edge = (context.level, context.state_key, action.key)
        return edge not in context.dangerous_edges and edge not in context.noop_edges
