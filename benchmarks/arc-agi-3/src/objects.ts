/**
 * Object-level frame analysis for ARC-AGI-3 grids.
 *
 * A raw 64x64 hex dump is hard for an LLM to parse; game entities (sprites,
 * targets, walls) are connected same-color regions. This module turns grids
 * into OBJECTS:
 *
 * - `segmentObjects(grid)`: connected-component labeling (4-connectivity,
 *   same color) via iterative flood fill — grids are 4096 cells, so no
 *   recursion.
 * - `summarizeObjects(grid)`: compact inventory — background (largest
 *   component) plus remaining components sorted by size, capped.
 * - `describeObjectChanges(prev, next)`: object-level diff — components
 *   matched across frames by (color, width, height, size) signature, with
 *   `moved`/`appeared`/`disappeared` lines, capped.
 *
 * Coordinates follow the package-wide convention: (x,y) = (column,row).
 * Everything here is pure and deterministic.
 */

import { changedCellCount, hexDigit } from "./render";

/** Default cap on listed components in `summarizeObjects`. */
export const SUMMARY_OBJECT_CAP = 16;

/** Default cap on lines in `describeObjectChanges`. */
export const CHANGE_LINE_CAP = 12;

export interface GridObject {
  color: number;
  /** Number of cells in the component. */
  size: number;
  /** Inclusive bounding box; (x,y) = (column,row). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

/**
 * Connected-component labeling: 4-connectivity, same-color cells. Components
 * are returned in row-major order of their first-encountered cell.
 */
export function segmentObjects(grid: number[][]): GridObject[] {
  const height = grid.length;
  const visited = grid.map((row) => new Uint8Array(row.length));
  const objects: GridObject[] = [];

  for (let y = 0; y < height; y++) {
    const row = grid[y] ?? [];
    for (let x = 0; x < row.length; x++) {
      if (visited[y]![x]) continue;
      const color = row[x]!;
      visited[y]![x] = 1;

      // Iterative flood fill with an explicit (x,y)-pair stack: 64x64 grids
      // would overflow a recursive fill.
      const stack: number[] = [x, y];
      let size = 0;
      let x0 = x;
      let y0 = y;
      let x1 = x;
      let y1 = y;

      while (stack.length > 0) {
        const cy = stack.pop()!;
        const cx = stack.pop()!;
        size++;
        if (cx < x0) x0 = cx;
        if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;

        for (const [nx, ny] of [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ] as const) {
          if (ny < 0 || ny >= height) continue;
          const nrow = grid[ny] ?? [];
          if (nx < 0 || nx >= nrow.length) continue;
          if (visited[ny]![nx] || nrow[nx] !== color) continue;
          visited[ny]![nx] = 1;
          stack.push(nx, ny);
        }
      }

      objects.push({ color, size, x0, y0, x1, y1 });
    }
  }
  return objects;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function objectWidth(obj: GridObject): number {
  return obj.x1 - obj.x0 + 1;
}

function objectHeight(obj: GridObject): number {
  return obj.y1 - obj.y0 + 1;
}

function cellNoun(n: number): string {
  return n === 1 ? "cell" : "cells";
}

/** `color 3 5x5 rect (25 cells) at (34,40)..(38,44)` — one inventory line. */
function describeObject(obj: GridObject): string {
  const w = objectWidth(obj);
  const h = objectHeight(obj);
  // "rect" only when exact (solid bbox); 1x1 is trivially solid, skip it.
  const rect = obj.size === w * h && obj.size > 1 ? " rect" : "";
  const at =
    w === 1 && h === 1
      ? `(${obj.x0},${obj.y0})`
      : `(${obj.x0},${obj.y0})..(${obj.x1},${obj.y1})`;
  return (
    `color ${hexDigit(obj.color)} ${w}x${h}${rect} ` +
    `(${obj.size} ${cellNoun(obj.size)}) at ${at}`
  );
}

/**
 * Compact object inventory for the LLM: the background (single largest
 * component) as `bg=<color> (<size> cells)`, then remaining components sorted
 * by size descending, capped at `maxObjects` (default SUMMARY_OBJECT_CAP)
 * with a trailing count line.
 */
export function summarizeObjects(
  grid: number[][],
  opts: { maxObjects?: number } = {},
): string {
  const maxObjects = opts.maxObjects ?? SUMMARY_OBJECT_CAP;
  const objects = segmentObjects(grid);
  if (objects.length === 0) return "no objects";

  let bgIndex = 0;
  for (let i = 1; i < objects.length; i++) {
    if (objects[i]!.size > objects[bgIndex]!.size) bgIndex = i;
  }
  const bg = objects[bgIndex]!;
  // Stable sort: equal sizes keep row-major discovery order.
  const rest = objects
    .filter((_, i) => i !== bgIndex)
    .sort((a, b) => b.size - a.size);

  const lines = [`bg=${hexDigit(bg.color)} (${bg.size} ${cellNoun(bg.size)})`];
  for (const obj of rest.slice(0, maxObjects)) lines.push(describeObject(obj));

  const omitted = rest.slice(maxObjects);
  if (omitted.length > 0) {
    const singles = omitted.filter((o) => o.size === 1).length;
    if (singles === omitted.length) {
      // Tiny-noise guard: a pile of stray pixels collapses to one count.
      lines.push(`…and ${singles} more single cells`);
    } else {
      const smallest = omitted[omitted.length - 1]!.size;
      lines.push(
        `…and ${omitted.length} more (smallest ${smallest} ${cellNoun(smallest)})`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Object-level diff
// ---------------------------------------------------------------------------

/** Foreground components: everything except the single largest (background). */
function foregroundObjects(grid: number[][]): GridObject[] {
  const objects = segmentObjects(grid);
  if (objects.length <= 1) return [];
  let bgIndex = 0;
  for (let i = 1; i < objects.length; i++) {
    if (objects[i]!.size > objects[bgIndex]!.size) bgIndex = i;
  }
  return objects.filter((_, i) => i !== bgIndex);
}

/** Match key: same color, same dims, same cell count. */
function signature(obj: GridObject): string {
  return `${obj.color}|${objectWidth(obj)}x${objectHeight(obj)}|${obj.size}`;
}

function groupBySignature(objects: GridObject[]): Map<string, GridObject[]> {
  const groups = new Map<string, GridObject[]>();
  for (const obj of objects) {
    const key = signature(obj);
    const group = groups.get(key);
    if (group) group.push(obj);
    else groups.set(key, [obj]);
  }
  return groups;
}

function byPosition(a: GridObject, b: GridObject): number {
  return a.y0 - b.y0 || a.x0 - b.x0;
}

function position(obj: GridObject): string {
  return `(${obj.x0},${obj.y0})`;
}

/**
 * Object-level diff between two grids (each grid's background excluded).
 * Components are matched by (color, width, height, size) signature; within a
 * group of equal counts they pair by sorted (y0,x0) and report `moved` lines,
 * otherwise `appeared`/`disappeared` lines. Capped at `maxLines` (default
 * CHANGE_LINE_CAP). When cells changed but no object-level line can be made,
 * falls back to a single explanatory line.
 */
export function describeObjectChanges(
  prev: number[][],
  next: number[][],
  opts: { maxLines?: number } = {},
): string {
  const maxLines = opts.maxLines ?? CHANGE_LINE_CAP;
  const prevGroups = groupBySignature(foregroundObjects(prev));
  const nextGroups = groupBySignature(foregroundObjects(next));

  // Deterministic order: prev's discovery order, then next-only signatures.
  const keys = [...prevGroups.keys()];
  for (const key of nextGroups.keys()) {
    if (!prevGroups.has(key)) keys.push(key);
  }

  const lines: string[] = [];
  for (const key of keys) {
    const ps = (prevGroups.get(key) ?? []).slice().sort(byPosition);
    const ns = (nextGroups.get(key) ?? []).slice().sort(byPosition);
    const sample = (ps[0] ?? ns[0])!;
    const label =
      `color ${hexDigit(sample.color)} ` +
      `${objectWidth(sample)}x${objectHeight(sample)}`;

    if (ps.length > 0 && ps.length === ns.length) {
      // Equal counts: pair by sorted (y0,x0); only moved pairs are reported.
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i]!;
        const n = ns[i]!;
        if (p.x0 !== n.x0 || p.y0 !== n.y0) {
          lines.push(`${label} moved ${position(p)}→${position(n)}`);
        }
      }
      continue;
    }

    // Unequal counts (or signature in one frame only): cancel out the
    // position-stable objects, then report the leftovers.
    const nsLeft = [...ns];
    const psLeft: GridObject[] = [];
    for (const p of ps) {
      const j = nsLeft.findIndex((n) => n.x0 === p.x0 && n.y0 === p.y0);
      if (j >= 0) nsLeft.splice(j, 1);
      else psLeft.push(p);
    }
    if (nsLeft.length === 1) {
      lines.push(`${label} appeared at ${position(nsLeft[0]!)}`);
    } else if (nsLeft.length > 1) {
      const at = nsLeft.map(position).join(", ");
      lines.push(`${label}: ${nsLeft.length} appeared at ${at}`);
    }
    if (psLeft.length === 1) {
      lines.push(`${label} disappeared from ${position(psLeft[0]!)}`);
    } else if (psLeft.length > 1) {
      const from = psLeft.map(position).join(", ");
      lines.push(`${label}: ${psLeft.length} disappeared from ${from}`);
    }
  }

  if (lines.length === 0) {
    return changedCellCount(prev, next) > 0
      ? "no clean object moves (cell-level changes only)"
      : "no object changes";
  }
  if (lines.length > maxLines) {
    const extra = lines.length - maxLines;
    return [
      ...lines.slice(0, maxLines),
      `…and ${extra} more object changes`,
    ].join("\n");
  }
  return lines.join("\n");
}
