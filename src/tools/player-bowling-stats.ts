import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildBowlingStatsQuery } from "../queries/bowling.js";

export function registerPlayerBowlingStats(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_player_bowling_stats",
    {
      title: "Player Bowling Statistics",
      description:
        "Get aggregated bowling statistics for a cricket player. Returns matches, innings, overs, wickets, average, economy rate, strike rate, best bowling figures, maidens, five-wicket hauls, and more. Supports filtering by format, opposition, venue, date range, season, and tournament.",
      inputSchema: {
        player_name: z
          .string()
          .min(2)
          .describe("Bowler name to search for (partial match supported)."),
        ...MatchFilterSchema.shape,
      },
    },
    async (args) => {
      const { player_name, ...filters } = args;
      const { sql, params } = buildBowlingStatsQuery(player_name, filters);
      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No bowling statistics found for "${player_name}" with the given filters.`,
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
