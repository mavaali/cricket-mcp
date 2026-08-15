import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import {
  MatchFilterSchema,
  buildMatchFilter,
  buildAndClause,
} from "../queries/common.js";

export function registerSuperOvers(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_super_overs",
    {
      title: "Super Over History",
      description:
        "Which matches went to a super over, and who won them? Lists super-over matches with per-team super-over scores " +
        "(including double super overs), the match winner, and an aggregate super-over win/loss record per team. " +
        "Use for 'All IPL super overs', 'Has India ever lost a super over?', or 'Super over history at the T20 World Cup'. " +
        "Not for regular tied matches with no super over (use get_team_records with tied_matches).",
      inputSchema: {
        ...MatchFilterSchema.shape,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Number of most recent super-over matches to list (aggregate record covers all matches)."),
      },
    },
    async (args) => {
      const { limit, ...filters } = args;
      const { whereClauses, params } = buildMatchFilter(filters);
      const filterStr = buildAndClause(whereClauses);

      const sql = `
        WITH so_scores AS (
          SELECT
            i.match_id,
            i.innings_number,
            i.batting_team,
            SUM(d.runs_total) AS runs,
            COUNT(*) FILTER (WHERE d.is_wicket) AS wickets
          FROM innings i
          JOIN deliveries d
            ON d.match_id = i.match_id AND d.innings_number = i.innings_number
          WHERE i.is_super_over
          GROUP BY i.match_id, i.innings_number, i.batting_team
        )
        SELECT
          m.match_id,
          m.date_start AS date,
          m.venue,
          m.event_name,
          m.event_stage,
          m.match_type,
          m.gender,
          m.team1,
          m.team2,
          m.outcome_winner AS winner,
          s.innings_number,
          s.batting_team,
          s.runs,
          s.wickets
        FROM so_scores s
        JOIN matches m ON m.match_id = s.match_id
        WHERE TRUE
          ${filterStr}
        ORDER BY m.date_start DESC, s.match_id, s.innings_number
      `;

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No super overs found with the given filters.",
            },
          ],
        };
      }

      // Group per-innings rows into one entry per match.
      interface SoMatch {
        match_id: unknown;
        date: unknown;
        venue: unknown;
        event_name: unknown;
        event_stage: unknown;
        match_type: unknown;
        gender: unknown;
        team1: unknown;
        team2: unknown;
        winner: unknown;
        super_over_scores: {
          innings_number: unknown;
          batting_team: unknown;
          runs: unknown;
          wickets: unknown;
        }[];
      }
      const matches = new Map<string, SoMatch>();
      for (const r of rows) {
        const id = String(r.match_id);
        if (!matches.has(id)) {
          matches.set(id, {
            match_id: r.match_id,
            date: r.date,
            venue: r.venue,
            event_name: r.event_name,
            event_stage: r.event_stage,
            match_type: r.match_type,
            gender: r.gender,
            team1: r.team1,
            team2: r.team2,
            winner: r.winner,
            super_over_scores: [],
          });
        }
        matches.get(id)!.super_over_scores.push({
          innings_number: r.innings_number,
          batting_team: r.batting_team,
          runs: r.runs,
          wickets: r.wickets,
        });
      }

      const allMatches = [...matches.values()];

      // Aggregate super-over match W/L per team, across ALL matching matches.
      const record = new Map<string, { won: number; lost: number }>();
      for (const sm of allMatches) {
        for (const team of [String(sm.team1), String(sm.team2)]) {
          if (!record.has(team)) record.set(team, { won: 0, lost: 0 });
          if (sm.winner === null || sm.winner === undefined) continue;
          if (String(sm.winner) === team) record.get(team)!.won++;
          else record.get(team)!.lost++;
        }
      }
      const teamRecords = [...record.entries()]
        .map(([team, r]) => ({ team, ...r, played: r.won + r.lost }))
        .filter((r) => r.played > 0)
        .sort((a, b) => b.won - a.won || a.lost - b.lost);

      const result = {
        total_super_over_matches: allMatches.length,
        matches: allMatches.slice(0, limit),
        team_super_over_records: teamRecords,
        note:
          allMatches.length > limit
            ? `Showing ${limit} most recent of ${allMatches.length} super-over matches; team records cover all of them.`
            : undefined,
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
