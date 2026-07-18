"""Pure, deterministic mechanics available to autonomous world models.

The module intentionally has no project or environment imports. The isolated
worker exposes it as the global ``mechanics`` object to generated programs.
"""

from __future__ import annotations

from collections import deque
from copy import deepcopy
from typing import Any, Callable, Iterable, Sequence

Grid = list[list[int]]
Point = tuple[int, int]


def clone_grid(grid: Sequence[Sequence[int]]) -> Grid:
    return [list(map(int, row)) for row in grid]


def dimensions(grid: Sequence[Sequence[int]]) -> tuple[int, int]:
    return max((len(row) for row in grid), default=0), len(grid)


def in_bounds(grid: Sequence[Sequence[int]], point: Point) -> bool:
    x, y = point
    return 0 <= y < len(grid) and 0 <= x < len(grid[y])


def get(grid: Sequence[Sequence[int]], point: Point, default: int | None = None) -> int | None:
    x, y = point
    return int(grid[y][x]) if in_bounds(grid, point) else default


def set_cell(grid: Sequence[Sequence[int]], point: Point, color: int) -> Grid:
    out = clone_grid(grid)
    if not in_bounds(out, point):
        raise ValueError(f"point out of bounds: {point}")
    x, y = point
    out[y][x] = int(color)
    return out


def neighbors4(point: Point) -> tuple[Point, ...]:
    x, y = point
    return ((x, y - 1), (x + 1, y), (x, y + 1), (x - 1, y))


def neighbors8(point: Point) -> tuple[Point, ...]:
    x, y = point
    return tuple(
        (x + dx, y + dy)
        for dy in (-1, 0, 1)
        for dx in (-1, 0, 1)
        if dx or dy
    )


def cells_of_color(grid: Sequence[Sequence[int]], color: int) -> tuple[Point, ...]:
    return tuple(
        (x, y)
        for y, row in enumerate(grid)
        for x, value in enumerate(row)
        if int(value) == int(color)
    )


def color_counts(grid: Sequence[Sequence[int]]) -> dict[int, int]:
    counts: dict[int, int] = {}
    for row in grid:
        for value in row:
            color = int(value)
            counts[color] = counts.get(color, 0) + 1
    return counts


def connected_components(
    grid: Sequence[Sequence[int]],
    background: int | None = None,
    diagonal: bool = False,
) -> list[dict[str, Any]]:
    counts = color_counts(grid)
    if background is None:
        background = max(counts, key=lambda color: (counts[color], -color), default=0)
    adjacent = neighbors8 if diagonal else neighbors4
    unseen = {
        (x, y)
        for y, row in enumerate(grid)
        for x, value in enumerate(row)
        if int(value) != int(background)
    }
    result: list[dict[str, Any]] = []
    while unseen:
        start = min(unseen, key=lambda point: (point[1], point[0]))
        color = int(get(grid, start, background))
        queue = deque([start])
        unseen.remove(start)
        cells: list[Point] = []
        while queue:
            point = queue.popleft()
            cells.append(point)
            for neighbor in adjacent(point):
                if neighbor in unseen and get(grid, neighbor) == color:
                    unseen.remove(neighbor)
                    queue.append(neighbor)
        cells.sort(key=lambda point: (point[1], point[0]))
        xs = [point[0] for point in cells]
        ys = [point[1] for point in cells]
        result.append(
            {
                "color": color,
                "cells": tuple(cells),
                "size": len(cells),
                "bounds": (min(xs), min(ys), max(xs), max(ys)),
                "center": (sum(xs) / len(xs), sum(ys) / len(ys)),
            }
        )
    return sorted(result, key=lambda item: (item["bounds"][1], item["bounds"][0], item["color"]))


def translate(points: Iterable[Point], dx: int, dy: int) -> tuple[Point, ...]:
    return tuple((x + int(dx), y + int(dy)) for x, y in points)


def recolor(grid: Sequence[Sequence[int]], old: int, new: int) -> Grid:
    return [[int(new) if int(value) == int(old) else int(value) for value in row] for row in grid]


def swap_colors(grid: Sequence[Sequence[int]], first: int, second: int) -> Grid:
    return [
        [int(second) if value == first else int(first) if value == second else int(value) for value in row]
        for row in grid
    ]


