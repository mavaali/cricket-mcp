import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import {
  MatchFilterSchema,
  buildMatchFilter,
  buildWhereString,
} from "../queries/common.js";

export function registerFieldingStats(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_fielding_stats",
    {
      title: "Fielding Statistics",
      description:
        "Fielding statistics: catches, run outs, stumpings, total dismissals. Uses fielder data from ball-by-ball records. Use for 'Best fielders in IPL' or 'How many catches has Kohli taken in Tests?'",
      inputSchema: {
        player_name: z
          .string()
          .optional()
          .describe(
            "Fielder name (partial match). Omit for leaderboard mode."
          ),
        match_type: MatchFilterSchema.shape.match_type,
        gender: MatchFilterSchema.shape.gender,
        team: MatchFilterSchema.shape.team,
        opposition: MatchFilterSchema.shape.opposition,
        venue: MatchFilterSchema.shape.venue,
        season: MatchFilterSchema.shape.season,
        event_name: MatchFilterSchema.shape.event_name,
        date_from: MatchFilterSchema.shape.date_from,
        date_to: MatchFilterSchema.shape.date_to,
        sort_by: z
          .enum(["catches", "run_outs", "stumpings", "total_dismissals"])
          .default("total_dismissals")
          .describe("Sort metric for leaderboard."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results to return."),
        min_matches: z
          .number()
          .int()
          .min(1)
          .default(10)
          .describe("Minimum matches for leaderboard qualification."),
      },
    },
    async (args) => {
      const { player_name, sort_by, limit, min_matches, ...filters } = args;

      const { whereClauses, params } = buildMatchFilter(filters);

      if (player_name) {
        whereClauses.push("f.fielder_name ILIKE '%' || $player_name || '%'");
        params.player_name = player_name;
      }

      params.min_matches = min_matches;
      params.limit = limit;

      const filterStr = buildWhereString(whereClauses);

      const orderBy = {
        catches: "catches DESC",
        run_outs: "run_outs DESC",
        stumpings: "stumpings DESC",
        total_dismissals: "total_dismissals DESC",
      }[sort_by];

      const sql = `
        WITH fielding_events AS (
          SELECT
            f.fielder_name,
            d.match_id,
            d.wicket_kind,
            d.wicket_player_out
          FROM deliveries d
          JOIN matches m ON d.match_id = m.match_id
          CROSS JOIN LATERAL (
            VALUES (d.wicket_fielder1), (d.wicket_fielder2)
          ) AS f(fielder_name)
          WHERE d.is_wicket = true
            AND f.fielder_name IS NOT NULL
            ${filterStr}
        )
        SELECT
          fielder_name,
          COUNT(DISTINCT match_id) AS matches,
          COUNT(*) AS total_dismissals,
          COUNT(*) FILTER (WHERE wicket_kind IN ('caught', 'caught and bowled')) AS catches,
          COUNT(*) FILTER (WHERE wicket_kind = 'run out') AS run_outs,
          COUNT(*) FILTER (WHERE wicket_kind = 'stumped') AS stumpings
        FROM fielding_events
        GROUP BY fielder_name
        HAVING COUNT(DISTINCT match_id) >= $min_matches
        ORDER BY ${orderBy}
        LIMIT $limit
      `;

      const rows = await runQuery(db, sql, params);
      return {
        content: [
          {
            type: "text" as const,
            text:
              rows.length === 0
                ? "No fielding stats found with the given filters."
                : JSON.stringify(rows, null, 2),
          },
        ],
      };
    }
  );
}
