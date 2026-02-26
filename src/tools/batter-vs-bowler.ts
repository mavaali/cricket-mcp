import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildMatchupQuery } from "../queries/matchup.js";

export function registerBatterVsBowler(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_batter_vs_bowler",
    {
      title: "Batter vs Bowler Matchup",
      description:
        "Get a batter's record against a specific bowler. Returns balls faced, runs scored, dismissals, average, strike rate, dot ball %, boundary %, fours, sixes, and dismissal types. Batter's perspective.",
      inputSchema: {
        batter_name: z
          .string()
          .min(2)
          .describe("Batter name (partial match, case-insensitive)."),
        bowler_name: z
          .string()
          .min(2)
          .describe("Bowler name (partial match, case-insensitive)."),
        ...MatchFilterSchema.shape,
      },
    },
    async (args) => {
      const { batter_name, bowler_name, ...filters } = args;
      const { sql, params } = buildMatchupQuery({
        filters,
        extraWhere: [
          "d.batter ILIKE '%' || $batter_name || '%'",
          "d.bowler ILIKE '%' || $bowler_name || '%'",
        ],
        extraParams: { batter_name, bowler_name },
        groupBy: "both",
        orderBy: "runs_scored DESC",
        limit: 10,
      });

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matchup data found for batter "${batter_name}" vs bowler "${bowler_name}" with the given filters.`,
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
