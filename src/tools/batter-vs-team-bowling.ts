import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildMatchupQuery } from "../queries/matchup.js";

export function registerBatterVsTeamBowling(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_batter_vs_team_bowling",
    {
      title: "Batter vs Team Bowling Breakdown",
      description:
        "Break down a batter's performance against an opposition team into per-bowler matchups. Answers questions like 'How does Kohli do against each of Australia's bowlers?'",
      inputSchema: {
        batter_name: z
          .string()
          .min(2)
          .describe("Batter name (partial match, case-insensitive)."),
        opposition: z
          .string()
          .describe("Opposition team name (e.g., 'Australia', 'Mumbai Indians')."),
        ...MatchFilterSchema.omit({ opposition: true }).shape,
        min_balls: z
          .number()
          .int()
          .min(1)
          .default(6)
          .describe("Minimum balls faced vs a bowler to include (default: 6)."),
        sort_by: z
          .enum(["dismissals", "balls_faced", "average", "strike_rate"])
          .default("balls_faced")
          .describe("Sort results by this field."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Max bowlers to return."),
      },
    },
    async (args) => {
      const { batter_name, opposition, min_balls, sort_by, limit, ...filters } = args;

      let orderBy: string;
      switch (sort_by) {
        case "dismissals":
          orderBy = "dismissals DESC, balls_faced DESC";
          break;
        case "average":
          orderBy = "average ASC NULLS LAST";
          break;
        case "strike_rate":
          orderBy = "strike_rate ASC NULLS LAST";
          break;
        default:
          orderBy = "balls_faced DESC";
      }

      // We need to filter by opposition team. The bowler's team is the opposition,
      // so we join innings to ensure the bowler was bowling for the opposition team.
      const { sql: baseSql, params } = buildMatchupQuery({
        filters: { ...filters, opposition },
        extraWhere: [
          "d.batter ILIKE '%' || $batter_name || '%'",
        ],
        extraParams: { batter_name },
        groupBy: "both",
        orderBy,
        limit: limit * 2, // fetch extra, filter by min_balls after
      });

      // Wrap to filter by min_balls
      const sql = `
        WITH base AS (${baseSql})
        SELECT * FROM base
        WHERE balls_faced >= $min_balls
        ORDER BY ${orderBy}
        LIMIT $final_limit
      `;
      params.min_balls = min_balls;
      params.final_limit = limit;

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matchup data found for "${batter_name}" vs ${opposition} bowlers with the given filters.`,
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
