import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { registerSearchPlayers } from "./search-players.js";
import { registerPlayerBattingStats } from "./player-batting-stats.js";
import { registerPlayerBowlingStats } from "./player-bowling-stats.js";
import { registerSearchMatches } from "./search-matches.js";
import { registerHeadToHead } from "./head-to-head.js";
import { registerMatchScorecard } from "./match-scorecard.js";
import { registerBattingRecords } from "./batting-records.js";
import { registerBowlingRecords } from "./bowling-records.js";
import { registerVenueStats } from "./venue-stats.js";
import { registerPartnerships } from "./partnerships.js";
import { registerBatterVsBowler } from "./batter-vs-bowler.js";
import { registerBowlerVsBatter } from "./bowler-vs-batter.js";
import { registerBatterVsTeamBowling } from "./batter-vs-team-bowling.js";
import { registerMatchupRecords } from "./matchup-records.js";

export function registerAllTools(
  server: McpServer,
  db: DuckDBConnection
): void {
  registerSearchPlayers(server, db);
  registerPlayerBattingStats(server, db);
  registerPlayerBowlingStats(server, db);
  registerSearchMatches(server, db);
  registerHeadToHead(server, db);
  registerMatchScorecard(server, db);
  registerBattingRecords(server, db);
  registerBowlingRecords(server, db);
  registerVenueStats(server, db);
  registerPartnerships(server, db);
  registerBatterVsBowler(server, db);
  registerBowlerVsBatter(server, db);
  registerBatterVsTeamBowling(server, db);
  registerMatchupRecords(server, db);
}
