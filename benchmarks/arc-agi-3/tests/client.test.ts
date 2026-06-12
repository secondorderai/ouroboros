import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ArcApiError, ArcClient, FrameResponseSchema } from "../src/client";
import {
  MOCK_GAMES,
  MOCK_GRID_SIZE,
  MOCK_L2_MARK,
  MOCK_START,
  MOCK_WIN_SCORE,
  startMockArcServer,
  type MockArcServer,
} from "./mock-arc-server";

const GAME = MOCK_GAMES[0]!.game_id;

let mock: MockArcServer;
let savedArcCookies: string | undefined;

beforeAll(() => {
  mock = startMockArcServer();
  // Clients fall back to ARC_COOKIES; keep these tests hermetic.
  savedArcCookies = process.env.ARC_COOKIES;
  delete process.env.ARC_COOKIES;
});

afterAll(() => {
  mock.stop();
  if (savedArcCookies !== undefined) process.env.ARC_COOKIES = savedArcCookies;
});

function newClient(extra: ConstructorParameters<typeof ArcClient>[0] = {}) {
  return new ArcClient({
    apiKey: mock.apiKey,
    baseUrl: mock.url,
    retryDelayMs: 25,
    ...extra,
  });
}

function requestCount(path: string): number {
  return mock.requests.filter((r) => r.path === path).length;
}

