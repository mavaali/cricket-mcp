import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import {
  MatchFilterSchema,
  buildMatchFilter,
  buildWhereString,
} from "../queries/common.js";

export function registerSituationalStats(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_situational_stats",
    {
      title: "Situational Stats",
      description:
        "Get player or team stats in specific match situations: chasing vs setting, batting under pressure (3+ wickets down in first 10 overs), or by batting position. Format-aware: in Tests 'chasing' means 4th innings, 'setting' means 1st innings; in LOIs 'chasing' = innings 2, 'setting' = innings 1. Use for 'Kohli while chasing in ODIs', '4th innings specialists in Tests', or 'Best #3 batters in Tests'.",
      inputSchema: {
        situation: z
          .enum(["chasing", "setting", "pressure", "batting_position"])
          .describe("Match situation type."),
        batting_position: z
          .number()
          .int()
          .min(1)
          .max(11)
          .optional()
          .describe("Batting position (1-11). Only used when situation = 'batting_position'."),
        player_name: z
          .string()
          .optional()
          .describe("Player name (partial match). Omit for leaderboard."),
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
          .describe("Number of results."),
        min_innings: z
          .number()
          .int()
          .min(1)
          .default(5)
          .describe("Minimum innings for leaderboard qualification."),
        sort_by: z
          .enum(["runs", "average", "strike_rate", "centuries"])
          .default("runs")
          .describe("Sort metric."),
      },
    },
    async (args) => {
      const {
        situation,
        batting_position,
        player_name,
        limit,
        min_innings,
        sort_by,
        ...filters
      } = args;

      const { whereClauses, params } = buildMatchFilter(filters);
      params.limit = limit;
      params.min_innings = min_innings;

      if (player_name) {
        whereClauses.push("d.batter ILIKE '%' || $player_name || '%'");
        params.player_name = player_name;
      }

      // Situation-specific conditions
      let situationJoin = "";
      let situationWhere = "";

      switch (situation) {
        case "chasing":
          // LOIs: innings 2. Tests: innings 4 (4th innings chase).
          situationWhere = `AND (
            (m.match_type = 'Test' AND d.innings_number = 4)
            OR (m.match_type != 'Test' AND d.innings_number = 2)
          )`;
          break;

        case "setting":
          // LOIs: innings 1 (bat first). Tests: innings 1 or 2 (first innings for both teams).
          situationWhere = `AND (
            (m.match_type = 'Test' AND d.innings_number IN (1, 2))
            OR (m.match_type != 'Test' AND d.innings_number = 1)
          )`;
          break;

        case "pressure":
          // Batting when 3+ wickets have fallen in first 10 overs
          // We detect this by looking at innings where the batter entered
          // when cumulative wickets >= 3 and over_number <= 9
          situationJoin = `
            JOIN (
              SELECT DISTINCT match_id, innings_number, batter
              FROM deliveries
              WHERE over_number <= 9
            ) pressure_filter ON d.match_id = pressure_filter.match_id
              AND d.innings_number = pressure_filter.innings_number
              AND d.batter = pressure_filter.batter
          `;
          // Filter to innings where 3+ wickets fell in first 10 overs
          situationWhere = `
            AND (
              SELECT COUNT(*) FILTER (WHERE is_wicket)
              FROM deliveries d2
              WHERE d2.match_id = d.match_id
                AND d2.innings_number = d.innings_number
                AND d2.over_number <= 9
            ) >= 3
          `;
          break;

        case "batting_position":
          if (batting_position) {
            params.bat_pos = batting_position;
            // Determine batting position from order of first appearance in innings
            situationJoin = `
              JOIN (
                SELECT match_id, innings_number, batter,
                  ROW_NUMBER() OVER (
                    PARTITION BY match_id, innings_number
                    ORDER BY over_number, ball_number
                  ) AS first_ball_rank
                FROM (
                  SELECT DISTINCT ON (match_id, innings_number, batter)
                    match_id, innings_number, batter, over_number, ball_number
                  FROM deliveries
                  ORDER BY match_id, innings_number, batter, over_number, ball_number
                )
              ) bat_order ON d.match_id = bat_order.match_id
                AND d.innings_number = bat_order.innings_number
                AND d.batter = bat_order.batter
            `;
            // Batting position is the rank of first appearance
            // Position 1 = first batter to face, Position 2 = second distinct batter, etc.
            situationWhere = "AND bat_order.first_ball_rank = $bat_pos";
          }
          break;
      }

      const filterStr = buildWhereString(whereClauses);

      const orderBy = {
        runs: "runs DESC",
        average: "average DESC NULLS LAST",
        strike_rate: "strike_rate DESC NULLS LAST",
        centuries: "centuries DESC",
      }[sort_by];

      // For the pressure situation, use a simpler approach that's more efficient
      let sql: string;

      if (situation === "pressure") {
        sql = `
          WITH wickets_in_powerplay AS (
            SELECT match_id, innings_number,
              COUNT(*) FILTER (WHERE is_wicket) AS early_wickets
            FROM deliveries
            WHERE over_number <= 9
            GROUP BY match_id, innings_number
            HAVING COUNT(*) FILTER (WHERE is_wicket) >= 3
          ),
          innings_scores AS (
            SELECT
              d.batter AS player_name,
              d.batter_id AS player_id,
              d.match_id,
              d.innings_number,
              SUM(d.runs_batter) AS innings_runs,
              COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
              COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS innings_fours,
              COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS innings_sixes,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            JOIN wickets_in_powerplay wp ON d.match_id = wp.match_id AND d.innings_number = wp.innings_number
            WHERE 1=1
              ${filterStr}
            GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
          )
          SELECT
            player_name, player_id,
            COUNT(DISTINCT match_id) AS matches,
            COUNT(*) AS innings,
            SUM(innings_runs) AS runs,
            SUM(innings_balls) AS balls_faced,
            SUM(innings_fours) AS fours,
            SUM(innings_sixes) AS sixes,
            COUNT(*) FILTER (WHERE innings_runs >= 100) AS centuries,
            COUNT(*) FILTER (WHERE innings_runs >= 50 AND innings_runs < 100) AS fifties,
            SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) AS not_outs,
            ROUND(
              CASE WHEN COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) > 0
                THEN SUM(innings_runs)::DOUBLE / (COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END))
                ELSE NULL END, 2
            ) AS average,
            ROUND(
              CASE WHEN SUM(innings_balls) > 0
                THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
                ELSE NULL END, 2
            ) AS strike_rate
          FROM innings_scores
          GROUP BY player_name, player_id
          HAVING COUNT(*) >= $min_innings
          ORDER BY ${orderBy}
          LIMIT $limit
        `;
      } else if (situation === "batting_position" && batting_position) {
        // Batting position: determine order of distinct batter appearances per innings
        sql = `
          WITH batter_order AS (
            SELECT match_id, innings_number, batter,
              DENSE_RANK() OVER (
                PARTITION BY match_id, innings_number
                ORDER BY MIN(over_number * 1000 + ball_number)
              ) AS bat_position
            FROM deliveries
            GROUP BY match_id, innings_number, batter
          ),
          innings_scores AS (
            SELECT
              d.batter AS player_name,
              d.batter_id AS player_id,
              d.match_id,
              d.innings_number,
              SUM(d.runs_batter) AS innings_runs,
              COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
              COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS innings_fours,
              COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS innings_sixes,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            JOIN batter_order bo ON d.match_id = bo.match_id
              AND d.innings_number = bo.innings_number
              AND d.batter = bo.batter
            WHERE bo.bat_position = $bat_pos
              ${filterStr}
            GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
          )
          SELECT
            player_name, player_id,
            COUNT(DISTINCT match_id) AS matches,
            COUNT(*) AS innings,
            SUM(innings_runs) AS runs,
            SUM(innings_balls) AS balls_faced,
            SUM(innings_fours) AS fours,
            SUM(innings_sixes) AS sixes,
            COUNT(*) FILTER (WHERE innings_runs >= 100) AS centuries,
            COUNT(*) FILTER (WHERE innings_runs >= 50 AND innings_runs < 100) AS fifties,
            SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) AS not_outs,
            ROUND(
              CASE WHEN COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) > 0
                THEN SUM(innings_runs)::DOUBLE / (COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END))
                ELSE NULL END, 2
            ) AS average,
            ROUND(
              CASE WHEN SUM(innings_balls) > 0
                THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
                ELSE NULL END, 2
            ) AS strike_rate
          FROM innings_scores
          GROUP BY player_name, player_id
          HAVING COUNT(*) >= $min_innings
          ORDER BY ${orderBy}
          LIMIT $limit
        `;
      } else {
        // Chasing or setting — simple innings_number filter
        sql = `
          WITH innings_scores AS (
            SELECT
              d.batter AS player_name,
              d.batter_id AS player_id,
              d.match_id,
              d.innings_number,
              SUM(d.runs_batter) AS innings_runs,
              COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
              COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS innings_fours,
              COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS innings_sixes,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE 1=1
              ${filterStr}
              ${situationWhere}
            GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
          )
          SELECT
            player_name, player_id,
            COUNT(DISTINCT match_id) AS matches,
            COUNT(*) AS innings,
            SUM(innings_runs) AS runs,
            SUM(innings_balls) AS balls_faced,
            SUM(innings_fours) AS fours,
            SUM(innings_sixes) AS sixes,
            COUNT(*) FILTER (WHERE innings_runs >= 100) AS centuries,
            COUNT(*) FILTER (WHERE innings_runs >= 50 AND innings_runs < 100) AS fifties,
            SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) AS not_outs,
            ROUND(
              CASE WHEN COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) > 0
                THEN SUM(innings_runs)::DOUBLE / (COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END))
                ELSE NULL END, 2
            ) AS average,
            ROUND(
              CASE WHEN SUM(innings_balls) > 0
                THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
                ELSE NULL END, 2
            ) AS strike_rate
          FROM innings_scores
          GROUP BY player_name, player_id
          HAVING COUNT(*) >= $min_innings
          ORDER BY ${orderBy}
          LIMIT $limit
        `;
      }

      const rows = await runQuery(db, sql, params);
      return {
        content: [{
          type: "text" as const,
          text: rows.length === 0
            ? "No situational stats found with the given filters."
            : JSON.stringify(rows, null, 2),
        }],
      };
    }
  );
}
