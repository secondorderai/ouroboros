from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .actions import ActionSpec, RESET_ACTION, filter_legal_actions, normalize_available_actions
from .click_board import ClickBoardModel
from .gemma import GemmaAdvisor
from .movement import MovementModel
from .objects import object_motions, salient_click_targets, summarize_objects
from .render import frame_hash, last_grid, render_diff, render_full
from .telemetry import TelemetryWriter


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


@dataclass
class TransitionEvent:
    action: dict[str, Any]
    from_level: int
    to_level: int
    from_key: str
    to_key: str
    outcome: str
    diff: str

    def prompt_line(self) -> str:
        return (
            f"level {self.from_level}->{self.to_level} {self.action} "
            f"{self.from_key[:8]}->{self.to_key[:8]}: {self.outcome}; {self.diff}"
        )


class ArcController:
    """Deterministic ARC-AGI-3 explorer with sparse Gemma advice."""

    def __init__(
        self,
        advisor: GemmaAdvisor | None = None,
        max_queue: int = 24,
        telemetry: TelemetryWriter | None = None,
    ) -> None:
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
        self.level = 0
        self.level_probe_actions: set[int] = set()
        self.movement_deltas: dict[int, tuple[int, int]] = {}
        self.current_position: tuple[int, int] | None = None
        self.visited_positions: set[tuple[int, int]] = set()
        self.clicked_targets: dict[int, set[tuple[int, int]]] = {}
        self.dud_clicks: set[tuple[int, int]] = set()
        self.dangerous_edges: set[tuple[int, str, tuple[int, int | None, int | None]]] = set()
        self.noop_edges: set[tuple[int, str, tuple[int, int | None, int | None]]] = set()
        self.action_counts: dict[int, int] = {}
        self.model_asked_keys: set[str] = set()
        self.recent_events: list[TransitionEvent] = []
        self.last_transition_diff = ""
        self.movement_model = MovementModel()
        self.click_board = ClickBoardModel()
        self.telemetry = telemetry or TelemetryWriter()
        self.model_calls = 0
        self.model_plans = 0

    def choose(self, latest_frame: Any) -> ActionSpec:
        view = self._frame_view(latest_frame)
        self._observe_transition(view)

        if view.state in TERMINAL_STATES:
            return ActionSpec(RESET_ACTION, reason="game already terminal", source="controller")
        if view.state in RESET_STATES:
            self.queue = []
            self.current_macro = []
            self.level_probe_actions = set()
            self.visited_positions = set()
            self.current_position = None
            self.movement_model.reset_level()
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

        probe = self._structured_probe(view)
        if probe:
            self._record_choice(view, probe)
            return probe

        movement = self._movement_plan(view)
        if movement:
            self.queue.extend(movement[1 : self.max_queue])
            self._record_choice(view, movement[0])
            return movement[0]

        click_plan = self._click_board_plan(view)
        if click_plan:
            self.queue.extend(click_plan[1 : self.max_queue])
            self._record_choice(view, click_plan[0])
            return click_plan[0]

        candidates = self._candidate_actions(view)
        if not candidates:
            if self._should_ask_gemma(view, candidates, []):
                self.model_asked_keys.add(view.key)
                self.model_calls += 1
                plan = self.advisor.advise(self._prompt(view, candidates), view.available_actions)
                if plan:
                    self.model_plans += 1
                    self.hypothesis = plan.hypothesis or self.hypothesis
                    self.queue.extend(plan.actions[: self.max_queue])
                    queued = self._pop_legal(view.available_actions)
                    if queued:
                        self._record_choice(view, queued)
                        return queued
            self.replaying = bool(self.macros)
            return ActionSpec(RESET_ACTION, reason="no legal actions available", source="controller")
        unexplored = [action for action in candidates if action.key not in node.tried]

        if self._should_ask_gemma(view, candidates, unexplored):
            self.model_asked_keys.add(view.key)
            self.model_calls += 1
            plan = self.advisor.advise(self._prompt(view, candidates), view.available_actions)
            if plan:
                self.model_plans += 1
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
            outcome = "changed"
            if view.levels_completed > prev_level:
                outcome = "score increased"
                if not self.replaying and self.current_macro:
                    self.macros.append(self.current_macro[:])
                self.current_macro = []
                self.level = view.levels_completed
                self.level_probe_actions = set()
                self.visited_positions = set()
                self.current_position = None
                self.movement_model.reset_level()
                if self.replaying and view.levels_completed >= len(self.macros):
                    self.replaying = False
                if not self.replaying:
                    self.queue = []
                self.stagnation = 0
            elif view.state == "GAME_OVER":
                outcome = "game over"
                self.dangerous_edges.add((prev_level, self.last_view.key, self.last_action.key))
            elif view.key == self.last_view.key:
                outcome = "no visible change"
                self.stagnation += 1
                if self.last_action.action == 6 and self.last_action.x is not None and self.last_action.y is not None:
                    self.dud_clicks.add((self.last_action.x, self.last_action.y))
                elif not self.last_action.is_reset():
                    self.noop_edges.add((prev_level, self.last_view.key, self.last_action.key))
            else:
                self.stagnation = 0
                self._learn_motion(self.last_view, view, self.last_action)
            self.movement_model.observe_transition(
                self.last_view.grid,
                view.grid,
                self.last_action,
                outcome,
            )
            if self.last_action.action == 6:
                self.click_board.observe_click(
                    self.last_action,
                    self.last_view.grid,
                    view.grid,
                    prev_level,
                    view.levels_completed,
                    view.state,
                )
            self._sync_movement_fields()
            self._append_event(self.last_view, view, self.last_action, outcome)
        self.last_view = view

    def _record_choice(self, view: FrameView, action: ActionSpec) -> None:
        node = self.nodes.setdefault(view.key, GraphNode(key=view.key))
        node.tried.add(action.key)
        self.last_action = action
        if not action.is_reset():
            self.action_counts[action.action] = self.action_counts.get(action.action, 0) + 1
            self.current_macro.append(action)
            if action.action in {1, 2, 3, 4, 5, 7}:
                self.level_probe_actions.add(action.action)
            if action.action == 6 and action.x is not None and action.y is not None:
                self.clicked_targets.setdefault(view.levels_completed, set()).add((action.x, action.y))

    def _pop_legal(self, available_actions: set[int]) -> ActionSpec | None:
        while self.queue:
            action = self.queue.pop(0)
            if filter_legal_actions([action], available_actions):
                return action
        return None

    def _movement_plan(self, view: FrameView) -> list[ActionSpec]:
        width = max((len(row) for row in view.grid), default=0)
        height = len(view.grid)
        return self.movement_model.plan(width, height, view.available_actions)

    def _click_board_plan(self, view: FrameView) -> list[ActionSpec]:
        return [
            action
            for action in self.click_board.plan(view.grid, view.levels_completed, view.available_actions)
            if not self._is_dangerous(view, action) and (action.x, action.y) not in self.dud_clicks
        ]

    def _candidate_actions(self, view: FrameView) -> list[ActionSpec]:
        actions: list[ActionSpec] = []
        for action in (1, 2, 3, 4, 5, 7):
            spec = ActionSpec(action, reason="systematic probe", source="controller")
            if (
                action in view.available_actions
                and not self._is_dangerous(view, spec)
                and not self._is_noop(view, spec)
            ):
                actions.append(ActionSpec(action, reason="systematic probe", source="controller"))
        if 6 in view.available_actions:
            clicked = self.clicked_targets.setdefault(view.levels_completed, set())
            skipped: list[ActionSpec] = []
            for x, y, label in salient_click_targets(view.grid):
                spec = ActionSpec(6, x=x, y=y, reason=f"click {label}", source="controller")
                if self._is_dangerous(view, spec) or (x, y) in self.dud_clicks:
                    continue
                if (x, y) in clicked:
                    skipped.append(spec)
                else:
                    actions.append(spec)
            if not actions:
                actions.extend(skipped)
        if not actions and view.available_actions:
            simple = sorted(action for action in view.available_actions if action != 6)
            if simple:
                actions.append(ActionSpec(simple[0], reason="fallback legal action", source="controller"))
        return actions

    def _structured_probe(self, view: FrameView) -> ActionSpec | None:
        """Probe each simple action once per level before exploiting.

        This mirrors the stronger live-harness behavior: collect action-effect
        evidence first instead of treating every new position as permission to
        repeat the same first action forever.
        """

        for action in (1, 2, 3, 4, 5, 7):
            spec = ActionSpec(action, reason="level-opening probe", source="probe")
            if (
                action in view.available_actions
                and action not in self.level_probe_actions
                and not self._is_dangerous(view, spec)
                and not self._is_noop(view, spec)
            ):
                return spec
        return None

    def _movement_exploit(self, view: FrameView) -> ActionSpec | None:
        if not self.movement_deltas:
            return None
        if self.current_position is not None:
            self.visited_positions.add(self.current_position)

        ranked: list[tuple[int, ActionSpec]] = []
        for action, delta in self.movement_deltas.items():
            if action not in view.available_actions:
                continue
            spec = ActionSpec(action, reason="movement frontier", source="movement")
            if self._is_dangerous(view, spec) or self._is_noop(view, spec):
                continue
            score = self.action_counts.get(action, 0)
            if self.current_position is not None:
                nxt = (self.current_position[0] + delta[0], self.current_position[1] + delta[1])
                if nxt not in self.visited_positions:
                    score -= 10
            score += self.nodes.get(view.key, GraphNode(view.key)).visits
            ranked.append((score, spec))
        if not ranked:
            return None
        ranked.sort(key=lambda item: (item[0], item[1].action))
        return ranked[0][1]

    def _learn_motion(self, prev: FrameView, view: FrameView, action: ActionSpec) -> None:
        if action.action not in {1, 2, 3, 4}:
            return
        motions = object_motions(prev.grid, view.grid)
        height = len(view.grid)
        motions = [
            motion
            for motion in motions
            if motion[1][1] < height - 2 and motion[2][1] < height - 2
        ]
        if not motions:
            return
        if self.current_position is not None:
            current = [motion for motion in motions if motion[1] == self.current_position]
            if current:
                motions = current
        _sig, old_center, new_center = max(motions, key=lambda item: item[0][3])
        dx = new_center[0] - old_center[0]
        dy = new_center[1] - old_center[1]
        if dx == 0 and dy == 0:
            return
        self.movement_deltas[action.action] = (dx, dy)
        self.current_position = new_center
        self.visited_positions.add(old_center)
        self.visited_positions.add(new_center)

    def _sync_movement_fields(self) -> None:
        self.movement_deltas = dict(self.movement_model.deltas)
        self.current_position = self.movement_model.current_position
        self.visited_positions = set(self.movement_model.visited_positions)

    def _is_dangerous(self, view: FrameView, action: ActionSpec) -> bool:
        return (view.levels_completed, view.key, action.key) in self.dangerous_edges

    def _is_noop(self, view: FrameView, action: ActionSpec) -> bool:
        return (view.levels_completed, view.key, action.key) in self.noop_edges

    def _append_event(
        self,
        prev: FrameView,
        view: FrameView,
        action: ActionSpec,
        outcome: str,
    ) -> None:
        diff = render_diff(prev.grid, view.grid).splitlines()[0]
        self.last_transition_diff = diff
        self.recent_events.append(
            TransitionEvent(
                action=action.to_json(),
                from_level=prev.levels_completed,
                to_level=view.levels_completed,
                from_key=prev.key,
                to_key=view.key,
                outcome=outcome,
                diff=diff,
            )
        )
        self.recent_events = self.recent_events[-24:]
        event = {
            "action": action.to_json(),
            "before": {
                "level": prev.levels_completed,
                "state": prev.state,
                "key": prev.key,
            },
            "after": {
                "level": view.levels_completed,
                "state": view.state,
                "key": view.key,
            },
            "diff": diff,
            "outcome": outcome,
            "score_changed": view.levels_completed > prev.levels_completed,
            "solver": action.source,
            "gemma": {
                "calls": self.model_calls,
                "plans": self.model_plans,
                "used": action.source == "model",
            },
        }
        self.telemetry.write(event)
        self.telemetry.progress(event)

    def _should_ask_gemma(
        self,
        view: FrameView,
        candidates: list[ActionSpec],
        unexplored: list[ActionSpec],
    ) -> bool:
        if not view.grid or not view.available_actions:
            return False
        if view.key in self.model_asked_keys and self.stagnation < 4:
            return False
        simple_available = view.available_actions & {1, 2, 3, 4, 5, 7}
        simple_probed = bool(simple_available) and simple_available <= self.level_probe_actions
        clicked = self.clicked_targets.get(view.levels_completed, set())
        click_probe_ready = 6 not in view.available_actions or len(clicked) >= min(4, len(candidates))
        if simple_probed and click_probe_ready and (self.stagnation >= 1 or not self.movement_deltas):
            return True
        return self.stagnation >= 2 or not unexplored

    def _prompt(self, view: FrameView, candidates: list[ActionSpec]) -> str:
        previous = ""
        if self.last_transition_diff:
            previous = "\nDiff from previous frame:\n" + self.last_transition_diff
        macros = [
            [action.to_json() for action in macro]
            for macro in self.macros[-5:]
            if macro
        ]
        recent = "\n".join(event.prompt_line() for event in self.recent_events[-12:])
        return (
            "Select the next ARC-AGI-3 probe or exploit actions. Return only JSON.\n"
            f"State: {view.state}; levels={view.levels_completed}/{view.win_levels or '?'}; "
            f"available_actions={sorted(view.available_actions)}\n"
            f"Current hypothesis: {self.hypothesis or 'unknown'}\n"
            f"Learned movement deltas: {self.movement_deltas}\n"
            f"Movement model: {self.movement_model.summary()}\n"
            f"Click-board model: {self.click_board.summary()}\n"
            f"No-op edges: {len(self.noop_edges)}; dangerous edges: {len(self.dangerous_edges)}\n"
            f"Dud clicks: {sorted(self.dud_clicks)[:20]}\n"
            f"Solved macros: {macros}\n"
            f"Candidates: {[action.to_json() for action in candidates[:20]]}\n"
            "Recent action outcomes:\n"
            f"{recent or 'none'}\n"
            "Objects:\n"
            f"{summarize_objects(view.grid)}\n"
            f"{previous}\n"
            "Frame:\n"
            f"{render_full(view.grid)}\n"
            'Required JSON: {"mode":"probe|exploit|replay","actions":[{"action":1}],'
            '"hypothesis":"...","confidence":0.0}'
        )
