/**
 * Unit tests for frame-history persistence (src/history.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { appendHistory, frameLogPath, type HistoryRecord } from "../src/history";

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.ARC_FRAME_LOG_DIR;
  dir = mkdtempSync(join(tmpdir(), "arc-hist-"));
  process.env.ARC_FRAME_LOG_DIR = dir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ARC_FRAME_LOG_DIR;
  else process.env.ARC_FRAME_LOG_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

const rec = (over: Partial<HistoryRecord> = {}): HistoryRecord => ({
  seq: 0,
  t: "reset",
  score: 0,
  state: "NOT_FINISHED",
  available_actions: [1, 2, 3, 4],
  frame: [
    [0, 1],
    [2, 3],
  ],
  ...over,
});

describe("frameLogPath", () => {
  test("uses ARC_FRAME_LOG_DIR and a sanitized game id", () => {
    const p = frameLogPath("ls20-9607627b");
    expect(isAbsolute(p)).toBe(true);
    expect(p).toBe(join(dir, "arc-history-ls20-9607627b.jsonl"));
  });

  test("sanitizes unsafe characters in the game id", () => {
    const p = frameLogPath("a/b c:d");
    expect(p).toBe(join(dir, "arc-history-a_b_c_d.jsonl"));
  });

  test("falls back to cwd when the env var is unset", () => {
    delete process.env.ARC_FRAME_LOG_DIR;
    const p = frameLogPath("g1");
    expect(p).toBe(join(process.cwd(), "arc-history-g1.jsonl"));
  });
});

describe("appendHistory", () => {
  test("writes one JSON line per record, in order", () => {
    appendHistory("g1", rec({ seq: 0, t: "reset" }));
    appendHistory("g1", rec({ seq: 1, t: "act", action: 2, score: 1 }));
    const lines = readFileSync(frameLogPath("g1"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as HistoryRecord);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.t).toBe("reset");
    expect(lines[1]!).toMatchObject({ seq: 1, t: "act", action: 2, score: 1 });
    // Raw integer grid is preserved for code analysis.
    expect(lines[1]!.frame).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  test("keeps separate files per game", () => {
    appendHistory("g1", rec());
    appendHistory("g2", rec());
    expect(readFileSync(frameLogPath("g1"), "utf-8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(frameLogPath("g2"), "utf-8").trim().split("\n")).toHaveLength(1);
  });

  test("never throws when the directory is invalid", () => {
    process.env.ARC_FRAME_LOG_DIR = "/no/such/dir/at/all";
    expect(() => appendHistory("g1", rec())).not.toThrow();
  });
});
