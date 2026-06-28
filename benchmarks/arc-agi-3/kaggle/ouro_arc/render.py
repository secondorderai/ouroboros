from __future__ import annotations

import hashlib
from collections import Counter

from .objects import hex_digit


DIFF_CELL_CAP = 30
FULL_RENDER_CHANGE_RATIO = 0.4


def _as_list(value: object) -> object:
    if hasattr(value, "tolist"):
        return value.tolist()  # type: ignore[no-any-return]
    return value


def last_grid(frame: list[list[list[int]]] | list[list[int]]) -> list[list[int]]:
    normalized = _as_list(frame)
    if not isinstance(normalized, list) or len(normalized) == 0:
        return []
    first = _as_list(normalized[0])
    if isinstance(first, list) and first and isinstance(first[0], list):
        return _as_list(normalized[-1])  # type: ignore[return-value]
    return normalized  # type: ignore[return-value]


def render_full(grid: list[list[int]]) -> str:
    height = len(grid)
    width = len(grid[0]) if grid else 0
    tens = "".join(str((c // 10) % 10) if c % 10 == 0 else " " for c in range(width))
    ones = "".join(str(c % 10) for c in range(width))
    lines = [f"   {tens}", f"   {ones}"]
    for y in range(height):
        lines.append(f"{y:02d} {''.join(hex_digit(v) for v in grid[y])}")
    return "\n".join(lines)


def changed_cells(prev: list[list[int]], next_grid: list[list[int]]) -> list[tuple[int, int, int, int]]:
    changes: list[tuple[int, int, int, int]] = []
    height = max(len(prev), len(next_grid))
    for y in range(height):
        prev_row = prev[y] if y < len(prev) else []
        next_row = next_grid[y] if y < len(next_grid) else []
        width = max(len(prev_row), len(next_row))
        for x in range(width):
            old = prev_row[x] if x < len(prev_row) else -1
            new = next_row[x] if x < len(next_row) else -1
            if old != new:
                changes.append((x, y, old, new))
    return changes


def changed_cell_count(prev: list[list[int]], next_grid: list[list[int]]) -> int:
    return len(changed_cells(prev, next_grid))


def render_diff(prev: list[list[int]], next_grid: list[list[int]]) -> str:
    changes = changed_cells(prev, next_grid)
    if not changes:
        return "no cells changed"
    noun = "cell" if len(changes) == 1 else "cells"
    listed = changes[:DIFF_CELL_CAP]
    out = f"changed {len(changes)} {noun}: " + ", ".join(
        f"({x},{y}) {hex_digit(old)}->{hex_digit(new)}" for x, y, old, new in listed
    )
    if len(changes) > DIFF_CELL_CAP:
        xs = [x for x, _, _, _ in changes]
        ys = [y for _, y, _, _ in changes]
        transitions = Counter(f"{hex_digit(old)}->{hex_digit(new)}" for _, _, old, new in changes)
        counts = ", ".join(f"{k} x{n}" for k, n in transitions.most_common())
        out += (
            f", ... and {len(changes) - DIFF_CELL_CAP} more; "
            f"region x=[{min(xs)},{max(xs)}] y=[{min(ys)},{max(ys)}]; "
            f"transitions: {counts}"
        )
    return out


def frame_hash(grid: list[list[int]], mask_hud: bool = True) -> str:
    """Stable hash for graph exploration.

    ARC-AGI-3 games are 64x64. We conservatively mask a small top/bottom band
    so counters or HUD-like rows do not explode the state graph.
    """

    h = hashlib.blake2b(digest_size=16)
    height = len(grid)
    for y, row in enumerate(grid):
        if mask_hud and height >= 32 and (y < 2 or y >= height - 2):
            h.update(bytes([255]) * len(row))
        else:
            h.update(bytes((v if 0 <= v < 255 else 254) for v in row))
        h.update(b"\n")
    return h.hexdigest()
