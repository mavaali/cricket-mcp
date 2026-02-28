import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema, buildMatchFilter, buildWhereString } from "../queries/common.js";

export function registerHeadToHead(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_head_to_head",
    {
      title: "Head to Head Record",
      description:
        "What is the win/loss record between two teams? Returns total matches, wins for each side, draws, ties, and no results. " +
        "Use for 'India vs Australia Test record', 'England vs New Zealand in ODIs', or 'India vs Pakistan World Cup head-to-head'. " +
        "Not for individual player matchups (use get_matchup) or recent form (use get_team_form).",
      inputSchema: {
        team1: z.string().describe("First team name (e.g., 'India', 'Australia')."),
        team2: z.string().describe("Second team name."),
        match_type: MatchFilterSchema.shape.match_type,
        gender: MatchFilterSchema.shape.gender,
        venue: MatchFilterSchema.shape.venue,
        season: MatchFilterSchema.shape.season,
        event_name: MatchFilterSchema.shape.event_name,
        date_from: MatchFilterSchema.shape.date_from,
        date_to: MatchFilterSchema.shape.date_to,
      },
    },
    async (args) => {
      const { team1, team2, ...filters } = args;
      const { whereClauses, params } = buildMatchFilter(filters);
      params.team1 = team1;
      params.team2 = team2;
      const filterStr = buildWhereString(whereClauses);

      const sql = `
        SELECT
          $team1 AS team1,
          $team2 AS team2,
          COUNT(*) AS total_matches,
          COUNT(*) FILTER (WHERE m.outcome_winner = $team1) AS team1_wins,
          COUNT(*) FILTER (WHERE m.outcome_winner = $team2) AS team2_wins,
          COUNT(*) FILTER (WHERE m.outcome_result = 'draw') AS draws,
          COUNT(*) FILTER (WHERE m.outcome_result = 'tie') AS ties,
          COUNT(*) FILTER (WHERE m.outcome_result = 'no result') AS no_results
        FROM matches m
        WHERE (
          (m.team1 = $team1 AND m.team2 = $team2)
          OR (m.team1 = $team2 AND m.team2 = $team1)
        )
        ${filterStr}
      `;

      const rows = await runQuery(db, sql, params);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rows[0], null, 2),
          },
        ],
      };
    }
  );
}
