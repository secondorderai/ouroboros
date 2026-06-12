import { describe, expect, test } from "bun:test";
import {
  DIFF_CELL_CAP,
  FULL_RENDER_CHANGE_RATIO,
  changedCellCount,
  changedCells,
  lastGrid,
  renderDiff,
  renderFrame,
  renderFrameDiff,
  renderFull,
  shouldRenderFull,
} from "../src/render";

function zeros(size = 64): number[][] {
  return Array.from({ length: size }, () => new Array<number>(size).fill(0));
}

describe("renderFull", () => {
  test("renders a 64x64 grid with a two-line column ruler and 2-digit row prefixes", () => {
    const grid = zeros();
    grid[5]![7] = 12; // hex 'c'
    grid[63]![63] = 15; // hex 'f'
    grid[0]![0] = 1;

    const out = renderFull(grid);
    const lines = out.split("\n");
    expect(lines.length).toBe(66); // 2 ruler lines + 64 rows

    // Ruler line 1: tens digits at every 10th column, 3-space prefix.
    expect(lines[0]).toBe(
      "   0         1         2         3         4         5         6   ",
    );
    // Ruler line 2: ones digits cycling 0-9, 3-space prefix.
    expect(lines[1]).toBe("   " + "0123456789".repeat(6) + "0123");

    // Row prefixes are 2-digit, zero-padded, followed by one space.
    expect(lines[2]!.startsWith("00 ")).toBe(true);
    expect(lines[2 + 5]!.startsWith("05 ")).toBe(true);
    expect(lines[65]!.startsWith("63 ")).toBe(true);

    // Each row line is exactly prefix (3 chars) + 64 hex digits.
    for (const line of lines.slice(2)) {
      expect(line.length).toBe(3 + 64);
    }

    // Cell values land at prefix offset + x, as lowercase hex.
    expect(lines[2]![3 + 0]).toBe("1");
    expect(lines[2 + 5]![3 + 7]).toBe("c");
    expect(lines[65]![3 + 63]).toBe("f");
    expect(out).not.toMatch(/[A-F]/); // lowercase hex only
  });

  test("exact output for a tiny grid", () => {
    const out = renderFull([
      [0, 10, 2],
      [3, 0, 15],
    ]);
    expect(out).toBe(["   0  ", "   012", "00 0a2", "01 30f"].join("\n"));
  });

  test("out-of-palette values render as ?", () => {
    const out = renderFull([[16, -1, 0.5]]);
    expect(out.split("\n")[2]).toBe("00 ???");
  });
});

describe("renderDiff", () => {
  test("lists changed cells as (x,y) from→to in row-major order", () => {
    const prev = zeros(8);
    const next = zeros(8);
    next[5]![7] = 12; // (x=7, y=5) 0→c
    next[2]![1] = 4; // (x=1, y=2) 0→4

    expect(renderDiff(prev, next)).toBe(
      "changed 2 cells: (1,2) 0→4, (7,5) 0→c",
    );
  });

  test("uses singular noun for one cell and reports no-op diffs", () => {
    const prev = zeros(4);
    const next = zeros(4);
    next[0]![3] = 9;
    expect(renderDiff(prev, next)).toBe("changed 1 cell: (3,0) 0→9");
    expect(renderDiff(prev, prev)).toBe("no cells changed");
  });

  test("caps the list at 30 cells, then summarizes region and transitions", () => {
    const prev = zeros();
    const next = zeros();
    // 100 changed cells in rows 10-19, columns 20-29 (region known exactly).
    let flipped = 0;
    for (let y = 10; y < 20; y++) {
      for (let x = 20; x < 30; x++) {
        next[y]![x] = flipped < 70 ? 3 : 5; // two distinct transitions
        flipped++;
      }
    }

    const out = renderDiff(prev, next);
    expect(out.startsWith("changed 100 cells: ")).toBe(true);

    // Exactly DIFF_CELL_CAP cells are listed.
    const listedCells = out.match(/\(\d+,\d+\) \d→\d/g) ?? [];
    expect(listedCells.length).toBe(DIFF_CELL_CAP);
    expect(DIFF_CELL_CAP).toBe(30);

    expect(out).toContain("… and 70 more");
    expect(out).toContain("region x∈[20,29] y∈[10,19]");
    expect(out).toContain("transitions: 0→3 ×70, 0→5 ×30");
  });

  test("does not append a summary at or below the cap", () => {
    const prev = zeros();
    const next = zeros();
    for (let x = 0; x < DIFF_CELL_CAP; x++) next[0]![x] = 1;
    const out = renderDiff(prev, next);
    expect(out).toContain(`changed ${DIFF_CELL_CAP} cells: `);
    expect(out).not.toContain("more");
    expect(out).not.toContain("region");
  });
});

describe("changed-cell helpers", () => {
  test("changedCellCount counts differing cells, zero for identical grids", () => {
    const prev = zeros(8);
    const next = zeros(8);
    expect(changedCellCount(prev, next)).toBe(0);
    next[1]![1] = 7;
    next[6]![3] = 2;
    expect(changedCellCount(prev, next)).toBe(2);
  });

  test("changedCells handles dimension mismatches without throwing", () => {
    const prev = [[1, 2]];
    const next = [
      [1, 2, 3],
      [4],
    ];
    const changes = changedCells(prev, next);
    expect(changes).toEqual([
      { x: 2, y: 0, from: -1, to: 3 },
      { x: 0, y: 1, from: -1, to: 4 },
    ]);
  });

  test("shouldRenderFull triggers above the 40% threshold", () => {
    expect(FULL_RENDER_CHANGE_RATIO).toBe(0.4);
    const prev = zeros(10); // 100 cells
    const at40 = zeros(10);
    const above40 = zeros(10);
    let n = 0;
    for (let y = 0; y < 10 && n < 41; y++) {
      for (let x = 0; x < 10 && n < 41; x++) {
        if (n < 40) at40[y]![x] = 1;
        above40[y]![x] = 1;
        n++;
      }
    }
    expect(shouldRenderFull(prev, at40)).toBe(false); // exactly 40% is not >40%
    expect(shouldRenderFull(prev, above40)).toBe(true); // 41%
  });
});

describe("multi-grid frames", () => {
  const gridA = [
    [1, 1],
    [1, 1],
  ];
  const gridB = [
    [2, 2],
    [2, 3],
  ];

  test("renderFrame renders the last grid and reports the grid count", () => {
    const out = renderFrame([gridA, gridB]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("frame contains 2 grids; showing last");
    expect(lines.slice(1).join("\n")).toBe(renderFull(gridB));
  });

  test("renderFrame omits the note for single-grid frames", () => {
    expect(renderFrame([gridA])).toBe(renderFull(gridA));
  });

  test("renderFrameDiff diffs the last grids of each frame", () => {
    const out = renderFrameDiff([gridA], [gridA, gridB]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("frame contains 2 grids; diff vs last grid");
    expect(lines[1]).toBe(renderDiff(gridA, gridB));
  });

  test("lastGrid returns an empty grid for empty frames", () => {
    expect(lastGrid([])).toEqual([]);
    expect(renderFull(lastGrid([]))).toBe("   \n   ");
  });
});
