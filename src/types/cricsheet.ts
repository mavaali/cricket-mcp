// Types for Cricsheet JSON format v1.1.0

export interface CricsheetMatch {
  meta: CricsheetMeta;
  info: CricsheetInfo;
  innings: CricsheetInnings[];
}

export interface CricsheetMeta {
  data_version: string;
  created: string;
  revision: number;
}

export interface CricsheetInfo {
  balls_per_over: number;
  city?: string;
  dates: string[];
  event?: {
    name: string;
    match_number?: number;
    group?: string;
    stage?: string;
  };
  gender: string;
  match_type: string;
  match_type_number?: number;
  officials?: {
    match_referees?: string[];
    reserve_umpires?: string[];
    tv_umpires?: string[];
    umpires?: string[];
  };
  outcome: CricsheetOutcome;
  overs?: number;
  player_of_match?: string[];
  players: Record<string, string[]>;
  registry?: {
    people: Record<string, string>;
  };
  season: string;
  team_type?: string;
  teams: string[];
  toss?: {
    decision: string;
    winner: string;
  };
  venue?: string;
}

export interface CricsheetOutcome {
  winner?: string;
  by?: {
    runs?: number;
    wickets?: number;
    innings?: number;
  };
  result?: string; // "tie", "draw", "no result"
  method?: string; // "D/L", "VJD", etc.
}

export interface CricsheetInnings {
  team: string;
  overs: CricsheetOver[];
  declared?: boolean;
  forfeited?: boolean;
  super_over?: boolean;
  target?: {
    runs?: number;
    overs?: number;
  };
  penalty_runs?: {
    pre?: number;
    post?: number;
  };
}

export interface CricsheetOver {
  over: number;
  deliveries: CricsheetDelivery[];
}

export interface CricsheetDelivery {
  batter: string;
  bowler: string;
  non_striker: string;
  runs: {
    batter: number;
    extras: number;
    total: number;
    non_boundary?: boolean;
  };
  extras?: {
    wides?: number;
    noballs?: number;
    byes?: number;
    legbyes?: number;
    penalty?: number;
  };
  wickets?: CricsheetWicket[];
}

export interface CricsheetWicket {
  player_out: string;
  kind: string;
  fielders?: { name: string }[];
}

// Parsed row types for database insertion

export interface MatchRow {
  match_id: string;
  match_type: string;
  gender: string;
  season: string | null;
  date_start: string;
  date_end: string | null;
  team1: string;
  team2: string;
  venue: string | null;
  city: string | null;
  toss_winner: string | null;
  toss_decision: string | null;
  outcome_winner: string | null;
  outcome_by_runs: number | null;
  outcome_by_wickets: number | null;
  outcome_by_innings: number | null;
  outcome_result: string | null;
  outcome_method: string | null;
  player_of_match: string | null;
  event_name: string | null;
  event_match_number: number | null;
  event_group: string | null;
  event_stage: string | null;
  overs_per_side: number | null;
  balls_per_over: number;
  team_type: string | null;
}

export interface InningsRow {
  match_id: string;
  innings_number: number;
  batting_team: string;
  bowling_team: string;
  is_super_over: boolean;
  declared: boolean;
  forfeited: boolean;
  target_runs: number | null;
  target_overs: number | null;
}

export interface DeliveryRow {
  match_id: string;
  innings_number: number;
  over_number: number;
  ball_number: number;
  batter: string;
  batter_id: string | null;
  bowler: string;
  bowler_id: string | null;
  non_striker: string;
  non_striker_id: string | null;
  runs_batter: number;
  runs_extras: number;
  runs_total: number;
  runs_non_boundary: boolean;
  extras_wides: number;
  extras_noballs: number;
  extras_byes: number;
  extras_legbyes: number;
  extras_penalty: number;
  is_wicket: boolean;
  wicket_kind: string | null;
  wicket_player_out: string | null;
  wicket_player_out_id: string | null;
  wicket_fielder1: string | null;
  wicket_fielder2: string | null;
}

export interface PlayerRow {
  player_id: string;
  player_name: string;
  batting_style?: string | null;
  bowling_style?: string | null;
  playing_role?: string | null;
  country?: string | null;
}

export interface ParsedMatch {
  match: MatchRow;
  innings: InningsRow[];
  deliveries: DeliveryRow[];
  players: PlayerRow[];
}
