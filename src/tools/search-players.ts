import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";

export function registerSearchPlayers(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "search_players",
    {
      title: "Search Players",
      description:
        "Who is this player? Lookup players by name to get exact names, batting/bowling style, role, and country. " +
        "Use for 'Find players named Sharma', 'What is Bumrah\\'s bowling style?', or 'Is there a player called Williamson?'. " +
        "Always use this first when unsure of a player\\'s exact name. Not for stats -- use get_player_stats for career numbers.",
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
          p.country
        FROM players p
        WHERE p.player_name ILIKE '%' || $query || '%'
        ORDER BY p.player_name
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
