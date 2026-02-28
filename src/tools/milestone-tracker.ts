import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { BOWLING_WICKET_KINDS } from "../queries/common.js";

export function registerMilestoneTracker(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_milestone_tracker",
    {
      title: "Milestone Tracker",
      description:
        "Who is close to a career milestone? Find players approaching or who have reached landmarks like 10000 runs, 500 wickets, 100 centuries, etc. " +
        "Use for 'Who is near 10000 ODI runs?', 'Players approaching 500 Test wickets', or 'Who just reached 50 Test centuries?'. " +
        "Not for current career totals (use get_player_stats) or season-by-season progression (use get_season_stats).",
      inputSchema: {
        milestone_type: z
          .enum(["runs", "wickets", "matches", "centuries", "fifties", "five_wicket_hauls"])
          .describe("Type of milestone."),
        threshold: z
          .number()
          .int()
          .min(1)
          .describe("Milestone threshold (e.g., 10000 for runs, 500 for wickets)."),
        match_type: z
          .string()
          .optional()
          .describe('Cricket format: "Test", "ODI", "T20", "IT20".'),
        proximity: z
          .number()
          .int()
          .optional()
          .describe("Within N of threshold (e.g., within 500 runs of milestone). Default: 10% of threshold."),
        gender: z
          .enum(["male", "female"])
          .optional()
          .describe("Filter by gender."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Number of results."),
      },
    },
    async (args) => {
      const { milestone_type, threshold, match_type, proximity, gender, limit } = args;

      const params: Record<string, string | number> = {
        threshold,
        limit,
      };

      const effectiveProximity = proximity ?? Math.ceil(threshold * 0.1);
      params.lower_bound = threshold - effectiveProximity;

      let matchTypeFilter = "";
      if (match_type) {
        matchTypeFilter = "AND m.match_type = $match_type";
        params.match_type = match_type;
      }
      let genderFilter = "";
      if (gender) {
        genderFilter = "AND m.gender = $gender";
        params.gender = gender;
      }

      let sql: string;

      switch (milestone_type) {
        case "runs":
        case "centuries":
        case "fifties":
          sql = `
            WITH innings_scores AS (
              SELECT
                d.batter AS player_name,
                d.batter_id AS player_id,
                d.match_id,
                d.innings_number,
                SUM(d.runs_batter) AS innings_runs,
                MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
              FROM deliveries d
              JOIN matches m ON d.match_id = m.match_id
              WHERE 1=1 ${matchTypeFilter} ${genderFilter}
              GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
            ),
            player_totals AS (
              SELECT
                player_name,
                player_id,
                SUM(innings_runs) AS total_runs,
                COUNT(DISTINCT match_id) AS matches,
                COUNT(*) AS innings,
                COUNT(*) FILTER (WHERE innings_runs >= 100) AS centuries,
                COUNT(*) FILTER (WHERE innings_runs >= 50 AND innings_runs < 100) AS fifties
              FROM innings_scores
              GROUP BY player_name, player_id
            )
            SELECT
              player_name,
              player_id,
              matches,
              innings,
              total_runs AS runs,
              centuries,
              fifties,
              ${milestone_type === "runs" ? "total_runs" : milestone_type} AS current_value,
              $threshold AS milestone,
              $threshold - ${milestone_type === "runs" ? "total_runs" : milestone_type} AS remaining,
              CASE WHEN ${milestone_type === "runs" ? "total_runs" : milestone_type} >= $threshold THEN true ELSE false END AS reached
            FROM player_totals
            WHERE ${milestone_type === "runs" ? "total_runs" : milestone_type} >= $lower_bound
            ORDER BY ${milestone_type === "runs" ? "total_runs" : milestone_type} DESC
            LIMIT $limit
          `;
          break;

        case "wickets":
        case "five_wicket_hauls":
          sql = `
            WITH bowling_innings AS (
              SELECT
                d.bowler AS player_name,
                d.bowler_id AS player_id,
                d.match_id,
                d.innings_number,
                COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets
              FROM deliveries d
              JOIN matches m ON d.match_id = m.match_id
              WHERE 1=1 ${matchTypeFilter} ${genderFilter}
              GROUP BY d.bowler, d.bowler_id, d.match_id, d.innings_number
            ),
            player_totals AS (
              SELECT
                player_name,
                player_id,
                COUNT(DISTINCT match_id) AS matches,
                COUNT(*) AS innings,
                SUM(wickets) AS total_wickets,
                COUNT(*) FILTER (WHERE wickets >= 5) AS five_wicket_hauls
              FROM bowling_innings
              GROUP BY player_name, player_id
            )
            SELECT
              player_name,
              player_id,
              matches,
              innings,
              total_wickets AS wickets,
              five_wicket_hauls,
              ${milestone_type === "wickets" ? "total_wickets" : "five_wicket_hauls"} AS current_value,
              $threshold AS milestone,
              $threshold - ${milestone_type === "wickets" ? "total_wickets" : "five_wicket_hauls"} AS remaining,
              CASE WHEN ${milestone_type === "wickets" ? "total_wickets" : "five_wicket_hauls"} >= $threshold THEN true ELSE false END AS reached
            FROM player_totals
            WHERE ${milestone_type === "wickets" ? "total_wickets" : "five_wicket_hauls"} >= $lower_bound
            ORDER BY ${milestone_type === "wickets" ? "total_wickets" : "five_wicket_hauls"} DESC
            LIMIT $limit
          `;
          break;

        case "matches":
          sql = `
            WITH player_matches AS (
              SELECT
                p.player_name,
                p.player_id,
                COUNT(DISTINCT d.match_id) AS matches
              FROM deliveries d
              JOIN matches m ON d.match_id = m.match_id
              JOIN players p ON (d.batter_id = p.player_id OR d.bowler_id = p.player_id)
              WHERE 1=1 ${matchTypeFilter} ${genderFilter}
              GROUP BY p.player_name, p.player_id
            )
            SELECT
              player_name,
              player_id,
              matches AS current_value,
              $threshold AS milestone,
              $threshold - matches AS remaining,
              CASE WHEN matches >= $threshold THEN true ELSE false END AS reached
            FROM player_matches
            WHERE matches >= $lower_bound
            ORDER BY matches DESC
            LIMIT $limit
          `;
          break;

        default:
          return {
            content: [{ type: "text" as const, text: "Unsupported milestone type." }],
          };
      }

      const rows = await runQuery(db, sql, params);
      return {
        content: [{
          type: "text" as const,
          text: rows.length === 0
            ? "No players found near that milestone with the given filters."
            : JSON.stringify(rows, null, 2),
        }],
      };
    }
  );
}
