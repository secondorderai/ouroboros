/**
 * Pure ARC-AGI-3 HTTP client.
 *
 * - Auth via `X-API-Key` header (constructor arg, falling back to ARC_API_KEY env).
 * - Base URL from ARC_BASE_URL env, default https://three.arcprize.org.
 * - Cookie jar: captures Set-Cookie headers across all responses and replays
 *   them as a single Cookie header (AWS ALB stickiness).
 * - Retries 429/5xx honoring Retry-After (default 2s fallback, max 3 attempts).
 * - 30s per-request timeout via AbortSignal.
 * - Tolerant Zod parsing (loose objects keep unknown fields).
 */

import { appendFileSync } from "node:fs";
import { z } from "zod";

export const DEFAULT_BASE_URL = "https://three.arcprize.org";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// Schemas / types (loose: unknown fields are preserved)
// ---------------------------------------------------------------------------

export const GameInfoSchema = z.looseObject({
  game_id: z.string(),
  title: z.string().optional(),
});
export type GameInfo = z.infer<typeof GameInfoSchema>;

export const GameListSchema = z.array(GameInfoSchema);

export const ScorecardOpenResponseSchema = z.looseObject({
  card_id: z.string(),
});
export type ScorecardOpenResponse = z.infer<typeof ScorecardOpenResponseSchema>;

