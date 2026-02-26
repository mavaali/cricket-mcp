import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import {
  MatchFilterSchema,
  buildMatchFilter,
  buildWhereString,
  BOWLING_WICKET_KINDS,
} from "../queries/common.js";

export function registerSeasonStats(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_season_stats",
    {
      title: "Season Stats",
      description:
        "Season-by-season career breakdown. Shows stats per season for a player. Use for 'Kohli's Test average year by year' or 'Bumrah's IPL economy by season'.",
      inputSchema: {
        player_name: z
          .string()
          .min(2)
          .describe("Player name to search for (partial match supported)."),
        perspective: z
          .enum(["batting", "bowling"])
          .describe("Batting or bowling stats."),
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
          .enum(["season", "runs", "average", "wickets"])
          .default("season")
          .describe("Sort metric."),
      },
    },
    async (args) => {
      const { player_name, perspective, sort_by, ...filters } = args;

      const { whereClauses, params } = buildMatchFilter(filters);
      params.player_name = player_name;

      if (perspective === "batting") {
        whereClauses.push("d.batter ILIKE '%' || $player_name || '%'");
        const filterStr = buildWhereString(whereClauses);

        const orderBy = {
          season: "season ASC",
          runs: "runs DESC",
          average: "average DESC NULLS LAST",
          wickets: "runs DESC",
        }[sort_by];

        const sql = `
          WITH innings_scores AS (
            SELECT
              d.batter AS player_name,
              d.batter_id AS player_id,
              m.season,
              d.match_id,
              d.innings_number,
              SUM(d.runs_batter) AS innings_runs,
              COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE 1=1
              ${filterStr}
            GROUP BY d.batter, d.batter_id, m.season, d.match_id, d.innings_number
          )
          SELECT
            player_name,
            player_id,
            season,
            COUNT(DISTINCT match_id) AS matches,
            COUNT(*) AS innings,
            SUM(innings_runs) AS runs,
            SUM(innings_balls) AS balls_faced,
            MAX(innings_runs) AS highest_score,
            SUM(was_dismissed) AS dismissals,
            COUNT(*) FILTER (WHERE innings_runs >= 100) AS centuries,
            COUNT(*) FILTER (WHERE innings_runs >= 50 AND innings_runs < 100) AS fifties,
            ROUND(
              CASE WHEN SUM(was_dismissed) > 0
                THEN SUM(innings_runs)::DOUBLE / SUM(was_dismissed)
                ELSE NULL END, 2
            ) AS average,
            ROUND(
              CASE WHEN SUM(innings_balls) > 0
                THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
                ELSE NULL END, 2
            ) AS strike_rate
          FROM innings_scores
          GROUP BY player_name, player_id, season
          ORDER BY ${orderBy}
        `;

        const rows = await runQuery(db, sql, params);
        return {
          content: [
            {
              type: "text" as const,
              text:
                rows.length === 0
                  ? `No batting stats found for "${player_name}" with the given filters.`
                  : JSON.stringify(rows, null, 2),
            },
          ],
        };
      } else {
        // Bowling perspective
        whereClauses.push("d.bowler ILIKE '%' || $player_name || '%'");
        const filterStr = buildWhereString(whereClauses);

        const orderBy = {
          season: "season ASC",
          runs: "wickets DESC",
          average: "average ASC NULLS LAST",
          wickets: "wickets DESC",
        }[sort_by];

        const sql = `
          WITH bowling_innings AS (
            SELECT
              d.bowler AS player_name,
              d.bowler_id AS player_id,
              m.season,
              d.match_id,
              d.innings_number,
              COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
              SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
              COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE 1=1
              ${filterStr}
            GROUP BY d.bowler, d.bowler_id, m.season, d.match_id, d.innings_number
          )
          SELECT
            player_name,
            player_id,
            season,
            COUNT(DISTINCT match_id) AS matches,
            COUNT(*) AS innings,
            SUM(legal_balls) AS balls_bowled,
            CAST(SUM(legal_balls) / 6 AS VARCHAR) || '.' || CAST(SUM(legal_balls) % 6 AS VARCHAR) AS overs,
            SUM(runs_conceded) AS runs_conceded,
            SUM(wickets) AS wickets,
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
            ) AS bowling_strike_rate
          FROM bowling_innings
          GROUP BY player_name, player_id, season
          ORDER BY ${orderBy}
        `;

        const rows = await runQuery(db, sql, params);
        return {
          content: [
            {
              type: "text" as const,
              text:
                rows.length === 0
                  ? `No bowling stats found for "${player_name}" with the given filters.`
                  : JSON.stringify(rows, null, 2),
            },
          ],
        };
      }
    }
  );
}
