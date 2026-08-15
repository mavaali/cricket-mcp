import {
  type MatchFilter,
  buildMatchFilter,
  buildWhereClause,
  buildAndClause,
} from "./common.js";

export type TeamRecordType =
  | "highest_total"
  | "lowest_total"
  | "biggest_win_runs"
  | "narrowest_win_runs"
  | "biggest_win_wickets"
  | "narrowest_win_wickets"
  | "highest_successful_chase"
  | "tied_matches";

/** Innings totals with match context — shared base for team record queries. */
function inningsTotalsCte(filterStr: string): string {
  return `
    innings_totals AS (
      SELECT
        i.match_id,
        i.innings_number,
        i.batting_team,
        i.bowling_team,
        i.target_runs,
        MIN(m.match_type) AS match_type,
        MIN(m.date_start) AS date,
        MIN(m.venue) AS venue,
        MIN(m.event_name) AS event_name,
        MIN(m.outcome_winner) AS outcome_winner,
        MIN(m.overs_per_side) AS overs_per_side,
        MIN(m.balls_per_over) AS balls_per_over,
        SUM(d.runs_total) AS total_runs,
        COUNT(*) FILTER (WHERE d.is_wicket) AS wickets_lost,
        COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls
      FROM innings i
      JOIN deliveries d
        ON d.match_id = i.match_id AND d.innings_number = i.innings_number
      JOIN matches m ON m.match_id = i.match_id
      WHERE NOT i.is_super_over
        ${filterStr}
      GROUP BY i.match_id, i.innings_number, i.batting_team, i.bowling_team, i.target_runs
    )`;
}

export function buildTeamRecordsQuery(
  recordType: TeamRecordType,
  filters: MatchFilter,
  limit: number
): { sql: string; params: Record<string, string | number> } {
  const { whereClauses, params } = buildMatchFilter(filters);
  params.limit = limit;

  if (recordType === "highest_total" || recordType === "lowest_total") {
    const filterStr = buildAndClause(whereClauses);
    // Lowest totals only count completed innings (all out), otherwise a rain-
    // shortened 20/2 would top the list.
    const completedOnly =
      recordType === "lowest_total" ? "WHERE wickets_lost >= 10" : "";
    const orderBy =
      recordType === "lowest_total" ? "total_runs ASC" : "total_runs DESC";
    const sql = `
      WITH ${inningsTotalsCte(filterStr)}
      SELECT
        batting_team AS team,
        total_runs || '/' || wickets_lost AS total,
        total_runs,
        wickets_lost,
        (legal_balls // 6) || '.' || (legal_balls % 6) AS overs,
        bowling_team AS opposition,
        match_type,
        venue,
        date,
        event_name,
        match_id,
        innings_number
      FROM innings_totals
      ${completedOnly}
      ORDER BY ${orderBy}
      LIMIT $limit
    `;
    return { sql, params };
  }

  if (recordType === "highest_successful_chase") {
    const filterStr = buildAndClause(whereClauses);
    // The side batting last (max innings number, super overs excluded) wins by
    // wickets — that innings total is the successful chase.
    const sql = `
      WITH ${inningsTotalsCte(filterStr)},
      with_last AS (
        -- The match's true last innings must be found across ALL innings,
        -- before filtering to the winner's rows (a winner batting first would
        -- otherwise have its own innings counted as "last").
        SELECT *,
          MAX(innings_number) OVER (PARTITION BY match_id) AS last_innings
        FROM innings_totals
      )
      SELECT
        batting_team AS team,
        total_runs || '/' || wickets_lost AS chase,
        total_runs,
        target_runs,
        wickets_lost,
        (legal_balls // 6) || '.' || (legal_balls % 6) AS overs,
        bowling_team AS opposition,
        match_type,
        venue,
        date,
        event_name,
        match_id
      FROM with_last
      WHERE batting_team = outcome_winner
        AND innings_number = last_innings
      ORDER BY total_runs DESC
      LIMIT $limit
    `;
    return { sql, params };
  }

  if (recordType === "tied_matches") {
    const filterStr = buildAndClause(whereClauses);
    const sql = `
      SELECT
        m.match_id,
        m.team1,
        m.team2,
        m.outcome_result,
        m.outcome_winner AS decided_winner,
        m.match_type,
        m.venue,
        m.date_start AS date,
        m.event_name,
        m.event_stage
      FROM matches m
      WHERE m.outcome_result = 'tie'
        ${filterStr}
      ORDER BY m.date_start DESC
      LIMIT $limit
    `;
    return { sql, params };
  }

  // Win-margin records, straight off the matches table. Wicket margins get a
  // balls-remaining tiebreak from the chase innings (limited-overs only).
  const byWickets =
    recordType === "biggest_win_wickets" ||
    recordType === "narrowest_win_wickets";
  const marginCol = byWickets ? "outcome_by_wickets" : "outcome_by_runs";
  const ascending =
    recordType === "narrowest_win_runs" ||
    recordType === "narrowest_win_wickets";

  whereClauses.push(`m.${marginCol} IS NOT NULL`);
  const filterStr = buildWhereClause(whereClauses);

  const ballsRemaining = byWickets
    ? `CASE
        WHEN m.match_type IN ('Test', 'MDM') THEN NULL
        ELSE m.overs_per_side * m.balls_per_over - chase.legal_balls
      END AS balls_remaining,`
    : "";
  const chaseJoin = byWickets
    ? `LEFT JOIN (
        SELECT d.match_id,
          COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls
        FROM deliveries d
        JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
        WHERE NOT i.is_super_over AND d.innings_number = 2
        GROUP BY d.match_id
      ) chase ON chase.match_id = m.match_id`
    : "";
  const orderBy = byWickets
    ? ascending
      ? "margin ASC, balls_remaining ASC NULLS LAST"
      : "margin DESC, balls_remaining DESC NULLS LAST"
    : ascending
      ? "margin ASC"
      : "margin DESC";

  const sql = `
    SELECT
      m.outcome_winner AS winner,
      m.${marginCol} AS margin,
      '${byWickets ? "wickets" : "runs"}' AS margin_type,
      ${ballsRemaining}
      CASE WHEN m.team1 = m.outcome_winner THEN m.team2 ELSE m.team1 END AS opposition,
      m.match_type,
      m.venue,
      m.date_start AS date,
      m.event_name,
      m.outcome_method,
      m.match_id
    FROM matches m
    ${chaseJoin}
    ${filterStr}
    ORDER BY ${orderBy}
    LIMIT $limit
  `;
  return { sql, params };
}
