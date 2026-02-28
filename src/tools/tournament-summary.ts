import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { BOWLING_WICKET_KINDS } from "../queries/common.js";

export function registerTournamentSummary(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_tournament_summary",
    {
      title: "Tournament Summary",
      description:
        "How did a tournament go? Who were the top performers? Tournament overview: team standings (wins/losses/win %), top run scorers, and top wicket takers. " +
        "Use for 'IPL 2024 standings', 'Top performers in 2023 World Cup', or 'Who scored the most runs in the Ashes 2023?'. " +
        "Not for a single team\\'s form (use get_team_form) or a single player\\'s career stats (use get_player_stats).",
      inputSchema: {
        event_name: z
          .string()
          .describe("Tournament/series name (e.g., 'Indian Premier League', 'ICC Cricket World Cup'). Partial match."),
        season: z
          .string()
          .optional()
          .describe("Season (e.g., '2024', '2023/24'). Omit for all-time tournament stats."),
        aspect: z
          .enum(["standings", "top_batters", "top_bowlers", "summary"])
          .default("summary")
          .describe("What to return: standings, top_batters, top_bowlers, or summary (all combined)."),
        gender: z
          .enum(["male", "female"])
          .optional()
          .describe("Filter by gender."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results per section."),
      },
    },
    async (args) => {
      const { event_name, season, aspect, gender, limit } = args;
      const params: Record<string, string | number> = {
        event_name,
        limit,
      };
      if (season) params.season = season;
      if (gender) params.gender = gender;

      let seasonFilter = season ? "AND m.season = $season" : "";
      let genderFilter = gender ? "AND m.gender = $gender" : "";
      const commonFilter = `
        m.event_name ILIKE '%' || $event_name || '%'
        ${seasonFilter}
        ${genderFilter}
      `;

      const result: Record<string, unknown> = {};

      // Standings
      if (aspect === "standings" || aspect === "summary") {
        const standingsSql = `
          WITH team_matches AS (
            SELECT
              t.team,
              m.match_id,
              m.outcome_winner,
              m.outcome_result
            FROM matches m
            CROSS JOIN LATERAL (VALUES (m.team1), (m.team2)) AS t(team)
            WHERE ${commonFilter}
          )
          SELECT
            team,
            COUNT(*) AS played,
            COUNT(*) FILTER (WHERE outcome_winner = team) AS won,
            COUNT(*) FILTER (WHERE outcome_winner IS NOT NULL AND outcome_winner != team AND outcome_result IS NULL) AS lost,
            COUNT(*) FILTER (WHERE outcome_result = 'draw') AS drawn,
            COUNT(*) FILTER (WHERE outcome_result = 'tie') AS tied,
            COUNT(*) FILTER (WHERE outcome_result = 'no result') AS no_result,
            ROUND(COUNT(*) FILTER (WHERE outcome_winner = team)::DOUBLE / NULLIF(COUNT(*) FILTER (WHERE outcome_winner IS NOT NULL), 0) * 100, 1) AS win_pct
          FROM team_matches
          GROUP BY team
          ORDER BY won DESC, win_pct DESC NULLS LAST
          LIMIT $limit
        `;
        result.standings = await runQuery(db, standingsSql, params);
      }

      // Top batters
      if (aspect === "top_batters" || aspect === "summary") {
        const battersSql = `
          WITH innings_scores AS (
            SELECT
              d.batter AS player_name,
              d.match_id,
              d.innings_number,
              SUM(d.runs_batter) AS innings_runs,
              COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE ${commonFilter}
            GROUP BY d.batter, d.match_id, d.innings_number
          )
          SELECT
            player_name,
            COUNT(DISTINCT match_id) AS matches,
            COUNT(*) AS innings,
            SUM(innings_runs) AS runs,
            MAX(innings_runs) AS highest_score,
            ROUND(
              CASE WHEN COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) > 0
                THEN SUM(innings_runs)::DOUBLE / (COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END))
                ELSE NULL END, 2
            ) AS average,
            ROUND(
              CASE WHEN SUM(innings_balls) > 0
                THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
                ELSE NULL END, 2
            ) AS strike_rate,
            COUNT(*) FILTER (WHERE innings_runs >= 100) AS centuries,
            COUNT(*) FILTER (WHERE innings_runs >= 50 AND innings_runs < 100) AS fifties
          FROM innings_scores
          GROUP BY player_name
          ORDER BY SUM(innings_runs) DESC
          LIMIT $limit
        `;
        result.top_batters = await runQuery(db, battersSql, params);
      }

      // Top bowlers
      if (aspect === "top_bowlers" || aspect === "summary") {
        const bowlersSql = `
          WITH bowling_innings AS (
            SELECT
              d.bowler AS player_name,
              d.match_id,
              d.innings_number,
              COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
              SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
              COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE ${commonFilter}
            GROUP BY d.bowler, d.match_id, d.innings_number
          )
          SELECT
            player_name,
            COUNT(DISTINCT match_id) AS matches,
            COUNT(*) AS innings,
            SUM(wickets) AS wickets,
            SUM(runs_conceded) AS runs_conceded,
            ROUND(
              CASE WHEN SUM(wickets) > 0
                THEN SUM(runs_conceded)::DOUBLE / SUM(wickets)
                ELSE NULL END, 2
            ) AS average,
            ROUND(
              CASE WHEN SUM(legal_balls) > 0
                THEN SUM(runs_conceded)::DOUBLE / (SUM(legal_balls)::DOUBLE / 6)
                ELSE NULL END, 2
            ) AS economy,
            COUNT(*) FILTER (WHERE wickets >= 5) AS five_wicket_hauls
          FROM bowling_innings
          GROUP BY player_name
          ORDER BY SUM(wickets) DESC
          LIMIT $limit
        `;
        result.top_bowlers = await runQuery(db, bowlersSql, params);
      }

      // Tournament meta info
      if (aspect === "summary") {
        const metaSql = `
          SELECT
            COUNT(*) AS total_matches,
            MIN(m.date_start) AS first_match,
            MAX(m.date_start) AS last_match,
            COUNT(DISTINCT m.season) AS seasons
          FROM matches m
          WHERE ${commonFilter}
        `;
        const meta = await runQuery(db, metaSql, params);
        result.meta = meta[0] || {};
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
