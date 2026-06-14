/**
 * ARC-AGI-3 benchmark orchestrator.
 *
 * Drives the Ouroboros CLI (spawned in --json-rpc mode) to play ARC-AGI-3
 * games through the `arc` MCP server (src/server.ts). Flow:
 *
 *   1. Preflight ARC_API_KEY.
 *   2. Resolve games (explicit list or GET /api/games).
 *   3. POST /api/scorecard/open with tags.
 *   4. Write a temp workdir `.ouroboros`: the user's real config shallow-merged
 *      with verifier-off, the bench skill directory, and the arc MCP server.
 *   5. Spawn `bun run packages/cli/src/cli.ts --json-rpc --config <workdir>`
 *      and speak NDJSON JSON-RPC over its stdio.
 *   6. Per game: session/new, agent/run (skill arc-agi-3, maxSteps budget,
 *      wall-clock cap with agent/cancel on breach), then ground truth from
 *      GET /api/scorecard/{card_id}.
 *   7. Finally: close the scorecard, kill the child, print a summary table and
 *      the scorecard URL, optionally write a results JSON.
 *
 * Pure helpers (config merge, goal templating, summary formatting, scorecard
 * stat extraction) are exported for unit tests; the orchestration loop takes
 * injectable deps (ArcClient, spawnAgent) so tests never spawn the real CLI.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type Subprocess } from "bun";
import { ArcClient } from "./client";
import type { ArcBenchOptions } from "./options";

// ---------------------------------------------------------------------------
// Paths / constants
// ---------------------------------------------------------------------------

/** benchmarks/arc-agi-3 (absolute). */
export const BENCH_ROOT = resolve(import.meta.dir, "..");
/** Repository root (absolute). */
export const REPO_ROOT = resolve(BENCH_ROOT, "..", "..");
/** Absolute skill directory handed to the agent via skillDirectories. */
export const SKILLS_DIR = join(BENCH_ROOT, "skills");
/** Absolute path to the arc MCP stdio server entry. */
export const MCP_SERVER_ENTRY = join(BENCH_ROOT, "src", "server.ts");
/** Absolute path to the Ouroboros CLI entry. */
export const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "src", "cli.ts");
/** Skill activated on every agent/run. */
export const SKILL_NAME = "arc-agi-3";
/** Public scorecard URL prefix. */
export const SCORECARD_URL_BASE = "https://arcprize.org/scorecards/";

const SESSION_NEW_TIMEOUT_MS = 60_000;
const CANCEL_TIMEOUT_MS = 30_000;
const DEFAULT_CANCEL_GRACE_MS = 15_000;
const READY_ATTEMPTS = 120;
const READY_POLL_TIMEOUT_MS = 1_000;
const READY_POLL_INTERVAL_MS = 250;
/**
 * Stop re-prompting after this many consecutive continuations that produced no
 * new steps — the model is genuinely stuck, not just quitting early. Models
 * that quit after 1-2 steps every turn (common with smaller local models) are
 * driven to the full step budget instead of being capped at a fixed count.
 */
export const MAX_NO_PROGRESS_CONTINUATIONS = 3;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface BenchConfigInputs {
  apiKey: string;
  cardId: string;
  /** Forwarded to the MCP server as ARC_BASE_URL when set. */
  baseUrl?: string;
  /**
   * Serialized Cookie header from the runner's ArcClient, forwarded to the
   * MCP server as ARC_COOKIES. The ARC API keeps scorecard/game state behind
   * AWS ALB cookie affinity, so the MCP server process must reuse the cookies
   * from the scorecard/open call or its commands land on a node that has
   * never heard of the card ("game not found").
   */
  cookies?: string;
  /** When set, overrides reasoningEffort on the model block (bench default: high). */
  reasoningEffort?: string;
  /**
   * Directory where the MCP server writes per-game frame-history JSONL. Set to
   * the agent's workdir so its code-exec tool reads the same files (see
   * history.ts / the code-assisted reasoning skill section).
   */
  frameLogDir?: string;
}

/**
 * Build the `.ouroboros` config for the bench workdir: the user's real config
 * (model/auth blocks preserved) shallow-merged with bench overrides.
 */
