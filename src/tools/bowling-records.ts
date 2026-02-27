import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildBowlingRecordsQuery } from "../queries/bowling.js";

export function registerBowlingRecords(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_bowling_records",
    {
      title: "Bowling Records & Leaderboards",
      description:
        "Get bowling leaderboards and records. Rank players by wickets, bowling average, economy rate, strike rate, or five-wicket hauls. Supports filtering by format, team, opposition, venue, date range, and tournament.",
      inputSchema: {
        record_type: z
          .enum([
            "most_wickets",
            "best_average",
            "best_economy",
            "best_strike_rate",
            "most_five_wicket_hauls",
          ])
          .describe("Type of bowling record/leaderboard."),
        ...MatchFilterSchema.shape,
        min_innings: z
          .number()
          .int()
          .min(1)
          .default(10)
          .describe("Minimum innings qualification."),
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
      const { sql, params } = buildBowlingRecordsQuery(
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
              text: "No bowling records found with the given filters.",
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
