import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema, buildMatchFilter, buildWhereString } from "../queries/common.js";

export function registerPartnerships(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_partnerships",
    {
      title: "Partnership Records",
      description:
        "Get batting partnership records. Find the highest partnerships by runs, optionally filtered by player, format, team, venue, and more.",
      inputSchema: {
        player_name: z
          .string()
          .optional()
          .describe("Filter partnerships involving this player (partial match)."),
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
      const { player_name, min_runs, limit, ...filters } = args;
      const { whereClauses, params } = buildMatchFilter(filters);
      params.min_runs = min_runs;
      params.limit = limit;

      if (player_name) {
        whereClauses.push(
          "(d.batter ILIKE '%' || $player_name || '%' OR d.non_striker ILIKE '%' || $player_name || '%')"
        );
        params.player_name = player_name;
      }

      const filterStr = buildWhereString(whereClauses);

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
          WHERE 1=1
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
        LIMIT $limit
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
