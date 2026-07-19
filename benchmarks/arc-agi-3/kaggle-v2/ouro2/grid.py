"""Grid primitives.

A grid is an immutable ``bytes`` of length 4096 (64x64, row-major, colors
0-15). ARC-AGI-3 always serves 64x64 frames; fixing the shape keeps every
hot path allocation-free and hashable. Cell (x, y) lives at index y*64+x.
"""
from __future__ import annotations

import hashlib
from collections import Counter, deque
from dataclasses import dataclass
from functools import lru_cache

SIZE = 64
CELLS = SIZE * SIZE

Grid = bytes


def to_grid(frame_stack: list[list[list[int]]] | None) -> Grid | None:
    """Last grid of a FrameData.frame stack, or None for empty/burned frames.

    Duck-typed (len/int casts, no truthiness): the real engine returns numpy
    arrays, whose truth value raises.
    """
    if frame_stack is None or len(frame_stack) == 0:
        return None
    rows = frame_stack[-1]
    if rows is None or len(rows) == 0:
        return None
    flat = bytearray(CELLS)
    for y in range(min(len(rows), SIZE)):
        row = rows[y]
        for x in range(min(len(row), SIZE)):
            flat[y * SIZE + x] = int(row[x]) & 0x0F
    return bytes(flat)


def from_rows(rows: list[list[int]]) -> Grid:
    """Build a grid from (possibly smaller) row data, zero-padded to 64x64."""
    return to_grid([rows]) or bytes(CELLS)


def cell(g: Grid, x: int, y: int) -> int:
    return g[y * SIZE + x]


def grid_key(g: Grid) -> str:
    """Stable short key (safe across processes, unlike hash(bytes))."""
    return hashlib.blake2b(g, digest_size=8).hexdigest()


def diff(a: Grid, b: Grid) -> list[tuple[int, int, int, int]]:
    """Changed cells as (x, y, old, new)."""
    out = []
    for i in range(CELLS):
        if a[i] != b[i]:
            out.append((i % SIZE, i // SIZE, a[i], b[i]))
    return out


def color_counts(g: Grid) -> dict[int, int]:
    return dict(Counter(g))


@lru_cache(maxsize=8192)
def most_common_color(g: Grid) -> int:
    return Counter(g).most_common(1)[0][0]


@dataclass(frozen=True)
class Obj:
    color: int
    cells: frozenset[tuple[int, int]]
    bbox: tuple[int, int, int, int]  # x0, y0, x1, y1 inclusive
    centroid: tuple[int, int]
    shape_hash: str

    @property
    def size(self) -> int:
        return len(self.cells)

    @property
    def width(self) -> int:
        return self.bbox[2] - self.bbox[0] + 1

    @property
    def height(self) -> int:
        return self.bbox[3] - self.bbox[1] + 1


def _shape_hash(color: int, cells: list[tuple[int, int]], x0: int, y0: int) -> str:
    normalized = sorted((x - x0, y - y0) for x, y in cells)
    payload = bytes([color]) + b"".join(bytes((x, y)) for x, y in normalized)
    return hashlib.blake2b(payload, digest_size=6).hexdigest()


def components(
    g: Grid,
    colors: set[int] | None = None,
    conn: int = 4,
    background: int | None = None,
) -> list[Obj]:
    """Same-color connected components, largest first.

    ``colors`` restricts which colors to segment; ``background`` (default:
    most common color) is skipped entirely.
    """
    bg = most_common_color(g) if background is None else background
    seen = bytearray(CELLS)
    offsets4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
    offsets8 = offsets4 + ((1, 1), (1, -1), (-1, 1), (-1, -1))
    offsets = offsets8 if conn == 8 else offsets4
    out: list[Obj] = []
    for start in range(CELLS):
        if seen[start]:
            continue
        color = g[start]
        seen[start] = 1
        if color == bg or (colors is not None and color not in colors):
            continue
        cells = [(start % SIZE, start // SIZE)]
        queue = deque(cells)
        while queue:
            cx, cy = queue.popleft()
            for dx, dy in offsets:
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < SIZE and 0 <= ny < SIZE:
                    idx = ny * SIZE + nx
                    if not seen[idx] and g[idx] == color:
                        seen[idx] = 1
                        cells.append((nx, ny))
                        queue.append((nx, ny))
        xs = [c[0] for c in cells]
        ys = [c[1] for c in cells]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        out.append(
            Obj(
                color=color,
                cells=frozenset(cells),
                bbox=(x0, y0, x1, y1),
                centroid=(sum(xs) // len(xs), sum(ys) // len(ys)),
                shape_hash=_shape_hash(color, cells, x0, y0),
            )
        )
    out.sort(key=lambda o: (-o.size, o.color, o.bbox))
    return out


def apply_cells(g: Grid, cells: list[tuple[int, int, int]]) -> Grid:
    """Return a copy of ``g`` with (x, y, color) writes applied."""
    if not cells:
        return g
    flat = bytearray(g)
    for x, y, color in cells:
        flat[y * SIZE + x] = color & 0x0F
    return bytes(flat)
