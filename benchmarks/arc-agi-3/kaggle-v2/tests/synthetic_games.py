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


class PushGame(SyntheticGame):
    """Push the box onto the target cell (sokoban, one box)."""

    n_levels = 1
    available = (0, 1, 2, 3, 4)

    def initial(self, level: int) -> dict:
        walls = set()
        for x in range(2, 11):
            walls |= {(x, 2), (x, 10)}
        for y in range(2, 11):
            walls |= {(2, y), (10, y)}
        return {"avatar": (4, 6), "box": (6, 6), "target": (8, 6), "walls": walls}

    def render(self, s: dict) -> list[list[int]]:
        rows = empty_rows()
        for x, y in s["walls"]:
            rows[y][x] = WALL
        tx, ty = s["target"]
        rows[ty][tx] = TARGET
        bx, by = s["box"]
        rows[by][bx] = BOX
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
        if (nx, ny) == s["box"]:
            bx, by = nx + delta[0], ny + delta[1]
            if (bx, by) in s["walls"]:
                return s, False, False
            s = dict(s, avatar=(nx, ny), box=(bx, by))
            return s, (bx, by) == s["target"], False
        s = dict(s, avatar=(nx, ny))
        return s, False, False


class ToggleDoorsGame(SyntheticGame):
    """Click each button to switch it off; level done when all are off."""

    n_levels = 1
    available = (0, 6)
    BUTTONS = ((5, 5), (9, 5), (7, 8))

    def initial(self, level: int) -> dict:
        return {"on": set(self.BUTTONS)}

    def render(self, s: dict) -> list[list[int]]:
        rows = empty_rows()
        for x, y in self.BUTTONS:
            rows[y][x] = BTN if (x, y) in s["on"] else DOOR
        return rows

    def apply(self, s: dict, action: ActionSpec):
        if action.action != 6:
            return s, False, False
        p = (action.x, action.y)
        if p in self.BUTTONS:
            on = set(s["on"])
            if p in on:
                on.remove(p)
            else:
                on.add(p)
            s = dict(s, on=on)
        return s, not s["on"], False


class CollectGame(SyntheticGame):
    """Eat every pellet; level completes when the last one is consumed."""

    n_levels = 1
    available = (0, 1, 2, 3, 4)
    PELLETS = ((5, 4), (8, 7), (4, 8))

    def initial(self, level: int) -> dict:
        walls = set()
        for x in range(2, 11):
            walls |= {(x, 2), (x, 10)}
        for y in range(2, 11):
            walls |= {(2, y), (10, y)}
        return {"avatar": (3, 3), "pellets": set(self.PELLETS), "walls": walls}

    def render(self, s: dict) -> list[list[int]]:
        rows = empty_rows()
        for x, y in s["walls"]:
            rows[y][x] = WALL
        for x, y in s["pellets"]:
            rows[y][x] = PELLET
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
        pellets = set(s["pellets"])
        pellets.discard((nx, ny))
        s = dict(s, avatar=(nx, ny), pellets=pellets)
        return s, not pellets, False


class HazardTickGame(SyntheticGame):
    """A patrolling enemy sweeps a column; touching it is death.

    The enemy bounces vertically in column 5 (rows 5-7). The goal is
    reachable without ever entering that column — this game verifies tick
    induction and the GAME_OVER autopsy, not timing luck.
    """

    n_levels = 1
    available = (0, 1, 2, 3, 4)
    LO, HI = 5, 7

    def initial(self, level: int) -> dict:
        walls = set()
        for x in range(3, 10):
            walls |= {(x, 3), (x, 9)}
        for y in range(3, 10):
            walls |= {(3, y), (9, y)}
        return {
            "avatar": (4, 4),
            "goal": (5, 8),
            "enemy": (5, 5),
            "dir": 1,
            "walls": walls,
        }

    def render(self, s: dict) -> list[list[int]]:
        rows = empty_rows()
        for x, y in s["walls"]:
            rows[y][x] = WALL
        gx, gy = s["goal"]
        rows[gy][gx] = GOAL
        ex, ey = s["enemy"]
        rows[ey][ex] = HZ
        ax, ay = s["avatar"]
        rows[ay][ax] = AV
        return rows

    def apply(self, s: dict, action: ActionSpec):
        delta = DELTAS.get(action.action)
        ax, ay = s["avatar"]
        if delta is not None:
            nx, ny = ax + delta[0], ay + delta[1]
            if (nx, ny) not in s["walls"]:
                ax, ay = nx, ny
        # Enemy ticks every action, bouncing vertically between LO and HI.
        ex, ey = s["enemy"]
        d = s["dir"]
        if not self.LO <= ey + d <= self.HI:
            d = -d
        ey += d
        s = dict(s, avatar=(ax, ay), enemy=(ex, ey), dir=d)
        if (ax, ay) == (ex, ey):
            return s, False, True
        return s, (ax, ay) == s["goal"], False


class NoopGame(SyntheticGame):
    """Actions 1, 5 and 7 do nothing; 2/3/4 move. Tests the futility ledger."""

    n_levels = 1
    available = (0, 1, 2, 3, 4, 5, 7)

    def initial(self, level: int) -> dict:
        walls = set()
        for x in range(2, 9):
            walls |= {(x, 2), (x, 8)}
        for y in range(2, 9):
            walls |= {(2, y), (8, y)}
        return {"avatar": (3, 3), "goal": (7, 7), "walls": walls}

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
        if action.action not in (2, 3, 4):
            return s, False, False  # 1/5/7 are no-ops in this game
        delta = DELTAS[action.action]
        ax, ay = s["avatar"]
        nx, ny = ax + delta[0], ay + delta[1]
        if (nx, ny) in s["walls"]:
            return s, False, False
        s = dict(s, avatar=(nx, ny))
        return s, (nx, ny) == s["goal"], False
