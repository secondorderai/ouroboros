/**
 * Bun.serve mock of the ARC-AGI-3 API for tests. No network beyond localhost.
 *
 * Deterministic toy game on a 64x64 grid:
 * - Level 1: a movable player pixel (color 3) starts at MOCK_START; ACTION1-4
 *   move it up/down/left/right by one cell. Reaching the target cell
 *   (MOCK_L1_TARGET, color 2) increments score and starts level 2.
 * - Level 2: player resets to MOCK_START; an ACTION6 click on the marked cell
 *   (MOCK_L2_MARK, color 4) increments score and WINs the game (2 levels).
 * - Attempting to move off-grid 3 times (cumulative per play) => GAME_OVER.
 *
 * API behavior (mirrors the live three.arcprize.org API):
 * - All /api/* routes require a matching X-API-Key header (401 otherwise).
 * - Frame responses use the live field names `levels_completed`/`win_levels`
 *   (NOT `score`/`win_score`).
 * - GET /api/scorecard/{card_id} returns the live `environments: [...]` shape.
 * - AWS ALB cookie affinity is simulated: /api/scorecard/open and
 *   /api/cmd/RESET issue AWSALB + AWSALBCORS cookies encoding a "node".
 *   A scorecard is only visible to requests whose AWSALB cookie carries the
 *   node it was opened on. Like the live API, a mismatch fails with HTTP 200
 *   and a misleading body: RESET => {"error":"SERVER_ERROR","message":"game
 *   <game_id> not found"}; scorecard GET => {"error":"SERVER_ERROR",
 *   "message":"card_id `<id>` not found"}.
 * - Any ACTION cmd missing the AWSALB cookie or a known guid gets a 400.
 * - POST /api/scorecard/open also sets an `arcsess` cookie so tests can verify
 *   the client merges cookies across different responses.
 */

export const MOCK_API_KEY = "test-key";
export const MOCK_GRID_SIZE = 64;
export const MOCK_START = { x: 2, y: 2 };
export const MOCK_L1_TARGET = { x: 2, y: 7 };
export const MOCK_L2_MARK = { x: 30, y: 30 };
export const MOCK_PLAYER_COLOR = 3;
export const MOCK_L1_TARGET_COLOR = 2;
export const MOCK_L2_MARK_COLOR = 4;
export const MOCK_WIN_SCORE = 2;
export const MOCK_OFF_GRID_LIMIT = 3;

export const MOCK_GAMES = [
  { game_id: "toy1-abc123", title: "Toy Maze 1" },
  { game_id: "toy2-def456", title: "Toy Maze 2" },
];

export type MockGameState = "NOT_FINISHED" | "WIN" | "GAME_OVER";

export interface MockSession {
  guid: string;
  game_id: string;
  card_id?: string;
  level: 1 | 2;
  pos: { x: number; y: number };
  score: number;
  state: MockGameState;
  offGridAttempts: number;
  actionCount: number;
}

export interface MockCardGameStats {
  game_id: string;
  total_plays: number;
  total_actions: number;
  scores: number[];
  states: string[];
  guids: string[];
  /** Per-run action counts (parallel to scores/states/guids). */
  runActions: number[];
}

export interface MockScorecard {
  card_id: string;
  closed: boolean;
  tags: string[];
  /** ALB "node" the card lives on; other nodes cannot see it (affinity). */
  node: string;
  cards: Record<string, MockCardGameStats>;
}

export interface LoggedRequest {
  method: string;
  path: string;
  apiKey: string | null;
  cookie: string | null;
  contentType: string | null;
  body: unknown;
}

export interface FailNextOptions {
  status: number;
  /** Retry-After header value in seconds. */
  retryAfter?: number;
  /** How many consecutive requests fail (default 1). */
  times?: number;
}

export interface MockArcServer {
  url: string;
  apiKey: string;
  stop(): void;
  /** Make the next request(s) fail with the given status (before routing). */
  failNext(options: FailNextOptions): void;
  /** Delay the next request's response by the given milliseconds. */
  delayNext(ms: number): void;
  /** Chronological log of every request received. */
  requests: LoggedRequest[];
  getSession(guid: string): MockSession | undefined;
  listSessions(): MockSession[];
  getScorecard(cardId: string): MockScorecard | undefined;
}

interface SessionInternal extends MockSession {}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function badRequest(error: string): Response {
  return json({ error }, { status: 400 });
}

