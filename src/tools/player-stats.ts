import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildBattingStatsQuery } from "../queries/batting.js";
import { buildBowlingStatsQuery } from "../queries/bowling.js";

export function registerPlayerStats(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_player_stats",
    {
      title: "Player Statistics",
      description:
        "What are this player\\'s career numbers? Aggregated batting or bowling stats: matches, innings, runs, average, strike rate, centuries, fifties, highest score, fours, sixes (batting); or overs, wickets, economy, best figures, five-wicket hauls (bowling). " +
        "Use for 'Kohli\\'s Test batting stats', 'Bumrah\\'s ODI bowling record', or 'Ashwin\\'s wickets against England'. " +
        "Supports filtering by format, opposition, venue, date range, season, and tournament. " +
        "Not for comparing two players (use get_player_comparison), season-by-season breakdown (use get_season_stats), or batter-vs-bowler matchups (use get_matchup).",
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
