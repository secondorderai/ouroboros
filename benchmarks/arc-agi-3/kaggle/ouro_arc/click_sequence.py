from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from .actions import ActionSpec


Point = tuple[int, int]
StateId = tuple[int, str]


@dataclass(frozen=True)
class ClickEdge:
    level: int
    from_key: str
    point: Point
    to_key: str
    outcome: str
    count: int = 1

    @property
    def is_safe_transition(self) -> bool:
        return self.outcome in {"changed", "score increased"} and self.to_key != self.from_key


@dataclass
class ClickSequencePlanner:
    """State graph for toggle-style click games.

    The planner does not guess hidden mechanics. It only reuses observed click
    transitions to navigate from the current frame key to another known frame
    key that still has untried click frontiers.
    """

    max_path: int = 6
    edges: dict[tuple[int, str, Point], ClickEdge] = field(default_factory=dict)
    outgoing: dict[StateId, list[ClickEdge]] = field(default_factory=dict)
    tried_by_state: dict[StateId, set[Point]] = field(default_factory=dict)
    candidates_by_state: dict[StateId, list[Point]] = field(default_factory=dict)
    recent_states: dict[int, list[str]] = field(default_factory=dict)
    cycle_cooldowns: dict[StateId, int] = field(default_factory=dict)

    def observe_state(self, level: int, state_key: str, candidates: list[Point]) -> None:
        state = (level, state_key)
        existing = self.candidates_by_state.setdefault(state, [])
        seen = set(existing)
        for point in candidates:
            if point not in seen:
                existing.append(point)
                seen.add(point)
        recent = self.recent_states.setdefault(level, [])
        if not recent or recent[-1] != state_key:
            recent.append(state_key)
        del recent[:-12]
        self._decay_cooldowns()

    def observe_click(
        self,
        level: int,
        from_key: str,
        action: ActionSpec,
        to_key: str,
        outcome: str,
    ) -> None:
        if action.action != 6 or action.x is None or action.y is None:
            return
        point = (action.x, action.y)
        state = (level, from_key)
        self.tried_by_state.setdefault(state, set()).add(point)
        edge_key = (level, from_key, point)
        old = self.edges.get(edge_key)
        edge = ClickEdge(
            level=level,
            from_key=from_key,
            point=point,
            to_key=to_key,
            outcome=outcome,
            count=(old.count + 1) if old else 1,
        )
        self.edges[edge_key] = edge
        edges = self.outgoing.setdefault(state, [])
        for index, existing in enumerate(edges):
            if existing.point == point:
                edges[index] = edge
                break
        else:
            edges.append(edge)
        if outcome == "game over":
            self.cycle_cooldowns[state] = max(self.cycle_cooldowns.get(state, 0), 24)

    def plan(
        self,
        level: int,
        state_key: str,
        available_actions: set[int],
        candidates: list[Point],
        force_frontier: bool = False,
    ) -> list[ActionSpec]:
        if 6 not in available_actions:
            return []
        self.observe_state(level, state_key, candidates)
        state = (level, state_key)
        if self.cycle_cooldowns.get(state, 0) > 0:
            return []

        current_frontier = self._untried_points(state, candidates)
        in_cycle = self._in_recent_cycle(level, state_key)
        if current_frontier:
            if not in_cycle and not force_frontier:
                return []
            point = current_frontier[0]
            return [
                ActionSpec(
                    6,
                    x=point[0],
                    y=point[1],
                    reason="click-sequence frontier from observed graph",
                    source="click-sequence",
                )
            ]

        path = self._path_to_frontier(level, state_key)
        if not path:
            return []

        actions = [
            ActionSpec(
                6,
                x=edge.point[0],
                y=edge.point[1],
                reason="click-sequence navigate toggle state",
                source="click-sequence",
            )
            for edge in path[:-1]
        ]
        target_edge = path[-1]
        actions.append(
            ActionSpec(
                6,
                x=target_edge.point[0],
                y=target_edge.point[1],
                reason="click-sequence frontier click",
                source="click-sequence",
            )
        )
        return actions

    def summary(self) -> str:
        safe = sum(1 for edge in self.edges.values() if edge.is_safe_transition)
        cycle_edges = sum(
            1
            for level, state_key in self.outgoing
            for _point in self.cycle_points(level, state_key)
        )
        return f"states={len(self.candidates_by_state)} edges={len(self.edges)} safe={safe} cycle_edges={cycle_edges}"

    def has_safe_edges(self, level: int) -> bool:
        return any(edge.level == level and edge.is_safe_transition for edge in self.edges.values())

    def cycle_points(self, level: int, state_key: str) -> set[Point]:
        """Return observed click points that are currently bouncing in a cycle.

        These points are not globally unsafe. They are only poor default choices
        for generic click sweeps while a frame family is already alternating
        between known toggle states.
        """

        recent = self.recent_states.get(level, [])
        if len(recent) < 4:
            return set()
        points: set[Point] = set()
        for edge in self.outgoing.get((level, state_key), []):
            if not edge.is_safe_transition:
                continue
            if self._cycle_triplets(recent, state_key, edge.to_key) >= 2:
                points.add(edge.point)
        return points

    def repeated_points(self, level: int, state_key: str, min_count: int = 2) -> set[Point]:
        return {
            edge.point
            for edge in self.outgoing.get((level, state_key), [])
            if edge.is_safe_transition and edge.count >= min_count
        }

    def _path_to_frontier(self, level: int, state_key: str) -> list[ClickEdge]:
        start = (level, state_key)
        queue: deque[tuple[StateId, list[ClickEdge]]] = deque([(start, [])])
        seen: set[StateId] = {start}
        while queue:
            state, path = queue.popleft()
            if len(path) > self.max_path:
                continue
            frontier = self._untried_points(state, self.candidates_by_state.get(state, []))
            if frontier and path:
                point = frontier[0]
                return [
                    *path,
                    ClickEdge(state[0], state[1], point, state[1], "frontier"),
                ]
            for edge in self.outgoing.get(state, []):
                if not edge.is_safe_transition:
                    continue
                next_state = (edge.level, edge.to_key)
                if next_state in seen or self.cycle_cooldowns.get(next_state, 0) > 0:
                    continue
                seen.add(next_state)
                queue.append((next_state, [*path, edge]))
        return []

    def _untried_points(self, state: StateId, candidates: list[Point]) -> list[Point]:
        tried = self.tried_by_state.get(state, set())
        return [point for point in candidates if point not in tried]

    def _in_recent_cycle(self, level: int, state_key: str) -> bool:
        recent = self.recent_states.get(level, [])
        if len(recent) < 4 or recent[-1] != state_key:
            return False
        return recent.count(state_key) >= 3 or recent[-4:-2] == recent[-2:]

    def _cycle_triplets(self, recent: list[str], from_key: str, to_key: str) -> int:
        count = 0
        for index in range(len(recent) - 2):
            if recent[index : index + 3] == [from_key, to_key, from_key]:
                count += 1
        return count

    def _decay_cooldowns(self) -> None:
        expired: list[StateId] = []
        for state, remaining in self.cycle_cooldowns.items():
            remaining -= 1
            if remaining <= 0:
                expired.append(state)
            else:
                self.cycle_cooldowns[state] = remaining
        for state in expired:
            self.cycle_cooldowns.pop(state, None)
