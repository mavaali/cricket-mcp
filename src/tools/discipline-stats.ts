import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import {
  MatchFilterSchema,
  buildMatchFilter,
  buildWhereString,
  PHASE_OVERS,
} from "../queries/common.js";


export function registerDisciplineStats(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_discipline_stats",
    {
      title: "Discipline Stats",
      description:
        "Who bowls the most dot balls / fewest wides / least boundaries? Discipline metrics: dot ball %, wide/no-ball rates, extras per over, boundary % allowed (bowling); dot ball % faced, boundary % (batting). " +
        "Use for 'Most economical death bowlers in IPL', 'Which bowlers give the fewest extras?', or 'Batters with highest boundary % in T20s'. " +
        "Not for standard bowling figures (use get_bowling_records) or phase-specific stats (use get_phase_stats).",
      inputSchema: {
        perspective: z
          .enum(["batting", "bowling"])
          .describe("Batting or bowling discipline stats."),
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
        phase: z
          .enum(["powerplay", "middle", "death"])
          .optional()
          .describe("Optional phase filter."),
        sort_by: z
          .enum(["dot_ball_pct", "extras_rate", "boundary_pct", "wide_rate"])
          .default("dot_ball_pct")
          .describe("Sort metric."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results."),
        min_balls: z
          .number()
          .int()
          .min(1)
          .default(100)
          .describe("Minimum balls for qualification."),
      },
    },
    async (args) => {
      const {
        perspective,
        player_name,
        phase,
        sort_by,
        limit,
        min_balls,
        ...filters
      } = args;

      const { whereClauses, params } = buildMatchFilter(filters);
      params.limit = limit;
      params.min_balls = min_balls;

      if (phase) {
        const [from, to] = PHASE_OVERS[phase];
        params.phase_from = from;
        params.phase_to = to;
        whereClauses.push("d.over_number >= $phase_from AND d.over_number <= $phase_to");
      }

      if (player_name) {
        const col = perspective === "batting" ? "d.batter" : "d.bowler";
        whereClauses.push(`${col} ILIKE '%' || $player_name || '%'`);
        params.player_name = player_name;
      }

      const filterStr = buildWhereString(whereClauses);

      if (perspective === "bowling") {
        const orderBy = {
          dot_ball_pct: "dot_ball_pct DESC NULLS LAST",
          extras_rate: "extras_per_over ASC NULLS LAST",
          boundary_pct: "boundary_pct ASC NULLS LAST",
          wide_rate: "wide_pct ASC NULLS LAST",
        }[sort_by];

        const sql = `
          SELECT
            d.bowler AS player_name,
            d.bowler_id AS player_id,
            COUNT(DISTINCT d.match_id) AS matches,
            COUNT(*) AS total_deliveries,
            COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
            SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
            COUNT(*) FILTER (WHERE d.runs_total = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0) AS dot_balls,
            SUM(d.extras_wides) AS total_wides,
            SUM(d.extras_noballs) AS total_noballs,
            SUM(d.extras_wides + d.extras_noballs) AS total_extras_given,
            COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS fours_conceded,
            COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS sixes_conceded,
            ROUND(
              COUNT(*) FILTER (WHERE d.runs_total = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0)::DOUBLE /
              NULLIF(COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0), 0) * 100, 2
            ) AS dot_ball_pct,
            ROUND(
              SUM(d.extras_wides)::DOUBLE /
              NULLIF(COUNT(*), 0) * 100, 2
            ) AS wide_pct,
            ROUND(
              SUM(d.extras_noballs)::DOUBLE /
              NULLIF(COUNT(*), 0) * 100, 2
            ) AS noball_pct,
            ROUND(
              SUM(d.extras_wides + d.extras_noballs)::DOUBLE /
              (COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0)::DOUBLE / 6), 2
            ) AS extras_per_over,
            ROUND(
              (COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) +
               COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary))::DOUBLE /
              NULLIF(COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0), 0) * 100, 2
            ) AS boundary_pct
          FROM deliveries d
          JOIN matches m ON d.match_id = m.match_id
          WHERE 1=1
            ${filterStr}
          GROUP BY d.bowler, d.bowler_id
          HAVING COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) >= $min_balls
          ORDER BY ${orderBy}
          LIMIT $limit
        `;

        const rows = await runQuery(db, sql, params);
        return {
          content: [{
            type: "text" as const,
            text: rows.length === 0
              ? "No discipline stats found with the given filters."
              : JSON.stringify(rows, null, 2),
          }],
        };
      } else {
        // Batting discipline
        const orderBy = {
          dot_ball_pct: "dot_ball_pct ASC NULLS LAST",
          extras_rate: "dot_ball_pct ASC NULLS LAST",
          boundary_pct: "boundary_pct DESC NULLS LAST",
          wide_rate: "dot_ball_pct ASC NULLS LAST",
        }[sort_by];

        const sql = `
          SELECT
            d.batter AS player_name,
            d.batter_id AS player_id,
            COUNT(DISTINCT d.match_id) AS matches,
            COUNT(*) FILTER (WHERE d.extras_wides = 0) AS balls_faced,
            SUM(d.runs_batter) AS runs,
            COUNT(*) FILTER (WHERE d.runs_batter = 0 AND d.extras_wides = 0) AS dot_balls,
            COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS fours,
            COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS sixes,
            ROUND(
              COUNT(*) FILTER (WHERE d.runs_batter = 0 AND d.extras_wides = 0)::DOUBLE /
              NULLIF(COUNT(*) FILTER (WHERE d.extras_wides = 0), 0) * 100, 2
            ) AS dot_ball_pct,
            ROUND(
              (COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) +
               COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary))::DOUBLE /
              NULLIF(COUNT(*) FILTER (WHERE d.extras_wides = 0), 0) * 100, 2
            ) AS boundary_pct,
            ROUND(
              SUM(d.runs_batter)::DOUBLE /
              NULLIF(COUNT(*) FILTER (WHERE d.extras_wides = 0), 0) * 100, 2
            ) AS strike_rate
          FROM deliveries d
          JOIN matches m ON d.match_id = m.match_id
          WHERE 1=1
            ${filterStr}
          GROUP BY d.batter, d.batter_id
          HAVING COUNT(*) FILTER (WHERE d.extras_wides = 0) >= $min_balls
          ORDER BY ${orderBy}
          LIMIT $limit
        `;

        const rows = await runQuery(db, sql, params);
        return {
          content: [{
            type: "text" as const,
            text: rows.length === 0
              ? "No discipline stats found with the given filters."
              : JSON.stringify(rows, null, 2),
          }],
        };
      }
    }
  );
}
