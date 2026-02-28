import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema, buildMatchFilter, buildWhereString } from "../queries/common.js";

export function registerSearchMatches(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "search_matches",
    {
      title: "Search Matches",
      description:
        "Find specific matches. Search by date, teams, format, venue, or tournament. Returns match results with teams, scores, venue, date, outcome, and player of the match. " +
        "Use for 'India vs Australia Tests in 2023', 'IPL 2024 finals', or 'Matches at Lord\\'s this year'. " +
        "Use this to find match_id before calling get_match_scorecard or get_innings_progression. " +
        "Not for team records or win/loss tallies (use get_head_to_head or get_team_form).",
      inputSchema: {
        ...MatchFilterSchema.shape,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum number of matches to return."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Offset for pagination."),
      },
    },
    async (args) => {
      const { limit, offset, ...filters } = args;
      const { whereClauses, params } = buildMatchFilter(filters);
      params.limit = limit;
      params.offset = offset;

      const whereStr =
        whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

      const sql = `
        SELECT
          m.match_id,
          m.date_start,
          m.match_type,
          m.gender,
          m.team1,
          m.team2,
          m.venue,
          m.city,
          m.toss_winner,
          m.toss_decision,
          m.outcome_winner,
          m.outcome_by_runs,
          m.outcome_by_wickets,
          m.outcome_result,
          m.outcome_method,
          m.event_name,
          m.season,
          m.player_of_match
        FROM matches m
        ${whereStr}
        ORDER BY m.date_start DESC
        LIMIT $limit OFFSET $offset
      `;

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No matches found with the given filters.",
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
