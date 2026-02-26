import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import {
  MatchFilterSchema,
  buildMatchFilter,
  buildWhereString,
} from "../queries/common.js";

export function registerTeamForm(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_team_form",
    {
      title: "Team Form",
      description:
        "Team's recent form: last N match results, win/loss streak, average scores, run rate trends. Use for 'How has India been doing in T20s recently?' or 'Australia's form this year'.",
      inputSchema: {
        team: z.string().describe("Team name (e.g., 'India', 'Australia'). Required."),
        match_type: MatchFilterSchema.shape.match_type,
        last_n_matches: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of recent matches to analyze."),
        event_name: MatchFilterSchema.shape.event_name,
        season: MatchFilterSchema.shape.season,
        gender: MatchFilterSchema.shape.gender,
        date_from: MatchFilterSchema.shape.date_from,
        date_to: MatchFilterSchema.shape.date_to,
      },
    },
    async (args) => {
      const { team, last_n_matches, ...filters } = args;
      const { whereClauses, params } = buildMatchFilter(filters);
      params.team_name = team;
      params.last_n = last_n_matches;

      whereClauses.push("(m.team1 = $team_name OR m.team2 = $team_name)");
      const filterStr = buildWhereString(whereClauses);

      // Get the recent match results
      const resultsSql = `
        WITH recent_matches AS (
          SELECT
            m.match_id,
            m.date_start,
            m.match_type,
            m.team1,
            m.team2,
            m.venue,
            m.outcome_winner,
            m.outcome_result,
            m.outcome_by_runs,
            m.outcome_by_wickets,
            m.event_name,
            CASE
              WHEN m.outcome_winner = $team_name THEN 'W'
              WHEN m.outcome_result = 'draw' THEN 'D'
              WHEN m.outcome_result = 'tie' THEN 'T'
              WHEN m.outcome_result = 'no result' THEN 'NR'
              WHEN m.outcome_winner IS NOT NULL THEN 'L'
              ELSE 'NR'
            END AS result,
            CASE
              WHEN m.team1 = $team_name THEN m.team2
              ELSE m.team1
            END AS opponent
          FROM matches m
          WHERE 1=1
            ${filterStr}
          ORDER BY m.date_start DESC
          LIMIT $last_n
        )
        SELECT * FROM recent_matches ORDER BY date_start DESC
      `;

      const results = await runQuery(db, resultsSql, params);

      // Get aggregated form summary
      const summarySql = `
        WITH recent_matches AS (
          SELECT
            m.match_id,
            m.date_start,
            m.outcome_winner,
            m.outcome_result,
            CASE
              WHEN m.outcome_winner = $team_name THEN 'W'
              WHEN m.outcome_result = 'draw' THEN 'D'
              WHEN m.outcome_result = 'tie' THEN 'T'
              WHEN m.outcome_result = 'no result' THEN 'NR'
              WHEN m.outcome_winner IS NOT NULL THEN 'L'
              ELSE 'NR'
            END AS result
          FROM matches m
          WHERE 1=1
            ${filterStr}
          ORDER BY m.date_start DESC
          LIMIT $last_n
        ),
        innings_totals AS (
          SELECT
            d.match_id,
            i.innings_number,
            i.batting_team,
            SUM(d.runs_total) AS total_runs,
            COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
            COUNT(*) FILTER (WHERE d.is_wicket) AS wickets
          FROM deliveries d
          JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
          WHERE d.match_id IN (SELECT match_id FROM recent_matches)
            AND i.batting_team = $team_name
          GROUP BY d.match_id, i.innings_number, i.batting_team
        )
        SELECT
          COUNT(*) AS matches,
          COUNT(*) FILTER (WHERE result = 'W') AS wins,
          COUNT(*) FILTER (WHERE result = 'L') AS losses,
          COUNT(*) FILTER (WHERE result = 'D') AS draws,
          COUNT(*) FILTER (WHERE result = 'T') AS ties,
          COUNT(*) FILTER (WHERE result = 'NR') AS no_results,
          ROUND(COUNT(*) FILTER (WHERE result = 'W')::DOUBLE / NULLIF(COUNT(*) FILTER (WHERE result IN ('W', 'L')), 0) * 100, 1) AS win_pct,
          (SELECT ROUND(AVG(total_runs), 1) FROM innings_totals) AS avg_score,
          (SELECT MAX(total_runs) FROM innings_totals) AS highest_score,
          (SELECT MIN(total_runs) FROM innings_totals) AS lowest_score,
          (SELECT ROUND(AVG(total_runs::DOUBLE / NULLIF(legal_balls, 0) * 6), 2) FROM innings_totals) AS avg_run_rate,
          -- Current streak
          (
            SELECT result || ' x ' || COUNT(*)
            FROM (
              SELECT result,
                ROW_NUMBER() OVER (ORDER BY date_start DESC) -
                ROW_NUMBER() OVER (PARTITION BY result ORDER BY date_start DESC) AS grp
              FROM recent_matches
            )
            WHERE grp = 0
            GROUP BY result, grp
            ORDER BY MIN(grp)
            LIMIT 1
          ) AS current_streak
        FROM recent_matches
      `;

      const summary = await runQuery(db, summarySql, params);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            team,
            summary: summary[0] || {},
            recent_results: results,
          }, null, 2),
        }],
      };
    }
  );
}
