import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildMatchupQuery } from "../queries/matchup.js";

export function registerMatchup(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_matchup",
    {
      title: "Batter vs Bowler Matchup",
      description:
        "Head-to-head stats between a specific batter and bowler. Returns balls faced, runs scored, dismissals, average, strike rate, economy, dot ball %, boundary %, and dismissal types. Use 'perspective' to control sort order: 'batting' sorts by runs scored, 'bowling' by dismissals.",
      inputSchema: {
        batter_name: z
          .string()
          .min(2)
          .describe("Batter name (partial match, case-insensitive)."),
        bowler_name: z
          .string()
          .min(2)
          .describe("Bowler name (partial match, case-insensitive)."),
        perspective: z
          .enum(["batting", "bowling"])
          .default("batting")
          .describe(
            "Sort perspective: 'batting' orders by runs scored (batter's view), 'bowling' orders by dismissals then economy (bowler's view)."
          ),
        ...MatchFilterSchema.shape,
      },
    },
    async (args) => {
      const { batter_name, bowler_name, perspective, ...filters } = args;

      const orderBy =
        perspective === "bowling"
          ? "dismissals DESC, runs_conceded ASC"
          : "runs_scored DESC";

      const { sql, params } = buildMatchupQuery({
        filters,
        extraWhere: [
          "d.batter ILIKE '%' || $batter_name || '%'",
          "d.bowler ILIKE '%' || $bowler_name || '%'",
        ],
        extraParams: { batter_name, bowler_name },
        groupBy: "both",
        orderBy,
        limit: 10,
      });

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matchup data found for "${batter_name}" vs "${bowler_name}" with the given filters.`,
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
