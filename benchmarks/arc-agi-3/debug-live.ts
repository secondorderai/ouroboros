/**
 * Debug harness: mimic the runner's EXACT flow (ArcClient → openScorecard →
 * buildBenchConfig → spawn MCP server with the config's env block) without
 * the CLI/LLM, then call reset/act.
 * Usage: ARC_API_KEY=... bun run debug-live.ts <game_id>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ArcClient } from "./src/client";
import { buildBenchConfig } from "./src/runner";

const gameId = process.argv[2] ?? "ls20-9607627b";

const runner = new ArcClient();
const { card_id } = await runner.openScorecard({ tags: ["ouroboros", "debug"] });
console.log("card:", card_id);
console.log("runner cookies:", runner.cookieHeaderValue());

const config = buildBenchConfig({}, {
  apiKey: process.env.ARC_API_KEY ?? "",
  cardId: card_id,
  baseUrl: process.env.ARC_BASE_URL,
  cookies: runner.cookieHeaderValue(),
});
const serverDecl = (config.mcp as { servers: Array<{ command: string; args: string[]; env: Record<string, string> }> }).servers[0]!;
console.log("config env keys:", Object.keys(serverDecl.env));
console.log("config ARC_COOKIES len:", (serverDecl.env.ARC_COOKIES ?? "").length);

// Spawn exactly as the MCP manager does: minimal default env + config env.
const transport = new StdioClientTransport({
  command: serverDecl.command,
  args: serverDecl.args,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...serverDecl.env },
  stderr: "inherit",
});
const client = new Client({ name: "debug", version: "0.0.1" });
await client.connect(transport);

function show(label: string, res: unknown) {
  const r = res as { isError?: boolean; content?: Array<{ text?: string }> };
  const text = r.content?.map((c) => c.text ?? "").join("\n") ?? JSON.stringify(res);
  console.log(`\n=== ${label} (isError=${r.isError ?? false}) ===`);
  console.log(text.length > 8000 ? text.slice(0, 8000) + "\n…[truncated]" : text);
}

show("reset", await client.callTool({ name: "reset", arguments: { game_id: gameId } }));
show(
  "act [1]",
  await client.callTool({ name: "act", arguments: { game_id: gameId, moves: [{ action: 1 }] } }),
);

await client.close();
const scorecard = await runner.getScorecard(card_id);
console.log("\nscorecard:", JSON.stringify(scorecard).slice(0, 300));
await runner.closeScorecard(card_id);
