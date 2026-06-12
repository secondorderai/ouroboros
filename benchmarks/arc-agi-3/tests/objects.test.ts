import { describe, expect, test } from "bun:test";
import {
  CHANGE_LINE_CAP,
  SUMMARY_OBJECT_CAP,
  describeObjectChanges,
  segmentObjects,
  summarizeObjects,
} from "../src/objects";

function zeros(size = 16): number[][] {
  return Array.from({ length: size }, () => new Array<number>(size).fill(0));
}

/** Stamp a solid w x h block of `color` with its top-left at (x,y). */
function stamp(
  grid: number[][],
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      grid[y + dy]![x + dx] = color;
    }
  }
}

describe("segmentObjects", () => {
  test("labels a multi-object grid with correct color, size, and bbox", () => {
    const grid = zeros(16);
    stamp(grid, 4, 5, 3, 2, 3); // 3x2 block of color 3
    grid[10]![12] = 2; // lone pixel of color 2

    const objects = segmentObjects(grid);
    expect(objects.length).toBe(3); // background + 2 objects
    expect(objects).toContainEqual({
      color: 3,
      size: 6,
      x0: 4,
      y0: 5,
      x1: 6,
      y1: 6,
    });
    expect(objects).toContainEqual({
      color: 2,
      size: 1,
      x0: 12,
      y0: 10,
      x1: 12,
      y1: 10,
    });
    // Background: 256 - 6 - 1 cells of color 0 spanning the whole grid.
    expect(objects).toContainEqual({
      color: 0,
      size: 249,
      x0: 0,
      y0: 0,
      x1: 15,
      y1: 15,
    });
  });

  test("4-connectivity: diagonal same-color cells are separate objects", () => {
    const grid = zeros(8);
    grid[1]![1] = 5;
    grid[2]![2] = 5; // touches only diagonally
    grid[2]![3] = 5; // orthogonally adjacent to (2,2) — merges with it

    const fives = segmentObjects(grid).filter((o) => o.color === 5);
    expect(fives.length).toBe(2);
    expect(fives).toContainEqual({ color: 5, size: 1, x0: 1, y0: 1, x1: 1, y1: 1 });
    expect(fives).toContainEqual({ color: 5, size: 2, x0: 2, y0: 2, x1: 3, y1: 2 });
  });

  test("bbox is correct for non-rectangular shapes", () => {
    const grid = zeros(8);
    // L-shape: (2,2), (2,3), (3,3) — 3 cells in a 2x2 bbox.
    grid[2]![2] = 7;
    grid[3]![2] = 7;
    grid[3]![3] = 7;

    const obj = segmentObjects(grid).find((o) => o.color === 7);
    expect(obj).toEqual({ color: 7, size: 3, x0: 2, y0: 2, x1: 3, y1: 3 });
  });

  test("a single-color grid is one component covering everything", () => {
    const grid = Array.from({ length: 4 }, () => [9, 9, 9, 9]);
    expect(segmentObjects(grid)).toEqual([
      { color: 9, size: 16, x0: 0, y0: 0, x1: 3, y1: 3 },
    ]);
  });

  test("empty grid yields no objects", () => {
    expect(segmentObjects([])).toEqual([]);
  });
});

describe("summarizeObjects", () => {
  test("picks the largest component as background and lists the rest by size", () => {
    const grid = zeros(8);
    stamp(grid, 1, 1, 2, 2, 3); // 4 cells
    grid[6]![6] = 5; // 1 cell

    const out = summarizeObjects(grid);
    const lines = out.split("\n");
    expect(lines[0]).toBe("bg=0 (59 cells)");
    expect(lines[1]).toBe("color 3 2x2 rect (4 cells) at (1,1)..(2,2)");
    expect(lines[2]).toBe("color 5 1x1 (1 cell) at (6,6)");
    expect(lines.length).toBe(3);
  });

  test("tags solid rectangles with rect, but not partial shapes", () => {
    const grid = zeros(8);
    stamp(grid, 1, 1, 3, 2, 4); // solid 3x2
    grid[5]![5] = 6; // L-shape: 3 cells in a 2x2 bbox
    grid[6]![5] = 6;
    grid[6]![6] = 6;

    const out = summarizeObjects(grid);
    expect(out).toContain("color 4 3x2 rect (6 cells) at (1,1)..(3,2)");
    expect(out).toContain("color 6 2x2 (3 cells) at (5,5)..(6,6)");
    expect(out).not.toContain("2x2 rect");
  });

  test("caps the list and summarizes the omitted tail", () => {
    const grid = zeros(16);
    // 4 objects of distinct sizes (none adjacent): 4, 3, 2, 2 cells.
    stamp(grid, 0, 0, 2, 2, 1);
    stamp(grid, 4, 0, 3, 1, 2);
    stamp(grid, 8, 0, 2, 1, 3);
    stamp(grid, 11, 0, 2, 1, 4);

    const out = summarizeObjects(grid, { maxObjects: 2 });
    const lines = out.split("\n");
    expect(lines.length).toBe(4); // bg + 2 objects + tail
    expect(lines[1]).toContain("color 1 2x2 rect (4 cells)");
    expect(lines[2]).toContain("color 2 3x1 rect (3 cells)");
    expect(lines[3]).toBe("…and 2 more (smallest 2 cells)");
  });

  test("tiny-noise guard: an all-single-cell tail collapses to a count", () => {
    const grid = zeros(16);
    stamp(grid, 0, 0, 2, 2, 1); // listed
    grid[4]![4] = 2;
    grid[8]![8] = 3;
    grid[12]![12] = 4;

    const out = summarizeObjects(grid, { maxObjects: 1 });
    expect(out.split("\n").pop()).toBe("…and 3 more single cells");
  });

  test("default cap is SUMMARY_OBJECT_CAP", () => {
    expect(SUMMARY_OBJECT_CAP).toBe(16);
    const grid = zeros(64);
    // 20 isolated single cells (every other column on one row).
    for (let i = 0; i < 20; i++) grid[1]![i * 2] = 7;
    const lines = summarizeObjects(grid).split("\n");
    expect(lines.length).toBe(1 + 16 + 1); // bg + cap + tail
    expect(lines.at(-1)).toBe("…and 4 more single cells");
  });

  test("degenerate grids: empty and single-color", () => {
    expect(summarizeObjects([])).toBe("no objects");
    expect(summarizeObjects([[2, 2]])).toBe("bg=2 (2 cells)");
  });
});

