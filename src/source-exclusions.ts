/**
 * Matches Cricsheet deliberately leaves out of its downloads. These are absent
 * from the source, not dropped by ingest, so every query silently omits them.
 * See https://cricsheet.org/withheld-matches.
 */
export const WITHHELD_MATCHES_NOTE =
  "Cricsheet withholds every match involving the Afghanistan men's team (Tests, ODIs and T20Is) and all Afghanistan Premier League matches, since 14 Nov 2024. " +
  "Afghanistan men's international records are therefore absent, Afghan players' stats cover only other competitions (e.g. franchise T20 leagues), " +
  "and other teams' and players' international records exclude games against Afghanistan.";

export const SERVER_INSTRUCTIONS =
  "cricket-mcp answers questions from Cricsheet ball-by-ball data. Known source gap: " +
  WITHHELD_MATCHES_NOTE +
  " When a question involves Afghanistan, an Afghan player, or a men's international record that games against Afghanistan could change, tell the user about this gap instead of presenting the result as complete.";
