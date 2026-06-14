/**
 * ARC-AGI-3 MCP stdio server — the agent's hands for playing games.
 *
 * Tools:
 * - `list_games`: GET /api/games.
 * - `reset {game_id, card_id?}`: start (or restart) a game. `card_id` falls
 *   back to the ARC_CARD_ID env var; when a prior session exists for the
 *   game, its guid is included so the API reuses the session.
 * - `act {game_id, moves[1..20], render?}`: execute moves sequentially,
 *   early-stopping the batch when state becomes WIN/GAME_OVER or the score
 *   changes. Returns per-move one-liners (annotated with a clean object move
 *   when there is one) + the final frame (diff + `objects:` section vs the
 *   frame before the batch by default; full on request, on state/score
 *   change, or when >40% of cells changed) + a trailing status line.
 * - `status {game_id?}`: cached-state echo, no API call. Without `game_id`,
 *   lists tracked sessions; with it, re-renders the cached frame in full.
 *
 * Every full render is followed by a `summarizeObjects` inventory (background
 * + connected components) so the model tracks objects, not pixels.
 *
 * All guard failures return MCP tool errors (`isError: true`) — the server
 * never throws out of a tool handler. A single FIFO queue serializes every
 * tool execution because the Ouroboros agent may emit parallel tool calls.
 *
 * Env: ARC_API_KEY (required at first call), ARC_CARD_ID (default scorecard),
 * ARC_BASE_URL (test seam; see client.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  ArcClient,
  type ArcActionNumber,
  type ArcClientOptions,
  type FrameResponse,
} from "./client";
import { appendHistory, frameLogPath } from "./history";
import { describeObjectChanges, summarizeObjects } from "./objects";
import {
  changedCellCount,
  lastGrid,
  renderFrame,
  renderFrameDiff,
  shouldRenderFull,
} from "./render";

// Sized so a full replay of a learned level fits in one call (one LLM step):
// pilot logs showed deaths cost the whole level because re-clears were spread
// across many small batches.
export const MAX_MOVES_PER_ACT = 40;

interface GameSession {
  gameId: string;
  guid: string;
  lastFrame: FrameResponse;
  lastAvailableActions: number[];
  score: number;
  /** Total ACTION commands issued for this game (across resets). */
  actionCount: number;
}

