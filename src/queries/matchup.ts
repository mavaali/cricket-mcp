import { type MatchFilter, buildMatchFilter, buildWhereString } from "./common.js";

/**
 * Core matchup aggregation query. Groups deliveries by (batter, bowler) pair
 * and computes the full matchup stat line. Used by all 4 matchup tools.
 *
 * The caller provides additional WHERE clauses (e.g. batter name, bowler name,
 * opposition team) and ORDER BY / LIMIT via the options parameter.
 */
export function buildMatchupQuery(options: {
  filters: MatchFilter;
  extraWhere: string[];
  extraParams: Record<string, string | number>;
  groupBy?: "batter" | "bowler" | "both";
  orderBy: string;
  limit: number;
}): { sql: string; params: Record<string, string | number> } {
  const { whereClauses, params } = buildMatchFilter(options.filters);
  Object.assign(params, options.extraParams);
  params.limit = options.limit;

  const allWhere = [...whereClauses, ...options.extraWhere];
  const filterStr = buildWhereString(allWhere);

  // Determine grouping
  const groupBy = options.groupBy ?? "both";
  const groupCols =
    groupBy === "batter"
      ? "d.batter, d.batter_id"
      : groupBy === "bowler"
        ? "d.bowler, d.bowler_id"
        : "d.batter, d.batter_id, d.bowler, d.bowler_id";

  const selectBatter =
    groupBy === "bowler" ? "" : "d.batter AS batter_name, d.batter_id,";
  const selectBowler =
    groupBy === "batter" ? "" : "d.bowler AS bowler_name, d.bowler_id,";

  const sql = `
    WITH matchup_deliveries AS (
      SELECT
        d.match_id,
        d.innings_number,
        d.batter,
        d.batter_id,
        d.bowler,
        d.bowler_id,
        d.runs_batter,
        d.runs_total,
        d.runs_extras,
        d.runs_non_boundary,
        d.extras_wides,
        d.extras_noballs,
        d.extras_byes,
        d.extras_legbyes,
        d.is_wicket,
        d.wicket_kind,
        d.wicket_player_out
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      WHERE 1=1
        ${filterStr}
    ),
    matchup_stats AS (
      SELECT
        ${selectBatter}
        ${selectBowler}
        COUNT(DISTINCT d.match_id) AS matches,
        COUNT(DISTINCT d.match_id || '-' || d.innings_number) AS innings,
        COUNT(*) FILTER (WHERE d.extras_wides = 0) AS balls_faced,
        SUM(d.runs_batter) AS runs_scored,
        SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
        COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_player_out = d.batter AND d.wicket_kind IN
          ('bowled', 'caught', 'caught and bowled', 'lbw', 'stumped', 'hit wicket')) AS dismissals,
        COUNT(*) FILTER (WHERE d.runs_batter = 0 AND d.extras_wides = 0) AS dot_balls,
        COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS fours,
        COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS sixes,
        -- Dismissal type breakdown as JSON
        LIST(d.wicket_kind) FILTER (WHERE d.is_wicket AND d.wicket_player_out = d.batter AND d.wicket_kind IN
          ('bowled', 'caught', 'caught and bowled', 'lbw', 'stumped', 'hit wicket')) AS dismissal_kinds
      FROM matchup_deliveries d
      GROUP BY ${groupCols}
    )
    SELECT
      *,
      ROUND(
        CASE WHEN dismissals > 0 THEN runs_scored::DOUBLE / dismissals ELSE NULL END, 2
      ) AS average,
      ROUND(
        CASE WHEN balls_faced > 0 THEN runs_scored::DOUBLE / balls_faced * 100 ELSE NULL END, 2
      ) AS strike_rate,
      ROUND(
        CASE WHEN balls_faced > 0 THEN runs_conceded::DOUBLE / (balls_faced::DOUBLE / 6) ELSE NULL END, 2
      ) AS economy,
      ROUND(
        CASE WHEN dismissals > 0 THEN balls_faced::DOUBLE / dismissals ELSE NULL END, 2
      ) AS bowling_strike_rate,
      ROUND(
        CASE WHEN balls_faced > 0 THEN dot_balls::DOUBLE / balls_faced * 100 ELSE NULL END, 2
      ) AS dot_ball_pct,
      ROUND(
        CASE WHEN balls_faced > 0 THEN (fours + sixes)::DOUBLE / balls_faced * 100 ELSE NULL END, 2
      ) AS boundary_pct,
      fours + sixes AS boundaries_conceded
    FROM matchup_stats
    ORDER BY ${options.orderBy}
    LIMIT $limit
  `;

  return { sql, params };
}