def move_cells(
    grid: Sequence[Sequence[int]],
    cells: Iterable[Point],
    dx: int,
    dy: int,
    background: int = 0,
    collision_colors: Iterable[int] | None = None,
) -> Grid | None:
    source = tuple(cells)
    targets = translate(source, dx, dy)
    source_set = set(source)
    blocked = set(map(int, collision_colors or ()))
    for target in targets:
        value = get(grid, target)
        if value is None:
            return None
        if target not in source_set and (blocked and int(value) in blocked):
            return None
    out = clone_grid(grid)
    values = [int(get(grid, point, background)) for point in source]
    for x, y in source:
        out[y][x] = int(background)
    for (x, y), value in zip(targets, values):
        out[y][x] = value
    return out


def push_chain(
    grid: Sequence[Sequence[int]],
    start: Point,
    dx: int,
    dy: int,
    background: int = 0,
) -> Grid | None:
    chain: list[Point] = []
    point = start
    while in_bounds(grid, point) and get(grid, point) != background:
        chain.append(point)
        point = (point[0] + dx, point[1] + dy)
    if not in_bounds(grid, point) or get(grid, point) != background:
        return None
    out = clone_grid(grid)
    for source in reversed(chain):
        target = (source[0] + dx, source[1] + dy)
        tx, ty = target
        sx, sy = source
        out[ty][tx] = out[sy][sx]
    sx, sy = start
    out[sy][sx] = int(background)
    return out


def carry(state: dict[str, Any], key: str, value: Any) -> dict[str, Any]:
    out = deepcopy(state)
    out[key] = deepcopy(value)
    return out


def transport(grid: Sequence[Sequence[int]], source: Point, destination: Point, background: int = 0) -> Grid:
    if not in_bounds(grid, source) or not in_bounds(grid, destination):
        raise ValueError("transport point out of bounds")
    out = clone_grid(grid)
    sx, sy = source
    dx, dy = destination
    out[dy][dx], out[sy][sx] = out[sy][sx], int(background)
    return out


def toggle(value: Any, first: Any = False, second: Any = True) -> Any:
    return second if value == first else first


def spawn(grid: Sequence[Sequence[int]], cells: Iterable[Point], color: int) -> Grid:
    out = clone_grid(grid)
    for point in cells:
        if not in_bounds(out, point):
            raise ValueError(f"spawn point out of bounds: {point}")
        x, y = point
        out[y][x] = int(color)
    return out


def remove(grid: Sequence[Sequence[int]], cells: Iterable[Point], background: int = 0) -> Grid:
    return spawn(grid, cells, background)


def map_neighborhood(
    grid: Sequence[Sequence[int]],
    rule: Callable[[int, tuple[int | None, ...], Point], int],
    diagonal: bool = False,
) -> Grid:
    adjacent = neighbors8 if diagonal else neighbors4
    out = clone_grid(grid)
    for y, row in enumerate(grid):
        for x, value in enumerate(row):
            neighborhood = tuple(get(grid, point) for point in adjacent((x, y)))
            out[y][x] = int(rule(int(value), neighborhood, (x, y)))
    return out


def shortest_path(
    start: Point,
    goals: Iterable[Point],
    passable: Callable[[Point], bool],
    max_nodes: int = 10000,
) -> tuple[Point, ...]:
    targets = set(goals)
    queue = deque([start])
    parent: dict[Point, Point | None] = {start: None}
    while queue and len(parent) <= max_nodes:
        point = queue.popleft()
        if point in targets:
            path: list[Point] = []
            while point is not None:
                path.append(point)
                point = parent[point]  # type: ignore[assignment]
            return tuple(reversed(path))
        for neighbor in neighbors4(point):
            if neighbor not in parent and passable(neighbor):
                parent[neighbor] = point
                queue.append(neighbor)
    return ()


def compose(state: Any, action: Any, *rules: Callable[[Any, Any], Any]) -> Any:
    current = deepcopy(state)
    for rule in rules:
        current = rule(current, action)
    return current


def grid_equals(left: Sequence[Sequence[int]], right: Sequence[Sequence[int]]) -> bool:
    return clone_grid(left) == clone_grid(right)


def all_cells_match(grid: Sequence[Sequence[int]], predicate: Callable[[int, Point], bool]) -> bool:
    return all(predicate(int(value), (x, y)) for y, row in enumerate(grid) for x, value in enumerate(row))


PUBLIC_NAMES = tuple(
    name
    for name, value in sorted(globals().items())
    if callable(value) and not name.startswith("_") and name not in {"Any", "Callable", "Iterable", "Sequence"}
)
