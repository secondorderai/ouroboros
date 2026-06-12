/**
 * Pure frame rendering for ARC-AGI-3 grids.
 *
 * - `renderFull(grid)`: rows of lowercase hex digits with 2-digit row
 *   prefixes and a two-line column ruler header.
 * - `renderDiff(prev, next)`: "changed N cells: (x,y) a→b, …" capped at
 *   DIFF_CELL_CAP cells, then a region summary (x/y ranges) and per-transition
 *   change counts.
 * - Multi-grid frames: render the last grid and report the grid count.
 * - `changedCellCount` supports the >40% changed full-render fallback.
 */

export const DIFF_CELL_CAP = 30;

/** Ratio of changed cells above which callers should fall back to renderFull. */
export const FULL_RENDER_CHANGE_RATIO = 0.4;

export interface CellChange {
  /** Column index. */
  x: number;
  /** Row index. */
  y: number;
  from: number;
  to: number;
}

/** Lowercase hex digit for a cell value (also used by objects.ts). */
export function hexDigit(value: number): string {
  return Number.isInteger(value) && value >= 0 && value < 16
    ? value.toString(16)
    : "?";
}

// ---------------------------------------------------------------------------
// Full render
// ---------------------------------------------------------------------------

/**
 * Render a grid as rows of lowercase hex digits. Each row is prefixed with a
 * 2-digit row index; the header is a two-line column ruler (tens then ones).
 */
export function renderFull(grid: number[][]): string {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  let tens = "";
  let ones = "";
  for (let c = 0; c < width; c++) {
    tens += c % 10 === 0 ? String(Math.floor(c / 10) % 10) : " ";
    ones += String(c % 10);
  }

  const lines: string[] = [`   ${tens}`, `   ${ones}`];
  for (let y = 0; y < height; y++) {
    const row = grid[y] ?? [];
    lines.push(
      `${String(y).padStart(2, "0")} ${row.map(hexDigit).join("")}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Diff render
// ---------------------------------------------------------------------------

/** All changed cells between two grids, in row-major order (y, then x). */
export function changedCells(
  prev: number[][],
  next: number[][],
): CellChange[] {
  const height = Math.max(prev.length, next.length);
  const changes: CellChange[] = [];
  for (let y = 0; y < height; y++) {
    const prevRow = prev[y] ?? [];
    const nextRow = next[y] ?? [];
    const width = Math.max(prevRow.length, nextRow.length);
    for (let x = 0; x < width; x++) {
      const from = prevRow[x] ?? -1;
      const to = nextRow[x] ?? -1;
      if (from !== to) changes.push({ x, y, from, to });
    }
  }
  return changes;
}

/** Number of cells that differ between two grids. */
export function changedCellCount(prev: number[][], next: number[][]): number {
  return changedCells(prev, next).length;
}

/**
 * Whether a diff is too large to be useful, i.e. more than
 * FULL_RENDER_CHANGE_RATIO of the next grid's cells changed.
 */
export function shouldRenderFull(prev: number[][], next: number[][]): boolean {
  const total = next.length * (next[0]?.length ?? 0);
  if (total === 0) return false;
  return changedCellCount(prev, next) / total > FULL_RENDER_CHANGE_RATIO;
}

/**
 * Render the difference between two grids as a compact cell list:
 * `changed N cells: (x,y) a→b, …`. When more than DIFF_CELL_CAP cells
 * changed, the list is capped and followed by a region summary (x/y ranges)
 * and per-transition change counts.
 */
export function renderDiff(prev: number[][], next: number[][]): string {
  const changes = changedCells(prev, next);
  if (changes.length === 0) return "no cells changed";

  const listed = changes.slice(0, DIFF_CELL_CAP);
  const noun = changes.length === 1 ? "cell" : "cells";
  let out =
    `changed ${changes.length} ${noun}: ` +
    listed
      .map((c) => `(${c.x},${c.y}) ${hexDigit(c.from)}→${hexDigit(c.to)}`)
      .join(", ");

  if (changes.length > DIFF_CELL_CAP) {
    const remaining = changes.length - DIFF_CELL_CAP;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const transitions = new Map<string, number>();
    for (const c of changes) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
      const key = `${hexDigit(c.from)}→${hexDigit(c.to)}`;
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
    }
    const counts = [...transitions.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => `${key} ×${n}`)
      .join(", ");
    out +=
      `, … and ${remaining} more; ` +
      `region x∈[${minX},${maxX}] y∈[${minY},${maxY}]; ` +
      `transitions: ${counts}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Multi-grid frames (frame = array of grids; render the last one)
// ---------------------------------------------------------------------------

/** Last grid of a frame (frames are arrays of grids, usually length 1). */
export function lastGrid(frame: number[][][]): number[][] {
  return frame[frame.length - 1] ?? [];
}

/** Render a frame's last grid in full, noting the grid count when > 1. */
export function renderFrame(frame: number[][][]): string {
  const note =
    frame.length > 1
      ? `frame contains ${frame.length} grids; showing last\n`
      : "";
  return note + renderFull(lastGrid(frame));
}

/** Diff the last grids of two frames, noting the grid count when > 1. */
export function renderFrameDiff(
  prevFrame: number[][][],
  nextFrame: number[][][],
): string {
  const note =
    nextFrame.length > 1
      ? `frame contains ${nextFrame.length} grids; diff vs last grid\n`
      : "";
  return note + renderDiff(lastGrid(prevFrame), lastGrid(nextFrame));
}
