from __future__ import annotations

import binascii
import struct
import zlib


ARC_PALETTE: tuple[tuple[int, int, int], ...] = (
    (0, 0, 0),
    (0, 116, 217),
    (255, 65, 54),
    (46, 204, 64),
    (255, 220, 0),
    (170, 170, 170),
    (240, 18, 190),
    (255, 133, 27),
    (127, 219, 255),
    (135, 12, 37),
    (57, 204, 204),
    (61, 153, 112),
    (1, 255, 112),
    (177, 13, 201),
    (255, 65, 163),
    (221, 221, 221),
)


def grid_to_png_bytes(grid: list[list[int]], cell_size: int = 8) -> bytes:
    """Render an ARC grid to a deterministic RGB PNG."""

    if cell_size <= 0:
        raise ValueError("cell_size must be positive")
    if not grid:
        raise ValueError("grid must not be empty")
    width = len(grid[0])
    if width == 0:
        raise ValueError("grid rows must not be empty")
    for row in grid:
        if len(row) != width:
            raise ValueError("grid rows must have equal width")
        for value in row:
            if not 0 <= int(value) < len(ARC_PALETTE):
                raise ValueError(f"grid color out of palette range: {value}")

    png_width = width * cell_size
    png_height = len(grid) * cell_size
    scanlines: list[bytes] = []
    for row in grid:
        pixel_row = b"".join(bytes(ARC_PALETTE[int(value)]) * cell_size for value in row)
        for _ in range(cell_size):
            scanlines.append(b"\x00" + pixel_row)

    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", png_width, png_height, 8, 2, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(b"".join(scanlines), level=9))
        + _chunk(b"IEND", b"")
    )


def _chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)
    )
