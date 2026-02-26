import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema, buildMatchFilter, buildWhereString } from "../queries/common.js";

export function registerVenueStats(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_venue_stats",
    {
      title: "Venue Statistics",
      description:
        "Get statistics for cricket venues/grounds. Returns matches played, average first/second innings scores, highest and lowest totals, and win percentage batting first vs chasing. Filter by venue name, format, date range, etc.",
      inputSchema: {
        venue: z
          .string()
          .optional()
          .describe("Venue/ground name (partial match). Omit to get stats for all venues."),
        match_type: MatchFilterSchema.shape.match_type,
        gender: MatchFilterSchema.shape.gender,
        season: MatchFilterSchema.shape.season,
        event_name: MatchFilterSchema.shape.event_name,
        date_from: MatchFilterSchema.shape.date_from,
        date_to: MatchFilterSchema.shape.date_to,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of venues to return."),
      },
    },
    async (args) => {
      const { venue, limit, ...filters } = args;
      const { whereClauses, params } = buildMatchFilter(filters);
      params.limit = limit;

      if (venue) {
        whereClauses.push("m.venue ILIKE '%' || $venue_filter || '%'");
        params.venue_filter = venue;
      }

      const filterStr = buildWhereString(whereClauses);

      const sql = `
        WITH innings_totals AS (
          SELECT
            m.venue,
            m.match_id,
            m.outcome_winner,
            i.innings_number,
            i.batting_team,
            SUM(d.runs_total) AS total_runs,
            COUNT(*) FILTER (WHERE d.is_wicket) AS total_wickets
          FROM deliveries d
          JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
          JOIN matches m ON d.match_id = m.match_id
          WHERE m.venue IS NOT NULL
            ${filterStr}
          GROUP BY m.venue, m.match_id, m.outcome_winner, i.innings_number, i.batting_team
        )
        SELECT
          venue,
          COUNT(DISTINCT match_id) AS matches,
          ROUND(AVG(total_runs) FILTER (WHERE innings_number = 1), 1) AS avg_first_innings_score,
          ROUND(AVG(total_runs) FILTER (WHERE innings_number = 2), 1) AS avg_second_innings_score,
          MAX(total_runs) AS highest_total,
          MIN(total_runs) AS lowest_total,
          ROUND(
            COUNT(DISTINCT match_id) FILTER (WHERE innings_number = 1 AND batting_team = outcome_winner)::DOUBLE /
            NULLIF(COUNT(DISTINCT match_id), 0) * 100, 1
          ) AS bat_first_win_pct
        FROM innings_totals
        GROUP BY venue
        ORDER BY COUNT(DISTINCT match_id) DESC
        LIMIT $limit
      `;

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No venue statistics found with the given filters.",
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
