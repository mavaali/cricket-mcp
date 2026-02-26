import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { BOWLING_WICKET_KINDS } from "../queries/common.js";

export function registerSearchPlayers(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "search_players",
    {
      title: "Search Players",
      description:
        "Search for cricket players by name. Returns matching players with basic career stats. Use this to find exact player names before querying detailed stats.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .describe("Player name to search for (partial match, case-insensitive)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Max results to return."),
      },
    },
    async (args) => {
      const sql = `
        SELECT
          p.player_id,
          p.player_name,
          p.batting_style,
          p.bowling_style,
          p.playing_role,
          p.country,
          COUNT(DISTINCT d_bat.match_id) AS matches_batted,
          COALESCE(SUM(d_bat.runs_batter), 0) AS total_runs,
          COUNT(DISTINCT d_bowl.match_id) AS matches_bowled,
          COUNT(*) FILTER (WHERE d_bowl.is_wicket AND d_bowl.wicket_kind IN \${BOWLING_WICKET_KINDS}) AS total_wickets
        FROM players p
        LEFT JOIN deliveries d_bat ON p.player_id = d_bat.batter_id
        LEFT JOIN deliveries d_bowl ON p.player_id = d_bowl.bowler_id
        WHERE p.player_name ILIKE '%' || $query || '%'
        GROUP BY p.player_id, p.player_name
        ORDER BY
          COALESCE(SUM(d_bat.runs_batter), 0) +
          COUNT(*) FILTER (WHERE d_bowl.is_wicket AND d_bowl.wicket_kind IN \${BOWLING_WICKET_KINDS}) * 25
          DESC
        LIMIT $limit
      `;

      const rows = await runQuery(db, sql, {
        query: args.query,
        limit: args.limit,
      });

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No players found matching "${args.query}".`,
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
