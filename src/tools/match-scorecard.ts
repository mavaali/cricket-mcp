import { BAT, BOWL } from "../queries/innings.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { BOWLING_WICKET_KINDS } from "../queries/common.js";

export function registerMatchScorecard(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_match_scorecard",
    {
      title: "Match Scorecard",
      description:
        "Show me the full scorecard of a match. Complete batting and bowling cards with runs, balls, fours, sixes, strike rate, dismissals, bowling figures, extras, and totals per innings. " +
        "Use for 'Scorecard of the 2023 World Cup final', 'What did Kohli score in that match?', or 'Bowling figures from match 1417867'. " +
        "Requires match_id -- use search_matches first to find it. Not for aggregated stats across matches (use get_player_stats).",
      inputSchema: {
        match_id: z.string().describe("Cricsheet match ID (e.g., '1417867')."),
      },
    },
    async (args) => {
      // Match info
      const matchInfo = await runQuery(db, `
        SELECT * FROM matches WHERE match_id = $match_id
      `, { match_id: args.match_id });

      if (matchInfo.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No match found with ID "${args.match_id}".`,
          }],
        };
      }

      // Get innings
      const innings = await runQuery(db, `
        SELECT * FROM innings WHERE match_id = $match_id ORDER BY innings_number
      `, { match_id: args.match_id });

      const scorecard: Record<string, unknown> = {
        match: matchInfo[0],
        innings: [],
      };

      for (const inn of innings) {
        const inningsNum = inn.innings_number as number;

        // Batting card
        const batting = await runQuery(db, `
          SELECT
            d.batter AS player_name,
            SUM(d.runs_batter) AS runs,
            ${BAT.ballsFaced} AS balls,
            ${BAT.fours} AS fours,
            ${BAT.sixes} AS sixes,
            ROUND(
              CASE WHEN ${BAT.ballsFaced} > 0
              THEN SUM(d.runs_batter)::DOUBLE / ${BAT.ballsFaced} * 100
              ELSE 0 END, 2
            ) AS strike_rate,
            -- Dismissal: a batter is out at most once per innings, but pull all
            -- three fields from the SAME delivery row (arg_max on a stable ball
            -- key) so they can never tear across rows if the data ever carries
            -- more than one dismissal row for a batter (e.g. a multi-wicket ball).
            arg_max(d.wicket_kind, d.over_number * 100 + d.ball_number)
              FILTER (WHERE d.is_wicket AND d.wicket_player_out = d.batter) AS dismissal,
            arg_max(d.wicket_fielder1, d.over_number * 100 + d.ball_number)
              FILTER (WHERE d.is_wicket AND d.wicket_player_out = d.batter) AS fielder,
            arg_max(d.bowler, d.over_number * 100 + d.ball_number)
              FILTER (WHERE d.is_wicket AND d.wicket_player_out = d.batter) AS dismissed_by
          FROM deliveries d
          WHERE d.match_id = $match_id AND d.innings_number = $innings
          GROUP BY d.batter
          ORDER BY MIN(d.over_number * 100 + d.ball_number)
        `, { match_id: args.match_id, innings: inningsNum });

        // Bowling card
        const bowling = await runQuery(db, `
          WITH bowler_overs AS (
            SELECT
              d.bowler,
              d.over_number,
              ${BOWL.runsConceded} AS over_runs,
              ${BOWL.legalBalls} AS legal_balls
            FROM deliveries d
            WHERE d.match_id = $match_id AND d.innings_number = $innings
            GROUP BY d.bowler, d.over_number
          )
          SELECT
            d.bowler AS player_name,
            CAST(SUM(CASE WHEN d.extras_wides = 0 AND d.extras_noballs = 0 THEN 1 ELSE 0 END) / 6 AS VARCHAR)
              || '.' ||
              CAST(SUM(CASE WHEN d.extras_wides = 0 AND d.extras_noballs = 0 THEN 1 ELSE 0 END) % 6 AS VARCHAR)
              AS overs,
            (SELECT COUNT(*) FROM bowler_overs bo WHERE bo.bowler = d.bowler AND bo.over_runs = 0
              AND bo.legal_balls >= 6) AS maidens,
            ${BOWL.runsConceded} AS runs,
            ${BOWL.wickets} AS wickets,
            ROUND(
              CASE WHEN SUM(CASE WHEN d.extras_wides = 0 AND d.extras_noballs = 0 THEN 1 ELSE 0 END) > 0
              THEN ${BOWL.runsConceded}::DOUBLE /
                (SUM(CASE WHEN d.extras_wides = 0 AND d.extras_noballs = 0 THEN 1 ELSE 0 END)::DOUBLE / 6)
              ELSE NULL END, 2
            ) AS economy
          FROM deliveries d
          WHERE d.match_id = $match_id AND d.innings_number = $innings
          GROUP BY d.bowler
          ORDER BY MIN(d.over_number)
        `, { match_id: args.match_id, innings: inningsNum });

        // Totals and extras
        const totals = await runQuery(db, `
          SELECT
            SUM(d.runs_total) AS total_runs,
            COUNT(*) FILTER (WHERE d.is_wicket) AS total_wickets,
            MAX(d.over_number) + 1 AS overs_played,
            SUM(d.extras_wides) AS wides,
            SUM(d.extras_noballs) AS noballs,
            SUM(d.extras_byes) AS byes,
            SUM(d.extras_legbyes) AS legbyes,
            SUM(d.extras_penalty) AS penalty,
            SUM(d.runs_extras) AS total_extras
          FROM deliveries d
          WHERE d.match_id = $match_id AND d.innings_number = $innings
        `, { match_id: args.match_id, innings: inningsNum });

        (scorecard.innings as unknown[]).push({
          innings_number: inningsNum,
          batting_team: inn.batting_team,
          bowling_team: inn.bowling_team,
          batting: batting,
          bowling: bowling,
          totals: totals[0],
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(scorecard, null, 2),
        }],
      };
    }
  );
}
