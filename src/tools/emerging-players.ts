import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { BOWLING_WICKET_KINDS } from "../queries/common.js";

export function registerEmergingPlayers(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_emerging_players",
    {
      title: "Emerging Players",
      description:
        "Find players whose stats have significantly improved in recent seasons vs career baseline. The 'stocks rising' query. Compares recent window to career averages. Use for 'Which batters are improving in T20s?' or 'Rising bowling talent in IPL'.",
      inputSchema: {
        perspective: z
          .enum(["batting", "bowling"])
          .describe("Look at batting or bowling improvement."),
        match_type: z
          .string()
          .optional()
          .describe('Cricket format filter.'),
        event_name: z
          .string()
          .optional()
          .describe("Tournament filter (partial match)."),
        gender: z
          .enum(["male", "female"])
          .optional()
          .describe("Filter by gender."),
        recent_period: z
          .string()
          .optional()
          .describe("Recent comparison window as season (e.g., '2024'). Default: latest season in data."),
        min_matches_recent: z
          .number()
          .int()
          .min(1)
          .default(5)
          .describe("Minimum matches in recent period."),
        min_matches_career: z
          .number()
          .int()
          .min(1)
          .default(20)
          .describe("Minimum career matches."),
        metric: z
          .enum(["average", "strike_rate", "economy", "wickets_per_match"])
          .default("average")
          .describe("Metric to compare for improvement."),
        improvement_threshold: z
          .number()
          .min(0)
          .default(20)
          .describe("Minimum % improvement required."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results."),
      },
    },
    async (args) => {
      const {
        perspective,
        match_type,
        event_name,
        gender,
        recent_period,
        min_matches_recent,
        min_matches_career,
        metric,
        improvement_threshold,
        limit,
      } = args;

      const params: Record<string, string | number> = {
        min_recent: min_matches_recent,
        min_career: min_matches_career,
        improvement: improvement_threshold,
        limit,
      };

      let matchTypeFilter = "";
      if (match_type) {
        matchTypeFilter = "AND m.match_type = $match_type";
        params.match_type = match_type;
      }
      let eventFilter = "";
      if (event_name) {
        eventFilter = "AND m.event_name ILIKE '%' || $event_name || '%'";
        params.event_name = event_name;
      }
      let genderFilter = "";
      if (gender) {
        genderFilter = "AND m.gender = $gender";
        params.gender = gender;
      }

      const commonFilter = `${matchTypeFilter} ${eventFilter} ${genderFilter}`;

      // Determine recent period
      let recentFilter: string;
      if (recent_period) {
        params.recent_season = recent_period;
        recentFilter = "m.season = $recent_season";
      } else {
        recentFilter = "m.season = (SELECT MAX(season) FROM matches WHERE season IS NOT NULL)";
      }

      let sql: string;

      if (perspective === "batting") {
        const metricCol = metric === "strike_rate" ? "strike_rate" : "average";

        sql = `
          WITH innings_scores AS (
            SELECT
              d.batter AS player_name,
              d.batter_id AS player_id,
              d.match_id,
              d.innings_number,
              m.season,
              SUM(d.runs_batter) AS innings_runs,
              COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE 1=1 ${commonFilter}
            GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number, m.season
          ),
          career_stats AS (
            SELECT
              player_name,
              player_id,
              COUNT(DISTINCT match_id) AS career_matches,
              COUNT(*) AS career_innings,
              SUM(innings_runs) AS career_runs,
              SUM(innings_balls) AS career_balls,
              SUM(was_dismissed) AS career_dismissals,
              ROUND(
                CASE WHEN SUM(was_dismissed) > 0
                  THEN SUM(innings_runs)::DOUBLE / SUM(was_dismissed)
                  ELSE NULL END, 2
              ) AS career_average,
              ROUND(
                CASE WHEN SUM(innings_balls) > 0
                  THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
                  ELSE NULL END, 2
              ) AS career_strike_rate
            FROM innings_scores
            GROUP BY player_name, player_id
            HAVING COUNT(DISTINCT match_id) >= $min_career
          ),
          recent_stats AS (
            SELECT
              player_name,
              player_id,
              COUNT(DISTINCT match_id) AS recent_matches,
              COUNT(*) AS recent_innings,
              SUM(innings_runs) AS recent_runs,
              SUM(innings_balls) AS recent_balls,
              SUM(was_dismissed) AS recent_dismissals,
              ROUND(
                CASE WHEN SUM(was_dismissed) > 0
                  THEN SUM(innings_runs)::DOUBLE / SUM(was_dismissed)
                  ELSE NULL END, 2
              ) AS recent_average,
              ROUND(
                CASE WHEN SUM(innings_balls) > 0
                  THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
                  ELSE NULL END, 2
              ) AS recent_strike_rate
            FROM innings_scores
            WHERE ${recentFilter}
            GROUP BY player_name, player_id
            HAVING COUNT(DISTINCT match_id) >= $min_recent
          )
          SELECT
            c.player_name,
            c.player_id,
            c.career_matches,
            c.career_${metricCol},
            r.recent_matches,
            r.recent_${metricCol},
            ROUND(
              (r.recent_${metricCol} - c.career_${metricCol})::DOUBLE / NULLIF(c.career_${metricCol}, 0) * 100, 1
            ) AS improvement_pct
          FROM career_stats c
          JOIN recent_stats r ON c.player_id = r.player_id
          WHERE c.career_${metricCol} IS NOT NULL
            AND r.recent_${metricCol} IS NOT NULL
            AND (r.recent_${metricCol} - c.career_${metricCol})::DOUBLE / NULLIF(c.career_${metricCol}, 0) * 100 >= $improvement
          ORDER BY improvement_pct DESC
          LIMIT $limit
        `;
      } else {
        // Bowling
        const metricExpr = {
          average: "average",
          economy: "economy",
          strike_rate: "economy",
          wickets_per_match: "wickets_per_match",
        }[metric];

        sql = `
          WITH bowling_innings AS (
            SELECT
              d.bowler AS player_name,
              d.bowler_id AS player_id,
              d.match_id,
              d.innings_number,
              m.season,
              COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
              SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
              COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE 1=1 ${commonFilter}
            GROUP BY d.bowler, d.bowler_id, d.match_id, d.innings_number, m.season
          ),
          career_stats AS (
            SELECT
              player_name,
              player_id,
              COUNT(DISTINCT match_id) AS career_matches,
              SUM(wickets) AS career_wickets,
              ROUND(
                CASE WHEN SUM(wickets) > 0
                  THEN SUM(runs_conceded)::DOUBLE / SUM(wickets)
                  ELSE NULL END, 2
              ) AS career_average,
              ROUND(
                CASE WHEN SUM(legal_balls) > 0
                  THEN SUM(runs_conceded)::DOUBLE / (SUM(legal_balls)::DOUBLE / 6)
                  ELSE NULL END, 2
              ) AS career_economy,
              ROUND(SUM(wickets)::DOUBLE / NULLIF(COUNT(DISTINCT match_id), 0), 2) AS career_wickets_per_match
            FROM bowling_innings
            GROUP BY player_name, player_id
            HAVING COUNT(DISTINCT match_id) >= $min_career
          ),
          recent_stats AS (
            SELECT
              player_name,
              player_id,
              COUNT(DISTINCT match_id) AS recent_matches,
              SUM(wickets) AS recent_wickets,
              ROUND(
                CASE WHEN SUM(wickets) > 0
                  THEN SUM(runs_conceded)::DOUBLE / SUM(wickets)
                  ELSE NULL END, 2
              ) AS recent_average,
              ROUND(
                CASE WHEN SUM(legal_balls) > 0
                  THEN SUM(runs_conceded)::DOUBLE / (SUM(legal_balls)::DOUBLE / 6)
                  ELSE NULL END, 2
              ) AS recent_economy,
              ROUND(SUM(wickets)::DOUBLE / NULLIF(COUNT(DISTINCT match_id), 0), 2) AS recent_wickets_per_match
            FROM bowling_innings
            WHERE ${recentFilter}
            GROUP BY player_name, player_id
            HAVING COUNT(DISTINCT match_id) >= $min_recent
          )
          SELECT
            c.player_name,
            c.player_id,
            c.career_matches,
            c.career_${metricExpr},
            r.recent_matches,
            r.recent_${metricExpr},
            ROUND(
              ${metricExpr === "wickets_per_match"
                ? `(r.recent_${metricExpr} - c.career_${metricExpr})::DOUBLE / NULLIF(c.career_${metricExpr}, 0) * 100`
                : `(c.career_${metricExpr} - r.recent_${metricExpr})::DOUBLE / NULLIF(c.career_${metricExpr}, 0) * 100`
              }, 1
            ) AS improvement_pct
          FROM career_stats c
          JOIN recent_stats r ON c.player_id = r.player_id
          WHERE c.career_${metricExpr} IS NOT NULL
            AND r.recent_${metricExpr} IS NOT NULL
            AND ${metricExpr === "wickets_per_match"
              ? `(r.recent_${metricExpr} - c.career_${metricExpr})::DOUBLE / NULLIF(c.career_${metricExpr}, 0) * 100`
              : `(c.career_${metricExpr} - r.recent_${metricExpr})::DOUBLE / NULLIF(c.career_${metricExpr}, 0) * 100`
            } >= $improvement
          ORDER BY improvement_pct DESC
          LIMIT $limit
        `;
      }

      const rows = await runQuery(db, sql, params);
      return {
        content: [{
          type: "text" as const,
          text: rows.length === 0
            ? "No emerging players found with the given filters and threshold."
            : JSON.stringify(rows, null, 2),
        }],
      };
    }
  );
}
