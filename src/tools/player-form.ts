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

export function registerPlayerForm(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_player_form",
    {
      title: "Player Form",
      description:
        "How has this player been performing recently? Returns the last N innings with individual scores, strike rates, opposition, venue, and dismissal info. " +
        "Includes a form summary (runs, average, strike rate over the window). " +
        "Use for 'Salt\\'s last 10 T20 innings', 'Is Kohli in form?', or 'Bumrah\\'s recent bowling figures'. " +
        "Not for career aggregates (use get_player_stats) or season-by-season trends (use get_season_stats).",
      inputSchema: {
        player_name: z
          .string()
          .min(2)
          .describe("Player name (partial match supported)."),
        perspective: z
          .enum(["batting", "bowling"])
          .describe("Batting or bowling form."),
        last_n_innings: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of recent innings to return (default 10)."),
        match_type: MatchFilterSchema.shape.match_type,
        gender: MatchFilterSchema.shape.gender,
        team: MatchFilterSchema.shape.team,
        opposition: MatchFilterSchema.shape.opposition,
        venue: MatchFilterSchema.shape.venue,
        event_name: MatchFilterSchema.shape.event_name,
      },
    },
    async (args) => {
      const { player_name, perspective, last_n_innings, ...filters } = args;

      const { whereClauses, params } = buildMatchFilter(filters);
      params.player_name = player_name;
      params.limit = last_n_innings;

      if (perspective === "batting") {
        whereClauses.push("d.batter ILIKE '%' || $player_name || '%'");
        const filterStr = buildWhereString(whereClauses);

        const sql = `
          WITH batting_innings AS (
            SELECT
              d.batter AS player_name,
              d.batter_id AS player_id,
              d.match_id,
              d.innings_number,
              m.date_start,
              m.match_type,
              m.venue,
              m.event_name,
              COALESCE(
                (SELECT i.bowling_team FROM innings i
                 WHERE i.match_id = d.match_id AND i.innings_number = d.innings_number),
                'Unknown'
              ) AS opposition,
              SUM(d.runs_batter) AS runs,
              COUNT(*) FILTER (WHERE d.extras_wides = 0) AS balls,
              COUNT(*) FILTER (WHERE d.runs_batter = 4 AND d.runs_non_boundary = FALSE) AS fours,
              COUNT(*) FILTER (WHERE d.runs_batter = 6) AS sixes,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN d.wicket_kind ELSE NULL END) AS how_out,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN d.bowler ELSE NULL END) AS dismissed_by
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE 1=1
              ${filterStr}
            GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number,
                     m.date_start, m.match_type, m.venue, m.event_name
            ORDER BY m.date_start DESC, d.match_id DESC, d.innings_number DESC
            LIMIT $limit
          )
          SELECT
            player_name,
            player_id,
            date_start,
            match_type,
            opposition,
            venue,
            event_name,
            runs,
            balls,
            fours,
            sixes,
            ROUND(
              CASE WHEN balls > 0 THEN runs::DOUBLE / balls * 100 ELSE NULL END, 2
            ) AS strike_rate,
            CASE WHEN was_dismissed = 1 THEN how_out ELSE 'not out' END AS dismissal,
            CASE WHEN was_dismissed = 1 THEN dismissed_by ELSE NULL END AS dismissed_by
          FROM batting_innings
          ORDER BY date_start DESC, match_id DESC
        `;

        const rows = await runQuery(db, sql, params);

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No recent batting innings found for "${player_name}" with the given filters.`,
              },
            ],
          };
        }

        // Compute summary
        const totalRuns = rows.reduce(
          (s, r) => s + Number(r.runs ?? 0),
          0
        );
        const totalBalls = rows.reduce(
          (s, r) => s + Number(r.balls ?? 0),
          0
        );
        const dismissals = rows.filter(
          (r) => r.dismissal !== "not out"
        ).length;
        const avg =
          dismissals > 0
            ? Math.round((totalRuns / dismissals) * 100) / 100
            : null;
        const sr =
          totalBalls > 0
            ? Math.round((totalRuns / totalBalls) * 100 * 100) / 100
            : null;

        const result = {
          summary: {
            innings: rows.length,
            runs: totalRuns,
            dismissals,
            average: avg,
            strike_rate: sr,
            highest: Math.max(...rows.map((r) => Number(r.runs ?? 0))),
            lowest: Math.min(...rows.map((r) => Number(r.runs ?? 0))),
          },
          innings: rows,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } else {
        // Bowling perspective
        whereClauses.push("d.bowler ILIKE '%' || $player_name || '%'");
        const filterStr = buildWhereString(whereClauses);

        const sql = `
          WITH bowling_innings AS (
            SELECT
              d.bowler AS player_name,
              d.bowler_id AS player_id,
              d.match_id,
              d.innings_number,
              m.date_start,
              m.match_type,
              m.venue,
              m.event_name,
              COALESCE(
                (SELECT i.batting_team FROM innings i
                 WHERE i.match_id = d.match_id AND i.innings_number = d.innings_number),
                'Unknown'
              ) AS opposition,
              COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
              SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
              COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets,
              COUNT(*) FILTER (WHERE d.runs_batter = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0) AS dot_balls
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE 1=1
              ${filterStr}
            GROUP BY d.bowler, d.bowler_id, d.match_id, d.innings_number,
                     m.date_start, m.match_type, m.venue, m.event_name
            ORDER BY m.date_start DESC, d.match_id DESC, d.innings_number DESC
            LIMIT $limit
          )
          SELECT
            player_name,
            player_id,
            date_start,
            match_type,
            opposition,
            venue,
            event_name,
            CAST(legal_balls / 6 AS VARCHAR) || '.' || CAST(legal_balls % 6 AS VARCHAR) AS overs,
            runs_conceded,
            wickets,
            dot_balls,
            ROUND(
              CASE WHEN legal_balls > 0
                THEN runs_conceded::DOUBLE / (legal_balls::DOUBLE / 6)
                ELSE NULL END, 2
            ) AS economy,
            CAST(wickets AS VARCHAR) || '/' || CAST(runs_conceded AS VARCHAR) AS figures
          FROM bowling_innings
          ORDER BY date_start DESC, match_id DESC
        `;

        const rows = await runQuery(db, sql, params);

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No recent bowling innings found for "${player_name}" with the given filters.`,
              },
            ],
          };
        }

        const totalWickets = rows.reduce(
          (s, r) => s + Number(r.wickets ?? 0),
          0
        );
        const totalRunsConceded = rows.reduce(
          (s, r) => s + Number(r.runs_conceded ?? 0),
          0
        );
        // Parse overs string to get total balls for economy
        const totalBalls = rows.reduce((s, r) => {
          const parts = String(r.overs ?? "0.0").split(".");
          return s + Number(parts[0]) * 6 + Number(parts[1] ?? 0);
        }, 0);
        const econ =
          totalBalls > 0
            ? Math.round(
                (totalRunsConceded / (totalBalls / 6)) * 100
              ) / 100
            : null;
        const avg =
          totalWickets > 0
            ? Math.round((totalRunsConceded / totalWickets) * 100) / 100
            : null;

        const result = {
          summary: {
            innings: rows.length,
            wickets: totalWickets,
            runs_conceded: totalRunsConceded,
            average: avg,
            economy: econ,
            best: rows.reduce(
              (best: { w: number; rc: number; fig: string }, r) => {
                const w = Number(r.wickets ?? 0);
                const rc = Number(r.runs_conceded ?? 0);
                if (w > best.w || (w === best.w && rc < best.rc))
                  return { w, rc, fig: String(r.figures) };
                return best;
              },
              { w: 0, rc: 999, fig: "0/0" }
            ).fig,
          },
          innings: rows,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    }
  );
}
