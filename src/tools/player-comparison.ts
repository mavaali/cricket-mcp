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

export function registerPlayerComparison(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_player_comparison",
    {
      title: "Player Comparison",
      description:
        "How do two players compare? Side-by-side batting or bowling stats for two players under the same filters. " +
        "Use for 'Kohli vs Root in Tests since 2020', 'Bumrah vs Starc in ODIs', or 'Warner vs Babar in T20 World Cups'. " +
        "Not for individual player stats (use get_player_stats) or batter-vs-bowler matchup (use get_matchup).",
      inputSchema: {
        player1_name: z
          .string()
          .min(2)
          .describe("First player name (partial match supported)."),
        player2_name: z
          .string()
          .min(2)
          .describe("Second player name (partial match supported)."),
        perspective: z
          .enum(["batting", "bowling"])
          .describe("Batting or bowling comparison."),
        match_type: MatchFilterSchema.shape.match_type,
        gender: MatchFilterSchema.shape.gender,
        team: MatchFilterSchema.shape.team,
        opposition: MatchFilterSchema.shape.opposition,
        venue: MatchFilterSchema.shape.venue,
        season: MatchFilterSchema.shape.season,
        event_name: MatchFilterSchema.shape.event_name,
        date_from: MatchFilterSchema.shape.date_from,
        date_to: MatchFilterSchema.shape.date_to,
      },
    },
    async (args) => {
      const { player1_name, player2_name, perspective, ...filters } = args;

      const { whereClauses, params } = buildMatchFilter(filters);
      params.player1 = player1_name;
      params.player2 = player2_name;

      if (perspective === "batting") {
        whereClauses.push(
          "(d.batter ILIKE '%' || $player1 || '%' OR d.batter ILIKE '%' || $player2 || '%')"
        );
        const filterStr = buildWhereString(whereClauses);

        const sql = `
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
            GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
          )
          SELECT
            player_name,
            player_id,
            COUNT(DISTINCT match_id) AS matches,
            COUNT(*) AS innings,
            SUM(innings_runs) AS runs,
            SUM(innings_balls) AS balls_faced,
            MAX(innings_runs) AS highest_score,
            SUM(innings_fours) AS fours,
            SUM(innings_sixes) AS sixes,
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
          GROUP BY player_name, player_id
          ORDER BY player_name
        `;

        const rows = await runQuery(db, sql, params);

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No batting stats found for "${player1_name}" or "${player2_name}" with the given filters.`,
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
      } else {
        // Bowling perspective
        whereClauses.push(
          "(d.bowler ILIKE '%' || $player1 || '%' OR d.bowler ILIKE '%' || $player2 || '%')"
        );
        const filterStr = buildWhereString(whereClauses);

        const sql = `
          WITH bowling_innings AS (
            SELECT
              d.bowler AS player_name,
              d.bowler_id AS player_id,
              d.match_id,
              d.innings_number,
              COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
              SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
              COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets,
              COUNT(*) FILTER (WHERE d.runs_total = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0) AS dots
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
          GROUP BY player_name, player_id
          ORDER BY player_name
        `;

        const rows = await runQuery(db, sql, params);

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No bowling stats found for "${player1_name}" or "${player2_name}" with the given filters.`,
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
    }
  );
}
