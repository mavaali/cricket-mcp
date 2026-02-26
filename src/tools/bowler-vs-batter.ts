import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildMatchupQuery } from "../queries/matchup.js";

export function registerBowlerVsBatter(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_bowler_vs_batter",
    {
      title: "Bowler vs Batter Matchup",
      description:
        "Get a bowler's record against a specific batter. Returns balls bowled, runs conceded, wickets, average, economy, strike rate, dot ball %, boundaries conceded, and dismissal types. Bowler's perspective.",
      inputSchema: {
        bowler_name: z
          .string()
          .min(2)
          .describe("Bowler name (partial match, case-insensitive)."),
        batter_name: z
          .string()
          .min(2)
          .describe("Batter name (partial match, case-insensitive)."),
        ...MatchFilterSchema.shape,
      },
    },
    async (args) => {
      const { bowler_name, batter_name, ...filters } = args;
      const { sql, params } = buildMatchupQuery({
        filters,
        extraWhere: [
          "d.bowler ILIKE '%' || $bowler_name || '%'",
          "d.batter ILIKE '%' || $batter_name || '%'",
        ],
        extraParams: { bowler_name, batter_name },
        groupBy: "both",
        orderBy: "dismissals DESC, runs_conceded ASC",
        limit: 10,
      });

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matchup data found for bowler "${bowler_name}" vs batter "${batter_name}" with the given filters.`,
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
