import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";

export function registerInningsProgression(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_innings_progression",
    {
      title: "Innings Progression",
      description:
        "Over-by-over scoring progression for a specific match innings. Shows runs per over, cumulative runs, wickets, run rate. Use for 'Show me the scoring progression of that 438 chase' or 'How did India's innings unfold?'",
      inputSchema: {
        match_id: z
          .string()
          .describe("Cricsheet match ID (e.g., '1417867'). Use search_matches to find it."),
        innings_number: z
          .number()
          .int()
          .min(1)
          .max(4)
          .default(1)
          .describe("Which innings (1, 2, 3, or 4). Default: 1."),
      },
    },
    async (args) => {
      const { match_id, innings_number } = args;

      // Get match context
      const matchInfo = await runQuery(
        db,
        `
        SELECT
          m.team1, m.team2, m.date_start, m.venue, m.match_type,
          i.batting_team, i.bowling_team
        FROM matches m
        JOIN innings i ON m.match_id = i.match_id AND i.innings_number = $innings_number
        WHERE m.match_id = $match_id
        `,
        { match_id, innings_number }
      );

      if (matchInfo.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No match or innings found for match_id="${match_id}", innings_number=${innings_number}.`,
            },
          ],
        };
      }

      // Get over-by-over progression
      const progression = await runQuery(
        db,
        `
        SELECT
          d.over_number + 1 AS over,
          SUM(d.runs_total) AS runs_in_over,
          SUM(SUM(d.runs_total)) OVER (ORDER BY d.over_number) AS cumulative_runs,
          COUNT(*) FILTER (WHERE d.is_wicket) AS wickets_in_over,
          SUM(COUNT(*) FILTER (WHERE d.is_wicket)) OVER (ORDER BY d.over_number) AS cumulative_wickets,
          ROUND(
            SUM(d.runs_total)::DOUBLE /
            NULLIF(COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0), 0) * 6,
            2
          ) AS run_rate_this_over,
          ROUND(
            SUM(SUM(d.runs_total)) OVER (ORDER BY d.over_number)::DOUBLE /
            (SUM(COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0)) OVER (ORDER BY d.over_number)::DOUBLE / 6),
            2
          ) AS cumulative_run_rate,
          STRING_AGG(
            CASE WHEN d.is_wicket THEN d.wicket_player_out ELSE NULL END, ', '
          ) FILTER (WHERE d.is_wicket) AS wickets_fell
        FROM deliveries d
        WHERE d.match_id = $match_id
          AND d.innings_number = $innings_number
        GROUP BY d.over_number
        ORDER BY d.over_number
        `,
        { match_id, innings_number }
      );

      const result = {
        match_info: matchInfo[0],
        progression,
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
