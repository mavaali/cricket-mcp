import { BOWLING_WICKET_KINDS } from "./common.js";

/**
 * Canonical cricket scoring expressions.
 *
 * These exact SQL aggregate expressions were duplicated across 8+ query
 * builders and tool handlers. Centralizing them here makes the scoring logic
 * canonical in one place and prevents the variants from drifting apart over
 * time. Each expression assumes the `deliveries` table is aliased as `d` (the
 * convention used everywhere these appear), and batting expressions assume the
 * grouped subject is the batter (`d.batter`).
 *
 * Substituting these constants produces byte-for-byte identical SQL at every
 * call site — it is a pure deduplication with no behavioral change.
 */
export const BAT = {
  /** Legal balls faced by the batter (wides don't count as a ball faced). */
  ballsFaced: "COUNT(*) FILTER (WHERE d.extras_wides = 0)",
  /** Fours off the bat (excludes boundaries credited as non-bat runs). */
  fours: "COUNT(*) FILTER (WHERE d.runs_batter = 4 AND NOT d.runs_non_boundary)",
  /** Sixes off the bat. */
  sixes: "COUNT(*) FILTER (WHERE d.runs_batter = 6 AND NOT d.runs_non_boundary)",
  /** 1 if the batter was dismissed in this innings, else 0 (for not-out counts). */
  wasDismissed:
    "MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END)",
} as const;

export const BOWL = {
  /** Legal balls bowled (excludes wides and no-balls). */
  legalBalls: "COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0)",
  /** Runs conceded by the bowler (total minus byes and leg-byes). */
  runsConceded: "SUM(d.runs_total - d.extras_byes - d.extras_legbyes)",
  /** Dot balls (no runs off a legal delivery). */
  dots: "COUNT(*) FILTER (WHERE d.runs_total = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0)",
  /** Wickets credited to the bowler (excludes run outs etc.). */
  wickets: `COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN ${BOWLING_WICKET_KINDS})`,
} as const;
