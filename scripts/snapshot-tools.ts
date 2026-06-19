/**
 * Regression snapshot harness.
 *
 * Loads every MCP tool handler via a mock server, points them at the real
 * read-only DuckDB, invokes each with auto-generated args derived from its zod
 * inputSchema, and writes deterministic JSON output to a snapshot file.
 *
 * Usage: tsx scripts/snapshot-tools.ts <out.json>
 *
 * Run before and after a refactor; a zero diff proves semantic identity.
 */
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { getConnection, closeConnection } from "../src/db/connection.js";
import { registerAllTools } from "../src/tools/register.js";

const DB_PATH = path.resolve("data/cricket.duckdb");

// Stable entity values pulled from the DB (see snapshot README).
const POOL: Record<string, string | number | boolean> = {
  player_name: "AN Cook",
  player: "AN Cook",
  name: "AN Cook",
  batter: "AN Cook",
  batsman: "AN Cook",
  striker: "AN Cook",
  bowler: "JM Anderson",
  player1: "AN Cook",
  player2: "JM Anderson",
  player_a: "AN Cook",
  player_b: "JM Anderson",
  team: "England",
  team1: "England",
  team2: "India",
  opposition: "India",
  venue: "Dubai International Cricket Stadium",
  city: "Dubai",
  event_name: "Indian Premier League",
  event: "Indian Premier League",
  tournament: "Indian Premier League",
  season: "2025",
  match_id: "1491707",
  match_type: "T20",
  gender: "male",
  phase: "powerplay",
  query: "Kohli",
  search: "Kohli",
  q: "Kohli",
};

type ToolEntry = {
  name: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: unknown) => Promise<unknown>;
};

const tools: ToolEntry[] = [];

// Minimal mock of McpServer capturing registerTool calls.
const mockServer = {
  registerTool(
    name: string,
    config: { inputSchema?: Record<string, z.ZodTypeAny> },
    handler: (args: unknown) => Promise<unknown>
  ) {
    tools.push({ name, inputSchema: config.inputSchema ?? {}, handler });
  },
} as never;

function unwrap(t: z.ZodTypeAny): z.ZodTypeAny {
  let cur = t;
  // Peel optional/default/nullable/effects wrappers to inspect the core type.
  // (We intentionally do NOT use this to apply defaults — z.object().parse does.)
  while (
    cur instanceof z.ZodOptional ||
    cur instanceof z.ZodDefault ||
    cur instanceof z.ZodNullable ||
    cur instanceof z.ZodEffects
  ) {
    if (cur instanceof z.ZodEffects) cur = cur._def.schema;
    else cur = cur._def.innerType;
  }
  return cur;
}

function valueFor(key: string, t: z.ZodTypeAny): unknown {
  if (key in POOL) {
    const core = unwrap(t);
    // If it's an enum, only use the pool value when it's a valid member.
    if (core instanceof z.ZodEnum) {
      const opts = core._def.values as string[];
      if (opts.includes(POOL[key] as string)) return POOL[key];
      return opts[0];
    }
    return POOL[key];
  }
  const core = unwrap(t);
  if (core instanceof z.ZodEnum) return (core._def.values as string[])[0];
  if (core instanceof z.ZodNumber) {
    const checks = core._def.checks ?? [];
    const min = checks.find((c: { kind: string }) => c.kind === "min");
    return min ? (min as { value: number }).value : 1;
  }
  if (core instanceof z.ZodBoolean) return false;
  if (core instanceof z.ZodString) return POOL.batter; // catch-all string
  return undefined;
}

function buildArgs(inputSchema: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, t] of Object.entries(inputSchema)) {
    // Provide values only for REQUIRED fields plus a few common optionals that
    // make output deterministic and exercise the filter path.
    const required = !t.isOptional();
    const wantOptional = ["match_type", "gender"].includes(key);
    if (required || wantOptional) {
      const v = valueFor(key, t);
      if (v !== undefined) args[key] = v;
    }
  }
  return args;
}

function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (r?.content) return r.content.map((c) => c.text ?? "").join("\n");
  return JSON.stringify(result);
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) throw new Error("usage: snapshot-tools.ts <out.json>");

  const db = getConnection(DB_PATH, true);
  registerAllTools(mockServer, db);
  tools.sort((a, b) => a.name.localeCompare(b.name));

  const snapshot: Record<string, { args: unknown; output: string }> = {};

  for (const tool of tools) {
    let args: Record<string, unknown> = {};
    try {
      args = buildArgs(tool.inputSchema);
      // Apply zod parsing exactly as the MCP SDK would (fills defaults, coerces).
      const parsed = z.object(tool.inputSchema).parse(args);
      const result = await tool.handler(parsed);
      snapshot[tool.name] = { args: parsed, output: extractText(result) };
      process.stderr.write(`  ok   ${tool.name}\n`);
    } catch (err) {
      snapshot[tool.name] = {
        args,
        output: `__ERROR__ ${(err as Error).message}`,
      };
      process.stderr.write(`  ERR  ${tool.name}: ${(err as Error).message}\n`);
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  process.stderr.write(`\nWrote ${tools.length} tool snapshots to ${outPath}\n`);
  await closeConnection();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
