from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Callable, Iterable


ActionKey = tuple[int, int | None, int | None]
Outcome = str


def _sort_key(action_key: ActionKey) -> tuple[int, int, int]:
    """None-safe ordering for action keys.

    Action keys mix simple actions ``(a, None, None)`` and clicks ``(6, x, y)``.
    Plain ``sorted`` would compare ``None`` with ``int`` and raise, so map the
    optional coordinates onto ``-1`` for a total order that is still deterministic.
    """

    action, x, y = action_key
    return (action, x if x is not None else -1, y if y is not None else -1)


@dataclass
class Edge:
    action_key: ActionKey
    to_key: str | None
    outcome: Outcome
    level: int
    visits: int = 1


class TransitionGraph:
    """Per-game directed graph of observed transitions.

    Nodes are frame-state keys; edges are ``(state_key, action_key) -> next_state``
    annotated with the observed outcome. This consumes the transition tuples the
    controller already produces (previously written to the dead ``transition_memory``
    map and read nowhere) so the planner can search for directed paths instead of
    re-deriving them by blind exploration.
    """

    def __init__(self) -> None:
        self.edges: dict[str, dict[ActionKey, Edge]] = {}
        self.score_edges: set[tuple[str, ActionKey]] = set()

    def observe(
        self,
        from_key: str,
        action_key: ActionKey,
        to_key: str | None,
        outcome: Outcome,
        level: int,
    ) -> None:
        adjacency = self.edges.setdefault(from_key, {})
        edge = adjacency.get(action_key)
        if edge is None:
            adjacency[action_key] = Edge(action_key, to_key, outcome, level)
        else:
            edge.visits += 1
            edge.outcome = outcome
            if to_key is not None:
                edge.to_key = to_key
        if outcome == "score increased":
            self.score_edges.add((from_key, action_key))

    def neighbors(self, key: str) -> dict[ActionKey, Edge]:
        return self.edges.get(key, {})

    def known_score_edges(self) -> set[tuple[str, ActionKey]]:
        return set(self.score_edges)

    def frontier_actions(
        self,
        key: str,
        candidate_keys: Iterable[ActionKey],
        is_blocked: Callable[[ActionKey], bool],
    ) -> list[ActionKey]:
        tried = set(self.edges.get(key, {}))
        return [
            action_key
            for action_key in candidate_keys
            if action_key not in tried and not is_blocked(action_key)
        ]

    def path_to_score(
        self,
        start_key: str,
        max_depth: int,
        is_blocked: Callable[[ActionKey], bool],
    ) -> list[ActionKey] | None:
        """Shortest observed action path from ``start_key`` ending on a score edge."""

        queue: deque[tuple[str, list[ActionKey]]] = deque([(start_key, [])])
        seen = {start_key}
        while queue:
            key, path = queue.popleft()
            if len(path) >= max_depth:
                continue
            for action_key in sorted(self.edges.get(key, {}), key=_sort_key):
                if is_blocked(action_key):
                    continue
                new_path = [*path, action_key]
                if (key, action_key) in self.score_edges:
                    return new_path
                to_key = self.edges[key][action_key].to_key
                if to_key is None or to_key in seen:
                    continue
                seen.add(to_key)
                queue.append((to_key, new_path))
        return None

    def path_to_frontier(
        self,
        start_key: str,
        candidate_provider: Callable[[str], Iterable[ActionKey]],
        max_depth: int,
        is_blocked: Callable[[ActionKey], bool],
    ) -> list[ActionKey] | None:
        """Shortest path to a state that still has an untried, unblocked action.

        The returned path ends with the frontier action itself, so executing it
        both travels to the frontier state and probes the new action.
        """

        queue: deque[tuple[str, list[ActionKey]]] = deque([(start_key, [])])
        seen = {start_key}
        while queue:
            key, path = queue.popleft()
            if len(path) >= max_depth:
                continue
            frontier = self.frontier_actions(key, candidate_provider(key), is_blocked)
            if frontier:
                return [*path, sorted(frontier, key=_sort_key)[0]]
            for action_key in sorted(self.edges.get(key, {}), key=_sort_key):
                if is_blocked(action_key):
                    continue
                to_key = self.edges[key][action_key].to_key
                if to_key is None or to_key in seen:
                    continue
                seen.add(to_key)
                queue.append((to_key, [*path, action_key]))
        return None
