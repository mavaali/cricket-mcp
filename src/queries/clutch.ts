import { BAT, BOWL } from "./innings.js";
import {
  type MatchFilter,
  buildMatchFilter,
  buildAndClause,
} from "./common.js";

/**
 * Classify a match's event_stage into a pressure bucket. The raw data has
 * inconsistent casing/punctuation ("Semi Final", "Semi-final", "Play-off"),
 * so classification is pattern-based:
 *   - final:     the title match ("Final", but not semi/quarter/preliminary)
 *   - knockout:  semis, quarters, eliminators, qualifiers, play-offs — lose and
 *     you're out (or drop a path to the title)
 *   - placement: 3rd/5th/7th place play-offs — knockout-shaped, nothing at stake
 *   - league:    everything else, including matches with no stage recorded
 */
export const STAGE_BUCKET_EXPR = `
  CASE
    WHEN m.event_stage IS NULL THEN 'league'
    WHEN m.event_stage ILIKE '%place%' THEN 'placement'
    WHEN m.event_stage ILIKE '%final%'
      AND m.event_stage NOT ILIKE '%semi%'
      AND m.event_stage NOT ILIKE '%quarter%'
      AND m.event_stage NOT ILIKE '%preliminary%' THEN 'final'
    WHEN m.event_stage ILIKE '%final%'
      OR m.event_stage ILIKE '%eliminator%'
      OR m.event_stage ILIKE '%qualifier%'
      OR m.event_stage ILIKE '%knockout%'
      OR m.event_stage ILIKE '%play%off%'
      OR m.event_stage ILIKE '%challenger%' THEN 'knockout'
    ELSE 'league'
  END`;

export function buildClutchQuery(
  playerName: string,
  perspective: "batting" | "bowling",
  filters: MatchFilter,
  groupBy: "bucket" | "stage" = "bucket"
): { sql: string; params: Record<string, string | number> } {
  const { whereClauses, params } = buildMatchFilter(filters);
  params.player_name = playerName;
  const filterStr = buildAndClause(whereClauses);

  const groupExpr =
    groupBy === "bucket" ? STAGE_BUCKET_EXPR : "COALESCE(m.event_stage, 'League/Group')";

  if (perspective === "batting") {
    const sql = `
      WITH innings_scores AS (
        SELECT
          d.batter,
          d.match_id,
          d.innings_number,
          ${groupExpr} AS stage,
          SUM(d.runs_batter) AS runs,
          ${BAT.ballsFaced} AS balls,
          ${BAT.wasDismissed} AS was_dismissed
        FROM deliveries d
        JOIN matches m ON d.match_id = m.match_id
        WHERE d.batter ILIKE '%' || $player_name || '%'
          ${filterStr}
        GROUP BY d.batter, d.match_id, d.innings_number, m.event_stage
      )
      SELECT
        stage,
        COUNT(DISTINCT match_id) AS matches,
        COUNT(*) AS innings,
        SUM(runs) AS runs,
        SUM(was_dismissed) AS dismissals,
        SUM(balls) AS balls,
        ROUND(
          CASE WHEN SUM(was_dismissed) > 0
            THEN SUM(runs)::DOUBLE / SUM(was_dismissed) ELSE NULL END, 2
        ) AS average,
        ROUND(
          CASE WHEN SUM(balls) > 0
            THEN SUM(runs)::DOUBLE / SUM(balls) * 100 ELSE NULL END, 2
        ) AS strike_rate,
        COUNT(*) FILTER (WHERE runs >= 100) AS hundreds,
        COUNT(*) FILTER (WHERE runs >= 50 AND runs < 100) AS fifties,
        MAX(runs) AS highest_score,
        COUNT(*) FILTER (WHERE runs = 0 AND was_dismissed = 1) AS ducks
      FROM innings_scores
      GROUP BY stage
      ORDER BY stage
    `;
    return { sql, params };
  }

  const sql = `
    WITH bowling_innings AS (
      SELECT
        d.bowler,
        d.match_id,
        d.innings_number,
        ${groupExpr} AS stage,
        ${BOWL.wickets} AS wickets,
        ${BOWL.runsConceded} AS runs_conceded,
        ${BOWL.legalBalls} AS legal_balls
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      WHERE d.bowler ILIKE '%' || $player_name || '%'
        ${filterStr}
      GROUP BY d.bowler, d.match_id, d.innings_number, m.event_stage
    )
    SELECT
      stage,
      COUNT(DISTINCT match_id) AS matches,
      COUNT(*) AS innings,
      SUM(wickets) AS wickets,
      SUM(runs_conceded) AS runs_conceded,
      SUM(legal_balls) AS balls,
      ROUND(
        CASE WHEN SUM(wickets) > 0
          THEN SUM(runs_conceded)::DOUBLE / SUM(wickets) ELSE NULL END, 2
      ) AS average,
      ROUND(
        CASE WHEN SUM(legal_balls) > 0
          THEN SUM(runs_conceded)::DOUBLE / (SUM(legal_balls) / 6.0) ELSE NULL END, 2
      ) AS economy,
      ROUND(
        CASE WHEN SUM(wickets) > 0
          THEN SUM(legal_balls)::DOUBLE / SUM(wickets) ELSE NULL END, 2
      ) AS bowling_strike_rate,
      arg_max(wickets || '/' || runs_conceded, wickets * 10000 - runs_conceded) AS best_figures,
      arg_max(wickets, wickets * 10000 - runs_conceded) AS best_wickets,
      arg_max(runs_conceded, wickets * 10000 - runs_conceded) AS best_runs
    FROM bowling_innings
    GROUP BY stage
    ORDER BY stage
  `;
  return { sql, params };
}
