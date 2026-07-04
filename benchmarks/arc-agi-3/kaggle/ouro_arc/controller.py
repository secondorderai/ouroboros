from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from .actions import ActionSpec, RESET_ACTION, filter_legal_actions, normalize_available_actions
from .click_board import ClickBoardModel
from .click_sequence import ClickSequencePlanner
from .constraint_board import ConstraintBoardPlanner
from .explore import EXPLORE_ACTIONS, ExplorePolicy
from .gemma import GemmaAdvisor
from .movement import MovementModel
from .objects import goal_targets, object_motions, paired_control_targets, salient_click_targets, summarize_objects
from .render import changed_cells, frame_hash, last_grid, object_frame_hash, render_diff, render_full
from .skills import SkillContext, SkillPlan, SkillRegistry
from .telemetry import TelemetryWriter
from .transition_graph import TransitionGraph


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
        skill_registry: SkillRegistry | None = None,
    ) -> None:
        self.advisor = advisor or GemmaAdvisor()
        self.max_queue = max_queue
        self.nodes: dict[str, GraphNode] = {}
        self.queue: list[ActionSpec] = []
        self.queue_source: str | None = None
        self.queue_start_key: str | None = None
        self.queue_abort_on_key_change = False
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
        self.dud_clicks_by_family: dict[tuple[int, str], set[tuple[int, int]]] = {}
        self.dangerous_edges: set[tuple[int, str, tuple[int, int | None, int | None]]] = set()
        self.noop_edges: set[tuple[int, str, tuple[int, int | None, int | None]]] = set()
        self.action_counts: dict[int, int] = {}
        self.model_asked_keys: set[str] = set()
        self.recent_events: list[TransitionEvent] = []
        self.last_transition_diff = ""
        self.movement_model = MovementModel()
        self.click_board = ClickBoardModel()
        self.click_sequence = ClickSequencePlanner()
        self.constraint_board = ConstraintBoardPlanner()
        self.click_board_actions_by_level: dict[int, int] = {}
        self.click_board_level_limit = max(1, int(os.getenv("OURO_ARC_CLICK_BOARD_LEVEL_LIMIT", "96")))
        windows = tuple(
            int(item)
            for item in os.getenv("OURO_ARC_EXPLORE_BURSTS", "8,24,64").split(",")
            if item.strip()
        )
        self.explore_policy = ExplorePolicy(burst_windows=windows or (8, 24, 64))
        self.explore_min_stagnation = max(0, int(os.getenv("OURO_ARC_EXPLORE_MIN_STAGNATION", "6")))
        self.telemetry = telemetry or TelemetryWriter()
        self.model_calls = 0
        self.model_plans = 0
        skills_disabled = os.getenv("OURO_ARC_DISABLE_SKILLS", "0").lower() in {"1", "true", "yes"}
        self.skill_registry = skill_registry or SkillRegistry([] if skills_disabled else None)
        self.last_skill_plans: list[SkillPlan] = []
        self.failed_skills: list[str] = []
        self.last_skill_id: str | None = None
        self.skill_no_progress: dict[tuple[int, str], int] = {}
        self.skill_cooldowns: dict[tuple[int, str], int] = {}
        self.banned_skills: set[tuple[int, str]] = set()
        self.reset_count = 0
        self.consecutive_resets = 0
        self.after_reset = False
        self.macro_replay_disabled = False
        self.action_cycle_counts: dict[tuple[int, str, tuple[int, int | None, int | None]], int] = {}
        self.solver_counts: dict[str, int] = {}
        self.source_demotions: dict[str, int] = {}
        self.family_no_progress: dict[tuple[str, int], int] = {}
        self.source_totals: dict[str, int] = {}
        self.source_no_progress: dict[str, int] = {}
        self.click_source_failures: dict[tuple[int, str, str], int] = {}
        self.click_source_cooldowns: dict[tuple[int, str, str], int] = {}
        self.transition_memory: dict[tuple[str, tuple[int, int | None, int | None]], str] = {}
        self.transition_graph = TransitionGraph()
        self.large_click_replay: ActionSpec | None = None
        self.large_click_replay_remaining = 0
        self.large_click_replay_min_changed = max(
            1,
            int(os.getenv("OURO_ARC_LARGE_CLICK_REPLAY_MIN_CHANGED", "128")),
        )
        self.large_click_replay_limit = max(
            1,
            int(os.getenv("OURO_ARC_LARGE_CLICK_REPLAY_LIMIT", "8")),
        )
        self.paired_control_attempted_levels: set[int] = set()
        self.paired_control_failed_levels: set[int] = set()
        self.paired_control_replay_limit = max(
            1,
            int(os.getenv("OURO_ARC_PAIRED_CONTROL_REPLAY_LIMIT", "7")),
        )
        self.gemma_backoff_count = 0
        self.model_failure_total = 0
        self.max_level_reached = 0
        default_policy = "sparse"
        self.gemma_policy = os.getenv("OURO_ARC_GEMMA_POLICY", default_policy).lower()
        self.gemma_interval = max(1, int(os.getenv("OURO_ARC_GEMMA_INTERVAL", "16")))
        self.max_model_calls = max(0, int(os.getenv("OURO_ARC_GEMMA_MAX_CALLS", "12")))
        self.actions_since_model = self.gemma_interval
        self.consecutive_model_failures = 0
        self.gemma_backoff_remaining = 0
        self.gemma_backoff_actions = max(1, int(os.getenv("OURO_ARC_GEMMA_BACKOFF_ACTIONS", "12")))
        self.gemma_failure_threshold = max(1, int(os.getenv("OURO_ARC_GEMMA_FAILURE_THRESHOLD", "3")))
        self.click_source_failure_threshold = max(
            1,
            int(os.getenv("OURO_ARC_CLICK_SOURCE_FAILURE_THRESHOLD", "8")),
        )
        self.click_source_cooldown_actions = max(
            1,
            int(os.getenv("OURO_ARC_CLICK_SOURCE_COOLDOWN_ACTIONS", "24")),
        )
        self.planner_disabled = os.getenv("OURO_ARC_DISABLE_PLANNER", "0").lower() in {"1", "true", "yes"}
        self.planner_min_nodes = max(1, int(os.getenv("OURO_ARC_PLANNER_MIN_NODES", "6")))
        self.planner_max_depth = max(1, int(os.getenv("OURO_ARC_PLANNER_MAX_DEPTH", "24")))
        self.goal_nav_enabled = os.getenv("OURO_ARC_GOAL_NAV", "0").lower() in {"1", "true", "yes"}

    def choose(self, latest_frame: Any) -> ActionSpec:
        view = self._frame_view(latest_frame)
        self._observe_transition(view)

        if view.state in TERMINAL_STATES:
            return self._reset_action(view, "game already terminal")
        if view.state in RESET_STATES:
            self.queue = []
            self._clear_queue_metadata()
            self.current_macro = []
            self.level_probe_actions = set()
            self.visited_positions = set()
            self.current_position = None
            self._clear_large_click_replay()
            self.paired_control_attempted_levels = set()
            self.movement_model.reset_level()
            self.explore_policy.reset_level()
            if view.state == "GAME_OVER" and self.replaying:
                self.macro_replay_disabled = True
                self.macros = []
            self.replaying = (
                view.state == "GAME_OVER"
                and bool(self.macros)
                and not self.macro_replay_disabled
                and self.consecutive_resets == 0
            )
            return self._reset_action(view, f"state={view.state}")

        if self.after_reset:
            resume_replay = (
                self.replaying
                and view.levels_completed == 0
                and bool(self.macros)
                and not self.macro_replay_disabled
            )
            self.queue = []
            self._clear_queue_metadata()
            self.current_macro = []
            self.replaying = resume_replay
            self.level_probe_actions = set()
            self.after_reset = False

        large_replay = self._large_click_replay_action(view)
        if large_replay:
            self._record_choice(view, large_replay)
            return large_replay

        if self.replaying and not self.queue and view.levels_completed == 0 and not self.macro_replay_disabled:
            for macro in self.macros:
                self._enqueue(macro, view, source="macro-replay")

        queued = self._pop_legal(view)
        if queued:
            self._record_choice(view, queued)
            return queued

        node = self.nodes.setdefault(view.key, GraphNode(key=view.key))
        node.visits += 1
        self._observe_click_sequence_state(view)

        probe = self._structured_probe(view)
        if probe:
            self._record_choice(view, probe)
            return probe

        paired_control = self._paired_control_plan(view)
        if paired_control:
            self._enqueue(paired_control[1 : self.max_queue], view, source="paired-control")
            self._record_choice(view, paired_control[0])
            return paired_control[0]

        planner = self._planner_plan(view)
        if planner:
            self._enqueue(planner[1 : self.max_queue], view, source="planner", abort_on_key_change=True)
            self._record_choice(view, planner[0])
            return planner[0]

        skill_plan = self._skill_plan(view, node)
        if skill_plan:
            skill_candidates = self._skill_candidate_actions()
            if self._should_ask_gemma(view, skill_candidates, skill_candidates) and self._skill_plan_needs_model(skill_plan):
                queued = self._ask_gemma(view, skill_candidates)
                if queued:
                    return queued
            self._enqueue(skill_plan.actions[1 : self.max_queue], view, source=skill_plan.actions[0].source)
            self._record_choice(view, skill_plan.actions[0], skill_id=skill_plan.card.id)
            return skill_plan.actions[0]

        goal_nav = self._goal_nav_plan(view)
        if goal_nav:
            self._record_choice(view, goal_nav[0])
            return goal_nav[0]

        movement = self._movement_plan(view)
        if movement:
            self._enqueue(movement[1 : self.max_queue], view, source="movement-bfs")
            self._record_choice(view, movement[0])
            return movement[0]

        constraint_plan = self._constraint_board_plan(view)
        if constraint_plan:
            self._enqueue(constraint_plan[1 : self.max_queue], view, source="constraint-board")
            self._record_choice(view, constraint_plan[0])
            return constraint_plan[0]

        click_plan = self._click_board_plan(view)
        if click_plan:
            self._enqueue(click_plan[1 : self.max_queue], view, source="click-board")
            self._record_choice(view, click_plan[0])
            return click_plan[0]

        click_sequence = self._click_sequence_plan(view)
        if click_sequence:
            self._enqueue(
                click_sequence[1 : self.max_queue],
                view,
                source="click-sequence",
            )
            self._record_choice(view, click_sequence[0])
            return click_sequence[0]

        candidates = self._candidate_actions(view)
        if not candidates:
            if self._should_ask_gemma(view, candidates, []):
                queued = self._ask_gemma(view, candidates)
                if queued:
                    return queued
            fallback = self._fallback_non_reset(view)
            if fallback:
                self._record_choice(view, fallback)
                return fallback
            explore = self._explore_plan(view)
            if explore:
                self._enqueue(explore[1 : self.max_queue], view, source="explore-repeat", abort_on_key_change=True)
                self._record_choice(view, explore[0])
                return explore[0]
            escape = self._least_bad_non_reset(view)
            if escape:
                self._record_choice(view, escape)
                return escape
            self.replaying = bool(self.macros) and not self.macro_replay_disabled
            return self._reset_action(view, "no legal actions available")
        unexplored = [action for action in candidates if action.key not in node.tried]

        if self._should_ask_gemma(view, candidates, unexplored):
            queued = self._ask_gemma(view, candidates)
            if queued:
                return queued

        explore = self._explore_plan(view)
        if explore and (not unexplored or self.stagnation >= self.explore_min_stagnation):
            self._enqueue(explore[1 : self.max_queue], view, source="explore-repeat", abort_on_key_change=True)
            self._record_choice(view, explore[0])
            return explore[0]

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
        # State identity. Default raw-pixel key preserves existing behavior; the
        # object key (opt-in, highest-risk) is stable across HUD/background churn.
        if os.getenv("OURO_ARC_STATE_KEY", "pixel").lower() == "object":
            key = object_frame_hash(grid)
        else:
            key = frame_hash(grid)
        return FrameView(
            grid=grid,
            state=state,
            levels_completed=levels_completed,
            win_levels=win_levels,
            available_actions=available,
            key=key,
        )

    def _observe_transition(self, view: FrameView) -> None:
        if self.last_action and self.last_view:
            prev_level = self.last_view.levels_completed
            outcome = "changed"
            if view.levels_completed > prev_level:
                outcome = "score increased"
                self._clear_large_click_replay()
                self.paired_control_attempted_levels.discard(view.levels_completed)
                self.max_level_reached = max(self.max_level_reached, view.levels_completed)
                self.consecutive_model_failures = 0
                self.gemma_backoff_remaining = 0
                if not self.replaying and self.current_macro:
                    self.macros.append(self.current_macro[:])
                self.current_macro = []
                self.level = view.levels_completed
                self.level_probe_actions = set()
                self.visited_positions = set()
                self.current_position = None
                self.movement_model.reset_level()
                self.explore_policy.reset_level(view.levels_completed)
                self.click_board_actions_by_level[view.levels_completed] = 0
                if self.replaying and view.levels_completed >= len(self.macros):
                    self.replaying = False
                if not self.replaying:
                    self.queue = []
                    self._clear_queue_metadata()
                self.stagnation = 0
            elif view.state == "GAME_OVER":
                outcome = "game over"
                self._clear_large_click_replay()
                if self.last_action.source == "paired-control":
                    self.paired_control_failed_levels.add(prev_level)
                self.dangerous_edges.add((prev_level, self.last_view.key, self.last_action.key))
                self.macro_replay_disabled = True
                self.queue = []
                self._clear_queue_metadata()
                self.current_macro = []
                if self.last_skill_id:
                    self._record_skill_failure(prev_level, self.last_skill_id, "game over")
            elif view.key == self.last_view.key:
                outcome = "no visible change"
                self.stagnation += 1
                cycle_key = (prev_level, self.last_view.key, self.last_action.key)
                self.action_cycle_counts[cycle_key] = self.action_cycle_counts.get(cycle_key, 0) + 1
                if self.action_cycle_counts[cycle_key] >= 2 and not self.last_action.is_reset():
                    self.noop_edges.add(cycle_key)
                if self.last_skill_id:
                    self._record_skill_failure(prev_level, self.last_skill_id, "no visible change")
                if self.last_action.action == 6 and self.last_action.x is not None and self.last_action.y is not None:
                    self.dud_clicks.add((self.last_action.x, self.last_action.y))
                    self.dud_clicks_by_family.setdefault((prev_level, self.last_view.key), set()).add(
                        (self.last_action.x, self.last_action.y)
                    )
                elif not self.last_action.is_reset():
                    self.noop_edges.add((prev_level, self.last_view.key, self.last_action.key))
            else:
                self.stagnation = 0
                self._learn_motion(self.last_view, view, self.last_action)
                self._learn_frontier_targets(self.last_view, view)
                self._observe_large_click_progress(self.last_view, view, self.last_action)
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
                    frame_family=self.last_view.key,
                )
                self.click_sequence.observe_click(
                    prev_level,
                    self.last_view.key,
                    self.last_action,
                    view.key,
                    outcome,
                )
            self._sync_movement_fields()
            self._observe_policy_outcome(self.last_view, view, self.last_action, outcome)
            self._append_event(self.last_view, view, self.last_action, outcome)
            self.failed_skills = self.failed_skills[-12:]
            self.last_skill_id = None
        self.last_view = view

    def _record_choice(
        self,
        view: FrameView,
        action: ActionSpec,
        skill_id: str | None = None,
    ) -> None:
        node = self.nodes.setdefault(view.key, GraphNode(key=view.key))
        node.tried.add(action.key)
        self.last_action = action
        self.last_skill_id = skill_id
        if action.is_reset():
            self.reset_count += 1
            self.consecutive_resets += 1
            self.after_reset = True
            if self.consecutive_resets >= 2:
                self.macro_replay_disabled = True
                self.replaying = False
                self.queue = []
                self._clear_queue_metadata()
        else:
            self.consecutive_resets = 0
            self._decay_skill_cooldowns()
            self._decay_source_demotions()
            self._decay_click_source_cooldowns()
            self.actions_since_model += 1
            if self.gemma_backoff_remaining > 0:
                self.gemma_backoff_remaining -= 1
                if self.gemma_backoff_remaining == 0:
                    print("[ouro-arc] gemma backoff ended")
            self.action_counts[action.action] = self.action_counts.get(action.action, 0) + 1
            self.current_macro.append(action)
            if action.action in {1, 2, 3, 4, 5, 7}:
                self.level_probe_actions.add(action.action)
            if action.action == 6 and action.x is not None and action.y is not None:
                self.clicked_targets.setdefault(view.levels_completed, set()).add((action.x, action.y))
            if action.source == "click-board":
                level_count = self.click_board_actions_by_level.get(view.levels_completed, 0)
                self.click_board_actions_by_level[view.levels_completed] = level_count + 1
        self.solver_counts[action.source] = self.solver_counts.get(action.source, 0) + 1

    def _enqueue(
        self,
        actions: list[ActionSpec],
        view: FrameView,
        source: str | None = None,
        abort_on_key_change: bool = False,
    ) -> None:
        if not actions:
            return
        self.queue.extend(actions)
        self.queue_source = source or actions[0].source
        self.queue_start_key = view.key
        self.queue_abort_on_key_change = abort_on_key_change

    def _clear_queue_metadata(self) -> None:
        self.queue_source = None
        self.queue_start_key = None
        self.queue_abort_on_key_change = False

    def _clear_large_click_replay(self) -> None:
        self.large_click_replay = None
        self.large_click_replay_remaining = 0

    def _observe_large_click_progress(
        self,
        prev: FrameView,
        view: FrameView,
        action: ActionSpec,
    ) -> None:
        if action.action != 6 or action.x is None or action.y is None:
            self._clear_large_click_replay()
            return
        changed = len(changed_cells(prev.grid, view.grid))
        if changed < self.large_click_replay_min_changed:
            self._clear_large_click_replay()
            return
        self.large_click_replay = ActionSpec(
            action.action,
            x=action.x,
            y=action.y,
            reason=f"repeat large board-changing click ({changed} cells)",
            source=action.source,
        )
        self.large_click_replay_remaining = self.large_click_replay_limit
        self.queue = []
        self._clear_queue_metadata()

    def _large_click_replay_action(self, view: FrameView) -> ActionSpec | None:
        action = self.large_click_replay
        if action is None or self.large_click_replay_remaining <= 0:
            self._clear_large_click_replay()
            return None
        if action.action not in view.available_actions:
            self._clear_large_click_replay()
            return None
        if self._is_dangerous(view, action):
            self._clear_large_click_replay()
            return None
        self.large_click_replay_remaining -= 1
        return action

    def _pop_legal(self, view: FrameView) -> ActionSpec | None:
        if (
            self.queue
            and self.queue_abort_on_key_change
            and self.queue_start_key is not None
            and view.key != self.queue_start_key
        ):
            if self.queue_source:
                self._demote_source(self.queue_source, actions=8)
            self.queue = []
            self._clear_queue_metadata()
        while self.queue:
            action = self.queue.pop(0)
            if self._source_demoted(action.source):
                continue
            if (
                action.source == "click-board"
                and self.click_board_actions_by_level.get(view.levels_completed, 0) >= self.click_board_level_limit
            ):
                continue
            if action.action == 6 and self._click_source_cooled(view, action.source):
                continue
            if self._is_dangerous(view, action) or self._is_noop(view, action):
                continue
            if filter_legal_actions([action], view.available_actions):
                return action
        self._clear_queue_metadata()
        return None

    def _movement_plan(self, view: FrameView) -> list[ActionSpec]:
        if self._source_demoted("movement-bfs"):
            return []
        width = max((len(row) for row in view.grid), default=0)
        height = len(view.grid)
        return self.movement_model.plan(width, height, view.available_actions)

    def _goal_nav_plan(self, view: FrameView) -> list[ActionSpec]:
        """Steer the player toward a detected goal object instead of searching
        the space blindly. Directed navigation is the only thing that beats
        blind-search complexity on movement games (e.g. ls20 reaches its level-0
        goal in ~22 human steps but the blind explorer needs ~300)."""

        if not self.goal_nav_enabled or self._source_demoted("goal-nav"):
            return []
        if self.current_position is None or not self.movement_deltas:
            return []
        cx, cy = self.current_position
        player_color = (
            view.grid[cy][cx]
            if 0 <= cy < len(view.grid) and 0 <= cx < len(view.grid[cy])
            else None
        )
        exclude = frozenset({player_color}) if player_color is not None else frozenset()
        for tx, ty, _color in goal_targets(view.grid, exclude_colors=exclude):
            if (tx, ty) in self.visited_positions:
                continue
            action = self.movement_model.step_toward((tx, ty), view.available_actions)
            if action is None:
                continue
            spec = ActionSpec(action, reason=f"goal-nav ({tx},{ty})", source="goal-nav")
            if self._is_dangerous(view, spec) or self._is_noop(view, spec):
                continue
            return [spec]
        return []

    def _click_board_plan(self, view: FrameView) -> list[ActionSpec]:
        if self._source_demoted("click-board"):
            return []
        if self.click_board_actions_by_level.get(view.levels_completed, 0) >= self.click_board_level_limit:
            return []
        return [
            action
            for action in self.click_board.plan(
                view.grid,
                view.levels_completed,
                view.available_actions,
                frame_family=view.key,
            )
            if (
                not self._is_dangerous(view, action)
                and not self._is_dud_click(view, action.x, action.y)
                and not self._is_cycle_click(view, action)
            )
        ]

    def _constraint_board_plan(self, view: FrameView) -> list[ActionSpec]:
        if self._source_demoted("constraint-board"):
            return []
        return [
            action
            for action in self.constraint_board.plan(
                view.grid,
                view.levels_completed,
                view.available_actions,
            )
            if not self._is_dangerous(view, action) and not self._is_dud_click(view, action.x, action.y)
        ]

    def _paired_control_plan(self, view: FrameView) -> list[ActionSpec]:
        if 6 not in view.available_actions:
            return []
        if view.available_actions - {6}:
            return []
        if view.levels_completed in self.paired_control_attempted_levels:
            return []
        if view.levels_completed in self.paired_control_failed_levels:
            return []

        actions: list[ActionSpec] = []
        for x, y, label in paired_control_targets(view.grid):
            spec = ActionSpec(6, x=x, y=y, reason=f"repeat {label}", source="paired-control")
            if self._is_dangerous(view, spec) or self._is_dud_click(view, x, y):
                continue
            actions.extend(
                ActionSpec(6, x=x, y=y, reason=f"repeat {label}", source="paired-control")
                for _ in range(self.paired_control_replay_limit)
            )
        if len(actions) < self.paired_control_replay_limit * 2:
            return []
        self.paired_control_attempted_levels.add(view.levels_completed)
        return actions[: self.max_queue]

    def _planner_plan(self, view: FrameView) -> list[ActionSpec]:
        """Directed plan over the learned transition graph.

        Exploit first: replay the shortest observed route to a score-increasing
        transition (the efficiency win). Otherwise route to the nearest reachable
        state that still has an untried, safe action. Purely generic — the graph
        is learned at runtime, so this transfers to unseen games where hand-built
        game-specific heuristics do not. Execution safety is enforced by
        ``_pop_legal`` and ``abort_on_key_change`` when the queue is consumed, so
        the planning-time filters here are only a best-effort prune.
        """

        if self.planner_disabled or self._source_demoted("planner"):
            return []
        graph = self.transition_graph
        if len(graph.edges) < self.planner_min_nodes:
            return []

        def is_blocked(action_key: tuple[int, int | None, int | None]) -> bool:
            edge = (view.levels_completed, view.key, action_key)
            return edge in self.dangerous_edges or edge in self.noop_edges

        path = graph.path_to_score(view.key, self.planner_max_depth, is_blocked)
        if not path:
            current_candidates = self._planner_candidate_keys(view)
            # Only ROUTE to a distant frontier when the current state is locally
            # exhausted; if untried local actions remain, defer to the existing
            # solvers so the planner augments exploration instead of monopolizing it.
            if graph.frontier_actions(view.key, current_candidates, is_blocked):
                return []
            simple_candidates = [(action, None, None) for action in EXPLORE_ACTIONS]
            path = graph.path_to_frontier(
                view.key,
                candidate_provider=lambda key: (
                    current_candidates if key == view.key else simple_candidates
                ),
                max_depth=self.planner_max_depth,
                is_blocked=is_blocked,
            )
        if not path:
            return []
        return self._materialize_path(view, path)

    def _planner_candidate_keys(self, view: FrameView) -> list[tuple[int, int | None, int | None]]:
        keys: list[tuple[int, int | None, int | None]] = []
        seen: set[tuple[int, int | None, int | None]] = set()
        for spec in self._candidate_actions(view):
            if spec.key not in seen:
                seen.add(spec.key)
                keys.append(spec.key)
        return keys

    def _materialize_path(
        self,
        view: FrameView,
        path: list[tuple[int, int | None, int | None]],
    ) -> list[ActionSpec]:
        specs = [
            ActionSpec(action, x=x, y=y, reason="planner path", source="planner")
            for action, x, y in path
        ]
        if not specs:
            return []
        first = specs[0]
        if not filter_legal_actions([first], view.available_actions):
            return []
        if (
            self._is_dangerous(view, first)
            or self._is_noop(view, first)
            or self._is_dud_click(view, first.x, first.y)
        ):
            return []
        return specs

    def _click_sequence_plan(self, view: FrameView) -> list[ActionSpec]:
        if self._source_demoted("click-sequence") and not self._click_source_cooled(view, "controller"):
            return []
        plan = self.click_sequence.plan(
            view.levels_completed,
            view.key,
            view.available_actions,
            self._click_candidate_points(view),
            force_frontier=self._click_sequence_force_frontier(view),
        )
        return [
            action
            for action in plan
            if not self._is_dangerous(view, action) and not self._is_dud_click(view, action.x, action.y)
        ]

    def _observe_click_sequence_state(self, view: FrameView) -> None:
        if 6 in view.available_actions:
            self.click_sequence.observe_state(
                view.levels_completed,
                view.key,
                self._click_candidate_points(view),
            )

    def _explore_plan(self, view: FrameView) -> list[ActionSpec]:
        early_enabled = os.getenv("OURO_ARC_EXPLORE_EARLY", "0").lower() in {"1", "true", "yes"}
        if not early_enabled and self.stagnation < self.explore_min_stagnation:
            return []
        return self.explore_policy.plan(
            level=view.levels_completed,
            frame_key=view.key,
            available_actions=view.available_actions,
            probed_actions=self.level_probe_actions,
            dangerous=self.dangerous_edges,
            noop=self.noop_edges,
            demoted_sources=set(self.source_demotions),
        )

    def _skill_plan(self, view: FrameView, node: GraphNode) -> SkillPlan | None:
        context = SkillContext(
            grid=view.grid,
            level=view.levels_completed,
            available_actions=view.available_actions,
            movement_model=self.movement_model,
            click_board=self.click_board,
            node_tried=node.tried,
            dud_clicks=self.dud_clicks_by_family.get((view.levels_completed, view.key), set()),
            dangerous_edges=self.dangerous_edges,
            noop_edges=self.noop_edges,
            state_key=view.key,
            clicked_targets=self.clicked_targets.get(view.levels_completed, set()),
            stagnation=self.stagnation,
            cooled_skills=self._cooled_skill_ids(view.levels_completed),
            banned_skills=self._banned_skill_ids(view.levels_completed),
        )
        plans = self.skill_registry.ranked_plans(context)
        plans = [plan for plan in plans if not self._source_demoted(plan.actions[0].source)]
        self.last_skill_plans = plans
        return plans[0] if plans else None

    def _skill_plan_needs_model(self, plan: SkillPlan) -> bool:
        if self.stagnation >= 2:
            return True
        if plan.score < 0:
            return True
        return any(item.startswith(f"{plan.card.id}:") for item in self.failed_skills[-6:])

    def _skill_candidate_actions(self) -> list[ActionSpec]:
        actions: list[ActionSpec] = []
        seen: set[tuple[int, int | None, int | None]] = set()
        for plan in self.last_skill_plans:
            for action in plan.actions[:4]:
                if action.key in seen:
                    continue
                seen.add(action.key)
                actions.append(action)
        return actions

    def _ask_gemma(self, view: FrameView, candidates: list[ActionSpec]) -> ActionSpec | None:
        if self.max_model_calls and self.model_calls >= self.max_model_calls:
            return None
        if self.gemma_backoff_remaining > 0:
            return None
        if bool(getattr(self.advisor, "disabled", False)):
            return None
        self.model_asked_keys.add(view.key)
        self.model_calls += 1
        self.actions_since_model = 0
        try:
            plan = self.advisor.advise(self._prompt(view, candidates), view.available_actions)
        except Exception as exc:
            # An advisor exception must never propagate: it would abort the
            # whole run and zero every game (Kaggle submissions V7/V8).
            print(f"[ouro-arc] gemma advise raised, treating as failure: {exc!r}")
            self._record_model_failure()
            return None
        if not plan:
            self._record_model_failure()
            return None
        self.model_plans += 1
        self.consecutive_model_failures = 0
        self.gemma_backoff_remaining = 0
        self.hypothesis = plan.hypothesis or self.hypothesis
        self._enqueue(plan.actions[: self.max_queue], view, source="model")
        queued = self._pop_legal(view)
        if queued:
            self._record_choice(view, queued)
            return queued
        self._record_model_failure()
        return None

    def _record_model_failure(self) -> None:
        self.model_failure_total += 1
        self.consecutive_model_failures += 1
        if self.consecutive_model_failures >= self.gemma_failure_threshold:
            self.gemma_backoff_remaining = self.gemma_backoff_actions
            self.consecutive_model_failures = 0
            self.gemma_backoff_count += 1
            print(
                "[ouro-arc] gemma backoff started "
                f"actions={self.gemma_backoff_remaining}"
            )

    def _reset_action(self, view: FrameView, reason: str) -> ActionSpec:
        action = ActionSpec(RESET_ACTION, reason=reason, source="controller")
        self._record_choice(view, action)
        return action

    def _fallback_non_reset(self, view: FrameView) -> ActionSpec | None:
        for action in sorted(a for a in view.available_actions if a != RESET_ACTION):
            spec = ActionSpec(action, reason="fallback legal action", source="controller")
            if action == 6:
                continue
            if not self._source_demoted(spec.source) and not self._is_dangerous(view, spec) and not self._is_noop(view, spec):
                return spec
        if 6 in view.available_actions:
            if self._click_source_cooled(view, "controller"):
                return None
            clicked = self.clicked_targets.setdefault(view.levels_completed, set())
            sweep = [
                (x, y)
                for y in (7, 15, 23, 31, 39, 47, 55)
                for x in (7, 15, 23, 31, 39, 47, 55)
            ]
            for x, y in sweep:
                spec = ActionSpec(6, x=x, y=y, reason="fallback click sweep", source="controller")
                if (
                    (x, y) not in clicked
                    and not self._is_dud_click(view, x, y)
                    and not self._is_dangerous(view, spec)
                    and not self._is_cycle_click(view, spec)
                ):
                    return spec
        return None

    def _least_bad_non_reset(self, view: FrameView) -> ActionSpec | None:
        simple = sorted(action for action in view.available_actions if action not in {RESET_ACTION, 6})
        if simple:
            return ActionSpec(simple[0], reason="escape exhausted policy", source="escape")
        if 6 in view.available_actions:
            count = self.action_counts.get(6, 0)
            for offset in range(64):
                x = ((count + offset) * 17 + 11) % 64
                y = ((count + offset) * 29 + 13) % 64
                spec = ActionSpec(6, x=x, y=y, reason="escape click rescan", source="escape")
                if (
                    not self._is_dud_click(view, x, y)
                    and not self._is_dangerous(view, spec)
                    and not self._is_cycle_click(view, spec)
                ):
                    return spec
        return None

    def _record_skill_failure(self, level: int, skill_id: str, outcome: str) -> None:
        self.failed_skills.append(f"{skill_id}:{outcome}")
        key = (level, skill_id)
        if outcome == "game over":
            if skill_id in {"salient-click-probe", "click-board-toggle"}:
                self.skill_cooldowns[key] = max(self.skill_cooldowns.get(key, 0), 12)
                return
            self.banned_skills.add(key)
            return
        self.skill_no_progress[key] = self.skill_no_progress.get(key, 0) + 1
        if self.skill_no_progress[key] >= 3:
            self.skill_cooldowns[key] = 24
            self.skill_no_progress[key] = 0

    def _decay_skill_cooldowns(self) -> None:
        expired: list[tuple[int, str]] = []
        for key, remaining in self.skill_cooldowns.items():
            remaining -= 1
            if remaining <= 0:
                expired.append(key)
            else:
                self.skill_cooldowns[key] = remaining
        for key in expired:
            self.skill_cooldowns.pop(key, None)

    def _cooled_skill_ids(self, level: int) -> set[str]:
        return {skill_id for skill_level, skill_id in self.skill_cooldowns if skill_level == level}

    def _banned_skill_ids(self, level: int) -> set[str]:
        return {skill_id for skill_level, skill_id in self.banned_skills if skill_level == level}

    def _candidate_actions(self, view: FrameView) -> list[ActionSpec]:
        actions: list[ActionSpec] = []
        for action in (1, 2, 3, 4, 5, 7):
            spec = ActionSpec(action, reason="systematic probe", source="controller")
            if (
                action in view.available_actions
                and not self._source_demoted(spec.source)
                and not self._is_dangerous(view, spec)
                and not self._is_noop(view, spec)
            ):
                actions.append(ActionSpec(action, reason="systematic probe", source="controller"))
        if 6 in view.available_actions:
            controller_click_blocked = self._click_source_cooled(view, "controller")
            clicked = self.clicked_targets.setdefault(view.levels_completed, set())
            skipped: list[ActionSpec] = []
            for x, y, label in salient_click_targets(view.grid):
                spec = ActionSpec(6, x=x, y=y, reason=f"click {label}", source="controller")
                if (
                    controller_click_blocked
                    or
                    self._source_demoted(spec.source)
                    or self._is_dangerous(view, spec)
                    or self._is_dud_click(view, x, y)
                    or self._is_cycle_click(view, spec)
                ):
                    continue
                if (x, y) in clicked:
                    skipped.append(spec)
                    continue
                actions.append(spec)
            if not actions:
                actions.extend(skipped)
        if not actions and view.available_actions:
            simple = sorted(action for action in view.available_actions if action != 6)
            if simple:
                actions.append(ActionSpec(simple[0], reason="fallback legal action", source="controller"))
        return actions

    def _click_candidate_points(self, view: FrameView) -> list[tuple[int, int]]:
        if 6 not in view.available_actions:
            return []
        points: list[tuple[int, int]] = []
        seen: set[tuple[int, int]] = set()
        for x, y, _label in salient_click_targets(view.grid, limit=16):
            point = (x, y)
            if point not in seen:
                points.append(point)
                seen.add(point)
        for target in self.click_board.detect_targets(view.grid, limit=32):
            point = (target.x, target.y)
            if point not in seen:
                points.append(point)
                seen.add(point)
        return points

    def _structured_probe(self, view: FrameView) -> ActionSpec | None:
        """Probe each simple action once per level before exploiting.

        This mirrors the stronger live-harness behavior: collect action-effect
        evidence first instead of treating every new position as permission to
        repeat the same first action forever.
        """

        for action in EXPLORE_ACTIONS:
            spec = ActionSpec(action, reason="level-opening probe", source="probe")
            if (
                action in view.available_actions
                and action not in self.level_probe_actions
                and not self._source_demoted(spec.source)
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

    def _learn_frontier_targets(self, prev: FrameView, view: FrameView) -> None:
        for x, y, _old, _new in changed_cells(prev.grid, view.grid)[:24]:
            self.movement_model.frontier_targets.add((x, y))

    def _sync_movement_fields(self) -> None:
        self.movement_deltas = dict(self.movement_model.deltas)
        self.current_position = self.movement_model.current_position
        self.visited_positions = set(self.movement_model.visited_positions)

    def _is_dangerous(self, view: FrameView, action: ActionSpec) -> bool:
        return (view.levels_completed, view.key, action.key) in self.dangerous_edges

    def _is_noop(self, view: FrameView, action: ActionSpec) -> bool:
        return (view.levels_completed, view.key, action.key) in self.noop_edges

    def _is_dud_click(self, view: FrameView, x: int | None, y: int | None) -> bool:
        if x is None or y is None:
            return False
        return (x, y) in self.dud_clicks_by_family.get((view.levels_completed, view.key), set())

    def _is_cycle_click(self, view: FrameView, action: ActionSpec) -> bool:
        if action.action != 6 or action.x is None or action.y is None:
            return False
        point = (action.x, action.y)
        return (
            point in self.click_sequence.cycle_points(view.levels_completed, view.key)
            or point in self.click_sequence.repeated_points(view.levels_completed, view.key)
        )

    def _click_source_key(self, view: FrameView, source: str) -> tuple[int, str, str]:
        return (view.levels_completed, view.key, source)

    def _click_source_cooled(self, view: FrameView, source: str) -> bool:
        return self.click_source_cooldowns.get(self._click_source_key(view, source), 0) > 0

    def _click_sequence_force_frontier(self, view: FrameView) -> bool:
        if not self.click_sequence.has_safe_edges(view.levels_completed):
            return False
        return self._click_source_cooled(view, "controller")

    def _source_demoted(self, source: str) -> bool:
        return self.source_demotions.get(source, 0) > 0

    def _demote_source(self, source: str, actions: int = 32) -> None:
        if source in {
            "probe",
            "model",
            "controller",
            "click-board",
            "skill-salient-click",
            "escape",
        }:
            return
        self.source_demotions[source] = max(self.source_demotions.get(source, 0), actions)

    def _decay_source_demotions(self) -> None:
        expired: list[str] = []
        for source, remaining in self.source_demotions.items():
            remaining -= 1
            if remaining <= 0:
                expired.append(source)
            else:
                self.source_demotions[source] = remaining
        for source in expired:
            self.source_demotions.pop(source, None)

    def _decay_click_source_cooldowns(self) -> None:
        expired: list[tuple[int, str, str]] = []
        for key, remaining in self.click_source_cooldowns.items():
            remaining -= 1
            if remaining <= 0:
                expired.append(key)
            else:
                self.click_source_cooldowns[key] = remaining
        for key in expired:
            self.click_source_cooldowns.pop(key, None)

    def _record_click_source_outcome(
        self,
        prev: FrameView,
        view: FrameView,
        action: ActionSpec,
        outcome: str,
        novelty: bool,
    ) -> None:
        if action.action != 6 or action.source != "controller":
            return
        key = self._click_source_key(prev, action.source)
        if outcome == "score increased":
            for existing in list(self.click_source_failures):
                if existing[0] == prev.levels_completed:
                    self.click_source_failures.pop(existing, None)
            for existing in list(self.click_source_cooldowns):
                if existing[0] == prev.levels_completed:
                    self.click_source_cooldowns.pop(existing, None)
            return
        no_progress = outcome in {"no visible change", "game over"} or (
            outcome == "changed" and not novelty
        )
        if not no_progress:
            self.click_source_failures[key] = 0
            return
        failures = self.click_source_failures.get(key, 0) + 1
        self.click_source_failures[key] = failures
        if failures >= self.click_source_failure_threshold:
            self.click_source_cooldowns[key] = max(
                self.click_source_cooldowns.get(key, 0),
                self.click_source_cooldown_actions,
            )
            self.click_source_failures[key] = 0

    def _observe_policy_outcome(
        self,
        prev: FrameView,
        view: FrameView,
        action: ActionSpec,
        outcome: str,
    ) -> None:
        self.transition_memory[(prev.key, action.key)] = outcome
        self.transition_graph.observe(
            from_key=prev.key,
            action_key=action.key,
            to_key=prev.key if outcome == "no visible change" else view.key,
            outcome=outcome,
            level=prev.levels_completed,
        )
        if action.source == "explore-repeat" and outcome in {"no visible change", "game over"}:
            self.explore_policy.ban(prev.levels_completed, prev.key, action.action)

        self.source_totals[action.source] = self.source_totals.get(action.source, 0) + 1
        if outcome in {"no visible change", "game over"}:
            self.source_no_progress[action.source] = self.source_no_progress.get(action.source, 0) + 1

        novelty = view.key not in self.nodes
        self._record_click_source_outcome(prev, view, action, outcome, novelty)
        family = (action.source, action.action)
        if outcome == "score increased" or novelty:
            self.family_no_progress[family] = 0
            return
        self.family_no_progress[family] = self.family_no_progress.get(family, 0) + 1
        total = self.source_totals.get(action.source, 1)
        no_progress = self.source_no_progress.get(action.source, 0)
        if self.family_no_progress[family] >= 12 or (total >= 12 and no_progress / total >= 0.75):
            self._demote_source(action.source)
            self.queue = []
            self._clear_queue_metadata()

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
                "policy": self.gemma_policy,
                "max_calls": self.max_model_calls,
                "interval": self.gemma_interval,
                "failed_calls": self.consecutive_model_failures,
                "backoff_remaining": self.gemma_backoff_remaining,
                "backoff_count": self.gemma_backoff_count,
            },
            "model": self._model_summary(),
            "controller": {
                "reset_count": self.reset_count,
                "consecutive_resets": self.consecutive_resets,
                "macro_replay_disabled": self.macro_replay_disabled,
                "cooled_skills": sorted(self._cooled_skill_ids(view.levels_completed)),
                "banned_skills": sorted(self._banned_skill_ids(view.levels_completed)),
                "demoted_sources": dict(sorted(self.source_demotions.items())),
                "click_source_cooldowns": {
                    f"{level}:{frame_key[:8]}:{source}": remaining
                    for (level, frame_key, source), remaining in sorted(self.click_source_cooldowns.items())
                },
                "click_sequence": self.click_sequence.summary(),
            },
        }
        if os.getenv("OURO_ARC_TRACE_FRAMES", "0").lower() in {"1", "true", "yes"}:
            event["frames"] = {
                "before": prev.grid,
                "after": view.grid,
                "before_render": render_full(prev.grid),
                "after_render": render_full(view.grid),
            }
        game_id = os.getenv("OURO_ARC_GAME_ID")
        if game_id:
            event["game_id"] = game_id
        self.telemetry.write(event)
        self.telemetry.progress(event)

    def _model_summary(self) -> dict[str, Any]:
        path = None
        try:
            resolved = self.advisor.resolve_model_path()
            path = str(resolved) if resolved else None
        except Exception:
            path = None
        return {
            "path": path,
            "loaded": bool(getattr(self.advisor, "model", None) is not None),
        }

    def write_summary(self, print_summary: bool = False) -> None:
        self.telemetry.write_summary(
            {
                "action_count": sum(self.solver_counts.values()),
                "max_level_reached": self.max_level_reached,
                "final_state": self.last_view.state if self.last_view else "?",
                "reset_count": self.reset_count,
                "gemma_calls": self.model_calls,
                "gemma_plans": self.model_plans,
                "gemma_failures": self.model_failure_total,
                "gemma_backoff_count": self.gemma_backoff_count,
                "model_path_found": self._model_summary()["path"],
                "gemma_loaded": self._model_summary()["loaded"],
                "solver_counts": self.solver_counts,
            },
            print_summary=print_summary,
        )

    def _should_ask_gemma(
        self,
        view: FrameView,
        candidates: list[ActionSpec],
        unexplored: list[ActionSpec],
    ) -> bool:
        if not view.grid or not view.available_actions:
            return False
        if self.gemma_policy in {"off", "none", "disabled"}:
            return False
        if self.max_model_calls and self.model_calls >= self.max_model_calls:
            return False
        if self.gemma_backoff_remaining > 0:
            return False
        simple_available = view.available_actions & {1, 2, 3, 4, 5, 7}
        simple_probed = bool(simple_available) and simple_available <= self.level_probe_actions
        clicked = self.clicked_targets.get(view.levels_completed, set())
        click_probe_ready = 6 not in view.available_actions or len(clicked) >= min(4, len(candidates))

        if self.gemma_policy in {"every", "always"}:
            return simple_probed or not simple_available

        if self.gemma_policy in {"active", "aggressive"}:
            if view.key not in self.model_asked_keys and (simple_probed or not simple_available):
                return True
            if self.last_skill_plans and len(self.last_skill_plans) > 1:
                top = self.last_skill_plans[0].score
                second = self.last_skill_plans[1].score
                if top - second <= 8:
                    return True
            if self.actions_since_model >= self.gemma_interval and (simple_probed or self.stagnation):
                return True
            if simple_probed and click_probe_ready and (self.stagnation >= 1 or not self.movement_deltas):
                return True
            return self.stagnation >= 2 or not unexplored

        if view.key in self.model_asked_keys and self.stagnation < 4:
            return False
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
        skill_candidates = "\n".join(plan.prompt_line() for plan in self.last_skill_plans[:5])
        return (
            "Select the next ARC-AGI-3 probe or exploit actions. Return only JSON.\n"
            f"State: {view.state}; levels={view.levels_completed}/{view.win_levels or '?'}; "
            f"available_actions={sorted(view.available_actions)}\n"
            f"Current hypothesis: {self.hypothesis or 'unknown'}\n"
            f"Learned movement deltas: {self.movement_deltas}\n"
            f"Movement model: {self.movement_model.summary()}\n"
            f"Click-board model: {self.click_board.summary()}\n"
            f"Click-sequence model: {self.click_sequence.summary()}\n"
            f"No-op edges: {len(self.noop_edges)}; dangerous edges: {len(self.dangerous_edges)}\n"
            f"Dud clicks: {sorted(self.dud_clicks_by_family.get((view.levels_completed, view.key), set()))[:20]}\n"
            f"Solved macros: {macros}\n"
            f"Distilled skill candidates:\n{skill_candidates or 'none'}\n"
            f"Recent failed skills: {self.failed_skills[-8:]}\n"
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