export function buildBenchConfig(
  userConfig: Record<string, unknown>,
  inputs: BenchConfigInputs,
): Record<string, unknown> {
  const env: Record<string, string> = {
    ARC_API_KEY: inputs.apiKey,
    ARC_CARD_ID: inputs.cardId,
  };
  if (inputs.baseUrl) env.ARC_BASE_URL = inputs.baseUrl;
  if (inputs.cookies) env.ARC_COOKIES = inputs.cookies;
  // Frame history lands in the agent's workdir so its code-exec can read it.
  if (inputs.frameLogDir) env.ARC_FRAME_LOG_DIR = inputs.frameLogDir;
  // Debug knob: forward request tracing into the MCP server process.
  if (process.env.ARC_DEBUG_FILE) env.ARC_DEBUG_FILE = process.env.ARC_DEBUG_FILE;
  // ~/.ouroboros often holds only auth + permissions (model selection lives in
  // the desktop app). Without a model block the CLI defaults to provider
  // "openai", which needs OPENAI_API_KEY — so when the user is logged in via
  // ChatGPT OAuth, point the bench config at that provider instead.
  const auth = userConfig.auth as Record<string, unknown> | undefined;
  const baseModel =
    userConfig.model ??
    (auth?.["openai-chatgpt"]
      ? { provider: "openai-chatgpt", name: "gpt-5.5" }
      : undefined);
  // Grid-mechanics inference benefits from thinking budget: let the bench
  // raise reasoningEffort above the user's default without touching the
  // rest of their model block.
  const model =
    baseModel && inputs.reasoningEffort
      ? {
          ...(baseModel as Record<string, unknown>),
          reasoningEffort: inputs.reasoningEffort,
        }
      : baseModel;
  return {
    ...userConfig,
    ...(model ? { model } : {}),
    verifier: { trigger: "off" },
    skillDirectories: [SKILLS_DIR],
    mcp: {
      servers: [
        {
          type: "local",
          name: "arc",
          command: "bun",
          args: ["run", MCP_SERVER_ENTRY],
          env,
          requireApproval: false,
        },
      ],
    },
  };
}

/** Goal message sent on agent/run for one game. */
export function buildGoal(gameId: string, maxSteps: number): string {
  return (
    `Play the ARC-AGI-3 game ${gameId} using the mcp__arc__ tools. ` +
    `The scorecard is already open. Start with mcp__arc__reset. ` +
    `You have about ${maxSteps} agent steps; win as many levels as possible. ` +
    `Never stop while steps remain and the state is not WIN: on GAME_OVER, ` +
    `reset immediately and replay using what you learned; when stuck, probe ` +
    `an action combination you have not tried rather than stopping. Only ` +
    `report the mechanics you learned once the budget is exhausted or the ` +
    `game is won.`
  );
}

/**
 * Follow-up message when the agent stops with budget remaining and the game
 * not won. Models love to wrap up and summarize; this sends them back in.
 */
export function buildContinueMessage(
  gameId: string,
  remainingSteps: number,
  stats: GameStats,
): string {
  const state = stats.state ?? "unknown";
  const levels =
    stats.score !== undefined
      ? `${stats.score}/${stats.winScore ?? "?"}`
      : "unknown";
  return (
    `You stopped early: game ${gameId} is at state ${state} with ${levels} ` +
    `levels completed, and you still have about ${remainingSteps} agent ` +
    `steps. Resume playing now with the mcp__arc__ tools. If the state is ` +
    `GAME_OVER, call mcp__arc__reset and replay quickly using your mechanics ` +
    `notes before exploring further. Do not stop again while steps remain ` +
    `and the game is not won.`
  );
}

export interface GameRunRow {
  game: string;
  state: string;
  score?: number;
  winScore?: number;
  actions?: number;
  steps?: number;
  stopReason: string;
}

function formatLevels(row: GameRunRow): string {
  if (row.score === undefined) return "-";
  return row.winScore !== undefined
    ? `${row.score}/${row.winScore}`
    : String(row.score);
}

