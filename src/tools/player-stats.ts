import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildBattingStatsQuery } from "../queries/batting.js";
import { buildBowlingStatsQuery } from "../queries/bowling.js";

export function registerPlayerStats(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_player_stats",
    {
      title: "Player Statistics",
      description:
        "Get aggregated career statistics for a cricket player. Use 'perspective' to choose batting or bowling stats. Batting returns: matches, innings, runs, average, strike rate, centuries, fifties, highest score, fours, sixes. Bowling returns: matches, innings, overs, wickets, average, economy, strike rate, best figures, maidens, five-wicket hauls. Supports filtering by format, opposition, venue, date range, season, and tournament.",
      inputSchema: {
        player_name: z
          .string()
          .min(2)
          .describe("Player name to search for (partial match supported)."),
        perspective: z
          .enum(["batting", "bowling"])
          .describe("Get batting or bowling statistics."),
        ...MatchFilterSchema.shape,
      },
    },
    async (args) => {
      const { player_name, perspective, ...filters } = args;

      const { sql, params } =
        perspective === "batting"
          ? buildBattingStatsQuery(player_name, filters)
          : buildBowlingStatsQuery(player_name, filters);

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No ${perspective} statistics found for "${player_name}" with the given filters.`,
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