describe("construction / API key resolution", () => {
  test("throws a clear error when ARC_API_KEY is missing", () => {
    const saved = process.env.ARC_API_KEY;
    delete process.env.ARC_API_KEY;
    try {
      expect(() => new ArcClient({ baseUrl: "http://localhost:1" })).toThrow(
        /ARC_API_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.ARC_API_KEY = saved;
    }
  });

  test("falls back to the ARC_API_KEY env var", async () => {
    const saved = process.env.ARC_API_KEY;
    process.env.ARC_API_KEY = mock.apiKey;
    try {
      const client = new ArcClient({ baseUrl: mock.url });
      const games = await client.listGames();
      expect(games.map((g) => g.game_id)).toEqual(
        MOCK_GAMES.map((g) => g.game_id),
      );
    } finally {
      if (saved === undefined) delete process.env.ARC_API_KEY;
      else process.env.ARC_API_KEY = saved;
    }
  });
});

describe("header construction", () => {
  test("sends X-API-Key on GET requests, with no Content-Type", async () => {
    const client = newClient();
    await client.listGames();
    const req = mock.requests.at(-1)!;
    expect(req.path).toBe("/api/games");
    expect(req.method).toBe("GET");
    expect(req.apiKey).toBe(mock.apiKey);
    expect(req.contentType).toBeNull();
  });

  test("sends X-API-Key and JSON Content-Type on POST requests", async () => {
    const client = newClient();
    await client.openScorecard({ tags: ["bench"] });
    const req = mock.requests.at(-1)!;
    expect(req.path).toBe("/api/scorecard/open");
    expect(req.method).toBe("POST");
    expect(req.apiKey).toBe(mock.apiKey);
    expect(req.contentType).toContain("application/json");
    expect(req.body).toEqual({ tags: ["bench"] });
  });

  test("a wrong key gets a 401 ArcApiError without retries", async () => {
    const client = newClient({ apiKey: "wrong-key" });
    const before = requestCount("/api/games");
    let error: unknown;
    try {
      await client.listGames();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ArcApiError);
    expect((error as ArcApiError).status).toBe(401);
    expect(requestCount("/api/games")).toBe(before + 1); // no retry on 401
  });
});

describe("cookie jar", () => {
  test("merges cookies across responses and replays them as one header", async () => {
    const client = newClient();
    const opened = await client.openScorecard(); // sets arcsess + AWSALB(+CORS)
    const nodeAfterOpen = client.cookies().AWSALB!.split(".")[0];
    const frame = await client.reset({ game_id: GAME, card_id: opened.card_id }); // re-issues AWSALB + AWSALBCORS
    await client.action(2, { game_id: GAME, guid: frame.guid });

    const last = mock.requests.at(-1)!;
    expect(last.path).toBe("/api/cmd/ACTION2");
    expect(last.cookie).toContain(`arcsess=${opened.card_id}`);
    expect(last.cookie).toMatch(/AWSALB=node-\d+\.\d+/);
    expect(last.cookie).toMatch(/AWSALBCORS=node-\d+\.\d+/);
    // Single merged Cookie header: name=value pairs joined by "; ".
    expect(last.cookie!.split("; ").length).toBeGreaterThanOrEqual(3);

    expect(client.cookies()).toMatchObject({ arcsess: opened.card_id });
    // The re-issued AWSALB still points at the node the card was opened on.
    expect(client.cookies().AWSALB!.split(".")[0]).toBe(nodeAfterOpen!);
  });

  test("a later Set-Cookie for the same name replaces the jar entry", async () => {
    const client = newClient();
    await client.reset({ game_id: GAME });
    const firstAlb = client.cookies().AWSALB!;
    await client.reset({ game_id: GAME }); // re-issued (rotated) cookie value
    expect(client.cookies().AWSALB).not.toBe(firstAlb);
  });

  test("seedCookies/cookieHeaderValue round-trip", () => {
    const client = newClient();
    expect(client.cookieHeaderValue()).toBeUndefined();
    client.seedCookies("AWSALB=node-1.9; AWSALBCORS=node-1.9");
    expect(client.cookies()).toEqual({
      AWSALB: "node-1.9",
      AWSALBCORS: "node-1.9",
    });
    expect(client.cookieHeaderValue()).toBe("AWSALB=node-1.9; AWSALBCORS=node-1.9");
    // Round-trip: a second client seeded from the header has the same jar.
    const clone = newClient({ cookies: client.cookieHeaderValue() });
    expect(clone.cookies()).toEqual(client.cookies());
  });

  test("constructor cookies option seeds the jar", () => {
    const client = newClient({ cookies: "a=1; b=2" });
    expect(client.cookies()).toEqual({ a: "1", b: "2" });
    expect(client.cookieHeaderValue()).toBe("a=1; b=2");
  });

  test("falls back to the ARC_COOKIES env var", () => {
    const saved = process.env.ARC_COOKIES;
    process.env.ARC_COOKIES = "AWSALB=node-7.1; AWSALBCORS=node-7.1";
    try {
      const fromEnv = newClient();
      expect(fromEnv.cookies()).toEqual({
        AWSALB: "node-7.1",
        AWSALBCORS: "node-7.1",
      });
      // An explicit cookies option wins over the env var.
      const explicit = newClient({ cookies: "x=9" });
      expect(explicit.cookies()).toEqual({ x: "9" });
    } finally {
      if (saved === undefined) delete process.env.ARC_COOKIES;
      else process.env.ARC_COOKIES = saved;
    }
  });
});

describe("ALB cookie affinity (regression: live 'game not found')", () => {
  test("a client without the opener's cookies cannot use its scorecard", async () => {
    const opener = newClient();
    const { card_id } = await opener.openScorecard({ tags: ["affinity"] });

    // A second client WITHOUT the cookies: RESET fails with the live API's
    // misleading HTTP-200 {"error":"SERVER_ERROR","message":"game ... not
    // found"} body, surfaced as an ArcApiError.
    const stranger = newClient();
    let error: unknown;
    try {
      await stranger.reset({ game_id: GAME, card_id });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ArcApiError);
    expect((error as ArcApiError).message).toContain(`game ${GAME} not found`);

    // Scorecard GET from the stranger gets the misleading error body too
    // (the loose Scorecard schema tolerates it, so no environments appear).
    const invisible = await stranger.getScorecard(card_id);
    expect((invisible as Record<string, unknown>).environments).toBeUndefined();
    expect((invisible as Record<string, unknown>).error).toBe("SERVER_ERROR");

    // A client seeded with the opener's cookies lands on the right node.
    const seeded = newClient({ cookies: opener.cookieHeaderValue() });
    const frame = await seeded.reset({ game_id: GAME, card_id });
    expect(frame.state).toBe("NOT_FINISHED");
    const card = await seeded.getScorecard(card_id);
    expect(card.card_id).toBe(card_id);
  });
});

describe("retries", () => {
  test("honors Retry-After on 429 and then succeeds", async () => {
    const client = newClient();
    const before = requestCount("/api/games");
    mock.failNext({ status: 429, retryAfter: 1 });
    const start = performance.now();
    const games = await client.listGames();
    const elapsed = performance.now() - start;
    expect(games.length).toBe(MOCK_GAMES.length);
    expect(elapsed).toBeGreaterThanOrEqual(900); // waited ~1s per Retry-After
    expect(requestCount("/api/games")).toBe(before + 2); // 429 then success
  });

  test("retries 5xx with the default delay when Retry-After is absent", async () => {
    const client = newClient({ retryDelayMs: 30 });
    const before = requestCount("/api/games");
    mock.failNext({ status: 503 });
    const start = performance.now();
    await client.listGames();
    expect(performance.now() - start).toBeGreaterThanOrEqual(25);
    expect(requestCount("/api/games")).toBe(before + 2);
  });

  test("gives up after maxAttempts and reports the status", async () => {
    const client = newClient({ retryDelayMs: 5 });
    const before = requestCount("/api/games");
    mock.failNext({ status: 500, times: 3 }); // exactly maxAttempts
    let error: unknown;
    try {
      await client.listGames();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ArcApiError);
    expect((error as ArcApiError).status).toBe(500);
    expect((error as ArcApiError).message).toContain("500");
    expect((error as ArcApiError).message).toContain("3 attempts");
    expect(requestCount("/api/games")).toBe(before + 3);
  });

  test("aborts requests that exceed the timeout", async () => {
    const client = newClient({ timeoutMs: 50 });
    mock.delayNext(500);
    let error: unknown;
    try {
      await client.listGames();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ArcApiError);
    expect((error as ArcApiError).message).toContain("/api/games");
  });
});

describe("FrameResponse parsing", () => {
  test("normalizes live levels_completed/win_levels to score/win_score", () => {
    // Regression: the live API never sends score/win_score.
    const frame = FrameResponseSchema.parse({
      game_id: "g",
      guid: "u",
      frame: [[[0]]],
      state: "NOT_FINISHED",
      levels_completed: 3,
      win_levels: 7,
      available_actions: [1, 2],
    });
    expect(frame.score).toBe(3);
    expect(frame.win_score).toBe(7);
  });

  test("parses live-named RESET frames and preserves unknown fields", async () => {
    const client = newClient();
    const frame = await client.reset({ game_id: GAME });

    expect(frame.game_id).toBe(GAME);
    expect(typeof frame.guid).toBe("string");
    expect(frame.state).toBe("NOT_FINISHED");
    // The mock emits only levels_completed/win_levels (live naming); the
    // client must normalize them to score/win_score.
    expect(frame.score).toBe(0);
    expect(frame.win_score).toBe(MOCK_WIN_SCORE);
    expect(frame.available_actions).toEqual([1, 2, 3, 4]);

    expect(frame.frame.length).toBe(1);
    expect(frame.frame[0]!.length).toBe(MOCK_GRID_SIZE);
    expect(frame.frame[0]![0]!.length).toBe(MOCK_GRID_SIZE);
    expect(frame.frame[0]![MOCK_START.y]![MOCK_START.x]).toBe(3); // player pixel

    // Loose parsing keeps fields outside the declared schema.
    expect((frame as Record<string, unknown>).action_counter).toBe(0);
    expect((frame as Record<string, unknown>).full_reset).toBe(false);
    expect((frame as Record<string, unknown>).levels_completed).toBe(0);
  });

  test("an HTTP-200 {error,message} body surfaces as ArcApiError", async () => {
    // Regression: the live API reports "game not found" with HTTP 200.
    const bogus = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({ error: "SERVER_ERROR", message: "game x not found" }),
          { headers: { "Content-Type": "application/json" } },
        ),
    });
    try {
      const client = new ArcClient({
        apiKey: "k",
        baseUrl: `http://localhost:${bogus.port}`,
      });
      let error: unknown;
      try {
        await client.reset({ game_id: "x" });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ArcApiError);
      expect((error as ArcApiError).message).toContain("game x not found");
      expect((error as ArcApiError).message).not.toContain("unexpected shape");
    } finally {
      bogus.stop(true);
    }
  });

  test("non-OK responses surface as ArcApiError with their status", async () => {
    const client = newClient();
    let error: unknown;
    try {
      await client.action(1, { game_id: GAME, guid: "no-such-guid" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ArcApiError);
    expect((error as ArcApiError).status).toBe(400);
  });

  test("rejects frame responses with an unexpected shape", async () => {
    // One-off server that 200s a non-FrameResponse body for every route.
    const bogus = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ hello: "world" }), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    try {
      const client = new ArcClient({
        apiKey: "k",
        baseUrl: `http://localhost:${bogus.port}`,
      });
      let error: unknown;
      try {
        await client.reset({ game_id: GAME });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ArcApiError);
      expect((error as ArcApiError).message).toContain("unexpected shape");
    } finally {
      bogus.stop(true);
    }
  });
});