/** Plain-text summary table: game, state, levels, API actions, steps, stop. */
export function formatSummaryTable(rows: GameRunRow[]): string {
  const header = ["GAME", "STATE", "LEVELS", "ACTIONS", "STEPS", "STOP"];
  const cells = rows.map((row) => [
    row.game,
    row.state,
    formatLevels(row),
    row.actions === undefined ? "-" : String(row.actions),
    row.steps === undefined ? "-" : String(row.steps),
    row.stopReason,
  ]);
  const widths = header.map((title, col) =>
    Math.max(title.length, ...cells.map((line) => line[col]!.length)),
  );
  const renderLine = (line: string[]) =>
    line.map((cell, col) => cell.padEnd(widths[col]!)).join("  ").trimEnd();
  return [renderLine(header), ...cells.map(renderLine)].join("\n");
}

export interface GameStats {
  state?: string;
  score?: number;
  winScore?: number;
  actions?: number;
  plays?: number;
}

/**
 * Pull per-game ground truth out of a GET /api/scorecard/{card_id} payload.
 * Live shape: { environments: [{ id, actions, levels_completed, level_count,
 * resets, runs: [{ state, levels_completed, actions, ... }] }] }.
 * Tolerant: returns {} for unknown games or unexpected shapes.
 */
export function extractGameStats(scorecard: unknown, gameId: string): GameStats {
  if (scorecard === null || typeof scorecard !== "object") return {};
  const environments = (scorecard as Record<string, unknown>).environments;
  if (!Array.isArray(environments)) return {};
  const entry = environments.find(
    (e): e is Record<string, unknown> =>
      e !== null &&
      typeof e === "object" &&
      (e as Record<string, unknown>).id === gameId,
  );
  if (!entry) return {};
  const result: GameStats = {};

  if (typeof entry.levels_completed === "number") {
    result.score = entry.levels_completed;
  }
  if (typeof entry.level_count === "number") result.winScore = entry.level_count;
  if (typeof entry.actions === "number") result.actions = entry.actions;

  const runs = entry.runs;
  if (Array.isArray(runs)) {
    result.plays = runs.length;
    const last = runs[runs.length - 1];
    if (last !== null && typeof last === "object") {
      const state = (last as Record<string, unknown>).state;
      if (typeof state === "string") result.state = state;
    }
  }
  return result;
}

/** Terse stderr line for an interleaved notification, or undefined to skip. */
export function describeNotification(
  msg: Record<string, unknown>,
): string | undefined {
  const params =
    msg.params !== null && typeof msg.params === "object"
      ? (msg.params as Record<string, unknown>)
      : {};
  if (msg.method === "agent/toolCallStart") {
    return typeof params.toolName === "string" ? `tool> ${params.toolName}` : "tool>";
  }
  if (msg.method === "agent/toolCallEnd") {
    const name = typeof params.toolName === "string" ? params.toolName : "?";
    const result =
      typeof params.result === "string" ? params.result : JSON.stringify(params.result);
    if (params.isError) {
      return `tool! ${name} ERROR: ${truncateLine(result, 400)}`;
    }
    // Successful results are interesting only as a terse first line.
    return `tool< ${name}: ${truncateLine(result, 120)}`;
  }
  if (msg.method === "agent/error") {
    const message = typeof params.message === "string" ? params.message : "unknown";
    return `agent error: ${message}`;
  }
  return undefined;
}

