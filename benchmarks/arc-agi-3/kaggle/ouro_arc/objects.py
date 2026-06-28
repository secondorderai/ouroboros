from __future__ import annotations

from dataclasses import dataclass


SUMMARY_OBJECT_CAP = 16
CHANGE_LINE_CAP = 12


@dataclass(frozen=True)
class GridObject:
    color: int
    size: int
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0 + 1

    @property
    def height(self) -> int:
        return self.y1 - self.y0 + 1

    @property
    def center(self) -> tuple[int, int]:
        return ((self.x0 + self.x1) // 2, (self.y0 + self.y1) // 2)


def hex_digit(value: int) -> str:
    return format(value, "x") if isinstance(value, int) and 0 <= value < 16 else "?"


def segment_objects(grid: list[list[int]]) -> list[GridObject]:
    height = len(grid)
    visited = [bytearray(len(row)) for row in grid]
    objects: list[GridObject] = []

    for y, row in enumerate(grid):
        for x, color in enumerate(row):
            if visited[y][x]:
                continue
            visited[y][x] = 1
            stack = [(x, y)]
            size = 0
            x0 = x1 = x
            y0 = y1 = y

            while stack:
                cx, cy = stack.pop()
                size += 1
                x0 = min(x0, cx)
                x1 = max(x1, cx)
                y0 = min(y0, cy)
                y1 = max(y1, cy)
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if ny < 0 or ny >= height:
                        continue
                    if nx < 0 or nx >= len(grid[ny]):
                        continue
                    if visited[ny][nx] or grid[ny][nx] != color:
                        continue
                    visited[ny][nx] = 1
                    stack.append((nx, ny))

            objects.append(GridObject(color=color, size=size, x0=x0, y0=y0, x1=x1, y1=y1))
    return objects


def _cell_noun(n: int) -> str:
    return "cell" if n == 1 else "cells"


def _describe_object(obj: GridObject) -> str:
    rect = " rect" if obj.size == obj.width * obj.height and obj.size > 1 else ""
    if obj.width == 1 and obj.height == 1:
        at = f"({obj.x0},{obj.y0})"
    else:
        at = f"({obj.x0},{obj.y0})..({obj.x1},{obj.y1})"
    return (
        f"color {hex_digit(obj.color)} {obj.width}x{obj.height}{rect} "
        f"({obj.size} {_cell_noun(obj.size)}) at {at}"
    )


def summarize_objects(
    grid: list[list[int]],
    max_objects: int = SUMMARY_OBJECT_CAP,
) -> str:
    objects = segment_objects(grid)
    if not objects:
        return "no objects"

    bg = max(objects, key=lambda obj: obj.size)
    rest = [obj for obj in objects if obj is not bg]
    rest.sort(key=lambda obj: obj.size, reverse=True)

    lines = [f"bg={hex_digit(bg.color)} ({bg.size} {_cell_noun(bg.size)})"]
    lines.extend(_describe_object(obj) for obj in rest[:max_objects])
    omitted = rest[max_objects:]
    if omitted:
        singles = sum(1 for obj in omitted if obj.size == 1)
        if singles == len(omitted):
            lines.append(f"...and {singles} more single cells")
        else:
            smallest = omitted[-1].size
            lines.append(
                f"...and {len(omitted)} more (smallest {smallest} {_cell_noun(smallest)})"
            )
    return "\n".join(lines)


def foreground_objects(grid: list[list[int]]) -> list[GridObject]:
    objects = segment_objects(grid)
    if len(objects) <= 1:
        return []
    bg = max(objects, key=lambda obj: obj.size)
    return [obj for obj in objects if obj is not bg]


def salient_click_targets(grid: list[list[int]], limit: int = 10) -> list[tuple[int, int, str]]:
    """Return center points of likely interactive non-background objects."""

    targets: list[tuple[int, int, str]] = []
    for obj in sorted(foreground_objects(grid), key=lambda o: (o.size, -o.y0, -o.x0), reverse=True):
        x, y = obj.center
        targets.append((x, y, _describe_object(obj)))
        if len(targets) >= limit:
            break
    return targets