describe("end-to-end toy game over the client", () => {
  test("plays level 1 to score, clicks the level-2 mark, and WINs", async () => {
    const client = newClient();
    const opened = await client.openScorecard({ tags: ["e2e"] });
    let frame = await client.reset({ game_id: GAME, card_id: opened.card_id });

    // Level 1: move down from (2,2) to the target at (2,7).
    for (let i = 0; i < 5; i++) {
      frame = await client.action(2, { game_id: GAME, guid: frame.guid });
    }
    expect(frame.score).toBe(1);
    expect(frame.state).toBe("NOT_FINISHED");
    expect(frame.available_actions).toEqual([6]); // level 2

    // Level 2: ACTION6 on the marked cell wins.
    frame = await client.action(6, {
      game_id: GAME,
      guid: frame.guid,
      x: MOCK_L2_MARK.x,
      y: MOCK_L2_MARK.y,
    });
    expect(frame.score).toBe(MOCK_WIN_SCORE);
    expect(frame.state).toBe("WIN");

    // Ground truth lands on the scorecard (live environments[] shape).
    const card = await client.getScorecard(opened.card_id);
    const environments = (card as Record<string, any>).environments as any[];
    const entry = environments.find((e) => e.id === GAME)!;
    expect(entry.resets).toBe(1);
    expect(entry.actions).toBe(6);
    expect(entry.levels_completed).toBe(2);
    expect(entry.level_count).toBe(MOCK_WIN_SCORE);
    expect(entry.runs).toHaveLength(1);
    expect(entry.runs[0].state).toBe("WIN");
    expect(entry.runs[0].levels_completed).toBe(2);

    const closed = await client.closeScorecard(opened.card_id);
    expect(closed.card_id).toBe(opened.card_id);
    expect(mock.getScorecard(opened.card_id)!.closed).toBe(true);
  });

  test("moving off-grid three times causes GAME_OVER", async () => {
    const client = newClient();
    let frame = await client.reset({ game_id: GAME });
    // From (2,2): two ups reach the top edge, three more go off-grid.
    for (let i = 0; i < 4; i++) {
      frame = await client.action(1, { game_id: GAME, guid: frame.guid });
      expect(frame.state).toBe("NOT_FINISHED");
    }
    frame = await client.action(1, { game_id: GAME, guid: frame.guid });
    expect(frame.state).toBe("GAME_OVER");
    expect(frame.available_actions).toEqual([]);
  });
});
