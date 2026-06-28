from __future__ import annotations

from dataclasses import dataclass


SUMMARY_OBJECT_CAP = 16
CHANGE_LINE_CAP = 12
HUD_ROWS = 2


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


def object_signature(obj: GridObject) -> tuple[int, int, int, int]:
    return (obj.color, obj.width, obj.height, obj.size)


def object_motions(
    prev: list[list[int]],
    next_grid: list[list[int]],
) -> list[tuple[tuple[int, int, int, int], tuple[int, int], tuple[int, int]]]:
    """Match same-signature foreground objects and report center movements."""

    prev_objects = foreground_objects(prev)
    next_objects = foreground_objects(next_grid)
    prev_groups: dict[tuple[int, int, int, int], list[GridObject]] = {}
    next_groups: dict[tuple[int, int, int, int], list[GridObject]] = {}
    for obj in prev_objects:
        prev_groups.setdefault(object_signature(obj), []).append(obj)
    for obj in next_objects:
        next_groups.setdefault(object_signature(obj), []).append(obj)

    motions: list[tuple[tuple[int, int, int, int], tuple[int, int], tuple[int, int]]] = []
    for sig, old_group in prev_groups.items():
        new_group = next_groups.get(sig)
        if not new_group or len(old_group) != len(new_group):
            continue
        old_sorted = sorted(old_group, key=lambda o: (o.y0, o.x0))
        new_sorted = sorted(new_group, key=lambda o: (o.y0, o.x0))
        for old, new in zip(old_sorted, new_sorted):
            if old.center != new.center:
                motions.append((sig, old.center, new.center))
    return motions


def regular_click_targets(grid: list[list[int]], limit: int = 40) -> list[tuple[int, int, str]]:
    """Return centers of regular rectangular tiles likely to be click targets."""

    objects = [
        obj
        for obj in foreground_objects(grid)
        if obj.size == obj.width * obj.height
        and 2 <= obj.width <= 14
        and 2 <= obj.height <= 14
        and obj.size >= 4
        and obj.y0 >= HUD_ROWS
        and obj.y1 < len(grid) - HUD_ROWS
    ]
    groups: dict[tuple[int, int], list[GridObject]] = {}
    for obj in objects:
        groups.setdefault((obj.width, obj.height), []).append(obj)

    targets: list[tuple[int, int, str]] = []
    seen: set[tuple[int, int]] = set()
    for (_width, _height), group in sorted(
        groups.items(),
        key=lambda item: (-len(item[1]), item[0][1] * item[0][0]),
    ):
        if len(group) < 2:
            continue
        rows: dict[int, list[GridObject]] = {}
        for obj in group:
            rows.setdefault(obj.center[1], []).append(obj)
        regular_rows = [
            sorted(row, key=lambda obj: obj.center[0])
            for row in rows.values()
            if len(row) >= 2
        ]
        if not regular_rows and len(group) < 2:
            continue

        ordered = sorted(group, key=lambda obj: (obj.center[1], obj.center[0]))
        for obj in ordered:
            point = obj.center
            if point in seen:
                continue
            seen.add(point)
            targets.append((point[0], point[1], f"regular tile {_describe_object(obj)}"))
            if len(targets) >= limit:
                return targets
    return targets


def salient_click_targets(grid: list[list[int]], limit: int = 40) -> list[tuple[int, int, str]]:
    """Return center points of likely interactive non-background objects."""

    targets: list[tuple[int, int, str]] = []
    seen: set[tuple[int, int]] = set()
    for x, y, label in regular_click_targets(grid, limit=limit):
        targets.append((x, y, label))
        seen.add((x, y))
        if len(targets) >= limit:
            return targets

    width = max((len(row) for row in grid), default=0)
    height = len(grid)

    def click_rank(obj: GridObject) -> tuple[int, int, int, int, int]:
        touches_edge = obj.x0 == 0 or obj.y0 == 0 or obj.x1 >= width - 1 or obj.y1 >= height - 1
        huge = obj.size > 128 or obj.width > 24 or obj.height > 24
        compact_rect = obj.size == obj.width * obj.height and 2 <= obj.width <= 16 and 2 <= obj.height <= 16
        tiny = obj.size == 1
        return (
            1 if huge or (touches_edge and obj.size > 16) else 0,
            0 if compact_rect else 1,
            1 if tiny else 0,
            obj.size,
            obj.y0 * 100 + obj.x0,
        )

    for obj in sorted(foreground_objects(grid), key=click_rank):
        if obj.y0 < HUD_ROWS or obj.y1 >= height - HUD_ROWS:
            continue
        x, y = obj.center
        if (x, y) in seen:
            continue
        seen.add((x, y))
        targets.append((x, y, _describe_object(obj)))
        if len(targets) >= limit:
            break
    return targets