describe("describeObjectChanges", () => {
  test("reports a clean move with bbox top-left positions", () => {
    const prev = zeros(16);
    const next = zeros(16);
    stamp(prev, 1, 1, 2, 2, 3);
    stamp(next, 4, 5, 2, 2, 3);

    expect(describeObjectChanges(prev, next)).toBe(
      "color 3 2x2 moved (1,1)→(4,5)",
    );
  });

  test("reports appeared and disappeared objects", () => {
    const base = zeros(16);
    const withObj = zeros(16);
    withObj[6]![6] = 4;

    expect(describeObjectChanges(base, withObj)).toBe(
      "color 4 1x1 appeared at (6,6)",
    );
    expect(describeObjectChanges(withObj, base)).toBe(
      "color 4 1x1 disappeared from (6,6)",
    );
  });

  test("equal-count groups pair by sorted (y0,x0) and skip unmoved pairs", () => {
    const prev = zeros(16);
    const next = zeros(16);
    prev[1]![1] = 3;
    prev[5]![5] = 3;
    prev[9]![9] = 6; // unmoved bystander
    next[2]![1] = 3; // (1,1) -> (1,2)
    next[6]![5] = 3; // (5,5) -> (5,6)
    next[9]![9] = 6;

    expect(describeObjectChanges(prev, next)).toBe(
      ["color 3 1x1 moved (1,1)→(1,2)", "color 3 1x1 moved (5,5)→(5,6)"].join(
        "\n",
      ),
    );
  });

  test("unequal counts cancel position-stable objects and report leftovers", () => {
    const prev = zeros(16);
    const next = zeros(16);
    prev[3]![3] = 6;
    next[3]![3] = 6; // stable — must not be reported
    next[8]![8] = 6;
    next[8]![12] = 6;

    expect(describeObjectChanges(prev, next)).toBe(
      "color 6 1x1: 2 appeared at (8,8), (12,8)",
    );
  });

  test("falls back when cells changed but objects did not", () => {
    // The background flips 0->1 while the only object stays put: no object
    // line is possible, but cells did change.
    const prev = zeros(4);
    const next = Array.from({ length: 4 }, () => [1, 1, 1, 1]);
    prev[1]![1] = 3;
    next[1]![1] = 3;

    expect(describeObjectChanges(prev, next)).toBe(
      "no clean object moves (cell-level changes only)",
    );
  });

  test("identical grids report no object changes", () => {
    const grid = zeros(8);
    grid[2]![2] = 3;
    expect(describeObjectChanges(grid, grid)).toBe("no object changes");
  });

  test("caps the output at maxLines with a trailing count", () => {
    expect(CHANGE_LINE_CAP).toBe(12);
    const prev = zeros(16);
    const next = zeros(16);
    // 5 isolated single cells all move down one row.
    for (let i = 0; i < 5; i++) {
      prev[1]![i * 3] = 3;
      next[2]![i * 3] = 3;
    }

    const out = describeObjectChanges(prev, next, { maxLines: 2 });
    const lines = out.split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe("color 3 1x1 moved (0,1)→(0,2)");
    expect(lines[1]).toBe("color 3 1x1 moved (3,1)→(3,2)");
    expect(lines[2]).toBe("…and 3 more object changes");
  });
});
