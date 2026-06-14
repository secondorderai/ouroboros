/**
 * Frame-history persistence for code-assisted reasoning.
 *
 * Every reset/act appends one JSON line capturing the raw integer grid plus the
 * action and outcome. The agent's `code-exec` tool loads this file to analyze
 * mechanics on ground-truth grids (exact diffs, object tracking, transition
 * models, path search) instead of re-parsing rendered text — and crucially it
 * survives LLM context compaction, so the full transition history (including
 * deaths) remains available after old frames are dropped from the chat.
 *
 * Path: <ARC_FRAME_LOG_DIR or cwd>/arc-history-<game_id>.jsonl. The runner sets
 * ARC_FRAME_LOG_DIR to the agent's workdir so its code-exec reads the same dir.
 */

import { appendFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface HistoryRecord {
  /** Monotonic per-game sequence number (the running action count). */
  seq: number;
  /** "reset" begins/restarts a game; "act" is a single executed move. */
  t: "reset" | "act";
  /** Action number 1-6 (act only). */
  action?: number;
  /** ACTION6 coordinates (act only). */
  x?: number;
  y?: number;
  score: number;
  state: string;
  available_actions: number[];
  /** The settled 64x64 grid (last grid when the frame is animated). */
  frame: number[][];
}

/** Directory for history files: ARC_FRAME_LOG_DIR env, else the cwd. */
export function frameLogDir(): string {
  const dir = process.env.ARC_FRAME_LOG_DIR?.trim();
  return dir ? resolve(dir) : process.cwd();
}

/** Absolute path to a game's JSONL history file. */
export function frameLogPath(gameId: string): string {
  const safe = gameId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = frameLogDir();
  const file = `arc-history-${safe}.jsonl`;
  return isAbsolute(dir) ? join(dir, file) : resolve(dir, file);
}

/** Append one record as a JSON line. Never throws — logging must not break a tool. */
export function appendHistory(gameId: string, rec: HistoryRecord): void {
  try {
    appendFileSync(frameLogPath(gameId), `${JSON.stringify(rec)}\n`);
  } catch {
    // best-effort: a failed write must never abort a game command
  }
}
