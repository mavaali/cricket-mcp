import { BAT, BOWL } from "./innings.js";
import {
  type MatchFilter,
  buildMatchFilter,
  buildAndClause,
} from "./common.js";

export type InningsRecordType =
  | "highest_score"
  | "fastest_fifty"
  | "fastest_hundred"
  | "most_sixes"
  | "most_fours"
  | "best_bowling_figures"
  | "most_runs_in_over"
  | "most_expensive_over";

export function buildInningsRecordsQuery(
  recordType: InningsRecordType,
  playerName: string | undefined,
  filters: MatchFilter,
  limit: number
): { sql: string; params: Record<string, string | number> } {
  const { whereClauses, params } = buildMatchFilter(filters);
  params.limit = limit;

  const playerCol =
    recordType === "best_bowling_figures" ||
    recordType === "most_expensive_over"
      ? "d.bowler"
      : "d.batter";
  if (playerName) {
    whereClauses.push(`${playerCol} ILIKE '%' || $player_name || '%'`);
    params.player_name = playerName;
  }
  const filterStr = buildAndClause(whereClauses);

  if (recordType === "fastest_fifty" || recordType === "fastest_hundred") {
    const threshold = recordType === "fastest_fifty" ? 50 : 100;
    params.threshold = threshold;
    // Cumulative runs/balls per batter innings, ordered by delivery. The first
    // ball where cumulative runs cross the threshold gives balls-to-milestone.
    const sql = `
      WITH ball_seq AS (
        SELECT
          d.match_id,
          d.innings_number,
          d.batter,
          d.batter_id,
          m.match_type,
          m.date_start,
          m.venue,
          m.event_name,
          i.bowling_team,
          SUM(d.runs_batter) OVER w AS cum_runs,
          SUM(CASE WHEN d.extras_wides = 0 THEN 1 ELSE 0 END) OVER w AS cum_balls
        FROM deliveries d
        JOIN matches m ON d.match_id = m.match_id
        JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
        WHERE NOT i.is_super_over
          ${filterStr}
        WINDOW w AS (
          PARTITION BY d.match_id, d.innings_number, d.batter
          ORDER BY d.over_number, d.ball_number
          ROWS UNBOUNDED PRECEDING
        )
      ),
      milestones AS (
        SELECT
          match_id,
          innings_number,
          batter,
          batter_id,
          MIN(match_type) AS match_type,
          MIN(date_start) AS date,
          MIN(venue) AS venue,
          MIN(event_name) AS event_name,
          MIN(bowling_team) AS opposition,
          MIN(cum_balls) AS balls_to_milestone,
          MAX(cum_runs) AS final_runs,
          MAX(cum_balls) AS final_balls
        FROM ball_seq
        WHERE cum_runs >= $threshold
        GROUP BY match_id, innings_number, batter, batter_id
      )
      SELECT
        batter AS player_name,
        batter_id AS player_id,
        balls_to_milestone,
        final_runs,
        final_balls,
        opposition,
        match_type,
        venue,
        date,
        event_name,
        match_id,
        innings_number
      FROM milestones
      ORDER BY balls_to_milestone ASC, final_runs DESC
      LIMIT $limit
    `;
    return { sql, params };
  }

  if (recordType === "best_bowling_figures") {
    const sql = `
      WITH bowling_innings AS (
        SELECT
          d.bowler,
          d.bowler_id,
          d.match_id,
          d.innings_number,
          MIN(m.match_type) AS match_type,
          MIN(m.date_start) AS date,
          MIN(m.venue) AS venue,
          MIN(m.event_name) AS event_name,
          MIN(i.batting_team) AS opposition,
          ${BOWL.wickets} AS wickets,
          ${BOWL.runsConceded} AS runs_conceded,
          ${BOWL.legalBalls} AS legal_balls,
          ${BOWL.dots} AS dots
        FROM deliveries d
        JOIN matches m ON d.match_id = m.match_id
        JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
        WHERE NOT i.is_super_over
          ${filterStr}
        GROUP BY d.bowler, d.bowler_id, d.match_id, d.innings_number
      )
      SELECT
        bowler AS player_name,
        bowler_id AS player_id,
        wickets || '/' || runs_conceded AS figures,
        wickets,
        runs_conceded,
        (legal_balls // 6) || '.' || (legal_balls % 6) AS overs,
        dots,
        opposition,
        match_type,
        venue,
        date,
        event_name,
        match_id,
        innings_number
      FROM bowling_innings
      ORDER BY wickets DESC, runs_conceded ASC
      LIMIT $limit
    `;
    return { sql, params };
  }

  if (
    recordType === "most_runs_in_over" ||
    recordType === "most_expensive_over"
  ) {
    const isBatter = recordType === "most_runs_in_over";
    // A single over has one bowler (barring injury mid-over); a batter can
    // share it with a partner, so the batter grouping counts only their runs.
    const groupCol = isBatter ? "d.batter" : "d.bowler";
    const idCol = isBatter ? "d.batter_id" : "d.bowler_id";
    const runsExpr = isBatter
      ? "SUM(d.runs_batter)"
      : BOWL.runsConceded;
    const sql = `
      WITH over_totals AS (
        SELECT
          ${groupCol} AS player_name,
          ${idCol} AS player_id,
          d.match_id,
          d.innings_number,
          d.over_number,
          MIN(${isBatter ? "d.bowler" : "d.batter"}) AS ${isBatter ? "bowler" : "batter"},
          MIN(m.match_type) AS match_type,
          MIN(m.date_start) AS date,
          MIN(m.venue) AS venue,
          MIN(m.event_name) AS event_name,
          MIN(i.${isBatter ? "bowling_team" : "batting_team"}) AS opposition,
          ${runsExpr} AS runs,
          ${BAT.sixes} AS sixes,
          ${BAT.fours} AS fours
        FROM deliveries d
        JOIN matches m ON d.match_id = m.match_id
        JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
        WHERE NOT i.is_super_over
          ${filterStr}
        GROUP BY ${groupCol}, ${idCol}, d.match_id, d.innings_number, d.over_number
      )
      SELECT
        player_name,
        player_id,
        runs,
        sixes,
        fours,
        over_number + 1 AS over,
        ${isBatter ? "bowler" : "batter"},
        opposition,
        match_type,
        venue,
        date,
        event_name,
        match_id,
        innings_number
      FROM over_totals
      ORDER BY runs DESC, sixes DESC
      LIMIT $limit
    `;
    return { sql, params };
  }

  // highest_score, most_sixes, most_fours — innings-level batting records
  let orderBy: string;
  switch (recordType) {
    case "most_sixes":
      orderBy = "sixes DESC, runs DESC";
      break;
    case "most_fours":
      orderBy = "fours DESC, runs DESC";
      break;
    default:
      orderBy = "runs DESC, balls ASC";
  }

  const sql = `
    WITH innings_scores AS (
      SELECT
        d.batter,
        d.batter_id,
        d.match_id,
        d.innings_number,
        MIN(m.match_type) AS match_type,
        MIN(m.date_start) AS date,
        MIN(m.venue) AS venue,
        MIN(m.event_name) AS event_name,
        MIN(i.bowling_team) AS opposition,
        SUM(d.runs_batter) AS runs,
        ${BAT.ballsFaced} AS balls,
        ${BAT.fours} AS fours,
        ${BAT.sixes} AS sixes,
        ${BAT.wasDismissed} AS was_dismissed
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
      WHERE NOT i.is_super_over
        ${filterStr}
      GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number
    )
    SELECT
      batter AS player_name,
      batter_id AS player_id,
      runs,
      balls,
      ROUND(runs::DOUBLE / NULLIF(balls, 0) * 100, 2) AS strike_rate,
      fours,
      sixes,
      was_dismissed = 0 AS not_out,
      opposition,
      match_type,
      venue,
      date,
      event_name,
      match_id,
      innings_number
    FROM innings_scores
    ORDER BY ${orderBy}
    LIMIT $limit
  `;
  return { sql, params };
}
