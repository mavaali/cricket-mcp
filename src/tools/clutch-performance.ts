import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildClutchQuery } from "../queries/clutch.js";

type Row = Record<string, unknown>;

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

function combineBatting(rows: Row[]): Row | null {
  if (rows.length === 0) return null;
  const sum = (k: string) => rows.reduce((a, r) => a + num(r[k]), 0);
  const runs = sum("runs");
  const dismissals = sum("dismissals");
  const balls = sum("balls");
  return {
    matches: sum("matches"),
    innings: sum("innings"),
    runs,
    dismissals,
    balls,
    average: dismissals > 0 ? round2(runs / dismissals) : null,
    strike_rate: balls > 0 ? round2((runs / balls) * 100) : null,
    hundreds: sum("hundreds"),
    fifties: sum("fifties"),
    highest_score: Math.max(...rows.map((r) => num(r.highest_score))),
    ducks: sum("ducks"),
  };
}

function combineBowling(rows: Row[]): Row | null {
  if (rows.length === 0) return null;
  const sum = (k: string) => rows.reduce((a, r) => a + num(r[k]), 0);
  const wickets = sum("wickets");
  const runsConceded = sum("runs_conceded");
  const balls = sum("balls");
  const best = rows.reduce((a, r) =>
    num(r.best_wickets) > num(a.best_wickets) ||
    (num(r.best_wickets) === num(a.best_wickets) &&
      num(r.best_runs) < num(a.best_runs))
      ? r
      : a
  );
  return {
    matches: sum("matches"),
    innings: sum("innings"),
    wickets,
    runs_conceded: runsConceded,
    balls,
    average: wickets > 0 ? round2(runsConceded / wickets) : null,
    economy: balls > 0 ? round2(runsConceded / (balls / 6)) : null,
    bowling_strike_rate: wickets > 0 ? round2(balls / wickets) : null,
    best_figures: best.best_figures,
  };
}

export function registerClutchPerformance(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_clutch_performance",
    {
      title: "Big-Match (Clutch) Performance",
      description:
        "Is this player a big-match performer? Splits a player's record by tournament stage: league/group matches vs knockouts " +
        "(semis, quarters, eliminators, qualifiers) vs finals, with a clutch delta comparing knockout numbers to league numbers. " +
        "Also returns a per-stage breakdown using the raw stage labels. " +
        "Use for 'Is Kohli a big-match player?', 'Bumrah in finals', or 'How does Warner bat in knockouts?'. " +
        "Not for overall career stats (use get_player_stats) or recent form (use get_player_form).",
      inputSchema: {
        player_name: z
          .string()
          .describe("Player name (partial match, e.g. 'Kohli')."),
        perspective: z
          .enum(["batting", "bowling"])
          .default("batting")
          .describe("Analyze their batting or their bowling."),
        ...MatchFilterSchema.shape,
      },
    },
    async (args) => {
      const { player_name, perspective, ...filters } = args;

      const bucketQ = buildClutchQuery(player_name, perspective, filters, "bucket");
      const stageQ = buildClutchQuery(player_name, perspective, filters, "stage");
      const [bucketRows, stageRows] = await Promise.all([
        runQuery(db, bucketQ.sql, bucketQ.params),
        runQuery(db, stageQ.sql, stageQ.params),
      ]);

      if (bucketRows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No ${perspective} data found for '${player_name}' with the given filters.`,
            },
          ],
        };
      }

      const byBucket = new Map(bucketRows.map((r) => [r.stage as string, r]));
      const combine = perspective === "batting" ? combineBatting : combineBowling;
      const knockoutish: Row[] = [];
      for (const b of ["knockout", "final"]) {
        const row = byBucket.get(b);
        if (row) knockoutish.push(row);
      }

      const league = byBucket.get("league") ?? null;
      const allKnockouts = combine(knockoutish);
      const overall = combine(bucketRows);

      let clutchDelta: Row | null = null;
      if (league && allKnockouts) {
        if (perspective === "batting") {
          clutchDelta = {
            average_diff: round2(
              num(allKnockouts.average) - num(league.average)
            ),
            strike_rate_diff: round2(
              num(allKnockouts.strike_rate) - num(league.strike_rate)
            ),
            note: "knockouts (incl. finals) minus league stage; positive = better under pressure",
          };
        } else {
          clutchDelta = {
            average_diff: round2(num(allKnockouts.average) - num(league.average)),
            economy_diff: round2(num(allKnockouts.economy) - num(league.economy)),
            note: "knockouts (incl. finals) minus league stage; negative = better under pressure",
          };
        }
      }

      const result = {
        player_name,
        perspective,
        splits: {
          overall,
          league,
          all_knockouts: allKnockouts,
          knockouts_excluding_final: byBucket.get("knockout") ?? null,
          final: byBucket.get("final") ?? null,
          placement_playoffs: byBucket.get("placement") ?? null,
        },
        clutch_delta: clutchDelta,
        stage_breakdown: stageRows,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
