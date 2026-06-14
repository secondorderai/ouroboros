/**
 * Runner tests: pure helpers, the NDJSON RPC client, and the orchestration
 * loop driven by an injected fake agent + the mock ARC server. No real CLI
 * spawn, no LLM, no network beyond localhost.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
  buildBenchConfig,
  buildGoal,
  buildContinueMessage,
  MAX_NO_PROGRESS_CONTINUATIONS,
  formatSummaryTable,
  extractGameStats,
  describeNotification,
  readUserConfig,
  raceWallClock,
  runArcBenchmark,
  NdjsonRpcClient,
  RpcError,
  SKILLS_DIR,
  MCP_SERVER_ENTRY,
  SKILL_NAME,
  type AgentProcess,
  type GameRunRow,
  type RunnerDeps,
} from "../src/runner";
import type { ArcBenchOptions } from "../src/options";
import { ArcClient } from "../src/client";
import {
  startMockArcServer,
  MOCK_GAMES,
  MOCK_API_KEY,
  MOCK_L2_MARK,
  type MockArcServer,
} from "./mock-arc-server";

const GAME1 = MOCK_GAMES[0]!.game_id;
const GAME2 = MOCK_GAMES[1]!.game_id;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildBenchConfig", () => {
  const userConfig = {
    model: { provider: "anthropic", name: "claude-opus-4", reasoningEffort: "high" },
    permissions: { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false },
    skillDirectories: ["skills/core"],
    verifier: { trigger: "always", minToolCalls: 1 },
  };

  test("preserves the user's model and unrelated blocks", () => {
    const config = buildBenchConfig(userConfig, { apiKey: "k", cardId: "c1" });
    expect(config.model).toEqual(userConfig.model);
    expect(config.permissions).toEqual(userConfig.permissions);
  });

  test("defaults model to openai-chatgpt when config has only OAuth auth", () => {
    const oauthOnly = {
      auth: { "openai-chatgpt": { type: "oauth", refresh: "r", access: "a" } },
      permissions: userConfig.permissions,
    };
    const config = buildBenchConfig(oauthOnly, { apiKey: "k", cardId: "c1" });
    expect(config.model).toEqual({ provider: "openai-chatgpt", name: "gpt-5.5" });
  });

  test("user model block wins over OAuth-derived default", () => {
    const both = {
      ...userConfig,
      auth: { "openai-chatgpt": { type: "oauth", refresh: "r", access: "a" } },
    };
    const config = buildBenchConfig(both, { apiKey: "k", cardId: "c1" });
    expect(config.model).toEqual(userConfig.model);
  });

  test("leaves model unset without user model or OAuth auth", () => {
    const config = buildBenchConfig({}, { apiKey: "k", cardId: "c1" });
    expect(config.model).toBeUndefined();
  });

  test("forces verifier off and replaces skillDirectories with the absolute bench dir", () => {
    const config = buildBenchConfig(userConfig, { apiKey: "k", cardId: "c1" });
    expect(config.verifier).toEqual({ trigger: "off" });
    expect(config.skillDirectories).toEqual([SKILLS_DIR]);
    expect(isAbsolute(SKILLS_DIR)).toBe(true);
    expect(SKILLS_DIR.endsWith(join("benchmarks", "arc-agi-3", "skills"))).toBe(true);
  });

  test("declares the arc MCP server with absolute entry, env, and no approval", () => {
    const config = buildBenchConfig(userConfig, {
      apiKey: "key-1",
      cardId: "card-9",
      baseUrl: "http://localhost:1234",
    });
    const mcp = config.mcp as { servers: Array<Record<string, unknown>> };
    expect(mcp.servers).toHaveLength(1);
    const server = mcp.servers[0]!;
    expect(server.type).toBe("local");
    expect(server.name).toBe("arc");
    expect(server.command).toBe("bun");
    expect(server.args).toEqual(["run", MCP_SERVER_ENTRY]);
    expect(isAbsolute(MCP_SERVER_ENTRY)).toBe(true);
    expect(server.requireApproval).toBe(false);
    expect(server.env).toEqual({
      ARC_API_KEY: "key-1",
      ARC_CARD_ID: "card-9",
      ARC_BASE_URL: "http://localhost:1234",
    });
  });

  test("omits ARC_BASE_URL when no base url is provided", () => {
    const config = buildBenchConfig({}, { apiKey: "k", cardId: "c" });
    const mcp = config.mcp as { servers: Array<{ env: Record<string, string> }> };
    expect(Object.keys(mcp.servers[0]!.env)).toEqual(["ARC_API_KEY", "ARC_CARD_ID"]);
  });

  test("forwards cookies as ARC_COOKIES in the arc MCP server env", () => {
    // Regression: without this, the MCP server lands on a different ALB node
    // and every RESET fails with "game not found".
    const config = buildBenchConfig({}, {
      apiKey: "k",
      cardId: "c",
      cookies: "AWSALB=x; AWSALBCORS=x",
    });
    const mcp = config.mcp as { servers: Array<{ env: Record<string, string> }> };
    expect(mcp.servers[0]!.env.ARC_COOKIES).toBe("AWSALB=x; AWSALBCORS=x");
  });

  test("omits ARC_COOKIES when no cookies are provided", () => {
    const config = buildBenchConfig({}, { apiKey: "k", cardId: "c" });
    const mcp = config.mcp as { servers: Array<{ env: Record<string, string> }> };
    expect("ARC_COOKIES" in mcp.servers[0]!.env).toBe(false);
  });

  test("forwards frameLogDir as ARC_FRAME_LOG_DIR for code-assisted reasoning", () => {
    const config = buildBenchConfig({}, {
      apiKey: "k",
      cardId: "c",
      frameLogDir: "/tmp/arc-workdir-xyz",
    });
    const mcp = config.mcp as { servers: Array<{ env: Record<string, string> }> };
    expect(mcp.servers[0]!.env.ARC_FRAME_LOG_DIR).toBe("/tmp/arc-workdir-xyz");
  });

  test("applies reasoningEffort to the user's model block", () => {
    const config = buildBenchConfig(userConfig, {
      apiKey: "k",
      cardId: "c",
      reasoningEffort: "high",
    });
    expect(config.model).toEqual({ ...userConfig.model, reasoningEffort: "high" });
  });

  test("applies reasoningEffort to the OAuth-derived model default", () => {
    const oauthOnly = {
      auth: { "openai-chatgpt": { type: "oauth", refresh: "r", access: "a" } },
    };
    const config = buildBenchConfig(oauthOnly, {
      apiKey: "k",
      cardId: "c",
      reasoningEffort: "max",
    });
    expect(config.model).toEqual({
      provider: "openai-chatgpt",
      name: "gpt-5.5",
      reasoningEffort: "max",
    });
  });

  test("leaves reasoningEffort alone when not requested", () => {
    const config = buildBenchConfig(userConfig, { apiKey: "k", cardId: "c" });
    expect(config.model).toEqual(userConfig.model);
  });
});

describe("buildGoal", () => {
  test("templates game id, step budget, and the reset instruction", () => {
    const goal = buildGoal("ls20-abc", 80);
    expect(goal).toContain("ls20-abc");
    expect(goal).toContain("about 80 agent steps");
    expect(goal).toContain("Start with mcp__arc__reset");
    expect(goal).toContain("mcp__arc__ tools");
    expect(goal).toContain("scorecard is already open");
    // Anti-early-quit doctrine.
    expect(goal).toContain("Never stop while steps remain");
    expect(goal).toContain("on GAME_OVER");
  });
});

describe("buildContinueMessage", () => {
  test("includes state, levels, remaining budget, and resume instructions", () => {
    const msg = buildContinueMessage("g1-abc", 9, {
      state: "GAME_OVER",
      score: 1,
      winScore: 7,
    });
    expect(msg).toContain("g1-abc");
    expect(msg).toContain("GAME_OVER");
    expect(msg).toContain("1/7");
    expect(msg).toContain("about 9 agent steps");
    expect(msg).toContain("mcp__arc__reset");
    expect(msg).toContain("Do not stop again");
  });

  test("tolerates missing stats", () => {
    const msg = buildContinueMessage("g1-abc", 5, {});
    expect(msg).toContain("state unknown");
    expect(msg).toContain("unknown levels completed");
  });
});

describe("formatSummaryTable", () => {
  test("renders one aligned row per game with placeholders for missing stats", () => {
    const rows: GameRunRow[] = [
      {
        game: "toy1-abc123",
        state: "WIN",
        score: 2,
        winScore: 2,
        actions: 11,
        steps: 9,
        stopReason: "completed",
      },
      { game: "toy2-def456", state: "?", stopReason: "timeout" },
    ];
    const table = formatSummaryTable(rows);
    const lines = table.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/GAME\s+STATE\s+LEVELS\s+ACTIONS\s+STEPS\s+STOP/);
    expect(lines[1]).toContain("toy1-abc123");
    expect(lines[1]).toContain("2/2");
    expect(lines[1]).toContain("11");
    expect(lines[1]).toContain("completed");
    expect(lines[2]).toContain("toy2-def456");
    expect(lines[2]).toMatch(/-\s+-\s+-\s+timeout/);
  });
});

describe("extractGameStats", () => {
  // Live GET /api/scorecard/{card_id} shape.
  const scorecard = {
    card_id: "card-1",
    score: 2,
    tags: ["ouroboros"],
    environments: [
      {
        id: "g1",
        actions: 14,
        levels_completed: 2,
        level_count: 3,
        resets: 2,
        score: 2,
        runs: [
          { state: "GAME_OVER", levels_completed: 1, actions: 6, score: 1, guid: "u1" },
          { state: "WIN", levels_completed: 2, actions: 8, score: 2, guid: "u2" },
        ],
      },
      { id: "g2", actions: 0, levels_completed: 0, level_count: 5, resets: 0, runs: [] },
    ],
  };

  test("reads score, winScore, actions, plays, and latest state from environments[]", () => {
    expect(extractGameStats(scorecard, "g1")).toEqual({
      score: 2,
      winScore: 3,
      state: "WIN",
      actions: 14,
      plays: 2,
    });
  });

  test("returns {} for unknown games", () => {
    expect(extractGameStats(scorecard, "nope")).toEqual({});
  });

  test("returns {} for malformed payloads", () => {
    expect(extractGameStats(null, "g1")).toEqual({});
    expect(extractGameStats("junk", "g1")).toEqual({});
    expect(extractGameStats({ environments: 7 }, "g1")).toEqual({});
    expect(extractGameStats({ environments: [null, "x"] }, "g1")).toEqual({});
    // Old (pre-live) shape no longer matches anything.
    expect(extractGameStats({ cards: { g1: { scores: [2] } } }, "g1")).toEqual({});
  });

  test("tolerates entries with missing fields", () => {
    expect(extractGameStats({ environments: [{ id: "g3" }] }, "g3")).toEqual({});
    expect(
      extractGameStats({ environments: [{ id: "g3", runs: [{}] }] }, "g3"),
    ).toEqual({ plays: 1 });
  });
});

describe("describeNotification", () => {
  test("describes tool-call starts and agent errors, skips the rest", () => {
    expect(
      describeNotification({
        method: "agent/toolCallStart",
        params: { toolName: "mcp__arc__act" },
      }),
    ).toBe("tool> mcp__arc__act");
    expect(
      describeNotification({ method: "agent/error", params: { message: "boom" } }),
    ).toBe("agent error: boom");
    expect(describeNotification({ method: "agent/text", params: {} })).toBeUndefined();
  });
});

describe("readUserConfig", () => {
  test("reads .ouroboros JSON and falls back to {} when missing or invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-runner-cfg-"));
    try {
      expect(await readUserConfig(dir)).toEqual({});
      writeFileSync(join(dir, ".ouroboros"), '{"model":{"provider":"anthropic"}}');
      expect(await readUserConfig(dir)).toEqual({ model: { provider: "anthropic" } });
      writeFileSync(join(dir, ".ouroboros"), "{nope");
      expect(await readUserConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("raceWallClock", () => {
  test("resolves with the value when the promise wins", async () => {
    const outcome = await raceWallClock(Promise.resolve(42), 1_000);
    expect(outcome).toEqual({ timedOut: false, value: 42 });
  });

  test("flags a timeout when the deadline wins", async () => {
    const never = new Promise<void>(() => {});
    const outcome = await raceWallClock(never, 10);
    expect(outcome).toEqual({ timedOut: true });
  });
});

// ---------------------------------------------------------------------------
// NDJSON RPC client
// ---------------------------------------------------------------------------

describe("NdjsonRpcClient", () => {
  test("matches responses by id and routes interleaved notifications", async () => {
    const sent: string[] = [];
    const notifications: Array<Record<string, unknown>> = [];
    const client = new NdjsonRpcClient((line) => sent.push(line), {
      onNotification: (msg) => notifications.push(msg),
    });

    const pending = client.request("session/new", { a: 1 });
    expect(sent).toHaveLength(1);
    const req = JSON.parse(sent[0]!) as { id: number; method: string; params: unknown };
    expect(req.method).toBe("session/new");
    expect(req.params).toEqual({ a: 1 });

    // Notification interleaved before the response, response split mid-line.
    client.feed('{"jsonrpc":"2.0","method":"agent/toolCallStart","params":{"toolName":"x"}}\n');
    client.feed(`{"jsonrpc":"2.0","id":${req.id},"resu`);
    client.feed('lt":{"sessionId":"s-1"}}\nnot json noise\n');

    expect(await pending).toEqual({ sessionId: "s-1" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.method).toBe("agent/toolCallStart");
  });

  test("rejects with RpcError carrying the code on error responses", async () => {
    const sent: string[] = [];
    const client = new NdjsonRpcClient((line) => sent.push(line));
    const pending = client.request("agent/run", { message: "" });
    const req = JSON.parse(sent[0]!) as { id: number };
    client.feed(
      `{"jsonrpc":"2.0","id":${req.id},"error":{"code":-32602,"message":"bad params"}}\n`,
    );
    await expect(pending).rejects.toThrow("bad params");
    await pending.catch((err: unknown) => {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(-32602);
    });
  });

  test("honors per-request timeouts", async () => {
    const client = new NdjsonRpcClient(() => {});
    await expect(client.request("slow/thing", {}, { timeoutMs: 15 })).rejects.toThrow(
      "timed out",
    );
  });

  test("failAll rejects pending and future requests", async () => {
    const client = new NdjsonRpcClient(() => {});
    const pending = client.request("agent/run", {});
    client.failAll(new Error("agent process exited (code 1)"));
    await expect(pending).rejects.toThrow("agent process exited");
    await expect(client.request("session/new")).rejects.toThrow("agent process exited");
  });
});

// ---------------------------------------------------------------------------
// Orchestration loop (fake agent + mock ARC server)
// ---------------------------------------------------------------------------

type FakeHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown> | unknown;

interface FakeAgentHarness {
  spawnAgent: NonNullable<RunnerDeps["spawnAgent"]>;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  workdirConfigs: Array<Record<string, unknown>>;
  wasKilled: () => boolean;
  spawnCount: () => number;
}

function makeFakeAgent(handler: FakeHandler): FakeAgentHarness {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const workdirConfigs: Array<Record<string, unknown>> = [];
  let killed = false;
  let spawns = 0;
  const agent: AgentProcess = {
    rpc: {
      async request(method, params = {}) {
        calls.push({ method, params });
        return handler(method, params);
      },
    },
    kill: () => {
      killed = true;
    },
  };
  return {
    spawnAgent: async (workdir) => {
      spawns++;
      const configPath = join(workdir, ".ouroboros");
      if (existsSync(configPath)) {
        workdirConfigs.push(
          JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>,
        );
      }
      return agent;
    },
    calls,
    workdirConfigs,
    wasKilled: () => killed,
    spawnCount: () => spawns,
  };
}

function baseOptions(overrides: Partial<ArcBenchOptions> = {}): ArcBenchOptions {
  return {
    games: [GAME1],
    maxSteps: 12,
    tags: ["ouroboros", "test"],
    timeoutMin: 5,
    ...overrides,
  };
}

describe("runArcBenchmark", () => {
  let mock: MockArcServer;
  let userConfigDir: string;
  let outDir: string;
  const savedApiKey = process.env.ARC_API_KEY;
  const savedBaseUrl = process.env.ARC_BASE_URL;

  beforeAll(() => {
    mock = startMockArcServer();
    process.env.ARC_API_KEY = MOCK_API_KEY;
    process.env.ARC_BASE_URL = mock.url;
    userConfigDir = mkdtempSync(join(tmpdir(), "arc-runner-user-"));
    writeFileSync(
      join(userConfigDir, ".ouroboros"),
      JSON.stringify({
        model: { provider: "anthropic", name: "claude-opus-4" },
        permissions: { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false },
      }),
    );
    outDir = mkdtempSync(join(tmpdir(), "arc-runner-out-"));
  });

  afterAll(() => {
    mock.stop();
    if (savedApiKey === undefined) delete process.env.ARC_API_KEY;
    else process.env.ARC_API_KEY = savedApiKey;
    if (savedBaseUrl === undefined) delete process.env.ARC_BASE_URL;
    else process.env.ARC_BASE_URL = savedBaseUrl;
    rmSync(userConfigDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  function makeClient(): ArcClient {
    return new ArcClient({ apiKey: MOCK_API_KEY, baseUrl: mock.url });
  }

  test("happy path: plays a game, reports scorecard ground truth, closes up", async () => {
    let sessionCounter = 0;
    let mcpEnvFromConfig: Record<string, string> | undefined;
    let cardIdFromConfig: string | undefined;
    const harness = makeFakeAgent(async (method) => {
      if (method === "session/new") return { sessionId: `sess-${++sessionCounter}` };
      if (method === "agent/run") {
        // Simulate the agent playing level 1: reset then five ACTION2 moves
        // (MOCK_START y=2 → MOCK_L1_TARGET y=7) against the mock API. Like
        // the real MCP server, the play client must reuse the runner's ALB
        // cookies (ARC_COOKIES from the generated config) or the mock — like
        // the live API — answers RESET with "game not found".
        const play = new ArcClient({
          apiKey: MOCK_API_KEY,
          baseUrl: mock.url,
          cookies: mcpEnvFromConfig!.ARC_COOKIES,
        });
        const frame = await play.reset({ game_id: GAME1, card_id: cardIdFromConfig });
        for (let i = 0; i < 5; i++) {
          await play.action(2, { game_id: GAME1, guid: frame.guid });
        }
        // Report the full budget as used so the driver loop does not send a
        // continuation prompt (continuations have their own tests below).
        return {
          text: "won level 1",
          iterations: 12,
          stopReason: "completed",
          maxIterationsReached: true,
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const logs: string[] = [];
    const printed: string[] = [];
    const outFile = join(outDir, "results.json");
    const spawnAgent: FakeAgentHarness["spawnAgent"] = async (workdir, log) => {
      const agent = await harness.spawnAgent(workdir, log);
      const config = harness.workdirConfigs[harness.workdirConfigs.length - 1]!;
      const mcp = config.mcp as { servers: Array<{ env: Record<string, string> }> };
      mcpEnvFromConfig = mcp.servers[0]!.env;
      cardIdFromConfig = mcpEnvFromConfig.ARC_CARD_ID;
      return agent;
    };

    const { exitCode } = await runArcBenchmark(
      baseOptions({ configDir: userConfigDir, out: outFile }),
      {
        client: makeClient(),
        spawnAgent,
        log: (line) => logs.push(line),
        print: (line) => printed.push(line),
      },
    );

    expect(exitCode).toBe(0);
    expect(cardIdFromConfig).toBeDefined();
    // ALB affinity cookies from the runner's scorecard/open made it into the
    // MCP server env (and were required for the play above to succeed).
    expect(mcpEnvFromConfig!.ARC_COOKIES).toMatch(/AWSALB=/);

    // RPC sequencing.
    const methods = harness.calls.map((c) => c.method);
    expect(methods).toEqual(["session/new", "agent/run"]);
    const runParams = harness.calls[1]!.params;
    expect(runParams.sessionId).toBe("sess-1");
    expect(runParams.skillName).toBe(SKILL_NAME);
    expect(runParams.maxSteps).toBe(12);
    expect(runParams.message).toContain(GAME1);
    expect(runParams.message).toContain("mcp__arc__reset");

    // Generated workdir config: user blocks preserved, bench overrides applied.
    const config = harness.workdirConfigs[0]!;
    expect(config.model).toEqual({ provider: "anthropic", name: "claude-opus-4" });
    expect(config.verifier).toEqual({ trigger: "off" });
    expect(config.skillDirectories).toEqual([SKILLS_DIR]);
    const mcp = config.mcp as { servers: Array<Record<string, unknown>> };
    expect(mcp.servers[0]!.requireApproval).toBe(false);
    expect((mcp.servers[0]!.env as Record<string, string>).ARC_API_KEY).toBe(MOCK_API_KEY);

    // Ground truth from the mock scorecard.
    const results = JSON.parse(readFileSync(outFile, "utf-8")) as {
      cardId: string;
      url: string;
      games: GameRunRow[];
    };
    expect(results.cardId).toBe(cardIdFromConfig!);
    expect(results.url).toBe(`https://arcprize.org/scorecards/${cardIdFromConfig}`);
    expect(results.games).toHaveLength(1);
    const row = results.games[0]!;
    expect(row.game).toBe(GAME1);
    expect(row.state).toBe("NOT_FINISHED");
    expect(row.score).toBe(1);
    expect(row.actions).toBe(5);
    expect(row.steps).toBe(12);
    expect(row.stopReason).toBe("completed");

    // Summary output + scorecard URL.
    const output = printed.join("\n");
    expect(output).toContain(GAME1);
    expect(output).toContain(`Scorecard: https://arcprize.org/scorecards/${cardIdFromConfig}`);

    // Cleanup: scorecard closed, child killed.
    expect(mock.getScorecard(cardIdFromConfig!)!.closed).toBe(true);
    expect(harness.wasKilled()).toBe(true);
    expect(harness.spawnCount()).toBe(1);
  });

  test("wall-clock breach cancels the run and records a timeout", async () => {
    let sessionCounter = 0;
    const harness = makeFakeAgent((method) => {
      if (method === "session/new") return { sessionId: `sess-${++sessionCounter}` };
      if (method === "agent/run") return new Promise(() => {}); // never resolves
      if (method === "agent/cancel") return { cancelled: true };
      throw new Error(`unexpected method ${method}`);
    });

    const outFile = join(outDir, "timeout.json");
    const { exitCode } = await runArcBenchmark(
      // 0.002 min = 120ms wall clock.
      baseOptions({ timeoutMin: 0.002, out: outFile }),
      {
        client: makeClient(),
        spawnAgent: harness.spawnAgent,
        log: () => {},
        print: () => {},
        cancelGraceMs: 10,
      },
    );

    expect(exitCode).toBe(0); // the game ran; timeout is not a harness error
    const cancel = harness.calls.find((c) => c.method === "agent/cancel");
    expect(cancel).toBeDefined();
    expect(cancel!.params.sessionId).toBe("sess-1");
    const results = JSON.parse(readFileSync(outFile, "utf-8")) as { games: GameRunRow[] };
    expect(results.games[0]!.stopReason).toBe("timeout");
    expect(harness.wasKilled()).toBe(true);
  });

  test("mid-run failure still closes the scorecard and kills the child", async () => {
    // Set explicitly (not just via beforeAll) so the test stays correct if run
    // in isolation: the runner's preflight requires ARC_API_KEY even when a
    // client is injected.
    process.env.ARC_API_KEY = MOCK_API_KEY;
    const harness = makeFakeAgent((method) => {
      if (method === "session/new") return { sessionId: "sess-1" };
      if (method === "agent/run") throw new Error("LLM exploded");
      throw new Error(`unexpected method ${method}`);
    });

    const logs: string[] = [];
    let cardId: string | undefined;
    const client = makeClient();
    const open = client.openScorecard.bind(client);
    client.openScorecard = async (body) => {
      const result = await open(body);
      cardId = result.card_id;
      return result;
    };

    const { exitCode } = await runArcBenchmark(baseOptions(), {
      client,
      spawnAgent: harness.spawnAgent,
      log: (line) => logs.push(line),
      print: () => {},
    });

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("LLM exploded");
    expect(cardId).toBeDefined();
    expect(mock.getScorecard(cardId!)!.closed).toBe(true);
    expect(harness.wasKilled()).toBe(true);
  });

  test("spawn failure closes the scorecard and exits 1", async () => {
    let cardId: string | undefined;
    const client = makeClient();
    const open = client.openScorecard.bind(client);
    client.openScorecard = async (body) => {
      const result = await open(body);
      cardId = result.card_id;
      return result;
    };

    const { exitCode } = await runArcBenchmark(baseOptions(), {
      client,
      spawnAgent: async () => {
        throw new Error("CLI did not become ready");
      },
      log: () => {},
      print: () => {},
    });

    expect(exitCode).toBe(1);
    expect(mock.getScorecard(cardId!)!.closed).toBe(true);
  });

  test("a model that quits early every turn is driven to the full step budget", async () => {
    // Regression: smaller models quit after 1-2 steps every turn. A fixed
    // continuation cap left most of the budget unused; the driver should keep
    // re-prompting (progress is being made) until the step budget is spent.
    process.env.ARC_API_KEY = MOCK_API_KEY;
    let sessionCounter = 0;
    const harness = makeFakeAgent((method) => {
      if (method === "session/new") return { sessionId: `sess-${++sessionCounter}` };
      if (method === "agent/run") {
        // One step of progress each turn, then stops — never reaches WIN.
        return { text: "I'm done", iterations: 1, stopReason: "completed" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const { exitCode } = await runArcBenchmark(baseOptions(), {
      client: makeClient(),
      spawnAgent: harness.spawnAgent,
      log: () => {},
      print: () => {},
    });

    expect(exitCode).toBe(0);
    const runs = harness.calls.filter((c) => c.method === "agent/run");
    // baseOptions maxSteps is 12; one step per run drives all 12.
    expect(runs).toHaveLength(12);
    // Same session throughout; skill stays attached; budget shrinks each turn.
    for (const run of runs) {
      expect(run.params.sessionId).toBe("sess-1");
      expect(run.params.skillName).toBe(SKILL_NAME);
    }
    expect(runs.map((r) => r.params.maxSteps)).toEqual([
      12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
    ]);
    const followUp = runs[1]!.params.message as string;
    expect(followUp).toContain("You stopped early");
    expect(followUp).toContain("about 11 agent steps");
  });

  test("stops re-prompting after consecutive no-progress continuations", async () => {
    // A genuinely stuck model (zero new steps) must not be re-prompted forever.
    process.env.ARC_API_KEY = MOCK_API_KEY;
    let sessionCounter = 0;
    const harness = makeFakeAgent((method) => {
      if (method === "session/new") return { sessionId: `sess-${++sessionCounter}` };
      if (method === "agent/run") {
        // No progress: zero steps every turn.
        return { text: "stuck", iterations: 0, stopReason: "completed" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const { exitCode } = await runArcBenchmark(baseOptions(), {
      client: makeClient(),
      spawnAgent: harness.spawnAgent,
      log: () => {},
      print: () => {},
    });

    expect(exitCode).toBe(0);
    const runs = harness.calls.filter((c) => c.method === "agent/run");
    expect(runs).toHaveLength(MAX_NO_PROGRESS_CONTINUATIONS);
  });

  test("an errored run gets no continuation prompts", async () => {
    // Regression: a quota-exhausted model errored every continuation; the
    // driver burned all its prompts against a dead LLM before giving up.
    process.env.ARC_API_KEY = MOCK_API_KEY;
    let sessionCounter = 0;
    const harness = makeFakeAgent((method) => {
      if (method === "session/new") return { sessionId: `sess-${++sessionCounter}` };
      if (method === "agent/run") {
        return { text: "usage limit reached", iterations: 1, stopReason: "error" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await runArcBenchmark(baseOptions(), {
      client: makeClient(),
      spawnAgent: harness.spawnAgent,
      log: () => {},
      print: () => {},
    });

    const runs = harness.calls.filter((c) => c.method === "agent/run");
    expect(runs).toHaveLength(1);
  });

  test("continuations stop as soon as the scorecard reports WIN", async () => {
    process.env.ARC_API_KEY = MOCK_API_KEY;
    let sessionCounter = 0;
    let mcpEnv: Record<string, string> | undefined;
    const harness = makeFakeAgent(async (method) => {
      if (method === "session/new") return { sessionId: `sess-${++sessionCounter}` };
      if (method === "agent/run") {
        // Play the mock game to WIN: level 1 via five ACTION2 moves, then
        // level 2 via an ACTION6 click on the marked cell.
        const play = new ArcClient({
          apiKey: MOCK_API_KEY,
          baseUrl: mock.url,
          cookies: mcpEnv!.ARC_COOKIES,
        });
        const frame = await play.reset({ game_id: GAME1, card_id: mcpEnv!.ARC_CARD_ID });
        for (let i = 0; i < 5; i++) {
          await play.action(2, { game_id: GAME1, guid: frame.guid });
        }
        await play.action(6, {
          game_id: GAME1,
          guid: frame.guid,
          x: MOCK_L2_MARK.x,
          y: MOCK_L2_MARK.y,
        });
        return { text: "won", iterations: 3, stopReason: "completed" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const spawnAgent: FakeAgentHarness["spawnAgent"] = async (workdir, log) => {
      const agent = await harness.spawnAgent(workdir, log);
      const config = harness.workdirConfigs[harness.workdirConfigs.length - 1]!;
      const mcp = config.mcp as { servers: Array<{ env: Record<string, string> }> };
      mcpEnv = mcp.servers[0]!.env;
      return agent;
    };

    const { exitCode } = await runArcBenchmark(baseOptions(), {
      client: makeClient(),
      spawnAgent,
      log: () => {},
      print: () => {},
    });

    expect(exitCode).toBe(0);
    // Despite budget remaining (3 of 12 steps used), WIN ends the game loop.
    const runs = harness.calls.filter((c) => c.method === "agent/run");
    expect(runs).toHaveLength(1);
  });

  test("games:'all' resolves the list from the API and runs each game", async () => {
    let sessionCounter = 0;
    const ranGames: string[] = [];
    const harness = makeFakeAgent((method, params) => {
      if (method === "session/new") return { sessionId: `sess-${++sessionCounter}` };
      if (method === "agent/run") {
        const message = params.message as string;
        const game = MOCK_GAMES.find((g) => message.includes(g.game_id));
        ranGames.push(game?.game_id ?? "unknown");
        // Exhaust the budget so the driver loop moves straight to the next game.
        return { text: "ok", iterations: 12, stopReason: "completed" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const { exitCode } = await runArcBenchmark(baseOptions({ games: "all" }), {
      client: makeClient(),
      spawnAgent: harness.spawnAgent,
      log: () => {},
      print: () => {},
    });

    expect(exitCode).toBe(0);
    expect(ranGames).toEqual([GAME1, GAME2]);
    expect(sessionCounter).toBe(2); // one fresh session per game
  });

  test("a failing game does not stop later games, but flips the exit code", async () => {
    let sessionCounter = 0;
    const harness = makeFakeAgent((method, params) => {
      if (method === "session/new") return { sessionId: `sess-${++sessionCounter}` };
      if (method === "agent/run") {
        const message = params.message as string;
        if (message.includes(GAME1)) throw new Error("first game crashed");
        return { text: "ok", iterations: 3, stopReason: "completed" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const outFile = join(outDir, "partial.json");
    const { exitCode } = await runArcBenchmark(
      baseOptions({ games: [GAME1, GAME2], out: outFile }),
      {
        client: makeClient(),
        spawnAgent: harness.spawnAgent,
        log: () => {},
        print: () => {},
      },
    );

    expect(exitCode).toBe(1);
    const results = JSON.parse(readFileSync(outFile, "utf-8")) as { games: GameRunRow[] };
    expect(results.games).toHaveLength(2);
    expect(results.games[0]!.stopReason).toBe("error");
    expect(results.games[1]!.stopReason).toBe("completed");
  });

  test("preflight fails fast without ARC_API_KEY and without spawning", async () => {
    const saved = process.env.ARC_API_KEY;
    delete process.env.ARC_API_KEY;
    try {
      let spawned = false;
      const logs: string[] = [];
      const { exitCode } = await runArcBenchmark(baseOptions(), {
        spawnAgent: async () => {
          spawned = true;
          throw new Error("should not spawn");
        },
        log: (line) => logs.push(line),
        print: () => {},
      });
      expect(exitCode).toBe(1);
      expect(spawned).toBe(false);
      expect(logs.join("\n")).toContain("ARC_API_KEY");
    } finally {
      process.env.ARC_API_KEY = saved;
    }
  });
});
