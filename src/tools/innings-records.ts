import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildInningsRecordsQuery } from "../queries/innings-records.js";

export function registerInningsRecords(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_innings_records",
    {
      title: "Single-Innings Records",
      description:
        "What's the fastest hundred / highest individual score / best bowling figures in an innings? Single-performance leaderboards: " +
        "highest scores, fastest fifties and hundreds (fewest balls), most sixes or fours in one innings, best bowling figures, " +
        "most expensive over conceded, and most runs hit off a single over. Every row includes the match context (opposition, venue, date, event). " +
        "Use for 'Fastest IPL hundred', 'Highest T20I score', 'Best ODI bowling figures', or 'Most runs off one over'. " +
        "Not for career aggregates (use get_batting_records / get_bowling_records) or one match's full card (use get_match_scorecard).",
      inputSchema: {
        record_type: z
          .enum([
            "highest_score",
            "fastest_fifty",
            "fastest_hundred",
            "most_sixes",
            "most_fours",
            "best_bowling_figures",
            "most_runs_in_over",
            "most_expensive_over",
          ])
          .describe(
            "Record to rank: batting innings records (highest_score, fastest_fifty, fastest_hundred, most_sixes, most_fours, most_runs_in_over) or bowling (best_bowling_figures, most_expensive_over)."
          ),
        player_name: z
          .string()
          .optional()
          .describe(
            "Restrict to one player's performances (partial match), e.g. Kohli's fastest hundreds."
          ),
        ...MatchFilterSchema.shape,
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
      const { record_type, player_name, limit, ...filters } = args;
      const { sql, params } = buildInningsRecordsQuery(
        record_type,
        player_name,
        filters,
        limit
      );

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No innings records found with the given filters.",
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
