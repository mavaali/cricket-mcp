import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { MatchFilterSchema } from "../queries/common.js";
import { buildStyleMatchupQuery } from "../queries/style-matchup.js";

export function registerStyleMatchup(
  server: McpServer,
  db: DuckDBConnection
): void {
  server.registerTool(
    "get_style_matchup",
    {
      title: "Style-Based Matchup",
      description:
        "Analyze a player's performance broken down by bowling style or batting hand. " +
        "For batters: stats against pace vs spin, or left-arm pace vs right-arm offbreak, etc. " +
        "For bowlers: stats against right-hand vs left-hand batters. " +
        "Requires enriched player data (run 'npm run enrich' first). " +
        "Use for 'Kohli vs left-arm pace', 'Bumrah against left-handers', 'How does Smith bat against spin?'",
      inputSchema: {
        player_name: z
          .string()
          .min(2)
          .describe("Player name (partial match, case-insensitive)."),
        perspective: z
          .enum(["batting", "bowling"])
          .describe(
            "batting: how this batter performs against different bowling styles. " +
              "bowling: how this bowler performs against different batting hands."
          ),
        grouping: z
          .enum(["broad", "arm", "raw"])
          .default("arm")
          .describe(
            'How to group bowling styles. "broad": Pace/Spin. ' +
              '"arm": Left-arm Pace / Right-arm Pace / Left-arm Spin / Right-arm Spin. ' +
              '"raw": exact style strings (e.g. "Right-arm fast-medium"). ' +
              "Ignored for bowling perspective (batting styles are always shown as-is)."
          ),
        min_balls: z
          .number()
          .int()
          .min(1)
          .default(30)
          .describe("Minimum balls to qualify for a style group."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe("Max style groups to return."),
        ...MatchFilterSchema.shape,
      },
    },
    async (args) => {
      const {
        player_name,
        perspective,
        grouping,
        min_balls,
        limit,
        ...filters
      } = args;

      // Check if enrichment data exists
      const enrichCheck = await runQuery(
        db,
        "SELECT COUNT(*) AS cnt FROM players WHERE batting_style IS NOT NULL OR bowling_style IS NOT NULL",
        {}
      );
      const enrichedCount = Number(enrichCheck[0]?.cnt ?? 0);

      if (enrichedCount === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No player metadata found. Run 'npm run enrich -- --csv <path>' to add batting/bowling style data before using this tool.",
            },
          ],
        };
      }

      const { sql, params } = buildStyleMatchupQuery({
        perspective,
        playerName: player_name,
        grouping: perspective === "bowling" ? "raw" : grouping,
        filters,
        minBalls: min_balls,
        limit,
      });

      const rows = await runQuery(db, sql, params);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No style matchup data found for "${player_name}" with the given filters.`,
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
