import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildBattingRecordsQuery } from "../queries/batting.js";

export function registerBattingRecords(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_batting_records",
    {
      title: "Batting Records & Leaderboards",
      description:
        "Who has the most runs / highest average / most centuries? Batting leaderboards ranking players by runs, average, strike rate, centuries, fifties, sixes, fours, or highest score. " +
        "Use for 'All-time Test run scorers', 'Best T20I strike rates', or 'Most sixes in IPL 2024'. " +
        "Not for a single player\\'s stats (use get_player_stats) or bowling rankings (use get_bowling_records).",
      inputSchema: {
        record_type: z
          .enum([
            "most_runs",
            "highest_average",
            "highest_strike_rate",
            "most_centuries",
            "most_fifties",
            "most_sixes",
            "most_fours",
            "highest_score",
          ])
          .describe("Type of batting record/leaderboard."),
        ...MatchFilterSchema.shape,
        min_innings: z
          .number()
          .int()
          .min(1)
          .default(10)
          .describe("Minimum innings qualification (for averages/rates)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results to return."),
      },
    },
    async (args) => {
      const { record_type, min_innings, limit, ...filters } = args;
      const { sql, params } = buildBattingRecordsQuery(
        record_type,
        filters,
        min_innings,
        limit
      );

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No batting records found with the given filters.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rows, null, 2),
          },
        ],
      };
    }
  );
}
