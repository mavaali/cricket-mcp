import {
  type MatchFilter,
  type CricketPhase,
  buildMatchFilter,
  buildWhereString,
  BOWLING_WICKET_KINDS,
  PHASE_OVERS,
} from "./common.js";

export type StyleGrouping = "raw" | "broad" | "arm";

export function buildBowlingStyleExpr(
  alias: string,
  grouping: StyleGrouping
): string {
  if (grouping === "raw") {
    return `COALESCE(${alias}.bowling_style, 'Unknown')`;
  }
  if (grouping === "broad") {
    return `COALESCE(${alias}.bowling_style_broad, 'Unknown')`;
  }
  // grouping === "arm"
  return `COALESCE(${alias}.bowling_style_arm, 'Unknown')`;
}

export function buildStyleMatchupQuery(options: {
  perspective: "batting" | "bowling";
  playerName: string;
  grouping: StyleGrouping;
  filters: MatchFilter;
  minBalls: number;
  limit: number;
  phase?: CricketPhase;
}): { sql: string; params: Record<string, string | number> } {
  const { whereClauses, params } = buildMatchFilter(options.filters);
  params.player_name = options.playerName;
  params.min_balls = options.minBalls;
  params.limit = options.limit;

  // Phase filter: restrict to over range when provided
  if (options.phase) {
    const [overFrom, overTo] = PHASE_OVERS[options.phase];
    whereClauses.push(`d.over_number >= ${overFrom} AND d.over_number <= ${overTo}`);
  }

  // Phase column + GROUP BY fragments
  const phaseSelect = options.phase ? `'${options.phase}' AS phase,` : "";
  const phaseGroupBy = options.phase ? "phase," : "";
  const phaseOrderPrefix = options.phase ? "phase," : "";

  if (options.perspective === "batting") {
    // Batter vs bowling styles
    whereClauses.push("d.batter ILIKE '%' || $player_name || '%'");
    const filterStr = buildWhereString(whereClauses);
    const styleExpr = buildBowlingStyleExpr("bp", options.grouping);

    const sql = `
      SELECT
        ${phaseSelect}
        ${styleExpr} AS style_group,
        COUNT(DISTINCT d.match_id || '-' || d.innings_number) AS innings,
        COUNT(*) FILTER (WHERE d.extras_wides = 0) AS balls_faced,
        SUM(d.runs_batter) AS runs,
        COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_player_out = d.batter
          AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}
        ) AS dismissals,
        COUNT(*) FILTER (WHERE d.runs_batter = 0 AND d.extras_wides = 0) AS dot_balls,
        COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS fours,
        COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS sixes,
        ROUND(
          CASE WHEN COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_player_out = d.batter
            AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) > 0
          THEN SUM(d.runs_batter)::DOUBLE / COUNT(*) FILTER (WHERE d.is_wicket
            AND d.wicket_player_out = d.batter AND d.wicket_kind IN ${BOWLING_WICKET_KINDS})
          ELSE NULL END, 2
        ) AS average,
        ROUND(
          CASE WHEN COUNT(*) FILTER (WHERE d.extras_wides = 0) > 0
          THEN SUM(d.runs_batter)::DOUBLE / COUNT(*) FILTER (WHERE d.extras_wides = 0) * 100
          ELSE NULL END, 2
        ) AS strike_rate,
        ROUND(
          CASE WHEN COUNT(*) FILTER (WHERE d.extras_wides = 0) > 0
          THEN COUNT(*) FILTER (WHERE d.runs_batter = 0 AND d.extras_wides = 0)::DOUBLE
               / COUNT(*) FILTER (WHERE d.extras_wides = 0) * 100
          ELSE NULL END, 2
        ) AS dot_ball_pct,
        ROUND(
          CASE WHEN COUNT(*) FILTER (WHERE d.extras_wides = 0) > 0
          THEN (COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary)
              + COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary))::DOUBLE
              / COUNT(*) FILTER (WHERE d.extras_wides = 0) * 100
          ELSE NULL END, 2
        ) AS boundary_pct
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      LEFT JOIN players bp ON d.bowler_id = bp.player_id
      WHERE 1=1
        ${filterStr}
      GROUP BY ${phaseGroupBy} style_group
      HAVING COUNT(*) FILTER (WHERE d.extras_wides = 0) >= $min_balls
      ORDER BY ${phaseOrderPrefix} balls_faced DESC
      LIMIT $limit
    `;

    return { sql, params };
  } else {
    // Bowler vs batting styles
    whereClauses.push("d.bowler ILIKE '%' || $player_name || '%'");
    const filterStr = buildWhereString(whereClauses);

    const sql = `
      SELECT
        ${phaseSelect}
        COALESCE(bp.batting_style, 'Unknown') AS style_group,
        COUNT(DISTINCT d.match_id || '-' || d.innings_number) AS innings,
        COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS balls_bowled,
        SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
        COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets,
        COUNT(*) FILTER (WHERE d.runs_total = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0) AS dot_balls,
        ROUND(
          CASE WHEN COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) > 0
          THEN SUM(d.runs_total - d.extras_byes - d.extras_legbyes)::DOUBLE
               / COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS})
          ELSE NULL END, 2
        ) AS average,
        ROUND(
          CASE WHEN COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) > 0
          THEN SUM(d.runs_total - d.extras_byes - d.extras_legbyes)::DOUBLE
               / (COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0)::DOUBLE / 6)
          ELSE NULL END, 2
        ) AS economy,
        ROUND(
          CASE WHEN COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) > 0
          THEN COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0)::DOUBLE
               / COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS})
          ELSE NULL END, 2
        ) AS bowling_strike_rate,
        ROUND(
          CASE WHEN COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) > 0
          THEN COUNT(*) FILTER (WHERE d.runs_total = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0)::DOUBLE
               / COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) * 100
          ELSE NULL END, 2
        ) AS dot_ball_pct
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      LEFT JOIN players bp ON d.batter_id = bp.player_id
      WHERE 1=1
        ${filterStr}
      GROUP BY ${phaseGroupBy} style_group
      HAVING COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) >= $min_balls
      ORDER BY ${phaseOrderPrefix} balls_bowled DESC
      LIMIT $limit
    `;

    return { sql, params };
  }
}
