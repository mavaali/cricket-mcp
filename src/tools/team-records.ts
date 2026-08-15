import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildTeamRecordsQuery } from "../queries/team-records.js";

export function registerTeamRecords(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_team_records",
    {
      title: "Team Records & Extremes",
      description:
        "What's the highest team total / biggest win / highest successful chase? Team-level record lists: highest and lowest " +
        "innings totals (lowest counts only all-out innings), biggest and narrowest wins by runs or wickets, highest successful " +
        "run chases, and tied matches. " +
        "Use for 'Highest T20 total ever', 'Biggest Test wins by runs', 'Highest successful chase at Eden Gardens', or 'ODI ties'. " +
        "Not for individual player records (use get_innings_records or get_batting_records) or a team's recent results (use get_team_form).",
      inputSchema: {
        record_type: z
          .enum([
            "highest_total",
            "lowest_total",
            "biggest_win_runs",
            "narrowest_win_runs",
            "biggest_win_wickets",
            "narrowest_win_wickets",
            "highest_successful_chase",
            "tied_matches",
          ])
          .describe(
            "Record to rank. Win margins come from the official result; narrowest_win_wickets surfaces 1-wicket thrillers."
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
      const { record_type, limit, ...filters } = args;
      const { sql, params } = buildTeamRecordsQuery(record_type, filters, limit);

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No team records found with the given filters.",
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
