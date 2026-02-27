import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildMatchupQuery } from "../queries/matchup.js";

export function registerMatchupRecords(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_matchup_records",
    {
      title: "Matchup Records & Leaderboards",
      description:
        "Leaderboard for batter-vs-bowler matchups. Fix one side (batter or bowler) and rank the other. " +
        "When batter_name is provided: rank bowlers against that batter (most_dismissals, lowest_average, lowest_strike_rate, highest_dot_ball_pct). " +
        "When bowler_name is provided: rank batters against that bowler (most_dismissals, most_runs_conceded, highest_strike_rate, lowest_average). " +
        "Provide exactly one of batter_name or bowler_name.",
      inputSchema: {
        batter_name: z
          .string()
          .optional()
          .describe("Fix this batter, rank bowlers against them."),
        bowler_name: z
          .string()
          .optional()
          .describe("Fix this bowler, rank batters against them."),
        record_type: z
          .enum([
            "most_dismissals",
            "lowest_average",
            "lowest_strike_rate",
            "highest_dot_ball_pct",
            "most_runs_conceded",
            "highest_strike_rate",
          ])
          .describe(
            "Record type. For fixed batter: most_dismissals, lowest_average, lowest_strike_rate, highest_dot_ball_pct. " +
            "For fixed bowler: most_dismissals, most_runs_conceded, highest_strike_rate, lowest_average."
          ),
        ...MatchFilterSchema.shape,
        min_balls: z
          .number()
          .int()
          .min(1)
          .default(12)
          .describe("Minimum balls in the matchup to qualify (default: 12)."),
        min_innings: z
          .number()
          .int()
          .min(1)
          .default(3)
          .describe("Minimum innings to qualify (default: 3)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Results to return."),
      },
    },
    async (args) => {
      const {
        batter_name,
        bowler_name,
        record_type,
        min_balls,
        min_innings,
        limit,
        ...filters
      } = args;

      if (!batter_name && !bowler_name) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Provide exactly one of batter_name or bowler_name.",
            },
          ],
        };
      }

      if (batter_name && bowler_name) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Provide exactly one of batter_name or bowler_name, not both. Use get_matchup for a specific matchup.",
            },
          ],
        };
      }

      const extraWhere: string[] = [];
      const extraParams: Record<string, string | number> = {};
      let groupBy: "batter" | "bowler";
      let orderBy: string;

      if (batter_name) {
        // Fix batter, rank bowlers
        extraWhere.push("d.batter ILIKE '%' || $batter_name || '%'");
        extraParams.batter_name = batter_name;
        groupBy = "bowler";

        switch (record_type) {
          case "most_dismissals":
            orderBy = "dismissals DESC, balls_faced DESC";
            break;
          case "lowest_average":
            orderBy = "average ASC NULLS LAST";
            break;
          case "lowest_strike_rate":
            orderBy = "strike_rate ASC NULLS LAST";
            break;
          case "highest_dot_ball_pct":
            orderBy = "dot_ball_pct DESC NULLS LAST";
            break;
          default:
            orderBy = "dismissals DESC";
        }
      } else {
        // Fix bowler, rank batters
        extraWhere.push("d.bowler ILIKE '%' || $bowler_name || '%'");
        extraParams.bowler_name = bowler_name!;
        groupBy = "batter";

        switch (record_type) {
          case "most_dismissals":
            orderBy = "dismissals DESC, balls_faced DESC";
            break;
          case "most_runs_conceded":
            orderBy = "runs_conceded DESC";
            break;
          case "highest_strike_rate":
            orderBy = "strike_rate DESC NULLS LAST";
            break;
          case "lowest_average":
            orderBy = "average ASC NULLS LAST";
            break;
          default:
            orderBy = "dismissals DESC";
        }
      }

      const fetchLimit = limit * 3; // fetch extra to filter by min qualifications

      const { sql: baseSql, params } = buildMatchupQuery({
        filters,
        extraWhere,
        extraParams,
        groupBy,
        orderBy,
        limit: fetchLimit,
      });

      const sql = `
        WITH base AS (${baseSql})
        SELECT * FROM base
        WHERE balls_faced >= $min_balls AND innings >= $min_innings
        ORDER BY ${orderBy}
        LIMIT $final_limit
      `;
      params.min_balls = min_balls;
      params.min_innings = min_innings;
      params.final_limit = limit;

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matchup records found with the given filters and qualifications.`,
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
