import { BAT } from "./innings.js";
import {
  type MatchFilter,
  buildMatchFilter,
  buildAndClause,
} from "./common.js";

export type StreakType =
  | "fifty_plus"
  | "duck_streak"
  | "team_wins"
  | "team_losses";

/**
 * Gaps-and-islands streak queries.
 *
 * Batter streaks run over consecutive innings (ordered by date), team streaks
 * over consecutive matches. No-result matches are excluded from team sequences
 * (they don't break a streak); draws and ties do break win/loss streaks.
 */
export function buildStreaksQuery(
  streakType: StreakType,
  focusName: string | undefined,
  filters: MatchFilter,
  runThreshold: number,
  limit: number
): { sql: string; params: Record<string, string | number> } {
  const { whereClauses, params } = buildMatchFilter(filters);
  params.limit = limit;

  if (streakType === "team_wins" || streakType === "team_losses") {
    const wanted = streakType === "team_wins" ? "W" : "L";
    if (focusName) {
      whereClauses.push("t.team ILIKE '%' || $focus_name || '%'");
      params.focus_name = focusName;
    }
    const filterStr = buildAndClause(whereClauses);
    const sql = `
      WITH team_matches AS (
        SELECT
          t.team,
          m.match_id,
          m.date_start,
          CASE
            WHEN m.outcome_winner = t.team THEN 'W'
            WHEN m.outcome_winner IS NOT NULL THEN 'L'
            WHEN m.outcome_result IN ('draw', 'tie') THEN 'D'
            ELSE NULL
          END AS result
        FROM matches m
        CROSS JOIN LATERAL (VALUES (m.team1), (m.team2)) AS t(team)
        WHERE TRUE
          ${filterStr}
      ),
      seq AS (
        SELECT
          team,
          date_start,
          CASE WHEN result = '${wanted}' THEN 1 ELSE 0 END AS q,
          ROW_NUMBER() OVER (PARTITION BY team ORDER BY date_start, match_id) AS rn
        FROM team_matches
        WHERE result IS NOT NULL
      ),
      islands AS (
        SELECT
          team,
          date_start,
          q,
          rn - ROW_NUMBER() OVER (PARTITION BY team, q ORDER BY rn) AS grp
        FROM seq
      )
      SELECT
        team,
        COUNT(*) AS streak_length,
        MIN(date_start) AS start_date,
        MAX(date_start) AS end_date
      FROM islands
      WHERE q = 1
      GROUP BY team, grp
      HAVING COUNT(*) >= 2
      ORDER BY streak_length DESC, end_date DESC
      LIMIT $limit
    `;
    return { sql, params };
  }

  // Batter streaks: fifty_plus (>= threshold runs) or duck_streak
  if (focusName) {
    whereClauses.push("d.batter ILIKE '%' || $focus_name || '%'");
    params.focus_name = focusName;
  }
  const filterStr = buildAndClause(whereClauses);
  const qualifies =
    streakType === "duck_streak"
      ? "runs = 0 AND was_dismissed = 1"
      : "runs >= $run_threshold";
  if (streakType === "fifty_plus") {
    params.run_threshold = runThreshold;
  }

  const sql = `
    WITH innings_scores AS (
      SELECT
        d.batter,
        d.batter_id,
        d.match_id,
        d.innings_number,
        MIN(m.date_start) AS date,
        SUM(d.runs_batter) AS runs,
        ${BAT.wasDismissed} AS was_dismissed
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      WHERE TRUE
        ${filterStr}
      GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
    ),
    seq AS (
      SELECT
        batter,
        batter_id,
        date,
        runs,
        CASE WHEN ${qualifies} THEN 1 ELSE 0 END AS q,
        ROW_NUMBER() OVER (
          PARTITION BY batter ORDER BY date, match_id, innings_number
        ) AS rn
      FROM innings_scores
    ),
    islands AS (
      SELECT
        batter,
        batter_id,
        date,
        runs,
        q,
        rn - ROW_NUMBER() OVER (PARTITION BY batter, q ORDER BY rn) AS grp
      FROM seq
    )
    SELECT
      batter AS player_name,
      batter_id AS player_id,
      COUNT(*) AS streak_length,
      MIN(date) AS start_date,
      MAX(date) AS end_date,
      SUM(runs) AS runs_in_streak,
      MAX(runs) AS highest_score
    FROM islands
    WHERE q = 1
    GROUP BY batter, batter_id, grp
    HAVING COUNT(*) >= 2
    ORDER BY streak_length DESC, runs_in_streak DESC
    LIMIT $limit
  `;
  return { sql, params };
}
