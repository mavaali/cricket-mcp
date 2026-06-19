import { BAT, BOWL } from "./innings.js";
import {
  type MatchFilter,
  type CricketPhase,
  buildMatchFilter,
  buildWhereClause,
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
    const filterStr = buildWhereClause(whereClauses);
    const styleExpr = buildBowlingStyleExpr("bp", options.grouping);

    const sql = `
      SELECT
        ${phaseSelect}
        ${styleExpr} AS style_group,
        COUNT(DISTINCT d.match_id || '-' || d.innings_number) AS innings,
        ${BAT.ballsFaced} AS balls_faced,
        SUM(d.runs_batter) AS runs,
        COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_player_out = d.batter
          AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}
        ) AS dismissals,
        COUNT(*) FILTER (WHERE d.runs_batter = 0 AND d.extras_wides = 0) AS dot_balls,
        ${BAT.fours} AS fours,
        ${BAT.sixes} AS sixes,
        ROUND(
          CASE WHEN COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_player_out = d.batter
            AND d.wicket_kind IN ${BOWLING_WICKET_KINDS}) > 0
          THEN SUM(d.runs_batter)::DOUBLE / COUNT(*) FILTER (WHERE d.is_wicket
            AND d.wicket_player_out = d.batter AND d.wicket_kind IN ${BOWLING_WICKET_KINDS})
          ELSE NULL END, 2
        ) AS average,
        ROUND(
          CASE WHEN ${BAT.ballsFaced} > 0
          THEN SUM(d.runs_batter)::DOUBLE / ${BAT.ballsFaced} * 100
          ELSE NULL END, 2
        ) AS strike_rate,
        ROUND(
          CASE WHEN ${BAT.ballsFaced} > 0
          THEN COUNT(*) FILTER (WHERE d.runs_batter = 0 AND d.extras_wides = 0)::DOUBLE
               / ${BAT.ballsFaced} * 100
          ELSE NULL END, 2
        ) AS dot_ball_pct,
        ROUND(
          CASE WHEN ${BAT.ballsFaced} > 0
          THEN (${BAT.fours}
              + ${BAT.sixes})::DOUBLE
              / ${BAT.ballsFaced} * 100
          ELSE NULL END, 2
        ) AS boundary_pct
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      LEFT JOIN players bp ON d.bowler_id = bp.player_id
      ${filterStr}
      GROUP BY ${phaseGroupBy} style_group
      HAVING ${BAT.ballsFaced} >= $min_balls
      ORDER BY ${phaseOrderPrefix} balls_faced DESC
      LIMIT $limit
    `;

    return { sql, params };
  } else {
    // Bowler vs batting styles
    whereClauses.push("d.bowler ILIKE '%' || $player_name || '%'");
    const filterStr = buildWhereClause(whereClauses);

    const sql = `
      SELECT
        ${phaseSelect}
        COALESCE(bp.batting_style, 'Unknown') AS style_group,
        COUNT(DISTINCT d.match_id || '-' || d.innings_number) AS innings,
        ${BOWL.legalBalls} AS balls_bowled,
        ${BOWL.runsConceded} AS runs_conceded,
        ${BOWL.wickets} AS wickets,
        ${BOWL.dots} AS dot_balls,
        ROUND(
          CASE WHEN ${BOWL.wickets} > 0
          THEN ${BOWL.runsConceded}::DOUBLE
               / ${BOWL.wickets}
          ELSE NULL END, 2
        ) AS average,
        ROUND(
          CASE WHEN ${BOWL.legalBalls} > 0
          THEN ${BOWL.runsConceded}::DOUBLE
               / (${BOWL.legalBalls}::DOUBLE / 6)
          ELSE NULL END, 2
        ) AS economy,
        ROUND(
          CASE WHEN ${BOWL.wickets} > 0
          THEN ${BOWL.legalBalls}::DOUBLE
               / ${BOWL.wickets}
          ELSE NULL END, 2
        ) AS bowling_strike_rate,
        ROUND(
          CASE WHEN ${BOWL.legalBalls} > 0
          THEN ${BOWL.dots}::DOUBLE
               / ${BOWL.legalBalls} * 100
          ELSE NULL END, 2
        ) AS dot_ball_pct
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      LEFT JOIN players bp ON d.batter_id = bp.player_id
      ${filterStr}
      GROUP BY ${phaseGroupBy} style_group
      HAVING ${BOWL.legalBalls} >= $min_balls
      ORDER BY ${phaseOrderPrefix} balls_bowled DESC
      LIMIT $limit
    `;

    return { sql, params };
  }
}
