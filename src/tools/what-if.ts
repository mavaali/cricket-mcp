import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import { BOWLING_WICKET_KINDS } from "../queries/common.js";

export function registerWhatIf(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_what_if",
    {
      title: "What If",
      description:
        "What would this player\\'s stats look like without X? Recalculates career stats after excluding specific opponents, bowlers, venues, or tournaments. Shows original vs modified stats with deltas. " +
        "Use for 'Kohli\\'s average without Hazlewood', 'Sachin\\'s record excluding Lord\\'s', or 'Bumrah\\'s economy without IPL'. " +
        "Not for general career stats (use get_player_stats) or head-to-head matchup data (use get_matchup).",
      inputSchema: {
        player_name: z
          .string()
          .describe("Player name (partial match). Required."),
        perspective: z
          .enum(["batting", "bowling"])
          .describe("Recalculate batting or bowling stats."),
        exclude_opposition: z
          .string()
          .optional()
          .describe("Exclude matches against this team."),
        exclude_bowler: z
          .string()
          .optional()
          .describe("Exclude deliveries from this bowler (batting perspective only)."),
        exclude_batter: z
          .string()
          .optional()
          .describe("Exclude deliveries to this batter (bowling perspective only)."),
        exclude_venue: z
          .string()
          .optional()
          .describe("Exclude matches at this venue (partial match)."),
        exclude_event: z
          .string()
          .optional()
          .describe("Exclude matches in this tournament (partial match)."),
        match_type: z
          .string()
          .optional()
          .describe('Cricket format filter.'),
        gender: z
          .enum(["male", "female"])
          .optional()
          .describe("Filter by gender."),
      },
    },
    async (args) => {
      const {
        player_name,
        perspective,
        exclude_opposition,
        exclude_bowler,
        exclude_batter,
        exclude_venue,
        exclude_event,
        match_type,
        gender,
      } = args;

      const params: Record<string, string | number> = {
        player_name,
      };

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

      // Build exclusion clauses
      const exclusions: string[] = [];
      if (exclude_opposition) {
        exclusions.push("AND NOT (m.team1 = $excl_opp OR m.team2 = $excl_opp)");
        params.excl_opp = exclude_opposition;
      }
      if (exclude_venue) {
        exclusions.push("AND NOT (m.venue ILIKE '%' || $excl_venue || '%')");
        params.excl_venue = exclude_venue;
      }
      if (exclude_event) {
        exclusions.push("AND NOT (m.event_name ILIKE '%' || $excl_event || '%')");
        params.excl_event = exclude_event;
      }

      const commonFilter = `${matchTypeFilter} ${genderFilter}`;
      const exclusionStr = exclusions.join(" ");

      if (perspective === "batting") {
        let bowlerExclusion = "";
        if (exclude_bowler) {
          bowlerExclusion = "AND NOT (d.bowler ILIKE '%' || $excl_bowler || '%')";
          params.excl_bowler = exclude_bowler;
        }

        const sql = `
          WITH original_innings AS (
            SELECT
              d.batter,
              d.batter_id,
              d.match_id,
              d.innings_number,
              SUM(d.runs_batter) AS innings_runs,
              COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
              COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS innings_fours,
              COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS innings_sixes,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE d.batter ILIKE '%' || $player_name || '%'
              ${commonFilter}
            GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
          ),
          modified_innings AS (
            SELECT
              d.batter,
              d.batter_id,
              d.match_id,
              d.innings_number,
              SUM(d.runs_batter) AS innings_runs,
              COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
              COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS innings_fours,
              COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS innings_sixes,
              MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE d.batter ILIKE '%' || $player_name || '%'
              ${commonFilter}
              ${exclusionStr}
              ${bowlerExclusion}
            GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
          ),
          original AS (
            SELECT
              batter AS player_name,
              COUNT(DISTINCT match_id) AS matches,
              COUNT(*) AS innings,
              SUM(innings_runs) AS runs,
              SUM(innings_balls) AS balls_faced,
              MAX(innings_runs) AS highest_score,
              SUM(innings_fours) AS fours,
              SUM(innings_sixes) AS sixes,
              SUM(was_dismissed) AS dismissals,
              COUNT(*) FILTER (WHERE innings_runs >= 100) AS centuries,
              COUNT(*) FILTER (WHERE innings_runs >= 50 AND innings_runs < 100) AS fifties,
              ROUND(
                CASE WHEN SUM(was_dismissed) > 0
                  THEN SUM(innings_runs)::DOUBLE / SUM(was_dismissed)
                  ELSE NULL END, 2
              ) AS average,
              ROUND(
                CASE WHEN SUM(innings_balls) > 0
                  THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
                  ELSE NULL END, 2
              ) AS strike_rate
            FROM original_innings
            GROUP BY batter
          ),
          modified AS (
            SELECT
              batter AS player_name,
              COUNT(DISTINCT match_id) AS matches,
              COUNT(*) AS innings,
              SUM(innings_runs) AS runs,
              SUM(innings_balls) AS balls_faced,
              MAX(innings_runs) AS highest_score,
              SUM(innings_fours) AS fours,
              SUM(innings_sixes) AS sixes,
              SUM(was_dismissed) AS dismissals,
              COUNT(*) FILTER (WHERE innings_runs >= 100) AS centuries,
              COUNT(*) FILTER (WHERE innings_runs >= 50 AND innings_runs < 100) AS fifties,
              ROUND(
                CASE WHEN SUM(was_dismissed) > 0
                  THEN SUM(innings_runs)::DOUBLE / SUM(was_dismissed)
                  ELSE NULL END, 2
              ) AS average,
              ROUND(
                CASE WHEN SUM(innings_balls) > 0
                  THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
                  ELSE NULL END, 2
              ) AS strike_rate
            FROM modified_innings
            GROUP BY batter
          )
          SELECT
            o.player_name,
            o.matches AS original_matches,
            o.innings AS original_innings,
            o.runs AS original_runs,
            o.average AS original_average,
            o.strike_rate AS original_strike_rate,
            o.centuries AS original_centuries,
            m.matches AS modified_matches,
            m.innings AS modified_innings,
            m.runs AS modified_runs,
            m.average AS modified_average,
            m.strike_rate AS modified_strike_rate,
            m.centuries AS modified_centuries,
            o.matches - m.matches AS excluded_matches,
            o.innings - m.innings AS excluded_innings,
            o.runs - m.runs AS excluded_runs,
            ROUND(COALESCE(m.average, 0) - COALESCE(o.average, 0), 2) AS average_delta,
            ROUND(COALESCE(m.strike_rate, 0) - COALESCE(o.strike_rate, 0), 2) AS strike_rate_delta
          FROM original o
          LEFT JOIN modified m ON o.player_name = m.player_name
        `;

        const rows = await runQuery(db, sql, params);
        return {
          content: [{
            type: "text" as const,
            text: rows.length === 0
              ? "No data found for this player with the given filters."
              : JSON.stringify(rows, null, 2),
          }],
        };
      } else {
        // Bowling perspective
        let batterExclusion = "";
        if (exclude_batter) {
          batterExclusion = "AND NOT (d.batter ILIKE '%' || $excl_batter || '%')";
          params.excl_batter = exclude_batter;
        }

        const sql = `
          WITH original_innings AS (
            SELECT
              d.bowler,
              d.bowler_id,
              d.match_id,
              d.innings_number,
              COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
              SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
              COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE d.bowler ILIKE '%' || $player_name || '%'
              ${commonFilter}
            GROUP BY d.bowler, d.bowler_id, d.match_id, d.innings_number
          ),
          modified_innings AS (
            SELECT
              d.bowler,
              d.bowler_id,
              d.match_id,
              d.innings_number,
              COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
              SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
              COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets
            FROM deliveries d
            JOIN matches m ON d.match_id = m.match_id
            WHERE d.bowler ILIKE '%' || $player_name || '%'
              ${commonFilter}
              ${exclusionStr}
              ${batterExclusion}
            GROUP BY d.bowler, d.bowler_id, d.match_id, d.innings_number
          ),
          original AS (
            SELECT
              bowler AS player_name,
              COUNT(DISTINCT match_id) AS matches,
              COUNT(*) AS innings,
              SUM(legal_balls) AS balls_bowled,
              SUM(runs_conceded) AS runs_conceded,
              SUM(wickets) AS wickets,
              ROUND(
                CASE WHEN SUM(wickets) > 0
                  THEN SUM(runs_conceded)::DOUBLE / SUM(wickets)
                  ELSE NULL END, 2
              ) AS average,
              ROUND(
                CASE WHEN SUM(legal_balls) > 0
                  THEN SUM(runs_conceded)::DOUBLE / (SUM(legal_balls)::DOUBLE / 6)
                  ELSE NULL END, 2
              ) AS economy
            FROM original_innings
            GROUP BY bowler
          ),
          modified AS (
            SELECT
              bowler AS player_name,
              COUNT(DISTINCT match_id) AS matches,
              COUNT(*) AS innings,
              SUM(legal_balls) AS balls_bowled,
              SUM(runs_conceded) AS runs_conceded,
              SUM(wickets) AS wickets,
              ROUND(
                CASE WHEN SUM(wickets) > 0
                  THEN SUM(runs_conceded)::DOUBLE / SUM(wickets)
                  ELSE NULL END, 2
              ) AS average,
              ROUND(
                CASE WHEN SUM(legal_balls) > 0
                  THEN SUM(runs_conceded)::DOUBLE / (SUM(legal_balls)::DOUBLE / 6)
                  ELSE NULL END, 2
              ) AS economy
            FROM modified_innings
            GROUP BY bowler
          )
          SELECT
            o.player_name,
            o.matches AS original_matches,
            o.innings AS original_innings,
            o.wickets AS original_wickets,
            o.runs_conceded AS original_runs_conceded,
            o.average AS original_average,
            o.economy AS original_economy,
            m.matches AS modified_matches,
            m.innings AS modified_innings,
            m.wickets AS modified_wickets,
            m.runs_conceded AS modified_runs_conceded,
            m.average AS modified_average,
            m.economy AS modified_economy,
            o.matches - m.matches AS excluded_matches,
            o.wickets - m.wickets AS excluded_wickets,
            ROUND(COALESCE(m.average, 0) - COALESCE(o.average, 0), 2) AS average_delta,
            ROUND(COALESCE(m.economy, 0) - COALESCE(o.economy, 0), 2) AS economy_delta
          FROM original o
          LEFT JOIN modified m ON o.player_name = m.player_name
        `;

        const rows = await runQuery(db, sql, params);
        return {
          content: [{
            type: "text" as const,
            text: rows.length === 0
              ? "No data found for this player with the given filters."
              : JSON.stringify(rows, null, 2),
          }],
        };
      }
    }
  );
}
