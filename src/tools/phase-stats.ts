import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import {
  MatchFilterSchema,
  buildMatchFilter,
  buildWhereString,
  PHASE_OVERS,
  BOWLING_WICKET_KINDS,
} from "../queries/common.js";


export function registerPhaseStats(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_phase_stats",
    {
      title: "Phase Stats",
      description:
        "How does a player perform in powerplay / middle / death overs? Batting or bowling stats scoped to a match phase: powerplay (1-6), middle (7-15), or death (16-20). " +
        "Works for individual players or as a leaderboard. Use for 'Bumrah\\'s death bowling economy', 'Best powerplay batters in IPL 2024', or 'Rashid Khan\\'s middle overs stats'. " +
        "Not for full career stats across all overs (use get_player_stats) or style-based phase analysis (use get_style_matchup with phase filter).",
      inputSchema: {
        phase: z
          .enum(["powerplay", "middle", "death"])
          .describe("Match phase: powerplay (overs 1-6), middle (7-15), death (16-20)."),
        perspective: z
          .enum(["batting", "bowling"])
          .describe("Batting or bowling stats."),
        player_name: z
          .string()
          .optional()
          .describe("Player name (partial match). Omit for leaderboard mode."),
        team: MatchFilterSchema.shape.team,
        match_type: MatchFilterSchema.shape.match_type,
        event_name: MatchFilterSchema.shape.event_name,
        season: MatchFilterSchema.shape.season,
        opposition: MatchFilterSchema.shape.opposition,
        venue: MatchFilterSchema.shape.venue,
        gender: MatchFilterSchema.shape.gender,
        date_from: MatchFilterSchema.shape.date_from,
        date_to: MatchFilterSchema.shape.date_to,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results to return (leaderboard mode)."),
        min_balls: z
          .number()
          .int()
          .min(1)
          .default(50)
          .describe("Minimum balls for leaderboard qualification."),
        sort_by: z
          .enum(["runs", "strike_rate", "average", "wickets", "economy", "dot_ball_pct"])
          .default("runs")
          .describe("Sort metric for leaderboard."),
      },
    },
    async (args) => {
      const {
        phase,
        perspective,
        player_name,
        limit,
        min_balls,
        sort_by,
        ...filters
      } = args;

      const { whereClauses, params } = buildMatchFilter(filters);
      const [overFrom, overTo] = PHASE_OVERS[phase];
      params.over_from = overFrom;
      params.over_to = overTo;
      params.limit = limit;
      params.min_balls = min_balls;

      whereClauses.push("d.over_number >= $over_from AND d.over_number <= $over_to");

      if (player_name) {
        const col = perspective === "batting" ? "d.batter" : "d.bowler";
        whereClauses.push(`${col} ILIKE '%' || $player_name || '%'`);
        params.player_name = player_name;
      }

      const filterStr = buildWhereString(whereClauses);

      if (perspective === "batting") {
        const orderBy = {
          runs: "runs DESC",
          strike_rate: "strike_rate DESC NULLS LAST",
          average: "average DESC NULLS LAST",
          wickets: "runs DESC",
          economy: "runs DESC",
          dot_ball_pct: "dot_ball_pct ASC NULLS LAST",
        }[sort_by];

        const sql = `
          WITH phase_innings AS (
            SELECT
              d.batter AS player_name,
              d.batter_id AS player_id,
              d.match_id,
              d.innings_number,
              SUM(d.runs_batter) AS innings_runs,
              COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
              COUNT(*) FILTER (WHERE d.runs_batter = 0 AND d.extras_wides = 0) AS innings_dots,
              COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS innings_fours,
              COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS innings_sixes,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE 1=1
              ${filterStr}
            GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
          )
          SELECT
            player_name,
            player_id,
            COUNT(DISTINCT match_id) AS matches,
            COUNT(*) AS innings,
            SUM(innings_runs) AS runs,
            SUM(innings_balls) AS balls_faced,
            SUM(innings_dots) AS dot_balls,
            SUM(innings_fours) AS fours,
            SUM(innings_sixes) AS sixes,
            SUM(was_dismissed) AS dismissals,
            ROUND(
              CASE WHEN SUM(was_dismissed) > 0
                THEN SUM(innings_runs)::DOUBLE / SUM(was_dismissed)
                ELSE NULL END, 2
            ) AS average,
            ROUND(
              CASE WHEN SUM(innings_balls) > 0
                THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
                ELSE NULL END, 2
            ) AS strike_rate,
            ROUND(
              CASE WHEN SUM(innings_balls) > 0
                THEN SUM(innings_dots)::DOUBLE / SUM(innings_balls) * 100
                ELSE NULL END, 2
            ) AS dot_ball_pct,
            ROUND(
              CASE WHEN SUM(innings_balls) > 0
                THEN (SUM(innings_fours) + SUM(innings_sixes))::DOUBLE / SUM(innings_balls) * 100
                ELSE NULL END, 2
            ) AS boundary_pct
          FROM phase_innings
          GROUP BY player_name, player_id
          HAVING SUM(innings_balls) >= $min_balls
          ORDER BY ${orderBy}
          LIMIT $limit
        `;

        const rows = await runQuery(db, sql, params);
        return {
          content: [{
            type: "text" as const,
            text: rows.length === 0
              ? "No phase stats found with the given filters."
              : JSON.stringify(rows, null, 2),
          }],
        };
      } else {
        // Bowling perspective
        const orderBy = {
          runs: "wickets DESC",
          strike_rate: "bowling_strike_rate ASC NULLS LAST",
          average: "average ASC NULLS LAST",
          wickets: "wickets DESC",
          economy: "economy ASC NULLS LAST",
          dot_ball_pct: "dot_ball_pct DESC NULLS LAST",
        }[sort_by];

        const sql = `
          WITH phase_bowling AS (
            SELECT
              d.bowler AS player_name,
              d.bowler_id AS player_id,
              d.match_id,
              d.innings_number,
              COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
              SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
              COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets,
              COUNT(*) FILTER (WHERE d.runs_total = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0) AS dots,
              COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS fours_conceded,
              COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS sixes_conceded
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE 1=1
              ${filterStr}
            GROUP BY d.bowler, d.bowler_id, d.match_id, d.innings_number
          )
          SELECT
            player_name,
            player_id,
            COUNT(DISTINCT match_id) AS matches,
            COUNT(*) AS innings,
            SUM(legal_balls) AS balls_bowled,
            CAST(SUM(legal_balls) / 6 AS VARCHAR) || '.' || CAST(SUM(legal_balls) % 6 AS VARCHAR) AS overs,
            SUM(runs_conceded) AS runs_conceded,
            SUM(wickets) AS wickets,
            SUM(dots) AS dot_balls,
            SUM(fours_conceded) AS fours_conceded,
            SUM(sixes_conceded) AS sixes_conceded,
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
            ROUND(
              CASE WHEN SUM(wickets) > 0
                THEN SUM(legal_balls)::DOUBLE / SUM(wickets)
                ELSE NULL END, 2
            ) AS bowling_strike_rate,
            ROUND(
              CASE WHEN SUM(legal_balls) > 0
                THEN SUM(dots)::DOUBLE / SUM(legal_balls) * 100
                ELSE NULL END, 2
            ) AS dot_ball_pct,
            ROUND(
              CASE WHEN SUM(legal_balls) > 0
                THEN (SUM(fours_conceded) + SUM(sixes_conceded))::DOUBLE / SUM(legal_balls) * 100
                ELSE NULL END, 2
            ) AS boundary_pct
          FROM phase_bowling
          GROUP BY player_name, player_id
          HAVING SUM(legal_balls) >= $min_balls
          ORDER BY ${orderBy}
          LIMIT $limit
        `;

        const rows = await runQuery(db, sql, params);
        return {
          content: [{
            type: "text" as const,
            text: rows.length === 0
              ? "No phase stats found with the given filters."
              : JSON.stringify(rows, null, 2),
          }],
        };
      }
    }
  );
}
