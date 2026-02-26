import { type MatchFilter, buildMatchFilter, buildWhereString } from "./common.js";

export function buildBowlingStatsQuery(
  playerName: string,
  filters: MatchFilter
): { sql: string; params: Record<string, string | number> } {
  const { whereClauses, params } = buildMatchFilter(filters);
  params.player_name = playerName;
  const filterStr = buildWhereString(whereClauses);

  const sql = `
    WITH bowling_innings AS (
      SELECT
        d.bowler,
        d.bowler_id,
        d.match_id,
        d.innings_number,
        COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
        SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
        COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN
          ('bowled', 'caught', 'caught and bowled', 'lbw', 'stumped', 'hit wicket')) AS wickets,
        COUNT(*) FILTER (WHERE d.runs_total = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0) AS dots
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      WHERE d.bowler ILIKE '%' || $player_name || '%'
        ${filterStr}
      GROUP BY d.bowler, d.bowler_id, d.match_id, d.innings_number
    ),
    maiden_overs AS (
      SELECT
        d.bowler,
        d.match_id,
        d.innings_number,
        d.over_number,
        SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS over_runs
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      WHERE d.bowler ILIKE '%' || $player_name || '%'
        ${filterStr}
      GROUP BY d.bowler, d.match_id, d.innings_number, d.over_number
    ),
    best_figures AS (
      SELECT
        bowler,
        wickets,
        runs_conceded,
        ROW_NUMBER() OVER (PARTITION BY bowler ORDER BY wickets DESC, runs_conceded ASC) AS rn
      FROM bowling_innings
    )
    SELECT
      bi.bowler AS player_name,
      bi.bowler_id AS player_id,
      COUNT(DISTINCT bi.match_id) AS matches,
      COUNT(*) AS innings,
      CAST(SUM(bi.legal_balls) / 6 AS VARCHAR) || '.' || CAST(SUM(bi.legal_balls) % 6 AS VARCHAR) AS overs,
      SUM(bi.runs_conceded) AS runs_conceded,
      SUM(bi.wickets) AS wickets,
      (SELECT wickets || '/' || runs_conceded FROM best_figures bf WHERE bf.bowler = bi.bowler AND bf.rn = 1) AS best_bowling,
      ROUND(
        CASE
          WHEN SUM(bi.wickets) > 0
          THEN SUM(bi.runs_conceded)::DOUBLE / SUM(bi.wickets)
          ELSE NULL
        END, 2
      ) AS average,
      ROUND(
        CASE
          WHEN SUM(bi.legal_balls) > 0
          THEN SUM(bi.runs_conceded)::DOUBLE / (SUM(bi.legal_balls)::DOUBLE / 6)
          ELSE NULL
        END, 2
      ) AS economy,
      ROUND(
        CASE
          WHEN SUM(bi.wickets) > 0
          THEN SUM(bi.legal_balls)::DOUBLE / SUM(bi.wickets)
          ELSE NULL
        END, 2
      ) AS strike_rate,
      (SELECT COUNT(*) FROM maiden_overs mo WHERE mo.bowler = bi.bowler AND mo.over_runs = 0) AS maidens,
      SUM(bi.dots) AS dot_balls,
      COUNT(*) FILTER (WHERE bi.wickets >= 5) AS five_wicket_hauls,
      COUNT(*) FILTER (WHERE bi.wickets >= 4) AS four_wicket_hauls
    FROM bowling_innings bi
    GROUP BY bi.bowler, bi.bowler_id
    ORDER BY SUM(bi.wickets) DESC
  `;

  return { sql, params };
}

export function buildBowlingRecordsQuery(
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
    case "most_wickets":
      orderBy = "wickets DESC";
      break;
    case "best_average":
      orderBy = "average ASC NULLS LAST";
      break;
    case "best_economy":
      orderBy = "economy ASC NULLS LAST";
      break;
    case "best_strike_rate":
      orderBy = "strike_rate ASC NULLS LAST";
      break;
    case "most_five_wicket_hauls":
      orderBy = "five_wicket_hauls DESC";
      break;
    default:
      orderBy = "wickets DESC";
  }

  const sql = `
    WITH bowling_innings AS (
      SELECT
        d.bowler,
        d.bowler_id,
        d.match_id,
        d.innings_number,
        COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
        SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
        COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN
          ('bowled', 'caught', 'caught and bowled', 'lbw', 'stumped', 'hit wicket')) AS wickets,
        COUNT(*) FILTER (WHERE d.runs_total = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0) AS dots
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      WHERE 1=1
        ${filterStr}
      GROUP BY d.bowler, d.bowler_id, d.match_id, d.innings_number
    ),
    best_figures AS (
      SELECT
        bowler,
        wickets,
        runs_conceded,
        ROW_NUMBER() OVER (PARTITION BY bowler ORDER BY wickets DESC, runs_conceded ASC) AS rn
      FROM bowling_innings
    )
    SELECT
      bi.bowler AS player_name,
      bi.bowler_id AS player_id,
      COUNT(DISTINCT bi.match_id) AS matches,
      COUNT(*) AS innings,
      CAST(SUM(bi.legal_balls) / 6 AS VARCHAR) || '.' || CAST(SUM(bi.legal_balls) % 6 AS VARCHAR) AS overs,
      SUM(bi.runs_conceded) AS runs_conceded,
      SUM(bi.wickets) AS wickets,
      (SELECT wickets || '/' || runs_conceded FROM best_figures bf WHERE bf.bowler = bi.bowler AND bf.rn = 1) AS best_bowling,
      ROUND(
        CASE
          WHEN SUM(bi.wickets) > 0
          THEN SUM(bi.runs_conceded)::DOUBLE / SUM(bi.wickets)
          ELSE NULL
        END, 2
      ) AS average,
      ROUND(
        CASE
          WHEN SUM(bi.legal_balls) > 0
          THEN SUM(bi.runs_conceded)::DOUBLE / (SUM(bi.legal_balls)::DOUBLE / 6)
          ELSE NULL
        END, 2
      ) AS economy,
      ROUND(
        CASE
          WHEN SUM(bi.wickets) > 0
          THEN SUM(bi.legal_balls)::DOUBLE / SUM(bi.wickets)
          ELSE NULL
        END, 2
      ) AS strike_rate,
      SUM(bi.dots) AS dot_balls,
      COUNT(*) FILTER (WHERE bi.wickets >= 5) AS five_wicket_hauls,
      COUNT(*) FILTER (WHERE bi.wickets >= 4) AS four_wicket_hauls
    FROM bowling_innings bi
    GROUP BY bi.bowler, bi.bowler_id
    HAVING COUNT(*) >= $min_innings
    ORDER BY ${orderBy}
    LIMIT $limit
  `;

  return { sql, params };
}
