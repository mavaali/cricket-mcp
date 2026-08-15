import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema, buildMatchFilter, buildWhereClause } from "../queries/common.js";

export function registerPartnerships(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_partnerships",
    {
      title: "Partnership Records",
      description:
        "What are the biggest batting partnerships? Highest partnerships by total runs, showing both batters, runs, balls, venue, and match context. " +
        "With both player_name and player2_name, focuses on that specific pair; with aggregate=true, returns career pair summaries " +
        "(stands together, total runs, average stand, highest, 50+/100+ stand counts) instead of individual stands. " +
        "Use for 'Biggest opening stands in Tests', 'Kohli and Rohit batting together in ODIs', or 'Most prolific partnership pairs in IPL history'. " +
        "Not for individual batting records (use get_batting_records) or batter-vs-bowler matchups (use get_matchup).",
      inputSchema: {
        player_name: z
          .string()
          .optional()
          .describe("Filter partnerships involving this player (partial match)."),
        player2_name: z
          .string()
          .optional()
          .describe(
            "Second player — with player_name, restricts to stands between this specific pair (partial match)."
          ),
        aggregate: z
          .boolean()
          .default(false)
          .describe(
            "Return career pair summaries (stands, total runs, avg stand, highest, 50+/100+ counts) instead of individual stands."
          ),
        ...MatchFilterSchema.shape,
        min_runs: z
          .number()
          .int()
          .default(50)
          .describe("Minimum partnership runs to include."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of results to return."),
      },
    },
    async (args) => {
      const { player_name, player2_name, aggregate, min_runs, limit, ...filters } =
        args;
      const { whereClauses, params } = buildMatchFilter(filters);
      // Aggregate mode summarizes every stand a pair had, so the per-stand
      // run floor only applies when listing individual stands.
      if (!aggregate) {
        params.min_runs = min_runs;
      }
      params.limit = limit;

      if (player_name) {
        whereClauses.push(
          "(d.batter ILIKE '%' || $player_name || '%' OR d.non_striker ILIKE '%' || $player_name || '%')"
        );
        params.player_name = player_name;
      }
      if (player2_name) {
        whereClauses.push(
          "(d.batter ILIKE '%' || $player2_name || '%' OR d.non_striker ILIKE '%' || $player2_name || '%')"
        );
        params.player2_name = player2_name;
      }

      const filterStr = buildWhereClause(whereClauses);

      const finalSelect = aggregate
        ? `
        SELECT
          pair_a,
          pair_b,
          COUNT(*) AS stands,
          SUM(partnership_runs) AS total_runs,
          ROUND(AVG(partnership_runs), 2) AS avg_stand,
          MAX(partnership_runs) AS highest,
          COUNT(*) FILTER (WHERE partnership_runs >= 50) AS fifty_plus_stands,
          COUNT(*) FILTER (WHERE partnership_runs >= 100) AS hundred_plus_stands
        FROM partnerships
        GROUP BY pair_a, pair_b
        ORDER BY total_runs DESC
        LIMIT $limit`
        : `
        SELECT
          pair_a,
          pair_b,
          partnership_runs,
          partnership_balls,
          match_id,
          innings_number,
          venue,
          date,
          match_type,
          event_name
        FROM partnerships
        WHERE partnership_runs >= $min_runs
        ORDER BY partnership_runs DESC
        LIMIT $limit`;

      const sql = `
        WITH batting_pairs AS (
          SELECT
            d.match_id,
            d.innings_number,
            LEAST(d.batter, d.non_striker) AS pair_a,
            GREATEST(d.batter, d.non_striker) AS pair_b,
            d.runs_total,
            d.extras_wides,
            m.venue,
            m.date_start,
            m.match_type,
            m.event_name
          FROM deliveries d
          JOIN matches m ON d.match_id = m.match_id
          ${filterStr}
        ),
        partnerships AS (
          SELECT
            match_id,
            innings_number,
            pair_a,
            pair_b,
            SUM(runs_total) AS partnership_runs,
            COUNT(*) FILTER (WHERE extras_wides = 0) AS partnership_balls,
            MIN(venue) AS venue,
            MIN(date_start) AS date,
            MIN(match_type) AS match_type,
            MIN(event_name) AS event_name
          FROM batting_pairs
          GROUP BY match_id, innings_number, pair_a, pair_b
        )
        ${finalSelect}
      `;

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No partnerships found with the given filters.",
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
  );
}
