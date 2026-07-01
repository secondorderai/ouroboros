from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from .actions import ActionSpec


@dataclass(frozen=True)
class _Block:
    x: int
    y: int
    color: int

    @property
    def center(self) -> tuple[int, int]:
        return (self.x + 2, self.y + 2)


class ConstraintBoardPlanner:
    """Solve local 3x3 clue blocks surrounded by toggle tiles.

    Some ARC-AGI-3 click boards render a clue as a 6x6 block made from 3x3
    subcells. The clue center is the target color. A zero-valued subcell means
    the neighboring tile should match the center; a nonzero subcell means it
    should differ. This planner detects that visual grammar from pixels only.
    """

    block_size = 6
    step = 8
    subcell = 2

    def plan(
        self,
        grid: list[list[int]],
        level: int,
        available_actions: set[int],
        max_actions: int = 12,
    ) -> list[ActionSpec]:
        if 6 not in available_actions:
            return []
        height = len(grid)
        width = max((len(row) for row in grid), default=0)
        if height < self.block_size or width < self.block_size:
            return []

        actions: list[ActionSpec] = []
        seen: set[tuple[int, int]] = set()
        for clue_x, clue_y, clue in self._clue_blocks(grid):
            neighbors = self._neighbor_blocks(grid, clue_x, clue_y)
            if len(neighbors) < 4:
                continue
            neighbor_colors = [block.color for block in neighbors.values()]
            other_color = self._other_color(clue[1][1], neighbor_colors)
            if other_color is None:
                continue
            for row_index, dy in enumerate((-1, 0, 1)):
                for col_index, dx in enumerate((-1, 0, 1)):
                    if dx == 0 and dy == 0:
                        continue
                    block = neighbors.get((dx, dy))
                    if block is None:
                        continue
                    target = clue[1][1] if clue[row_index][col_index] == 0 else other_color
                    if block.color == target:
                        continue
                    point = block.center
                    if point in seen:
                        continue
                    seen.add(point)
                    actions.append(
                        ActionSpec(
                            6,
                            x=point[0],
                            y=point[1],
                            reason="constraint-board satisfy 3x3 clue",
                            source="constraint-board",
                        )
                    )
                    if len(actions) >= max_actions:
                        return actions
        return actions

    def _clue_blocks(self, grid: list[list[int]]) -> list[tuple[int, int, list[list[int]]]]:
        height = len(grid)
        width = max((len(row) for row in grid), default=0)
        clues: list[tuple[int, int, list[list[int]]]] = []
        for y in range(0, height - self.block_size + 1, 2):
            for x in range(0, width - self.block_size + 1, 2):
                clue = self._subcell_colors(grid, x, y)
                if clue is None:
                    continue
                values = {value for row in clue for value in row}
                if len(values) <= 1:
                    continue
                center = clue[1][1]
                if center == 0:
                    continue
                zero_count = sum(1 for row in clue for value in row if value == 0)
                if zero_count == 0:
                    continue
                clues.append((x, y, clue))
        return clues

    def _neighbor_blocks(
        self,
        grid: list[list[int]],
        clue_x: int,
        clue_y: int,
    ) -> dict[tuple[int, int], _Block]:
        blocks: dict[tuple[int, int], _Block] = {}
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                x = clue_x + dx * self.step
                y = clue_y + dy * self.step
                color = self._solid_color(grid, x, y)
                if color is not None:
                    blocks[(dx, dy)] = _Block(x=x, y=y, color=color)
        return blocks

    def _subcell_colors(
        self,
        grid: list[list[int]],
        x: int,
        y: int,
    ) -> list[list[int]] | None:
        colors: list[list[int]] = []
        for row in range(3):
            color_row: list[int] = []
            for col in range(3):
                sx = x + col * self.subcell
                sy = y + row * self.subcell
                color = self._solid_color(grid, sx, sy, size=self.subcell)
                if color is None:
                    return None
                color_row.append(color)
            colors.append(color_row)
        return colors

    def _solid_color(
        self,
        grid: list[list[int]],
        x: int,
        y: int,
        size: int | None = None,
    ) -> int | None:
        size = size or self.block_size
        if y < 0 or x < 0 or y + size > len(grid):
            return None
        if any(x + size > len(row) for row in grid[y : y + size]):
            return None
        color = grid[y][x]
        for row in grid[y : y + size]:
            if any(value != color for value in row[x : x + size]):
                return None
        return color

    def _other_color(self, center: int, neighbor_colors: list[int]) -> int | None:
        counts = Counter(color for color in neighbor_colors if color != center)
        if not counts:
            return None
        return counts.most_common(1)[0][0]
