from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .actions import ActionSpec, RESET_ACTION, filter_legal_actions, normalize_available_actions
from .gemma import GemmaAdvisor
from .objects import salient_click_targets, summarize_objects
from .render import frame_hash, last_grid, render_diff, render_full


TERMINAL_STATES = {"WIN"}
RESET_STATES = {"NOT_PLAYED", "GAME_OVER"}


@dataclass
class GraphNode:
    key: str
    tried: set[tuple[int, int | None, int | None]] = field(default_factory=set)
    visits: int = 0


@dataclass
class FrameView:
    grid: list[list[int]]
    state: str
    levels_completed: int
    win_levels: int | None
    available_actions: set[int]
    key: str


class ArcController:
    """Deterministic ARC-AGI-3 explorer with sparse Gemma advice."""

    def __init__(self, advisor: GemmaAdvisor | None = None, max_queue: int = 24) -> None:
        self.advisor = advisor or GemmaAdvisor()
        self.max_queue = max_queue
        self.nodes: dict[str, GraphNode] = {}
        self.queue: list[ActionSpec] = []
        self.macros: list[list[ActionSpec]] = []
        self.current_macro: list[ActionSpec] = []
        self.last_view: FrameView | None = None
        self.last_action: ActionSpec | None = None
        self.stagnation = 0
        self.hypothesis = ""
        self.replaying = False

    def choose(self, latest_frame: Any) -> ActionSpec:
        view = self._frame_view(latest_frame)
        self._observe_transition(view)

        if view.state in TERMINAL_STATES:
            return ActionSpec(RESET_ACTION, reason="game already terminal", source="controller")
        if view.state in RESET_STATES:
            self.queue = []
            self.current_macro = []
            self.replaying = view.state == "GAME_OVER" and bool(self.macros)
            return ActionSpec(RESET_ACTION, reason=f"state={view.state}", source="controller")

        if self.replaying and not self.queue and view.levels_completed == 0:
            for macro in self.macros:
                self.queue.extend(macro)

        queued = self._pop_legal(view.available_actions)
        if queued:
            self._record_choice(view, queued)
            return queued

        node = self.nodes.setdefault(view.key, GraphNode(key=view.key))
        node.visits += 1

        candidates = self._candidate_actions(view)
        if not candidates:
            return ActionSpec(RESET_ACTION, reason="no legal actions available", source="controller")
        unexplored = [action for action in candidates if action.key not in node.tried]

        if self._should_ask_gemma(view, unexplored):
            plan = self.advisor.advise(self._prompt(view, candidates), view.available_actions)
            if plan:
                self.hypothesis = plan.hypothesis or self.hypothesis
                self.queue.extend(plan.actions[: self.max_queue])
                queued = self._pop_legal(view.available_actions)
                if queued:
                    self._record_choice(view, queued)
                    return queued

        action = (unexplored or candidates)[0]
        self._record_choice(view, action)
        return action

    def _frame_view(self, frame: Any) -> FrameView:
        raw_frame = getattr(frame, "frame", None)
        grid = last_grid(raw_frame or [])
        state = str(getattr(getattr(frame, "state", ""), "name", getattr(frame, "state", "")))
        levels_completed = int(getattr(frame, "levels_completed", getattr(frame, "score", 0)) or 0)
        win_levels_raw = getattr(frame, "win_levels", getattr(frame, "win_score", None))
        win_levels = int(win_levels_raw) if win_levels_raw is not None else None
        available = normalize_available_actions(getattr(frame, "available_actions", []))
        return FrameView(
            grid=grid,
            state=state,
            levels_completed=levels_completed,
            win_levels=win_levels,
            available_actions=available,
            key=frame_hash(grid),
        )

    def _observe_transition(self, view: FrameView) -> None:
        if self.last_action and self.last_view:
            prev_level = self.last_view.levels_completed
            if view.levels_completed > prev_level:
                if not self.replaying and self.current_macro:
                    self.macros.append(self.current_macro[:])
                self.current_macro = []
                if self.replaying and view.levels_completed >= len(self.macros):
                    self.replaying = False
                if not self.replaying:
                    self.queue = []
                self.stagnation = 0
            elif view.key == self.last_view.key:
                self.stagnation += 1
            else:
                self.stagnation = 0
        self.last_view = view

    def _record_choice(self, view: FrameView, action: ActionSpec) -> None:
        node = self.nodes.setdefault(view.key, GraphNode(key=view.key))
        node.tried.add(action.key)
        self.last_action = action
        if not action.is_reset():
            self.current_macro.append(action)

    def _pop_legal(self, available_actions: set[int]) -> ActionSpec | None:
        while self.queue:
            action = self.queue.pop(0)
            if filter_legal_actions([action], available_actions):
                return action
        return None

    def _candidate_actions(self, view: FrameView) -> list[ActionSpec]:
        actions: list[ActionSpec] = []
        for action in (1, 2, 3, 4, 5, 7):
            if action in view.available_actions:
                actions.append(ActionSpec(action, reason="systematic probe", source="controller"))
        if 6 in view.available_actions:
            for x, y, label in salient_click_targets(view.grid):
                actions.append(ActionSpec(6, x=x, y=y, reason=f"click {label}", source="controller"))
        if not actions and view.available_actions:
            first = sorted(view.available_actions)[0]
            actions.append(ActionSpec(first, reason="fallback legal action", source="controller"))
        return actions

    def _should_ask_gemma(self, view: FrameView, unexplored: list[ActionSpec]) -> bool:
        if not view.grid or not view.available_actions:
            return False
        if len(self.macros) == 0 and unexplored:
            return False
        return self.stagnation >= 2 or not unexplored

    def _prompt(self, view: FrameView, candidates: list[ActionSpec]) -> str:
        previous = ""
        if self.last_view:
            previous = "\nDiff from previous frame:\n" + render_diff(self.last_view.grid, view.grid)
        macros = [
            [action.to_json() for action in macro]
            for macro in self.macros[-5:]
            if macro
        ]
        return (
            "Select the next ARC-AGI-3 probe or exploit actions. Return only JSON.\n"
            f"State: {view.state}; levels={view.levels_completed}/{view.win_levels or '?'}; "
            f"available_actions={sorted(view.available_actions)}\n"
            f"Current hypothesis: {self.hypothesis or 'unknown'}\n"
            f"Solved macros: {macros}\n"
            f"Candidates: {[action.to_json() for action in candidates[:20]]}\n"
            "Objects:\n"
            f"{summarize_objects(view.grid)}\n"
            f"{previous}\n"
            "Frame:\n"
            f"{render_full(view.grid)}\n"
            'Required JSON: {"mode":"probe|exploit|replay","actions":[{"action":1}],'
            '"hypothesis":"...","confidence":0.0}'
        )
