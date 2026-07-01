from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from .actions import ActionSpec
from .objects import object_motions


Position = tuple[int, int]
Delta = tuple[int, int]


@dataclass
class MovementModel:
    deltas: dict[int, Delta] = field(default_factory=dict)
    current_position: Position | None = None
    visited_positions: set[Position] = field(default_factory=set)
    blocked_edges: set[tuple[Position, int]] = field(default_factory=set)
    death_edges: set[tuple[Position, int]] = field(default_factory=set)
    candidate_scores: dict[tuple[tuple[int, int, int, int], int, Delta], int] = field(default_factory=dict)
    frontier_targets: set[Position] = field(default_factory=set)

    def observe_transition(
        self,
        prev_grid: list[list[int]],
        next_grid: list[list[int]],
        action: ActionSpec,
        outcome: str,
    ) -> None:
        if action.action not in {1, 2, 3, 4}:
            return
        if outcome == "no visible change" and self.current_position is not None:
            self.blocked_edges.add((self.current_position, action.action))
            return
        if outcome == "game over" and self.current_position is not None:
            self.death_edges.add((self.current_position, action.action))
            return

        motions = object_motions(prev_grid, next_grid)
        height = len(next_grid)
        motions = [
            motion
            for motion in motions
            if motion[1][1] < height - 2 and motion[2][1] < height - 2
        ]
        if not motions:
            if self.current_position is not None:
                self.blocked_edges.add((self.current_position, action.action))
            return
        if self.current_position is not None:
            current = [motion for motion in motions if motion[1] == self.current_position]
            if current:
                motions = current
        if len(motions) > 1 and self.current_position is None:
            ranked: list[tuple[int, tuple[int, int, int, int], Position, Position]] = []
            for sig, old_center, new_center in motions:
                delta = (new_center[0] - old_center[0], new_center[1] - old_center[1])
                key = (sig, action.action, delta)
                self.candidate_scores[key] = self.candidate_scores.get(key, 0) + 1
                ranked.append((self.candidate_scores[key], sig, old_center, new_center))
            ranked.sort(key=lambda item: (-item[0], -item[1][3]))
            if ranked[0][0] < 2:
                return
            _score, sig, old_center, new_center = ranked[0]
        else:
            sig, old_center, new_center = max(motions, key=lambda item: item[0][3])
        delta = (new_center[0] - old_center[0], new_center[1] - old_center[1])
        if delta == (0, 0):
            return
        self.deltas[action.action] = delta
        self.current_position = new_center
        self.visited_positions.add(old_center)
        self.visited_positions.add(new_center)

    def reset_level(self) -> None:
        self.current_position = None
        self.visited_positions = set()
        self.blocked_edges = set()
        self.death_edges = set()
        self.candidate_scores = {}
        self.frontier_targets = set()

    def summary(self) -> str:
        return (
            f"position={self.current_position}; deltas={self.deltas}; "
            f"visited={len(self.visited_positions)}; blocked={len(self.blocked_edges)}; "
            f"deaths={len(self.death_edges)}"
        )

    def plan(
        self,
        width: int,
        height: int,
        available_actions: set[int],
        max_depth: int = 18,
    ) -> list[ActionSpec]:
        if self.current_position is None or not self.deltas:
            return []
        usable = {
            action: delta
            for action, delta in self.deltas.items()
            if action in available_actions
        }
        if not usable:
            return []

        start = self.current_position
        queue: deque[tuple[Position, list[int]]] = deque([(start, [])])
        seen = {start}
        best_path: list[int] = []
        best_score = -1

        while queue:
            pos, path = queue.popleft()
            if len(path) >= max_depth:
                continue
            for action, (dx, dy) in sorted(usable.items()):
                if (pos, action) in self.blocked_edges or (pos, action) in self.death_edges:
                    continue
                nxt = (pos[0] + dx, pos[1] + dy)
                if nxt[0] < 0 or nxt[1] < 0 or nxt[0] >= width or nxt[1] >= height:
                    continue
                if nxt in seen:
                    continue
                next_path = [*path, action]
                score = 10 if nxt not in self.visited_positions else 0
                if nxt in self.frontier_targets:
                    score += 8
                score -= len(next_path)
                if score > best_score:
                    best_score = score
                    best_path = next_path
                if nxt not in self.visited_positions:
                    return [
                        ActionSpec(step, reason="BFS movement frontier", source="movement-bfs")
                        for step in next_path
                    ]
                seen.add(nxt)
                queue.append((nxt, next_path))

        return [
            ActionSpec(step, reason="BFS movement fallback", source="movement-bfs")
            for step in best_path[:max_depth]
        ]
