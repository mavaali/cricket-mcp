import { DuckDBConnection } from "@duckdb/node-api";

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS players (
  player_id       VARCHAR PRIMARY KEY,
  player_name     VARCHAR NOT NULL,
  batting_style   VARCHAR,
  bowling_style   VARCHAR,
  playing_role    VARCHAR,
  country         VARCHAR
);

CREATE TABLE IF NOT EXISTS matches (
  match_id          VARCHAR PRIMARY KEY,
  match_type        VARCHAR NOT NULL,
  gender            VARCHAR NOT NULL,
  season            VARCHAR,
  date_start        VARCHAR NOT NULL,
  date_end          VARCHAR,
  team1             VARCHAR NOT NULL,
  team2             VARCHAR NOT NULL,
  venue             VARCHAR,
  city              VARCHAR,
  toss_winner       VARCHAR,
  toss_decision     VARCHAR,
  outcome_winner    VARCHAR,
  outcome_by_runs   INTEGER,
  outcome_by_wickets INTEGER,
  outcome_by_innings INTEGER,
  outcome_result    VARCHAR,
  outcome_method    VARCHAR,
  player_of_match   VARCHAR,
  event_name        VARCHAR,
  event_match_number INTEGER,
  event_group       VARCHAR,
  event_stage       VARCHAR,
  overs_per_side    INTEGER,
  balls_per_over    INTEGER DEFAULT 6,
  team_type         VARCHAR
);

CREATE TABLE IF NOT EXISTS innings (
  match_id         VARCHAR NOT NULL,
  innings_number   INTEGER NOT NULL,
  batting_team     VARCHAR NOT NULL,
  bowling_team     VARCHAR NOT NULL,
  is_super_over    BOOLEAN DEFAULT FALSE,
  declared         BOOLEAN DEFAULT FALSE,
  forfeited        BOOLEAN DEFAULT FALSE,
  target_runs      INTEGER,
  target_overs     INTEGER,
  PRIMARY KEY (match_id, innings_number)
);

CREATE TABLE IF NOT EXISTS deliveries (
  match_id         VARCHAR NOT NULL,
  innings_number   INTEGER NOT NULL,
  over_number      INTEGER NOT NULL,
  ball_number      INTEGER NOT NULL,
  batter           VARCHAR NOT NULL,
  batter_id        VARCHAR,
  bowler           VARCHAR NOT NULL,
  bowler_id        VARCHAR,
  non_striker      VARCHAR NOT NULL,
  non_striker_id   VARCHAR,
  runs_batter      INTEGER NOT NULL DEFAULT 0,
  runs_extras      INTEGER NOT NULL DEFAULT 0,
  runs_total       INTEGER NOT NULL DEFAULT 0,
  runs_non_boundary BOOLEAN DEFAULT FALSE,
  extras_wides     INTEGER DEFAULT 0,
  extras_noballs   INTEGER DEFAULT 0,
  extras_byes      INTEGER DEFAULT 0,
  extras_legbyes   INTEGER DEFAULT 0,
  extras_penalty   INTEGER DEFAULT 0,
  is_wicket        BOOLEAN DEFAULT FALSE,
  wicket_kind      VARCHAR,
  wicket_player_out VARCHAR,
  wicket_player_out_id VARCHAR,
  wicket_fielder1  VARCHAR,
  wicket_fielder2  VARCHAR,
  PRIMARY KEY (match_id, innings_number, over_number, ball_number)
);
`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_deliveries_batter ON deliveries(batter);
CREATE INDEX IF NOT EXISTS idx_deliveries_bowler ON deliveries(bowler);
CREATE INDEX IF NOT EXISTS idx_deliveries_batter_id ON deliveries(batter_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_bowler_id ON deliveries(bowler_id);
CREATE INDEX IF NOT EXISTS idx_matches_match_type ON matches(match_type);
CREATE INDEX IF NOT EXISTS idx_matches_date_start ON matches(date_start);
CREATE INDEX IF NOT EXISTS idx_matches_venue ON matches(venue);
CREATE INDEX IF NOT EXISTS idx_matches_event ON matches(event_name);
CREATE INDEX IF NOT EXISTS idx_matches_season ON matches(season);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(player_name);
CREATE INDEX IF NOT EXISTS idx_players_batting_style ON players(batting_style);
CREATE INDEX IF NOT EXISTS idx_players_bowling_style ON players(bowling_style);
`;

export async function createSchema(conn: DuckDBConnection): Promise<void> {
  const statements = CREATE_TABLES.split(";").filter((s) => s.trim());
  for (const stmt of statements) {
    await conn.run(stmt);
  }
}

export async function migrateSchema(conn: DuckDBConnection): Promise<void> {
  const result = await conn.runAndReadAll(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'players'`
  );
  const existingCols = new Set(
    result.getRowObjectsJson().map((r) => r.column_name as string)
  );

  const newColumns = [
    { name: "batting_style", type: "VARCHAR" },
    { name: "bowling_style", type: "VARCHAR" },
    { name: "playing_role", type: "VARCHAR" },
    { name: "country", type: "VARCHAR" },
  ];

  for (const col of newColumns) {
    if (!existingCols.has(col.name)) {
      await conn.run(`ALTER TABLE players ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

export async function createIndexes(conn: DuckDBConnection): Promise<void> {
  const statements = CREATE_INDEXES.split(";").filter((s) => s.trim());
  for (const stmt of statements) {
    await conn.run(stmt);
  }
}