export const ScorecardSchema = z.looseObject({
  card_id: z.string().optional(),
  cards: z.record(z.string(), z.unknown()).optional(),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;

/** Game state values documented by the API; kept open for tolerance. */
export type GameState =
  | "NOT_PLAYED"
  | "NOT_FINISHED"
  | "WIN"
  | "GAME_OVER"
  | (string & {});

export const FrameResponseSchema = z
  .looseObject({
    game_id: z.string(),
    guid: z.string(),
    /** Array of 64x64 grids (usually length 1). */
    frame: z.array(z.array(z.array(z.number()))),
    state: z.string(),
    // The live API reports `levels_completed`/`win_levels`; older docs used
    // `score`/`win_score`. Accept either and normalize to score/win_score.
    score: z.number().optional(),
    win_score: z.number().optional(),
    levels_completed: z.number().optional(),
    win_levels: z.number().optional(),
    available_actions: z.array(z.number()).default([]),
  })
  .transform((r) => ({
    ...r,
    score: r.score ?? r.levels_completed ?? 0,
    win_score: r.win_score ?? r.win_levels,
  }));
export type FrameResponse = z.infer<typeof FrameResponseSchema>;

export type ArcActionNumber = 1 | 2 | 3 | 4 | 5 | 6;

export interface ResetBody {
  game_id: string;
  card_id?: string;
  guid?: string;
}

export interface ActionBody {
  game_id: string;
  guid: string;
  x?: number;
  y?: number;
  reasoning?: string;
}

export interface ScorecardOpenBody {
  tags?: string[];
  source_url?: string;
  opaque?: Record<string, unknown>;
}

export interface ArcClientOptions {
  /** Overrides the ARC_API_KEY env var. */
  apiKey?: string;
  /** Overrides the ARC_BASE_URL env var (default https://three.arcprize.org). */
  baseUrl?: string;
  /** Total attempts for 429/5xx responses (default 3). */
  maxAttempts?: number;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Retry delay in ms used when no Retry-After header is present (default 2000). */
  retryDelayMs?: number;
  /**
   * Seed the cookie jar from a serialized Cookie header ("a=1; b=2").
   * The ARC API stores scorecard/game state per load-balancer node (AWS ALB
   * affinity), so every process talking about the same scorecard must share
   * cookies. Falls back to the ARC_COOKIES env var.
   */
  cookies?: string;
}

export class ArcApiError extends Error {
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "ArcApiError";
    this.status = status;
    this.body = body;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opt-in request tracing: when ARC_DEBUG_FILE is set, append one JSON line per
 * request/response. Never throws; never logs the API key.
 */
function debugTrace(entry: Record<string, unknown>): void {
  const file = process.env.ARC_DEBUG_FILE;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + "\n");
  } catch {
    // tracing must never break a request
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ArcClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  /** Cookie jar: name -> value, accumulated across all responses. */
  private readonly jar = new Map<string, string>();

  constructor(options: ArcClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ARC_API_KEY;
    if (!apiKey) {
      throw new ArcApiError(
        "ARC_API_KEY is not set. Pass { apiKey } or export ARC_API_KEY " +
          "(register at https://three.arcprize.org).",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (
      options.baseUrl ??
      process.env.ARC_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const seed = options.cookies ?? process.env.ARC_COOKIES;
    if (seed) this.seedCookies(seed);
  }

  /** Snapshot of the cookie jar (for tests / debugging). */
  cookies(): Record<string, string> {
    return Object.fromEntries(this.jar);
  }

  /**
   * Serialized Cookie header value, for handing ALB affinity to another
   * process (e.g. the runner passing ARC_COOKIES to the MCP server).
   */
  cookieHeaderValue(): string | undefined {
    return this.cookieHeader();
  }

  /** Merge cookies from a serialized Cookie header ("a=1; b=2") into the jar. */
  seedCookies(header: string): void {
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (name) this.jar.set(name, value);
    }
  }

  // -- Endpoints ------------------------------------------------------------

  async listGames(): Promise<GameInfo[]> {
    return this.request("GET", "/api/games", undefined, GameListSchema);
  }

  async openScorecard(
    body: ScorecardOpenBody = {},
  ): Promise<ScorecardOpenResponse> {
    return this.request(
      "POST",
      "/api/scorecard/open",
      body,
      ScorecardOpenResponseSchema,
    );
  }

  async getScorecard(cardId: string): Promise<Scorecard> {
    return this.request(
      "GET",
      `/api/scorecard/${encodeURIComponent(cardId)}`,
      undefined,
      ScorecardSchema,
    );
  }

  async closeScorecard(cardId: string): Promise<Scorecard> {
    return this.request(
      "POST",
      "/api/scorecard/close",
      { card_id: cardId },
      ScorecardSchema,
    );
  }

  async reset(body: ResetBody): Promise<FrameResponse> {
    return this.request("POST", "/api/cmd/RESET", body, FrameResponseSchema);
  }

  async action(
    action: ArcActionNumber,
    body: ActionBody,
  ): Promise<FrameResponse> {
    if (!Number.isInteger(action) || action < 1 || action > 6) {
      throw new ArcApiError(
        `invalid action number ${action}: must be an integer 1-6`,
      );
    }
    return this.request(
      "POST",
      `/api/cmd/ACTION${action}`,
      body,
      FrameResponseSchema,
    );
  }

  // -- Transport ------------------------------------------------------------

  private absorbCookies(res: Response): void {
    let setCookies: string[] = [];
    if (typeof res.headers.getSetCookie === "function") {
      setCookies = res.headers.getSetCookie();
    } else {
      const single = res.headers.get("set-cookie");
      if (single) setCookies = [single];
    }
    for (const raw of setCookies) {
      const pair = raw.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.jar.set(name, value);
    }
  }

  private cookieHeader(): string | undefined {
    if (this.jar.size === 0) return undefined;
    return [...this.jar.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private retryDelayFor(res: Response): number {
    const header = res.headers.get("retry-after");
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
      const date = Date.parse(header);
      if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    }
    return this.retryDelayMs;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const headers: Record<string, string> = {
        "X-API-Key": this.apiKey,
        Accept: "application/json",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const cookie = this.cookieHeader();
      if (cookie) headers["Cookie"] = cookie;

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "follow",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugTrace({ method, path, body, cookie, error: message });
        throw new ArcApiError(`${method} ${path} failed: ${message}`);
      }

      this.absorbCookies(res);
      debugTrace({
        method,
        path,
        body,
        cookie,
        status: res.status,
        setCookie: res.headers.get("set-cookie")?.slice(0, 120),
      });

      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => "");
        if (attempt < this.maxAttempts) {
          await sleep(this.retryDelayFor(res));
          continue;
        }
        throw new ArcApiError(
          `${method} ${path} failed with HTTP ${res.status} after ` +
            `${attempt} attempts: ${truncate(text)}`,
          res.status,
          text,
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ArcApiError(
          `${method} ${path} failed with HTTP ${res.status}: ${truncate(text)}`,
          res.status,
          text,
        );
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ArcApiError(
          `${method} ${path} returned invalid JSON: ${message}`,
          res.status,
        );
      }

      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        // The live API reports errors as {error, message} JSON, sometimes with
        // a 200 status — surface its message instead of a Zod shape error.
        const apiError = extractApiError(json);
        if (apiError) {
          throw new ArcApiError(
            `${method} ${path}: API error: ${apiError}`,
            res.status,
            truncate(JSON.stringify(json)),
          );
        }
        throw new ArcApiError(
          `${method} ${path} returned an unexpected shape: ${parsed.error.message}`,
          res.status,
          truncate(JSON.stringify(json)),
        );
      }
      return parsed.data;
    }

    // Unreachable: the loop either returns or throws.
    throw new ArcApiError(`${method} ${path} failed: retry loop exhausted`);
  }
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Pull a human-readable message out of an {error, message} API payload. */
function extractApiError(json: unknown): string | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  if (!("error" in obj)) return undefined;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.error === "string") return obj.error;
  return undefined;
}
