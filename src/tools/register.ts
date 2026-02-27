import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { registerSearchPlayers } from "./search-players.js";
import { registerPlayerStats } from "./player-stats.js";
import { registerSearchMatches } from "./search-matches.js";
import { registerHeadToHead } from "./head-to-head.js";
import { registerMatchScorecard } from "./match-scorecard.js";
import { registerBattingRecords } from "./batting-records.js";
import { registerBowlingRecords } from "./bowling-records.js";
import { registerVenueStats } from "./venue-stats.js";
import { registerPartnerships } from "./partnerships.js";
import { registerMatchup } from "./matchup.js";
import { registerBatterVsTeamBowling } from "./batter-vs-team-bowling.js";
import { registerMatchupRecords } from "./matchup-records.js";
import { registerPhaseStats } from "./phase-stats.js";
import { registerSituationalStats } from "./situational-stats.js";
import { registerTossAnalysis } from "./toss-analysis.js";
import { registerTeamForm } from "./team-form.js";
import { registerTournamentSummary } from "./tournament-summary.js";
import { registerMilestoneTracker } from "./milestone-tracker.js";
import { registerDisciplineStats } from "./discipline-stats.js";
import { registerEmergingPlayers } from "./emerging-players.js";
import { registerWhatIf } from "./what-if.js";
import { registerFieldingStats } from "./fielding-stats.js";
import { registerDismissalAnalysis } from "./dismissal-analysis.js";
import { registerSeasonStats } from "./season-stats.js";
import { registerPlayerComparison } from "./player-comparison.js";
import { registerInningsProgression } from "./innings-progression.js";
import { registerStyleMatchup } from "./style-matchup.js";

export function registerAllTools(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  registerSearchPlayers(server, db);
  registerPlayerStats(server, db);
  registerSearchMatches(server, db);
  registerHeadToHead(server, db);
  registerMatchScorecard(server, db);
  registerBattingRecords(server, db);
  registerBowlingRecords(server, db);
  registerVenueStats(server, db);
  registerPartnerships(server, db);
  registerMatchup(server, db);
  registerBatterVsTeamBowling(server, db);
  registerMatchupRecords(server, db);
  registerPhaseStats(server, db);
  registerSituationalStats(server, db);
  registerTossAnalysis(server, db);
  registerTeamForm(server, db);
  registerTournamentSummary(server, db);
  registerMilestoneTracker(server, db);
  registerDisciplineStats(server, db);
  registerEmergingPlayers(server, db);
  registerWhatIf(server, db);
  registerFieldingStats(server, db);
  registerDismissalAnalysis(server, db);
  registerSeasonStats(server, db);
  registerPlayerComparison(server, db);
  registerInningsProgression(server, db);
  registerStyleMatchup(server, db);
}
