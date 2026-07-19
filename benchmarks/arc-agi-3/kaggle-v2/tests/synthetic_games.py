"""Synthetic games with bespoke logic (independent of ouro2.rules)."""
from __future__ import annotations

from ouro2.timeline import ActionSpec

from .fake_env import SyntheticGame, empty_rows

AV = 3
WALL = 4
GOAL = 12
PELLET = 5
BOX = 6
TARGET = 9
HZ = 7
BTN = 10
DOOR = 11

DELTAS = {1: (0, -1), 2: (0, 1), 3: (-1, 0), 4: (1, 0)}


class MazeGame(SyntheticGame):
    """Room with walls; step onto the goal cell to finish the level."""

    n_levels = 2
    available = (0, 1, 2, 3, 4)
    ROOM = (2, 2, 8, 8)  # x0, y0, x1, y1 walls on the border

    def initial(self, level: int) -> dict:
        if level == 0:
            return {"avatar": (3, 3), "goal": (7, 7), "walls": self._walls()}
        return {"avatar": (7, 3), "goal": (3, 7), "walls": self._walls({(5, 4), (5, 5)})}

    def _walls(self, extra: set | None = None) -> set:
        x0, y0, x1, y1 = self.ROOM
        walls = set()
        for x in range(x0, x1 + 1):
            walls |= {(x, y0), (x, y1)}
        for y in range(y0, y1 + 1):
            walls |= {(x0, y), (x1, y)}
        return walls | (extra or set())

    def render(self, s: dict) -> list[list[int]]:
        rows = empty_rows()
        for x, y in s["walls"]:
            rows[y][x] = WALL
        gx, gy = s["goal"]
        rows[gy][gx] = GOAL
        ax, ay = s["avatar"]
        rows[ay][ax] = AV
        return rows

    def apply(self, s: dict, action: ActionSpec):
        delta = DELTAS.get(action.action)
        if delta is None:
            return s, False, False
        ax, ay = s["avatar"]
        nx, ny = ax + delta[0], ay + delta[1]
        if (nx, ny) in s["walls"]:
            return s, False, False
        s = dict(s, avatar=(nx, ny))
        return s, (nx, ny) == s["goal"], False
