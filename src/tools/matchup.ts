import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildMatchupQuery } from "../queries/matchup.js";

export function registerMatchup(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_matchup",
    {
      title: "Batter vs Bowler Matchup",
      description:
        "How does this batter fare against this bowler? Three modes: " +
        "(1) Specific matchup: provide both batter_name and bowler_name for head-to-head stats (balls, runs, dismissals, average, strike rate, dot %, boundary %). " +
        "(2) Batter vs team: provide batter_name with opposition filter (no bowler_name) to break down per-bowler matchups against that team. " +
        "(3) Leaderboard: provide only batter_name or bowler_name (without the other, without opposition) plus record_type to rank the other side. " +
        "Use for 'Kohli vs Starc', 'How does Rohit do against Australia\\'s bowlers?', or 'Which bowlers dismiss Warner most?'. " +
        "Not for stats by bowling style like pace vs spin (use get_style_matchup), not for overall career stats (use get_player_stats).",
      inputSchema: {
        batter_name: z
          .string()
          .min(2)
          .optional()
          .describe("Batter name (partial match, case-insensitive)."),
        bowler_name: z
          .string()
          .min(2)
          .optional()
          .describe("Bowler name (partial match, case-insensitive)."),
        perspective: z
          .enum(["batting", "bowling"])
          .default("batting")
          .describe(
            "Sort perspective: 'batting' orders by runs scored (batter's view), 'bowling' orders by dismissals then economy (bowler's view)."
          ),
        record_type: z
          .enum([
            "most_dismissals",
            "lowest_average",
            "lowest_strike_rate",
            "highest_dot_ball_pct",
            "most_runs_conceded",
            "highest_strike_rate",
          ])
          .optional()
          .describe(
            "Leaderboard ranking type (only for leaderboard mode). For fixed batter: most_dismissals, lowest_average, lowest_strike_rate, highest_dot_ball_pct. " +
            "For fixed bowler: most_dismissals, most_runs_conceded, highest_strike_rate, lowest_average."
          ),
        sort_by: z
          .enum(["dismissals", "balls_faced", "average", "strike_rate"])
          .optional()
          .describe(
            "Sort field for batter-vs-team mode. Default: balls_faced."
          ),
        min_balls: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Minimum balls faced to qualify. Default: 6 for vs-team mode, 12 for leaderboard mode."
          ),
        min_innings: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Minimum innings to qualify (leaderboard mode only). Default: 3."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Results to return."),
        ...MatchFilterSchema.shape,
      },
    },
    async (args) => {
      const {
        batter_name,
        bowler_name,
        perspective,
        record_type,
        sort_by,
        min_balls,
        min_innings,
        limit,
        ...filters
      } = args;

      // Validation: at least one name required
      if (!batter_name && !bowler_name) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Provide at least one of batter_name or bowler_name.",
            },
          ],
        };
      }

      // Mode 1: Specific matchup (both names)
      if (batter_name && bowler_name) {
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

      // Mode 2: Batter vs team bowling (batter_name + opposition, no bowler_name)
      if (batter_name && !bowler_name && filters.opposition) {
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

        const effectiveMinBalls = min_balls ?? 6;

        const { sql: baseSql, params } = buildMatchupQuery({
          filters,
          extraWhere: [
            "d.batter ILIKE '%' || $batter_name || '%'",
          ],
          extraParams: { batter_name },
          groupBy: "both",
          orderBy,
          limit: limit * 2,
        });

        const sql = `
          WITH base AS (${baseSql})
          SELECT * FROM base
          WHERE balls_faced >= $min_balls
          ORDER BY ${orderBy}
          LIMIT $final_limit
        `;
        params.min_balls = effectiveMinBalls;
        params.final_limit = limit;

        const rows = await runQuery(db, sql, params);

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No matchup data found for "${batter_name}" vs ${filters.opposition} bowlers with the given filters.`,
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

      // Mode 3: Leaderboard (one name only)
      if (!record_type) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: record_type is required for leaderboard mode (when only one of batter_name/bowler_name is provided without opposition).",
            },
          ],
        };
      }

      const extraWhere: string[] = [];
      const extraParams: Record<string, string | number> = {};
      let groupBy: "batter" | "bowler";
      let orderBy: string;

      if (batter_name) {
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

      const effectiveMinBalls = min_balls ?? 12;
      const effectiveMinInnings = min_innings ?? 3;
      const fetchLimit = limit * 3;

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
      params.min_balls = effectiveMinBalls;
      params.min_innings = effectiveMinInnings;
      params.final_limit = limit;

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No matchup records found with the given filters and qualifications.",
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