export interface ArcServerOptions {
  /** Overrides for the internal ArcClient (test seam). */
  clientOptions?: ArcClientOptions;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeMove(action: number, x?: number, y?: number): string {
  const coords = x !== undefined && y !== undefined ? `(${x},${y})` : "";
  return `ACTION${action}${coords}`;
}

/**
 * Build the ARC MCP server. Constructible without connecting a transport, so
 * tests can wire it to an InMemoryTransport pair.
 */
export function createArcServer(options: ArcServerOptions = {}): McpServer {
  const sessions = new Map<string, GameSession>();

  // Lazy client: ARC_API_KEY absence must surface as a tool error at call
  // time, never as a construction throw.
  let client: ArcClient | undefined;
  function getClient(): ArcClient {
    client ??= new ArcClient(options.clientOptions);
    return client;
  }

  // Affinity keep-alive: the API holds scorecard/game state behind AWS ALB
  // cookie affinity, and long gaps without requests (LLM thinking time, slow
  // CLI startup) can let it lapse — after which every command fails with a
  // misleading "game not found". Once a session is established, ping the
  // scorecard periodically; each response also refreshes the cookie jar.
  const keepAliveMs = Number(process.env.ARC_KEEPALIVE_MS ?? 45_000);
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  function ensureKeepAlive(): void {
    if (keepAlive || !(keepAliveMs > 0)) return;
    const cardId = process.env.ARC_CARD_ID?.trim();
    if (!cardId) return;
    keepAlive = setInterval(() => {
      getClient()
        .getScorecard(cardId)
        .catch(() => {
          // Best-effort: a failed ping must never crash the server.
        });
    }, keepAliveMs);
    // Never keep the process alive just for pings.
    keepAlive.unref?.();
  }

  // Single FIFO queue: the Ouroboros agent can emit parallel tool calls in
  // one step; game commands must never interleave.
  let queueTail: Promise<unknown> = Promise.resolve();
  function serialized(
    fn: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const run = queueTail.then(
      async () => {
        try {
          return await fn();
        } catch (err) {
          return toolError(errorMessage(err));
        }
      },
      // The previous task never rejects (errors become tool results), but be
      // defensive: a rejected predecessor must not poison the queue.
      async () => toolError("internal queue error"),
    );
    queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function statusLine(session: GameSession): string {
    const frame = session.lastFrame;
    const win =
      typeof frame.win_score === "number" ? `/${frame.win_score}` : "";
    const available = (frame.available_actions ?? []).join(",");
    return (
      `state=${frame.state} score=${frame.score}${win} ` +
      `available_actions=[${available}] total_actions=${session.actionCount}`
    );
  }

  function updateSession(session: GameSession, frame: FrameResponse): void {
    session.guid = frame.guid;
    session.lastFrame = frame;
    session.lastAvailableActions = frame.available_actions ?? [];
    session.score = frame.score;
  }

  // Persist the raw grid for code-assisted analysis (see history.ts).
  function logHistory(
    session: GameSession,
    t: "reset" | "act",
    move?: { action: number; x?: number; y?: number },
  ): void {
    const frame = session.lastFrame;
    appendHistory(session.gameId, {
      seq: session.actionCount,
      t,
      ...(move ? { action: move.action, x: move.x, y: move.y } : {}),
      score: frame.score,
      state: frame.state,
      available_actions: frame.available_actions ?? [],
      frame: lastGrid(frame.frame),
    });
  }

  const server = new McpServer({ name: "arc", version: "0.1.0" });

  // -- list_games -------------------------------------------------------------

  server.registerTool(
    "list_games",
    {
      description:
        "List the available ARC-AGI-3 games (game_id and title) from the API.",
    },
    () =>
      serialized(async () => {
        const games = await getClient().listGames();
        const lines = games.map((g) =>
          g.title ? `${g.game_id} — ${g.title}` : g.game_id,
        );
        return textResult(
          `${games.length} game(s):\n${lines.join("\n")}`,
        );
      }),
  );

  // -- reset --------------------------------------------------------------------

  server.registerTool(
    "reset",
    {
      description:
        "Start (or restart) a game via RESET. card_id defaults to the " +
        "ARC_CARD_ID env var; an existing session's guid is reused so the " +
        "play continues on the same scorecard session. Returns the full " +
        "starting frame.",
      inputSchema: {
        game_id: z.string().describe("Game id, e.g. ls20-abc123"),
        card_id: z
          .string()
          .optional()
          .describe(
            "Leave unset — the scorecard id is preconfigured by the harness " +
              "(ARC_CARD_ID env). Only pass a value if you opened a scorecard " +
              "yourself.",
          ),
      },
    },
    (args) =>
      serialized(async () => {
        // Models often pass card_id: "" for "I don't know it" — treat any
        // blank value as absent so the env-provided scorecard id wins.
        const cardId =
          args.card_id?.trim() || process.env.ARC_CARD_ID?.trim() || undefined;
        const prior = sessions.get(args.game_id);
        const frame = await getClient().reset({
          game_id: args.game_id,
          card_id: cardId,
          guid: prior?.guid,
        });
        const session: GameSession = prior ?? {
          gameId: args.game_id,
          guid: frame.guid,
          lastFrame: frame,
          lastAvailableActions: frame.available_actions ?? [],
          score: frame.score,
          actionCount: 0,
        };
        updateSession(session, frame);
        sessions.set(args.game_id, session);
        ensureKeepAlive();
        logHistory(session, "reset");
        return textResult(
          `RESET ${args.game_id} (guid ${frame.guid})\n` +
            `${renderFrame(frame.frame)}\n` +
            `${summarizeObjects(lastGrid(frame.frame))}\n${statusLine(session)}\n` +
            `frame_history=${frameLogPath(args.game_id)} ` +
            `(JSONL of {seq,t,action,x,y,score,state,available_actions,frame[64][64]} — ` +
            `analyze with code-exec)`,
        );
      }),
  );

  // -- act ----------------------------------------------------------------------

  server.registerTool(
    "act",
    {
      description:
        "Execute a batch of 1-40 moves sequentially. Each move is " +
        "{action: 1-6, x?, y?, note?}; ACTION6 requires x and y (0-63, " +
        "origin top-left). note is forwarded as the API reasoning field. " +
        "The batch early-stops when the state changes (WIN/GAME_OVER) or " +
        "the score changes. Returns per-move one-liners, the final frame " +
        "(diff vs the pre-batch frame by default), and a status line.",
      inputSchema: {
        game_id: z.string(),
        moves: z
          .array(
            z.object({
              action: z.number().int().min(1).max(6),
              x: z.number().int().min(0).max(63).optional(),
              y: z.number().int().min(0).max(63).optional(),
              note: z.string().optional(),
            }),
          )
          .min(1)
          .max(MAX_MOVES_PER_ACT),
        render: z
          .enum(["full", "diff"])
          .optional()
          .describe("Final frame rendering (default diff)"),
      },
    },
    (args) =>
      serialized(async () => {
        const session = sessions.get(args.game_id);
        if (!session) {
          return toolError(
            `No active session for game "${args.game_id}" — call reset first.`,
          );
        }

        // Static guard: ACTION6 needs coordinates. Reject the whole batch
        // up front so no moves execute against a malformed plan.
        for (const [i, move] of args.moves.entries()) {
          if (move.action === 6 && (move.x === undefined || move.y === undefined)) {
            return toolError(
              `Move #${i + 1}: ACTION6 requires x and y (integers 0-63).`,
            );
          }
        }

        const preBatchFrame = session.lastFrame;
        const lines: string[] = [];
        let prevGrid = lastGrid(preBatchFrame.frame);

        for (const [i, move] of args.moves.entries()) {
          const available = session.lastAvailableActions;
          if (!available.includes(move.action)) {
            const valid = `[${available.join(",")}]`;
            if (i === 0) {
              return toolError(
                `ACTION${move.action} is not available right now. ` +
                  `Valid actions: ${valid}.`,
              );
            }
            lines.push(
              `#${i + 1} ${describeMove(move.action, move.x, move.y)} ` +
                `skipped: not in available_actions ${valid}; batch stopped`,
            );
            break;
          }

          const desc = describeMove(move.action, move.x, move.y);
          const scoreBefore = session.score;
          const stateBefore = session.lastFrame.state;

          let frame: FrameResponse;
          try {
            frame = await getClient().action(move.action as ArcActionNumber, {
              game_id: args.game_id,
              guid: session.guid,
              ...(move.x !== undefined ? { x: move.x } : {}),
              ...(move.y !== undefined ? { y: move.y } : {}),
              ...(move.note !== undefined ? { reasoning: move.note } : {}),
            });
          } catch (err) {
            lines.push(`#${i + 1} ${desc} failed: ${errorMessage(err)}`);
            return toolError(lines.join("\n"));
          }

          session.actionCount++;
          const nextGrid = lastGrid(frame.frame);
          const changed = changedCellCount(prevGrid, nextGrid);
          let line = `#${i + 1} ${desc} → ${changed} cell${changed === 1 ? "" : "s"} changed`;
          if (changed > 0) {
            // When this move resolves to 1-2 clean object moves, surface the
            // first one inline — "52 cells changed" alone is just noise.
            const objLines = describeObjectChanges(prevGrid, nextGrid).split("\n");
            if (
              objLines.length <= 2 &&
              objLines.every((l) => l.includes(" moved ("))
            ) {
              line += ` (${objLines[0]})`;
            }
          }
          if (frame.score !== scoreBefore) {
            line += ` | score ${scoreBefore}→${frame.score}`;
          }
          if (frame.state !== stateBefore) {
            line += ` | state → ${frame.state}`;
          }
          lines.push(line);

          updateSession(session, frame);
          logHistory(session, "act", { action: move.action, x: move.x, y: move.y });
          prevGrid = nextGrid;

          const terminal = frame.state === "WIN" || frame.state === "GAME_OVER";
          const scoreChanged = frame.score !== scoreBefore;
          if (terminal || scoreChanged) {
            if (i < args.moves.length - 1) {
              lines.push(
                `early stop after move #${i + 1}: ` +
                  (terminal ? `state ${frame.state}` : "score changed") +
                  ` (${args.moves.length - i - 1} move(s) not executed)`,
              );
            }
            break;
          }
        }

        const finalFrame = session.lastFrame;
        const stateChanged = finalFrame.state !== preBatchFrame.state;
        const scoreChanged = finalFrame.score !== preBatchFrame.score;
        const preBatchGrid = lastGrid(preBatchFrame.frame);
        const finalGrid = lastGrid(finalFrame.frame);
        const renderFullFrame =
          args.render === "full" ||
          stateChanged ||
          scoreChanged ||
          shouldRenderFull(preBatchGrid, finalGrid);
        const frameText = renderFullFrame
          ? `${renderFrame(finalFrame.frame)}\n${summarizeObjects(finalGrid)}`
          : `${renderFrameDiff(preBatchFrame.frame, finalFrame.frame)}\n` +
            `objects:\n${describeObjectChanges(preBatchGrid, finalGrid)}`;

        return textResult(
          `${lines.join("\n")}\n\n${frameText}\n${statusLine(session)}`,
        );
      }),
  );

  // -- status -------------------------------------------------------------------

  server.registerTool(
    "status",
    {
      description:
        "Echo cached game state without any API call. Without game_id, " +
        "lists tracked sessions (guid, action count, score, last state). " +
        "With game_id, re-renders the cached last frame in full.",
      inputSchema: {
        game_id: z.string().optional(),
      },
    },
    (args) =>
      serialized(async () => {
        if (args.game_id !== undefined) {
          const session = sessions.get(args.game_id);
          if (!session) {
            return toolError(
              `No active session for game "${args.game_id}" — call reset first.`,
            );
          }
          const grid = lastGrid(session.lastFrame.frame);
          return textResult(
            `${session.gameId} guid=${session.guid}\n` +
              `${renderFrame(session.lastFrame.frame)}\n` +
              `${summarizeObjects(grid)}\n${statusLine(session)}`,
          );
        }

        if (sessions.size === 0) {
          return textResult("No tracked sessions — call reset to start a game.");
        }
        const lines = [...sessions.values()].map(
          (s) =>
            `${s.gameId}: guid=${s.guid} state=${s.lastFrame.state} ` +
            `score=${s.score} actions=${s.actionCount}`,
        );
        return textResult(lines.join("\n"));
      }),
  );

  return server;
}

// Entry point: `bun run src/server.ts` connects over stdio.
if (import.meta.main) {
  const server = createArcServer();
  await server.connect(new StdioServerTransport());
}
