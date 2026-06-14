/**
 * In-process tests for the ARC MCP server (src/server.ts).
 *
 * The MCP server is wired to an MCP client via the SDK's InMemoryTransport
 * linked pair; the server's HTTP client talks to the local mock ARC server
 * (tests/mock-arc-server.ts) via ARC_BASE_URL.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createArcServer } from "../src/server";
import { frameLogPath, type HistoryRecord } from "../src/history";
import {
  MOCK_GAMES,
  MOCK_L2_MARK,
  startMockArcServer,
  type MockArcServer,
} from "./mock-arc-server";

const GAME1 = MOCK_GAMES[0]!.game_id; // toy1-abc123
const GAME2 = MOCK_GAMES[1]!.game_id; // toy2-def456

interface ToolReply {
  text: string;
  isError: boolean;
}

let mock: MockArcServer;
let server: ReturnType<typeof createArcServer>;
let client: Client;
let frameLogDir: string;

async function connectServer(): Promise<void> {
  server = createArcServer({
    // Keep retries fast in tests; Retry-After (when set) still overrides.
    clientOptions: { retryDelayMs: 10 },
  });
  client = new Client({ name: "arc-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
}

beforeEach(async () => {
  mock = startMockArcServer();
  process.env.ARC_API_KEY = mock.apiKey;
  process.env.ARC_BASE_URL = mock.url;
  delete process.env.ARC_CARD_ID;
  delete process.env.ARC_COOKIES;
  // Isolate frame-history writes to a temp dir (don't pollute the repo).
  frameLogDir = mkdtempSync(join(tmpdir(), "arc-srv-hist-"));
  process.env.ARC_FRAME_LOG_DIR = frameLogDir;
  await connectServer();
});

afterEach(async () => {
  await client.close();
  await server.close();
  mock.stop();
  delete process.env.ARC_FRAME_LOG_DIR;
  rmSync(frameLogDir, { recursive: true, force: true });
});

function readHistory(gameId: string): HistoryRecord[] {
  return readFileSync(frameLogPath(gameId), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as HistoryRecord);
}

function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolReply> {
  return client
    .callTool({ name, arguments: args })
    .then((res) => {
      const result = res as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return { text, isError: result.isError === true };
    });
}

function actionRequests() {
  return mock.requests.filter((r) => /^\/api\/cmd\/ACTION\d$/.test(r.path));
}

describe("list_games", () => {
  test("returns every mock game with its title", async () => {
    const res = await call("list_games");
    expect(res.isError).toBe(false);
    expect(res.text).toContain("2 game(s)");
    expect(res.text).toContain("toy1-abc123 — Toy Maze 1");
    expect(res.text).toContain("toy2-def456 — Toy Maze 2");
  });
});

describe("reset", () => {
  test("starts a session and returns a full frame + status line", async () => {
    const res = await call("reset", { game_id: GAME1 });
    expect(res.isError).toBe(false);
    expect(res.text).toContain(`RESET ${GAME1}`);
    expect(res.text).toContain("guid guid-1");
    // Full render: row 02 has the player (color 3) at x=2.
    expect(res.text).toContain("02 003");
    // Object inventory follows the hex grid: bg + player + level-1 target.
    expect(res.text).toContain("bg=0 (4094 cells)");
    expect(res.text).toContain("color 3 1x1 (1 cell) at (2,2)");
    expect(res.text).toContain("color 2 1x1 (1 cell) at (2,7)");
    expect(res.text).toContain(
      "state=NOT_FINISHED score=0/2 available_actions=[1,2,3,4] total_actions=0",
    );
    // Surfaces the frame-history path for code-assisted reasoning.
    expect(res.text).toContain(`frame_history=${frameLogPath(GAME1)}`);
  });

  test("second reset reuses the prior guid", async () => {
    await call("reset", { game_id: GAME1 });
    await call("reset", { game_id: GAME1 });
    const resets = mock.requests.filter((r) => r.path === "/api/cmd/RESET");
    expect(resets.length).toBe(2);
    expect((resets[0]!.body as { guid?: string }).guid).toBeUndefined();
    expect((resets[1]!.body as { guid?: string }).guid).toBe("guid-1");
    expect(mock.listSessions().length).toBe(1);
  });

  test("card_id falls back to ARC_CARD_ID env; client picks up ARC_COOKIES", async () => {
    const open = await fetch(`${mock.url}/api/scorecard/open`, {
      method: "POST",
      headers: { "X-API-Key": mock.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["test"] }),
    });
    const { card_id } = (await open.json()) as { card_id: string };
    process.env.ARC_CARD_ID = card_id;
    // The mock simulates ALB cookie affinity: without forwarding the open
    // call's AWSALB cookie via ARC_COOKIES, this reset would fail with the
    // live API's "game ... not found" error.
    const alb = open.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((pair) => pair.startsWith("AWSALB="));
    expect(alb).toBeDefined();
    process.env.ARC_COOKIES = alb!;

    const res = await call("reset", { game_id: GAME1 });
    expect(res.isError).toBe(false);
    const reset = mock.requests.find((r) => r.path === "/api/cmd/RESET");
    expect((reset!.body as { card_id?: string }).card_id).toBe(card_id);
    expect(reset!.cookie).toContain(alb!);
    expect(mock.getScorecard(card_id)?.cards[GAME1]?.total_plays).toBe(1);
  });

  test("after reset, a keep-alive ping refreshes scorecard affinity", async () => {
    // Regression: ALB affinity can lapse during long LLM-thinking gaps with
    // no requests, after which every command fails with "game not found".
    const open = await fetch(`${mock.url}/api/scorecard/open`, {
      method: "POST",
      headers: { "X-API-Key": mock.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["test"] }),
    });
    const { card_id } = (await open.json()) as { card_id: string };
    process.env.ARC_CARD_ID = card_id;
    const alb = open.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((pair) => pair.startsWith("AWSALB="));
    process.env.ARC_COOKIES = alb!;
    process.env.ARC_KEEPALIVE_MS = "40";
    // Reconnect so the server reads the env knobs fresh.
    await client.close();
    await server.close();
    await connectServer();

    const res = await call("reset", { game_id: GAME1 });
    expect(res.isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const pings = mock.requests.filter(
      (r) => r.path === `/api/scorecard/${card_id}`,
    );
    expect(pings.length).toBeGreaterThanOrEqual(1);
    expect(pings[0]!.cookie).toContain("AWSALB=");
    delete process.env.ARC_KEEPALIVE_MS;
  });

  test('card_id: "" from the model is treated as absent (env wins)', async () => {
    // Regression: live models pass card_id: "" for "I don't know it"; with a
    // nullish-only fallback the empty string reached the API and every RESET
    // failed with "game not found".
    const open = await fetch(`${mock.url}/api/scorecard/open`, {
      method: "POST",
      headers: { "X-API-Key": mock.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["test"] }),
    });
    const { card_id } = (await open.json()) as { card_id: string };
    process.env.ARC_CARD_ID = card_id;
    const alb = open.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((pair) => pair.startsWith("AWSALB="));
    process.env.ARC_COOKIES = alb!;

    const res = await call("reset", { game_id: GAME1, card_id: "" });
    expect(res.isError).toBe(false);
    const reset = mock.requests.find((r) => r.path === "/api/cmd/RESET");
    expect((reset!.body as { card_id?: string }).card_id).toBe(card_id);
  });
});

describe("act", () => {
  test("happy path: per-move lines, diff render, status line", async () => {
    await call("reset", { game_id: GAME1 });
    const res = await call("act", {
      game_id: GAME1,
      moves: [{ action: 2 }, { action: 2, note: "probing down" }, { action: 2 }],
    });
    expect(res.isError).toBe(false);
    // Per-move lines carry the clean object-move annotation for the player.
    expect(res.text).toContain(
      "#1 ACTION2 → 2 cells changed (color 3 1x1 moved (2,2)→(2,3))",
    );
    expect(res.text).toContain(
      "#2 ACTION2 → 2 cells changed (color 3 1x1 moved (2,3)→(2,4))",
    );
    expect(res.text).toContain(
      "#3 ACTION2 → 2 cells changed (color 3 1x1 moved (2,4)→(2,5))",
    );
    // Diff vs the pre-batch frame: player moved (2,2) -> (2,5).
    expect(res.text).toContain("changed 2 cells");
    expect(res.text).toContain("(2,2) 3→0");
    expect(res.text).toContain("(2,5) 0→3");
    // Object-level diff section follows the cell diff.
    expect(res.text).toContain("objects:\ncolor 3 1x1 moved (2,2)→(2,5)");
    expect(res.text).toContain(
      "state=NOT_FINISHED score=0/2 available_actions=[1,2,3,4] total_actions=3",
    );
    // note forwarded as the reasoning body field.
    const reasonings = actionRequests().map(
      (r) => (r.body as { reasoning?: string }).reasoning,
    );
    expect(reasonings).toEqual([undefined, "probing down", undefined]);
  });

  test("accepts a 25-move batch (level-replay macros need >20)", async () => {
    // Regression for the 20→40 cap raise: a replay of a learned level must
    // fit in one act call so a death costs steps, not the whole budget.
    await call("reset", { game_id: GAME1 });
    // Alternate down/up so the player oscillates without scoring or dying.
    const moves = Array.from({ length: 25 }, (_, i) => ({
      action: i % 2 === 0 ? 2 : 1,
    }));
    const res = await call("act", { game_id: GAME1, moves });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("#25 ACTION");
    expect(actionRequests()).toHaveLength(25);
  });

  test("render: 'full' forces a full frame render", async () => {
    await call("reset", { game_id: GAME1 });
    const res = await call("act", {
      game_id: GAME1,
      moves: [{ action: 2 }],
      render: "full",
    });
    expect(res.isError).toBe(false);
    // Full render includes the row-index column ruler, not the diff header.
    expect(res.text).not.toContain("changed 2 cells");
    expect(res.text).toContain("03 003"); // player now at (2,3)
    // Full renders carry the object inventory instead of the objects: diff.
    expect(res.text).toContain("bg=0 (4094 cells)");
    expect(res.text).toContain("color 3 1x1 (1 cell) at (2,3)");
    expect(res.text).not.toContain("objects:");
  });

  test("early-stops the batch when the score changes", async () => {
    await call("reset", { game_id: GAME1 });
    // 5 downs reach the level-1 target; the other 5 must not execute.
    const res = await call("act", {
      game_id: GAME1,
      moves: Array.from({ length: 10 }, () => ({ action: 2 })),
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("#5 ACTION2");
    expect(res.text).toContain("score 0→1");
    expect(res.text).toContain("early stop after move #5");
    expect(res.text).not.toContain("#6 ");
    expect(res.text).toContain(
      "state=NOT_FINISHED score=1/2 available_actions=[6] total_actions=5",
    );
    expect(actionRequests().length).toBe(5);
    expect(mock.getSession("guid-1")?.actionCount).toBe(5);
  });

  test("early-stops the batch on GAME_OVER", async () => {
    await call("reset", { game_id: GAME1 });
    // From (2,2), two ups reach y=0; three more off-grid attempts => GAME_OVER.
    const res = await call("act", {
      game_id: GAME1,
      moves: Array.from({ length: 10 }, () => ({ action: 1 })),
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("state → GAME_OVER");
    expect(res.text).toContain("early stop after move #5: state GAME_OVER");
    expect(res.text).not.toContain("#6 ");
    expect(res.text).toContain(
      "state=GAME_OVER score=0/2 available_actions=[] total_actions=5",
    );
    expect(actionRequests().length).toBe(5);
  });

  test("plays through to WIN with ACTION6 on level 2", async () => {
    await call("reset", { game_id: GAME1 });
    await call("act", {
      game_id: GAME1,
      moves: Array.from({ length: 5 }, () => ({ action: 2 })),
    });
    const res = await call("act", {
      game_id: GAME1,
      moves: [{ action: 6, x: MOCK_L2_MARK.x, y: MOCK_L2_MARK.y }],
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain(`#1 ACTION6(${MOCK_L2_MARK.x},${MOCK_L2_MARK.y})`);
    expect(res.text).toContain("score 1→2");
    expect(res.text).toContain("state → WIN");
    expect(res.text).toContain(
      "state=WIN score=2/2 available_actions=[] total_actions=6",
    );
  });

  test("rejects ACTION6 without x/y before executing anything", async () => {
    await call("reset", { game_id: GAME1 });
    const before = actionRequests().length;
    const res = await call("act", {
      game_id: GAME1,
      moves: [{ action: 6 }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("ACTION6 requires x and y");
    expect(actionRequests().length).toBe(before);
  });

  test("rejects an unavailable action, listing the valid ones", async () => {
    await call("reset", { game_id: GAME1 });
    // Level 1 only allows actions 1-4.
    const res = await call("act", {
      game_id: GAME1,
      moves: [{ action: 6, x: 30, y: 30 }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("ACTION6 is not available");
    expect(res.text).toContain("[1,2,3,4]");
    expect(actionRequests().length).toBe(0);
  });

  test("act before reset is a tool error", async () => {
    const res = await call("act", {
      game_id: GAME2,
      moves: [{ action: 2 }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`No active session for game "${GAME2}"`);
    expect(res.text).toContain("reset");
  });

  test("network failure surfaces as a tool error, not a crash", async () => {
    await call("reset", { game_id: GAME1 });
    // Exhaust all 3 client attempts; Retry-After: 0 keeps retries instant.
    mock.failNext({ status: 500, retryAfter: 0, times: 3 });
    const res = await call("act", {
      game_id: GAME1,
      moves: [{ action: 2 }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("#1 ACTION2 failed");
    expect(res.text).toContain("500");
    // The server stays alive and serves subsequent calls.
    const after = await call("act", { game_id: GAME1, moves: [{ action: 2 }] });
    expect(after.isError).toBe(false);
    expect(after.text).toContain("#1 ACTION2 → 2 cells changed");
  });
});

describe("status", () => {
  test("status before reset for a game_id is a tool error", async () => {
    const res = await call("status", { game_id: GAME1 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`No active session for game "${GAME1}"`);
  });

  test("without game_id lists tracked sessions; with game_id re-renders, all without API calls", async () => {
    await call("reset", { game_id: GAME1 });
    await call("act", { game_id: GAME1, moves: [{ action: 2 }, { action: 2 }] });
    await call("reset", { game_id: GAME2 });
    const requestsBefore = mock.requests.length;

    const list = await call("status");
    expect(list.isError).toBe(false);
    expect(list.text).toContain(
      `${GAME1}: guid=guid-1 state=NOT_FINISHED score=0 actions=2`,
    );
    expect(list.text).toContain(
      `${GAME2}: guid=guid-2 state=NOT_FINISHED score=0 actions=0`,
    );

    const one = await call("status", { game_id: GAME1 });
    expect(one.isError).toBe(false);
    expect(one.text).toContain(`${GAME1} guid=guid-1`);
    expect(one.text).toContain("04 003"); // cached frame: player at (2,4)
    expect(one.text).toContain("bg=0 (4094 cells)");
    expect(one.text).toContain("color 3 1x1 (1 cell) at (2,4)");
    expect(one.text).toContain(
      "state=NOT_FINISHED score=0/2 available_actions=[1,2,3,4] total_actions=2",
    );

    // No API calls were made by either status invocation.
    expect(mock.requests.length).toBe(requestsBefore);
  });

  test("without game_id and no sessions reports none tracked", async () => {
    const res = await call("status");
    expect(res.isError).toBe(false);
    expect(res.text).toContain("No tracked sessions");
  });
});

describe("serialization", () => {
  test("concurrent tool calls execute in FIFO order", async () => {
    await call("reset", { game_id: GAME1 });
    // Slow down the first ACTION of batch A: without the FIFO queue, batch
    // B's moves would reach the mock before A finishes.
    mock.delayNext(75);
    const a = call("act", {
      game_id: GAME1,
      moves: [
        { action: 2, note: "A1" },
        { action: 2, note: "A2" },
      ],
    });
    const b = call("act", {
      game_id: GAME1,
      moves: [
        { action: 2, note: "B1" },
        { action: 2, note: "B2" },
        { action: 2, note: "B3" },
      ],
    });
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.isError).toBe(false);
    expect(resB.isError).toBe(false);

    const reasonings = actionRequests().map(
      (r) => (r.body as { reasoning?: string }).reasoning,
    );
    expect(reasonings).toEqual(["A1", "A2", "B1", "B2", "B3"]);
    // 5 downs total: batch B's last move reaches the target.
    expect(resB.text).toContain("score 0→1");
  });
});

describe("frame history (code-assisted reasoning)", () => {
  test("reset then act append raw grids to the per-game JSONL", async () => {
    await call("reset", { game_id: GAME1 });
    await call("act", { game_id: GAME1, moves: [{ action: 2 }, { action: 2 }] });

    const hist = readHistory(GAME1);
    expect(hist).toHaveLength(3); // 1 reset + 2 acts
    expect(hist[0]!).toMatchObject({ seq: 0, t: "reset", state: "NOT_FINISHED" });
    expect(hist[1]!).toMatchObject({ seq: 1, t: "act", action: 2 });
    expect(hist[2]!).toMatchObject({ seq: 2, t: "act", action: 2 });
    // The raw 64x64 integer grid is persisted for code analysis.
    expect(hist[0]!.frame.length).toBe(64);
    expect(hist[0]!.frame[0]!.length).toBe(64);
    // The player (color 3) moved from row 2 to row 4 over two downs.
    expect(hist[0]!.frame[2]![2]).toBe(3);
    expect(hist[2]!.frame[4]![2]).toBe(3);
  });

  test("ACTION6 coordinates are recorded in the history", async () => {
    await call("reset", { game_id: GAME1 });
    // Clear level 1 (5 downs) so ACTION6 becomes available for level 2.
    await call("act", { game_id: GAME1, moves: Array.from({ length: 5 }, () => ({ action: 2 })) });
    await call("act", {
      game_id: GAME1,
      moves: [{ action: 6, x: MOCK_L2_MARK.x, y: MOCK_L2_MARK.y }],
    });
    const last = readHistory(GAME1).at(-1)!;
    expect(last).toMatchObject({ t: "act", action: 6, x: MOCK_L2_MARK.x, y: MOCK_L2_MARK.y });
  });
});

describe("missing ARC_API_KEY", () => {
  test("every tool returns a clear error naming the env var", async () => {
    // Replace the default harness with a key-less one.
    await client.close();
    await server.close();
    delete process.env.ARC_API_KEY;
    await connectServer();

    const res = await call("list_games");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("ARC_API_KEY");

    const reset = await call("reset", { game_id: GAME1 });
    expect(reset.isError).toBe(true);
    expect(reset.text).toContain("ARC_API_KEY");
  });
});
