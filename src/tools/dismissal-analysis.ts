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

export function registerDismissalAnalysis(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_dismissal_analysis",
    {
      title: "Dismissal Analysis",
      description:
        "Dismissal type breakdown — how a batter gets out (caught, bowled, LBW, etc.) or how a bowler takes wickets. Use for 'How does Kohli get out?' or 'Bumrah's dismissal breakdown in T20s'.",
      inputSchema: {
        player_name: z
          .string()
          .min(2)
          .describe("Player name to analyze (partial match supported)."),
        perspective: z
          .enum(["batting", "bowling"])
          .describe(
            "batting = how this batter gets out, bowling = how this bowler gets wickets."
          ),
        vs_player: z
          .string()
          .optional()
          .describe(
            "Filter to dismissals involving a specific opposition player (partial match)."
          ),
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
      const { player_name, perspective, vs_player, ...filters } = args;

      const { whereClauses, params } = buildMatchFilter(filters);
      params.player_name = player_name;

      whereClauses.push("d.is_wicket = true");
      whereClauses.push("d.wicket_kind IS NOT NULL");

      if (perspective === "batting") {
        whereClauses.push(
          "d.wicket_player_out ILIKE '%' || $player_name || '%'"
        );
        if (vs_player) {
          whereClauses.push("d.bowler ILIKE '%' || $vs_player || '%'");
          params.vs_player = vs_player;
        }
      } else {
        whereClauses.push("d.bowler ILIKE '%' || $player_name || '%'");
        whereClauses.push(
          `d.wicket_kind IN ${BOWLING_WICKET_KINDS}`
        );
        if (vs_player) {
          whereClauses.push(
            "d.wicket_player_out ILIKE '%' || $vs_player || '%'"
          );
          params.vs_player = vs_player;
        }
      }

      const filterStr = buildWhereString(whereClauses);

      const sql = `
        WITH dismissals AS (
          SELECT
            d.wicket_kind AS dismissal_type,
            COUNT(*) AS count
          FROM deliveries d
          JOIN matches m ON d.match_id = m.match_id
          WHERE 1=1
            ${filterStr}
          GROUP BY d.wicket_kind
        ),
        total AS (
          SELECT SUM(count) AS total_dismissals FROM dismissals
        )
        SELECT
          d.dismissal_type,
          d.count,
          ROUND(d.count::DOUBLE / t.total_dismissals * 100, 1) AS percentage
        FROM dismissals d
        CROSS JOIN total t
        ORDER BY d.count DESC
      `;

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No dismissal data found for "${player_name}" with the given filters.`,
            },
          ],
        };
      }

      // Calculate total
      const totalDismissals = rows.reduce(
        (sum, r) => sum + (r.count as number),
        0
      );

      const result = {
        player_name,
        perspective,
        total_dismissals: totalDismissals,
        breakdown: rows,
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
  );
}