class HttpError extends Error {
  constructor(public readonly response: Response) {
    super("http error");
  }
}

export function startMockArcServer(
  options: { apiKey?: string } = {},
): MockArcServer {
  const apiKey = options.apiKey ?? MOCK_API_KEY;
  const sessions = new Map<string, SessionInternal>();
  const scorecards = new Map<string, MockScorecard>();
  const requests: LoggedRequest[] = [];
  let guidCounter = 0;
  let cardCounter = 0;
  let nodeCounter = 0;
  let cookieRotation = 0;
  let pendingFail: { status: number; retryAfter?: number; remaining: number } | null =
    null;
  let pendingDelayMs = 0;

  // -- Game logic -----------------------------------------------------------

  function freshSessionFields(): Pick<
    SessionInternal,
    "level" | "pos" | "score" | "state" | "offGridAttempts" | "actionCount"
  > {
    return {
      level: 1,
      pos: { ...MOCK_START },
      score: 0,
      state: "NOT_FINISHED",
      offGridAttempts: 0,
      actionCount: 0,
    };
  }

  function buildGrid(session: SessionInternal): number[][] {
    const grid: number[][] = Array.from({ length: MOCK_GRID_SIZE }, () =>
      new Array<number>(MOCK_GRID_SIZE).fill(0),
    );
    if (session.level === 1) {
      grid[MOCK_L1_TARGET.y]![MOCK_L1_TARGET.x] = MOCK_L1_TARGET_COLOR;
    } else {
      grid[MOCK_L2_MARK.y]![MOCK_L2_MARK.x] = MOCK_L2_MARK_COLOR;
    }
    if (session.state !== "GAME_OVER") {
      grid[session.pos.y]![session.pos.x] = MOCK_PLAYER_COLOR;
    }
    return grid;
  }

  function availableActions(session: SessionInternal): number[] {
    if (session.state !== "NOT_FINISHED") return [];
    return session.level === 1 ? [1, 2, 3, 4] : [6];
  }

  function frameResponse(session: SessionInternal): Record<string, unknown> {
    return {
      game_id: session.game_id,
      guid: session.guid,
      frame: [buildGrid(session)],
      state: session.state,
      // Live API naming: levels_completed/win_levels (no score/win_score).
      levels_completed: session.score,
      win_levels: MOCK_WIN_SCORE,
      available_actions: availableActions(session),
      // Extra fields the client must tolerate and preserve (loose parsing).
      action_counter: session.actionCount,
      full_reset: false,
    };
  }

  function applyAction(
    session: SessionInternal,
    action: number,
    x: unknown,
    y: unknown,
  ): void {
    if (session.state !== "NOT_FINISHED") return; // terminal: frame unchanged
    session.actionCount++;

    if (action >= 1 && action <= 4) {
      const delta = {
        1: { dx: 0, dy: -1 },
        2: { dx: 0, dy: 1 },
        3: { dx: -1, dy: 0 },
        4: { dx: 1, dy: 0 },
      }[action as 1 | 2 | 3 | 4];
      const nx = session.pos.x + delta.dx;
      const ny = session.pos.y + delta.dy;
      if (
        nx < 0 ||
        ny < 0 ||
        nx >= MOCK_GRID_SIZE ||
        ny >= MOCK_GRID_SIZE
      ) {
        session.offGridAttempts++;
        if (session.offGridAttempts >= MOCK_OFF_GRID_LIMIT) {
          session.state = "GAME_OVER";
        }
        return;
      }
      session.pos = { x: nx, y: ny };
      if (
        session.level === 1 &&
        session.pos.x === MOCK_L1_TARGET.x &&
        session.pos.y === MOCK_L1_TARGET.y
      ) {
        session.score = 1;
        session.level = 2;
        session.pos = { ...MOCK_START };
      }
      return;
    }

    if (action === 6) {
      if (typeof x !== "number" || typeof y !== "number") {
        throw new HttpError(badRequest("ACTION6 requires numeric x and y"));
      }
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= MOCK_GRID_SIZE ||
        y >= MOCK_GRID_SIZE
      ) {
        throw new HttpError(
          badRequest(`ACTION6 x/y must be integers in [0,${MOCK_GRID_SIZE - 1}]`),
        );
      }
      if (
        session.level === 2 &&
        x === MOCK_L2_MARK.x &&
        y === MOCK_L2_MARK.y
      ) {
        session.score = 2;
        session.state = "WIN";
      }
      return;
    }
    // ACTION5: no-op in the toy game.
  }

  // -- Scorecard tracking -----------------------------------------------------

  function cardStats(card: MockScorecard, gameId: string): MockCardGameStats {
    let stats = card.cards[gameId];
    if (!stats) {
      stats = {
        game_id: gameId,
        total_plays: 0,
        total_actions: 0,
        scores: [],
        states: [],
        guids: [],
        runActions: [],
      };
      card.cards[gameId] = stats;
    }
    return stats;
  }

  function recordPlay(session: SessionInternal): void {
    if (!session.card_id) return;
    const card = scorecards.get(session.card_id);
    if (!card || card.closed) return;
    const stats = cardStats(card, session.game_id);
    stats.total_plays++;
    stats.scores.push(session.score);
    stats.states.push(session.state);
    stats.guids.push(session.guid);
    stats.runActions.push(0);
  }

  function recordAction(session: SessionInternal): void {
    if (!session.card_id) return;
    const card = scorecards.get(session.card_id);
    if (!card || card.closed) return;
    const stats = cardStats(card, session.game_id);
    stats.total_actions++;
    if (stats.scores.length > 0) {
      stats.scores[stats.scores.length - 1] = session.score;
      stats.states[stats.states.length - 1] = session.state;
      stats.runActions[stats.runActions.length - 1]!++;
    }
  }

  /** Serialize a card the way the live GET /api/scorecard/{card_id} does. */
  function serializeScorecard(card: MockScorecard): Record<string, unknown> {
    const environments = Object.values(card.cards).map((stats) => {
      const best = stats.scores.length > 0 ? Math.max(...stats.scores) : 0;
      return {
        id: stats.game_id,
        actions: stats.total_actions,
        levels_completed: best,
        level_count: MOCK_WIN_SCORE,
        resets: stats.total_plays,
        score: best,
        runs: stats.scores.map((score, i) => ({
          state: stats.states[i],
          levels_completed: score,
          score,
          actions: stats.runActions[i],
          guid: stats.guids[i],
        })),
      };
    });
    return {
      card_id: card.card_id,
      score: environments.reduce((sum, e) => sum + e.levels_completed, 0),
      tags: card.tags,
      environments,
    };
  }

  // -- ALB cookie affinity ------------------------------------------------------

  /** Extract the node id from a request's AWSALB cookie, if any. */
  function nodeFromCookie(header: string | null): string | undefined {
    const match = /(?:^|;\s*)AWSALB=([^;]+)/.exec(header ?? "");
    if (!match) return undefined;
    const node = match[1]!.split(".")[0]!;
    return node.startsWith("node-") ? node : undefined;
  }

  /** Re-issue AWSALB/AWSALBCORS bound to a node (value rotates per response). */
  function withAffinityCookies(res: Response, node: string): Response {
    const value = `${node}.${++cookieRotation}`;
    res.headers.append("Set-Cookie", `AWSALB=${value}; Path=/`);
    res.headers.append("Set-Cookie", `AWSALBCORS=${value}; Path=/; SameSite=None`);
    return res;
  }

  /** The live API's misleading failure mode: HTTP 200 with an error body. */
  function serverError(message: string): Response {
    return json({ error: "SERVER_ERROR", message });
  }

  // -- Routes -----------------------------------------------------------------

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
    }

    requests.push({
      method: req.method,
      path,
      apiKey: req.headers.get("x-api-key"),
      cookie: req.headers.get("cookie"),
      contentType: req.headers.get("content-type"),
      body,
    });

    if (pendingDelayMs > 0) {
      const ms = pendingDelayMs;
      pendingDelayMs = 0;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }

    if (pendingFail && pendingFail.remaining > 0) {
      pendingFail.remaining--;
      const headers: Record<string, string> = {};
      if (pendingFail.retryAfter !== undefined) {
        headers["Retry-After"] = String(pendingFail.retryAfter);
      }
      const status = pendingFail.status;
      if (pendingFail.remaining === 0) pendingFail = null;
      return json({ error: `injected failure ${status}` }, { status, headers });
    }

    if (req.headers.get("x-api-key") !== apiKey) {
      return json({ error: "invalid or missing X-API-Key" }, { status: 401 });
    }

    if (req.method === "GET" && path === "/api/games") {
      return json(MOCK_GAMES);
    }

    const requestNode = nodeFromCookie(req.headers.get("cookie"));

    if (req.method === "POST" && path === "/api/scorecard/open") {
      const tags =
        body && typeof body === "object" && Array.isArray((body as any).tags)
          ? ((body as any).tags as string[])
          : [];
      const node = requestNode ?? `node-${++nodeCounter}`;
      const card: MockScorecard = {
        card_id: `card-${++cardCounter}`,
        closed: false,
        tags,
        node,
        cards: {},
      };
      scorecards.set(card.card_id, card);
      const res = json({ card_id: card.card_id });
      res.headers.append(
        "Set-Cookie",
        `arcsess=${card.card_id}; Path=/`,
      );
      return withAffinityCookies(res, node);
    }

    if (req.method === "POST" && path === "/api/scorecard/close") {
      const cardId = (body as any)?.card_id;
      if (typeof cardId !== "string") return badRequest("card_id required");
      const card = scorecards.get(cardId);
      if (!card) return json({ error: "unknown card_id" }, { status: 404 });
      card.closed = true;
      return json(serializeScorecard(card));
    }

    const scorecardMatch = path.match(/^\/api\/scorecard\/([^/]+)$/);
    if (req.method === "GET" && scorecardMatch) {
      const cardId = decodeURIComponent(scorecardMatch[1]!);
      const card = scorecards.get(cardId);
      // Affinity: a card opened on another node "does not exist" here, with
      // the live API's misleading HTTP-200 error body.
      if (!card || card.node !== requestNode) {
        return serverError(`card_id \`${cardId}\` not found`);
      }
      return json(serializeScorecard(card));
    }

    if (req.method === "POST" && path === "/api/cmd/RESET") {
      const { game_id, card_id, guid } = (body ?? {}) as Record<string, unknown>;
      if (typeof game_id !== "string" || game_id.length === 0) {
        return badRequest("game_id required");
      }
      if (!MOCK_GAMES.some((g) => g.game_id === game_id)) {
        return badRequest(`unknown game_id ${game_id}`);
      }
      if (card_id !== undefined) {
        if (typeof card_id !== "string") return badRequest("card_id must be a string");
        const card = scorecards.get(card_id);
        // Affinity: unknown card OR a card opened on another node fails with
        // the live API's misleading "game not found" HTTP-200 error body.
        if (!card || card.node !== requestNode) {
          return serverError(`game ${game_id} not found`);
        }
      }
      const node = requestNode ?? `node-${++nodeCounter}`;

      let session: SessionInternal;
      if (typeof guid === "string" && sessions.has(guid)) {
        session = sessions.get(guid)!;
        Object.assign(session, freshSessionFields());
      } else {
        session = {
          guid: `guid-${++guidCounter}`,
          game_id,
          ...freshSessionFields(),
        };
        sessions.set(session.guid, session);
      }
      if (typeof card_id === "string") session.card_id = card_id;
      recordPlay(session);

      return withAffinityCookies(json(frameResponse(session)), node);
    }

    const actionMatch = path.match(/^\/api\/cmd\/ACTION([1-6])$/);
    if (req.method === "POST" && actionMatch) {
      const cookie = req.headers.get("cookie") ?? "";
      if (!cookie.includes("AWSALB=")) {
        return badRequest("missing AWSALB cookie (call RESET first)");
      }
      const { game_id, guid, x, y } = (body ?? {}) as Record<string, unknown>;
      if (typeof guid !== "string" || !sessions.has(guid)) {
        return badRequest("missing or unknown guid");
      }
      const session = sessions.get(guid)!;
      if (typeof game_id === "string" && game_id !== session.game_id) {
        return badRequest("game_id does not match guid");
      }
      try {
        applyAction(session, Number(actionMatch[1]), x, y);
      } catch (err) {
        if (err instanceof HttpError) return err.response;
        throw err;
      }
      recordAction(session);
      return json(frameResponse(session));
    }

    return json({ error: `no route for ${req.method} ${path}` }, { status: 404 });
  }

  const server = Bun.serve({ port: 0, fetch: handle });

  return {
    url: `http://localhost:${server.port}`,
    apiKey,
    stop: () => {
      server.stop(true);
    },
    failNext: (opts) => {
      pendingFail = {
        status: opts.status,
        retryAfter: opts.retryAfter,
        remaining: opts.times ?? 1,
      };
    },
    delayNext: (ms) => {
      pendingDelayMs = ms;
    },
    requests,
    getSession: (guid) => sessions.get(guid),
    listSessions: () => [...sessions.values()],
    getScorecard: (cardId) => scorecards.get(cardId),
  };
}
