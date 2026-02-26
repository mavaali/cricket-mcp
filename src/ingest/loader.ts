import { DuckDBConnection } from "@duckdb/node-api";
import type {
  ParsedMatch,
  MatchRow,
  InningsRow,
  DeliveryRow,
  PlayerRow,
} from "../types/cricsheet.js";

// Track inserted player IDs across batches to avoid duplicates
const insertedPlayers = new Set<string>();

/**
 * Seed the insertedPlayers set from existing DB rows.
 * Must be called before loadBatch() in update flows to avoid duplicate player inserts.
 */
export async function seedInsertedPlayers(conn: DuckDBConnection): Promise<void> {
  const result = await conn.runAndReadAll("SELECT player_id FROM players");
  for (const row of result.getRowObjectsJson()) {
    insertedPlayers.add(row.player_id as string);
  }
}

export async function loadBatch(
  conn: DuckDBConnection,
  matches: ParsedMatch[]
): Promise<void> {
  // Collect all rows
  const allPlayers: PlayerRow[] = [];
  const allMatches: MatchRow[] = [];
  const allInnings: InningsRow[] = [];
  const allDeliveries: DeliveryRow[] = [];

  for (const m of matches) {
    allPlayers.push(...m.players);
    allMatches.push(m.match);
    allInnings.push(...m.innings);
    allDeliveries.push(...m.deliveries);
  }

  // Insert players via SQL (handles duplicates)
  for (const p of allPlayers) {
    if (insertedPlayers.has(p.player_id)) continue;
    insertedPlayers.add(p.player_id);
    await conn.run(
      "INSERT INTO players VALUES ($1, $2)",
      [p.player_id, p.player_name]
    );
  }

  // Insert matches
  if (allMatches.length > 0) {
    const appender = await conn.createAppender("matches");
    for (const m of allMatches) {
      appendStr(appender, m.match_id);
      appendStr(appender, m.match_type);
      appendStr(appender, m.gender);
      appendStrOrNull(appender, m.season);
      appendStr(appender, m.date_start);
      appendStrOrNull(appender, m.date_end);
      appendStr(appender, m.team1);
      appendStr(appender, m.team2);
      appendStrOrNull(appender, m.venue);
      appendStrOrNull(appender, m.city);
      appendStrOrNull(appender, m.toss_winner);
      appendStrOrNull(appender, m.toss_decision);
      appendStrOrNull(appender, m.outcome_winner);
      appendIntOrNull(appender, m.outcome_by_runs);
      appendIntOrNull(appender, m.outcome_by_wickets);
      appendIntOrNull(appender, m.outcome_by_innings);
      appendStrOrNull(appender, m.outcome_result);
      appendStrOrNull(appender, m.outcome_method);
      appendStrOrNull(appender, m.player_of_match);
      appendStrOrNull(appender, m.event_name);
      appendIntOrNull(appender, m.event_match_number);
      appendStrOrNull(appender, m.event_group);
      appendStrOrNull(appender, m.event_stage);
      appendIntOrNull(appender, m.overs_per_side);
      appender.appendInteger(m.balls_per_over);
      appendStrOrNull(appender, m.team_type);
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
  }

  // Insert innings
  if (allInnings.length > 0) {
    const appender = await conn.createAppender("innings");
    for (const i of allInnings) {
      appendStr(appender, i.match_id);
      appender.appendInteger(i.innings_number);
      appendStr(appender, i.batting_team);
      appendStr(appender, i.bowling_team);
      appender.appendBoolean(i.is_super_over);
      appender.appendBoolean(i.declared);
      appender.appendBoolean(i.forfeited);
      appendIntOrNull(appender, i.target_runs);
      appendIntOrNull(appender, i.target_overs);
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
  }

  // Insert deliveries
  if (allDeliveries.length > 0) {
    const appender = await conn.createAppender("deliveries");
    for (const d of allDeliveries) {
      appendStr(appender, d.match_id);
      appender.appendInteger(d.innings_number);
      appender.appendInteger(d.over_number);
      appender.appendInteger(d.ball_number);
      appendStr(appender, d.batter);
      appendStrOrNull(appender, d.batter_id);
      appendStr(appender, d.bowler);
      appendStrOrNull(appender, d.bowler_id);
      appendStr(appender, d.non_striker);
      appendStrOrNull(appender, d.non_striker_id);
      appender.appendInteger(d.runs_batter);
      appender.appendInteger(d.runs_extras);
      appender.appendInteger(d.runs_total);
      appender.appendBoolean(d.runs_non_boundary);
      appender.appendInteger(d.extras_wides);
      appender.appendInteger(d.extras_noballs);
      appender.appendInteger(d.extras_byes);
      appender.appendInteger(d.extras_legbyes);
      appender.appendInteger(d.extras_penalty);
      appender.appendBoolean(d.is_wicket);
      appendStrOrNull(appender, d.wicket_kind);
      appendStrOrNull(appender, d.wicket_player_out);
      appendStrOrNull(appender, d.wicket_player_out_id);
      appendStrOrNull(appender, d.wicket_fielder1);
      appendStrOrNull(appender, d.wicket_fielder2);
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
  }
}

function appendStr(
  appender: { appendVarchar(v: string): void },
  value: string
): void {
  appender.appendVarchar(String(value));
}

function appendStrOrNull(
  appender: { appendVarchar(v: string): void; appendNull(): void },
  value: string | null | undefined
): void {
  if (value == null) {
    appender.appendNull();
  } else {
    appender.appendVarchar(String(value));
  }
}

function appendIntOrNull(
  appender: { appendInteger(v: number): void; appendNull(): void },
  value: number | null | undefined
): void {
  if (value == null) {
    appender.appendNull();
  } else {
    appender.appendInteger(value);
  }
}
