import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildBattingStatsQuery } from "../queries/batting.js";

export function registerPlayerBattingStats(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_player_batting_stats",
    {
      title: "Player Batting Statistics",
      description:
        "Get aggregated batting statistics for a cricket player. Returns matches, innings, runs, average, strike rate, centuries, fifties, highest score, fours, sixes, and more. Supports filtering by format, opposition, venue, date range, season, and tournament.",
      inputSchema: {
        player_name: z
          .string()
          .min(2)
          .describe("Player name to search for (partial match supported)."),
        ...MatchFilterSchema.shape,
      },
    },
    async (args) => {
      const { player_name, ...filters } = args;
      const { sql, params } = buildBattingStatsQuery(player_name, filters);
      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No batting statistics found for "${player_name}" with the given filters.`,
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