function truncateLine(text: string | undefined, max: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export type WallClockOutcome<T> = { timedOut: false; value: T } | { timedOut: true };

/** Race a promise against a wall-clock deadline without rejecting on breach. */
export async function raceWallClock<T>(
  promise: Promise<T>,
  ms: number,
): Promise<WallClockOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((res) => {
        timer = setTimeout(() => res({ timedOut: true }), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Read `<configDir>/.ouroboros` as JSON; {} when missing or unparseable. */
export async function readUserConfig(
  configDir: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(join(configDir, ".ouroboros"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// NDJSON JSON-RPC client
// ---------------------------------------------------------------------------

export class RpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export interface RpcRequestOptions {
  /** Reject the request after this many ms. Omit for no timeout. */
  timeoutMs?: number;
}

/** The slice of the RPC client the orchestration loop needs (injectable). */
export interface AgentRpc {
  request(
    method: string,
    params?: Record<string, unknown>,
    opts?: RpcRequestOptions,
  ): Promise<unknown>;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface NdjsonRpcClientOptions {
  /** Called for every message that is not a response to a pending request. */
  onNotification?: (msg: Record<string, unknown>) => void;
}

/**
 * Minimal NDJSON JSON-RPC 2.0 client. Transport-agnostic for testability:
 * outgoing lines go through `sendLine`, incoming bytes are pushed via `feed`.
 */
export class NdjsonRpcClient implements AgentRpc {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private closedError: Error | null = null;

  constructor(
    private readonly sendLine: (line: string) => void,
    private readonly options: NdjsonRpcClientOptions = {},
  ) {}

  request(
    method: string,
    params: Record<string, unknown> = {},
    opts: RpcRequestOptions = {},
  ): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const entry: PendingRequest = {
        method,
        resolve: resolvePromise,
        reject: rejectPromise,
      };
      if (opts.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          rejectPromise(
            new RpcError(`request ${method} (id=${id}) timed out after ${opts.timeoutMs}ms`),
          );
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.sendLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        this.pending.delete(id);
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Push raw stdout text; lines are split and dispatched. */
  feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // non-JSON noise on stdout
      }
      if (parsed === null || typeof parsed !== "object") continue;
      this.dispatch(parsed as Record<string, unknown>);
    }
  }

  /** Reject every pending request and all future ones (child died). */
  failAll(error: Error): void {
    this.closedError = error;
    for (const [, entry] of this.pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id === "number" && this.pending.has(id)) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      if (msg.error !== undefined && msg.error !== null) {
        const error = msg.error as Record<string, unknown>;
        const message =
          typeof error.message === "string" ? error.message : JSON.stringify(error);
        const code = typeof error.code === "number" ? error.code : undefined;
        entry.reject(new RpcError(`${entry.method} failed: ${message}`, code, error.data));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    this.options.onNotification?.(msg);
  }
}

// ---------------------------------------------------------------------------
// Agent process (real spawn; injectable in tests)
// ---------------------------------------------------------------------------

export interface AgentProcess {
  rpc: AgentRpc;
  kill(): void;
}

export type SpawnAgent = (
  workdir: string,
  log: (line: string) => void,
) => Promise<AgentProcess>;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Poll a cheap method until the JSON-RPC server answers. */
async function waitForReady(rpc: AgentRpc): Promise<void> {
  for (let i = 0; i < READY_ATTEMPTS; i++) {
    try {
      await rpc.request("skills/list", {}, { timeoutMs: READY_POLL_TIMEOUT_MS });
      return;
    } catch (err) {
      if (err instanceof RpcError && err.code !== undefined) return; // server is up
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new Error("Ouroboros CLI did not become ready over JSON-RPC");
}

/** Spawn the Ouroboros CLI in --json-rpc mode and wait until it is ready. */
async function spawnAgentProcess(
  workdir: string,
  log: (line: string) => void,
): Promise<AgentProcess> {
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "--json-rpc", "--config", workdir],
    cwd: workdir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, OUROBOROS_DISABLE_RSI: "1" },
  }) as Subprocess<"pipe", "pipe", "inherit">;

  const rpc = new NdjsonRpcClient(
    (line) => {
      proc.stdin.write(line + "\n");
      proc.stdin.flush();
    },
    {
      onNotification: (msg) => {
        const line = describeNotification(msg);
        if (line) log(line);
      },
    },
  );

  void (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rpc.feed(decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream torn down on kill
    }
  })();

  void proc.exited.then((code) => {
    rpc.failAll(new Error(`agent process exited (code ${code})`));
  });

  const kill = () => {
    try {
      proc.stdin.end();
    } catch {
      // already closed
    }
    proc.kill();
  };

  try {
    await waitForReady(rpc);
  } catch (err) {
    kill();
    throw err;
  }
  return { rpc, kill };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunnerDeps {
  /** ARC HTTP client; defaults to one built from ARC_API_KEY/ARC_BASE_URL. */
  client?: ArcClient;
  /** Agent factory; defaults to spawning the real CLI in --json-rpc mode. */
  spawnAgent?: SpawnAgent;
  /** Progress logger (default: stderr). */
  log?: (line: string) => void;
  /** Summary printer (default: stdout). */
  print?: (line: string) => void;
  /** Grace period to let a cancelled run settle (default 15s; tests shrink). */
  cancelGraceMs?: number;
}

interface AgentRunResult {
  iterations?: number;
  stopReason?: string;
}

export async function runArcBenchmark(
  opts: ArcBenchOptions,
  deps: RunnerDeps = {},
): Promise<{ exitCode: number }> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const print = deps.print ?? ((line: string) => console.log(line));
  const cancelGraceMs = deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;

  // 1. Preflight.
  // The key is required even when a client is injected (tests): it is written
  // into the generated .ouroboros MCP env block, so an empty value would
  // produce an invalid config on disk.
  const apiKey = process.env.ARC_API_KEY;
  if (!apiKey) {
    log(
      "Error: ARC_API_KEY is not set. Register at https://three.arcprize.org " +
        "and export ARC_API_KEY before running the benchmark.",
    );
    return { exitCode: 1 };
  }
  const client = deps.client ?? new ArcClient();

  // 2. Resolve games.
  let games: string[];
  try {
    games =
      opts.games === "all"
        ? (await client.listGames()).map((g) => g.game_id)
        : opts.games;
  } catch (err) {
    log(`Error: failed to list games: ${errorMessage(err)}`);
    return { exitCode: 1 };
  }
  if (games.length === 0) {
    log("Error: no games to run.");
    return { exitCode: 1 };
  }

  // 3. Open the scorecard.
  let cardId: string;
  try {
    cardId = (await client.openScorecard({ tags: opts.tags })).card_id;
  } catch (err) {
    log(`Error: failed to open scorecard: ${errorMessage(err)}`);
    return { exitCode: 1 };
  }
  log(`Scorecard open: ${cardId} (games: ${games.join(", ")})`);

  const rows: GameRunRow[] = [];
  let harnessError = false;
  let workdir: string | undefined;
  let agent: AgentProcess | undefined;

  try {
    // 4. Temp workdir + merged config.
    workdir = await mkdtemp(join(tmpdir(), "arc-bench-"));
    const userConfig = await readUserConfig(opts.configDir ?? homedir());
    const benchConfig = buildBenchConfig(userConfig, {
      apiKey,
      cardId,
      baseUrl: process.env.ARC_BASE_URL,
      cookies: client.cookieHeaderValue(),
      reasoningEffort: opts.reasoningEffort,
      frameLogDir: workdir,
    });
    await writeFile(
      join(workdir, ".ouroboros"),
      JSON.stringify(benchConfig, null, 2) + "\n",
      "utf-8",
    );

    // 5. Spawn the agent.
    agent = await (deps.spawnAgent ?? spawnAgentProcess)(workdir, log);

    // 6. Per-game loop.
    for (const game of games) {
      const row: GameRunRow = { game, state: "?", stopReason: "error" };
      try {
        const session = (await agent.rpc.request(
          "session/new",
          {},
          { timeoutMs: SESSION_NEW_TIMEOUT_MS },
        )) as Record<string, unknown>;
        const sessionId = session?.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          throw new Error("session/new did not return a sessionId");
        }

        log(
          `[${game}] running (maxSteps=${opts.maxSteps}, timeout=${opts.timeoutMin}min)`,
        );
        // Driver loop: models love to stop early and summarize. Keep
        // re-prompting until the step budget is spent, the wall clock runs
        // out, the game is won, the run errors, or the model makes no progress
        // for several consecutive prompts (genuinely stuck).
        const deadline = Date.now() + opts.timeoutMin * 60_000;
        let stepsUsed = 0;
        let message = buildGoal(game, opts.maxSteps);
        let noProgressStreak = 0;
        while (true) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            row.stopReason = "timeout";
            break;
          }
          const runPromise = agent.rpc.request("agent/run", {
            sessionId,
            skillName: SKILL_NAME,
            maxSteps: Math.max(1, opts.maxSteps - stepsUsed),
            message,
          });
          const outcome = await raceWallClock(runPromise, remainingMs);
          if (outcome.timedOut) {
            log(`[${game}] wall-clock timeout — sending agent/cancel`);
            await agent.rpc
              .request("agent/cancel", { sessionId }, { timeoutMs: CANCEL_TIMEOUT_MS })
              .catch((err: unknown) => log(`[${game}] cancel failed: ${errorMessage(err)}`));
            // Give the cancelled run a moment to settle, then abandon it.
            await raceWallClock(
              runPromise.catch(() => undefined),
              cancelGraceMs,
            );
            row.stopReason = "timeout";
            break;
          }
          const result = (outcome.value ?? {}) as AgentRunResult;
          const delta = typeof result.iterations === "number" ? result.iterations : 0;
          stepsUsed += delta;
          row.steps = stepsUsed;
          row.stopReason =
            typeof result.stopReason === "string" ? result.stopReason : "completed";

          // An errored run (LLM failure, quota exhaustion) won't get better by
          // re-prompting — don't burn continuations on it.
          if (row.stopReason === "error") break;
          if (stepsUsed >= opts.maxSteps) break;

          // Bail out if the model is stuck (no new steps) several turns running.
          noProgressStreak = delta > 0 ? 0 : noProgressStreak + 1;
          if (noProgressStreak >= MAX_NO_PROGRESS_CONTINUATIONS) {
            log(
              `[${game}] no progress after ${noProgressStreak} continuations — stopping`,
            );
            break;
          }

          let stats: GameStats;
          try {
            stats = extractGameStats(await client.getScorecard(cardId), game);
          } catch (err) {
            log(`[${game}] scorecard fetch failed: ${errorMessage(err)}`);
            break;
          }
          if (stats.state === "WIN") break;
          const remaining = opts.maxSteps - stepsUsed;
          log(
            `[${game}] stopped early (${stepsUsed}/${opts.maxSteps} steps, ` +
              `state=${stats.state ?? "?"}) — continuing`,
          );
          message = buildContinueMessage(game, remaining, stats);
        }
      } catch (err) {
        harnessError = true;
        row.stopReason = "error";
        log(`[${game}] run failed: ${errorMessage(err)}`);
      }

      // Ground truth from the scorecard.
      try {
        const scorecard = await client.getScorecard(cardId);
        const stats = extractGameStats(scorecard, game);
        if (stats.state !== undefined) row.state = stats.state;
        row.score = stats.score;
        row.actions = stats.actions;
        row.winScore = stats.winScore;
      } catch (err) {
        log(`[${game}] scorecard fetch failed: ${errorMessage(err)}`);
      }
      rows.push(row);
      log(`[${game}] done: state=${row.state} score=${row.score ?? "-"} stop=${row.stopReason}`);
    }
  } catch (err) {
    harnessError = true;
    log(`Benchmark harness error: ${errorMessage(err)}`);
  } finally {
    try {
      await client.closeScorecard(cardId);
      log(`Scorecard closed: ${cardId}`);
    } catch (err) {
      log(`Warning: failed to close scorecard ${cardId}: ${errorMessage(err)}`);
    }
    agent?.kill();
    if (workdir) {
      // The workdir's .ouroboros contains ARC_API_KEY in plaintext — warn
      // loudly if cleanup fails so the operator can remove it manually.
      await rm(workdir, { recursive: true, force: true }).catch((err: unknown) =>
        log(`Warning: failed to delete temp workdir ${workdir}: ${errorMessage(err)}`),
      );
    }
  }

  // 7. Summary.
  const scorecardUrl = `${SCORECARD_URL_BASE}${cardId}`;
  print("");
  print(formatSummaryTable(rows));
  print("");
  print(`Scorecard: ${scorecardUrl}`);

  if (opts.out) {
    try {
      await writeFile(
        opts.out,
        JSON.stringify({ cardId, url: scorecardUrl, games: rows }, null, 2) + "\n",
        "utf-8",
      );
      log(`Results written to ${opts.out}`);
    } catch (err) {
      harnessError = true;
      log(`Error: failed to write ${opts.out}: ${errorMessage(err)}`);
    }
  }

  return { exitCode: harnessError ? 1 : 0 };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
