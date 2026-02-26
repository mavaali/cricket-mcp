import { type MatchFilter, buildMatchFilter, buildWhereString } from "./common.js";

export function buildBattingStatsQuery(
  playerName: string,
  filters: MatchFilter
): { sql: string; params: Record<string, string | number> } {
  const { whereClauses, params } = buildMatchFilter(filters);
  params.player_name = playerName;
  const filterStr = buildWhereString(whereClauses);

  const sql = `
    WITH innings_scores AS (
      SELECT
        d.batter,
        d.batter_id,
        d.match_id,
        d.innings_number,
        m.match_type,
        m.date_start,
        m.venue,
        SUM(d.runs_batter) AS innings_runs,
        COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
        COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary) AS innings_fours,
        COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary) AS innings_sixes,
        MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      WHERE d.batter ILIKE '%' || $player_name || '%'
        ${filterStr}
      GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number, m.match_type, m.date_start, m.venue
    )
    SELECT
      batter AS player_name,
      batter_id AS player_id,
      COUNT(DISTINCT match_id) AS matches,
      COUNT(*) AS innings,
      SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) AS not_outs,
      SUM(innings_runs) AS runs,
      MAX(innings_runs) AS highest_score,
      ROUND(
        CASE
          WHEN COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) > 0
          THEN SUM(innings_runs)::DOUBLE / (COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END))
          ELSE NULL
        END, 2
      ) AS average,
      SUM(innings_balls) AS balls_faced,
      ROUND(
        CASE
          WHEN SUM(innings_balls) > 0
          THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
          ELSE NULL
        END, 2
      ) AS strike_rate,
      SUM(innings_fours) AS fours,
      SUM(innings_sixes) AS sixes,
      COUNT(*) FILTER (WHERE innings_runs >= 100) AS centuries,
      COUNT(*) FILTER (WHERE innings_runs >= 50 AND innings_runs < 100) AS fifties,
      COUNT(*) FILTER (WHERE innings_runs = 0 AND was_dismissed = 1) AS ducks
    FROM innings_scores
    GROUP BY batter, batter_id
    ORDER BY SUM(innings_runs) DESC
  `;

  return { sql, params };
}

export function buildBattingRecordsQuery(
  recordType: string,
  filters: MatchFilter,
  minInnings: number,
  limit: number
): { sql: string; params: Record<string, string | number> } {
  const { whereClauses, params } = buildMatchFilter(filters);
  params.min_innings = minInnings;
  params.limit = limit;
  const filterStr = buildWhereString(whereClauses);

  let orderBy: string;
  switch (recordType) {
    case "most_runs":
      orderBy = "runs DESC";
      break;
    case "highest_average":
      orderBy = "average DESC NULLS LAST";
      break;
    case "highest_strike_rate":
      orderBy = "strike_rate DESC NULLS LAST";
      break;
    case "most_centuries":
      orderBy = "centuries DESC";
      break;
    case "most_fifties":
      orderBy = "fifties DESC";
      break;
    case "most_sixes":
      orderBy = "sixes DESC";
      break;
    case "most_fours":
      orderBy = "fours DESC";
      break;
    case "highest_score":
      orderBy = "highest_score DESC";
      break;
    default:
      orderBy = "runs DESC";
  }

  const sql = `
    WITH innings_scores AS (
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
      WHERE 1=1
        ${filterStr}
      GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
    )
    SELECT
      batter AS player_name,
      batter_id AS player_id,
      COUNT(DISTINCT match_id) AS matches,
      COUNT(*) AS innings,
      SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) AS not_outs,
      SUM(innings_runs) AS runs,
      MAX(innings_runs) AS highest_score,
      ROUND(
        CASE
          WHEN COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END) > 0
          THEN SUM(innings_runs)::DOUBLE / (COUNT(*) - SUM(CASE WHEN was_dismissed = 0 THEN 1 ELSE 0 END))
          ELSE NULL
        END, 2
      ) AS average,
      SUM(innings_balls) AS balls_faced,
      ROUND(
        CASE
          WHEN SUM(innings_balls) > 0
          THEN SUM(innings_runs)::DOUBLE / SUM(innings_balls) * 100
          ELSE NULL
        END, 2
      ) AS strike_rate,
      SUM(innings_fours) AS fours,
      SUM(innings_sixes) AS sixes,
      COUNT(*) FILTER (WHERE innings_runs >= 100) AS centuries,
      COUNT(*) FILTER (WHERE innings_runs >= 50 AND innings_runs < 100) AS fifties,
      COUNT(*) FILTER (WHERE innings_runs = 0 AND was_dismissed = 1) AS ducks
    FROM innings_scores
    GROUP BY batter, batter_id
    HAVING COUNT(*) >= $min_innings
    ORDER BY ${orderBy}
    LIMIT $limit
  `;

  return { sql, params };
}
