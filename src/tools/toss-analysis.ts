import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import {
  MatchFilterSchema,
  buildMatchFilter,
  buildWhereString,
} from "../queries/common.js";

export function registerTossAnalysis(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_toss_analysis",
    {
      title: "Toss Analysis",
      description:
        "Analyze toss impact on match outcomes. Win % batting first vs chasing, by venue, team, or format. Use for 'Should you bat first at Wankhede?' or 'Does the toss matter in T20s?'.",
      inputSchema: {
        venue: MatchFilterSchema.shape.venue,
        team: MatchFilterSchema.shape.team,
        match_type: MatchFilterSchema.shape.match_type,
        event_name: MatchFilterSchema.shape.event_name,
        season: MatchFilterSchema.shape.season,
        gender: MatchFilterSchema.shape.gender,
        date_from: MatchFilterSchema.shape.date_from,
        date_to: MatchFilterSchema.shape.date_to,
        group_by: z
          .enum(["venue", "team", "match_type", "season"])
          .optional()
          .describe("Group results by this dimension. Omit for overall aggregate."),
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
      const { group_by, limit, ...filters } = args;
      const { whereClauses, params } = buildMatchFilter(filters);
      params.limit = limit;

      // Exclude matches without a decisive result
      whereClauses.push("m.outcome_winner IS NOT NULL");

      const filterStr = buildWhereString(whereClauses);

      const groupCol = group_by
        ? group_by === "team" ? "m.toss_winner" : `m.${group_by}`
        : null;

      const selectGroup = groupCol ? `${groupCol} AS group_key,` : "";
      const groupByClause = groupCol ? `GROUP BY ${groupCol}` : "";
      const orderByClause = groupCol
        ? "ORDER BY total_matches DESC"
        : "";

      const sql = `
        SELECT
          ${selectGroup}
          COUNT(*) AS total_matches,
          COUNT(*) FILTER (WHERE m.toss_winner = m.outcome_winner) AS toss_winner_wins,
          ROUND(
            COUNT(*) FILTER (WHERE m.toss_winner = m.outcome_winner)::DOUBLE / COUNT(*) * 100, 1
          ) AS toss_winner_win_pct,
          COUNT(*) FILTER (WHERE m.toss_decision = 'bat') AS chose_bat,
          COUNT(*) FILTER (WHERE m.toss_decision = 'field') AS chose_field,
          ROUND(
            COUNT(*) FILTER (WHERE m.toss_decision = 'bat' AND m.toss_winner = m.outcome_winner)::DOUBLE /
            NULLIF(COUNT(*) FILTER (WHERE m.toss_decision = 'bat'), 0) * 100, 1
          ) AS bat_first_win_pct_after_toss,
          ROUND(
            COUNT(*) FILTER (WHERE m.toss_decision = 'field' AND m.toss_winner = m.outcome_winner)::DOUBLE /
            NULLIF(COUNT(*) FILTER (WHERE m.toss_decision = 'field'), 0) * 100, 1
          ) AS field_first_win_pct_after_toss,
          -- Overall bat first vs chase win %
          COUNT(*) FILTER (WHERE
            (m.toss_decision = 'bat' AND m.toss_winner = m.outcome_winner) OR
            (m.toss_decision = 'field' AND m.toss_winner != m.outcome_winner)
          ) AS bat_first_wins,
          ROUND(
            COUNT(*) FILTER (WHERE
              (m.toss_decision = 'bat' AND m.toss_winner = m.outcome_winner) OR
              (m.toss_decision = 'field' AND m.toss_winner != m.outcome_winner)
            )::DOUBLE / COUNT(*) * 100, 1
          ) AS bat_first_win_pct
        FROM matches m
        WHERE 1=1
          ${filterStr}
        ${groupByClause}
        ${orderByClause}
        LIMIT $limit
      `;

      const rows = await runQuery(db, sql, params);
      return {
        content: [{
          type: "text" as const,
          text: rows.length === 0
            ? "No toss data found with the given filters."
            : JSON.stringify(rows, null, 2),
        }],
      };
    }
  );
}
