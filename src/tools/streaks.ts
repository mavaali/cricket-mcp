import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildStreaksQuery } from "../queries/streaks.js";

export function registerStreaks(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_streaks",
    {
      title: "Streaks & Droughts",
      description:
        "What's the longest run of 50+ scores, consecutive ducks, or an unbeaten team run? Streak leaderboards: " +
        "consecutive innings with 50+ runs (threshold adjustable via run_threshold — e.g. 30+ or 100+), consecutive ducks, " +
        "and consecutive team wins or losses. Each streak shows its length and start/end dates. " +
        "No-result matches don't break team streaks; draws and ties do. " +
        "Use for 'Longest 50+ streak in ODIs', 'Most consecutive ducks', 'Longest T20 win streaks', or 'Kohli's best run of fifties'. " +
        "Not for recent form (use get_player_form / get_team_form).",
      inputSchema: {
        streak_type: z
          .enum(["fifty_plus", "duck_streak", "team_wins", "team_losses"])
          .describe(
            "Streak to rank: batter streaks (fifty_plus, duck_streak) or team result streaks (team_wins, team_losses)."
          ),
        name: z
          .string()
          .optional()
          .describe(
            "Focus on one player (for batter streaks) or one team (for team streaks); partial match. Omit for a leaderboard."
          ),
        run_threshold: z
          .number()
          .int()
          .min(1)
          .default(50)
          .describe(
            "For fifty_plus: the per-innings run threshold (50 = fifties, 100 = hundreds, 30 = thirty-plus)."
          ),
        ...MatchFilterSchema.shape,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of streaks to return."),
      },
    },
    async (args) => {
      const { streak_type, name, run_threshold, limit, ...filters } = args;
      const { sql, params } = buildStreaksQuery(
        streak_type,
        name,
        filters,
        run_threshold,
        limit
      );

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No streaks of length 2+ found with the given filters.",
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
