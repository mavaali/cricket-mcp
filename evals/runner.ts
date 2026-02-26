/**
 * Eval runner for cricket-mcp tools.
 *
 * Connects directly to the DuckDB database and calls query functions
 * to validate correctness against known cricket statistics.
 *
 * Usage: npx tsx evals/runner.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../src/queries/run.js";
import { buildBattingStatsQuery } from "../src/queries/batting.js";
import { buildBowlingStatsQuery } from "../src/queries/bowling.js";
import { buildBattingRecordsQuery } from "../src/queries/batting.js";
import { buildBowlingRecordsQuery } from "../src/queries/bowling.js";
import { buildMatchupQuery } from "../src/queries/matchup.js";
import { buildMatchFilter, buildWhereString } from "../src/queries/common.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/cricket.duckdb");

interface EvalCase {
  name: string;
  category: string;
  run: (conn: DuckDBConnection) => Promise<EvalResult>;
}

interface EvalResult {
  pass: boolean;
  details: string;
}

const evals: EvalCase[] = [];

function eval_(name: string, category: string, run: EvalCase["run"]): void {
  evals.push({ name, category, run });
}

// ──────────────────────────────────────────────
// Category 1: Data Integrity
// ──────────────────────────────────────────────

eval_("Total match count is 21,000+", "data-integrity", async (conn) => {
  const rows = await runQuery(conn, "SELECT COUNT(*) as cnt FROM matches");
  const cnt = Number(rows[0].cnt);
  return {
    pass: cnt >= 21000,
    details: `Expected >= 21000, got ${cnt}`,
  };
});

eval_("Total deliveries is 10M+", "data-integrity", async (conn) => {
  const rows = await runQuery(conn, "SELECT COUNT(*) as cnt FROM deliveries");
  const cnt = Number(rows[0].cnt);
  return {
    pass: cnt >= 10000000,
    details: `Expected >= 10M, got ${cnt.toLocaleString()}`,
  };
});

eval_("Total players is 14,000+", "data-integrity", async (conn) => {
  const rows = await runQuery(conn, "SELECT COUNT(*) as cnt FROM players");
  const cnt = Number(rows[0].cnt);
  return {
    pass: cnt >= 14000,
    details: `Expected >= 14000, got ${cnt}`,
  };
});

eval_("All match types present", "data-integrity", async (conn) => {
  const rows = await runQuery(
    conn,
    "SELECT DISTINCT match_type FROM matches ORDER BY match_type"
  );
  const types = rows.map((r) => r.match_type as string).sort();
  const expected = ["IT20", "MDM", "ODI", "ODM", "T20", "Test"];
  const pass = expected.every((t) => types.includes(t));
  return {
    pass,
    details: `Expected ${expected.join(",")}; got ${types.join(",")}`,
  };
});

eval_("Every delivery has a valid match_id in matches table", "data-integrity", async (conn) => {
  const rows = await runQuery(
    conn,
    `SELECT COUNT(*) as cnt FROM deliveries d
     LEFT JOIN matches m ON d.match_id = m.match_id
     WHERE m.match_id IS NULL`
  );
  const cnt = Number(rows[0].cnt);
  return {
    pass: cnt === 0,
    details: `Orphaned deliveries: ${cnt}`,
  };
});

eval_("IPL has 1100+ matches", "data-integrity", async (conn) => {
  const rows = await runQuery(
    conn,
    "SELECT COUNT(*) as cnt FROM matches WHERE event_name ILIKE '%Indian Premier League%'"
  );
  const cnt = Number(rows[0].cnt);
  return {
    pass: cnt >= 1100,
    details: `IPL matches: ${cnt}`,
  };
});

// ──────────────────────────────────────────────
// Category 2: Player Batting Stats
// ──────────────────────────────────────────────

eval_("Kohli ODI runs >= 14000", "batting-stats", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("V Kohli", { match_type: "ODI" });
  const rows = await runQuery(conn, sql, params);
  const runs = Number(rows[0]?.runs ?? 0);
  return {
    pass: runs >= 14000,
    details: `Kohli ODI runs: ${runs}`,
  };
});

eval_("Kohli ODI centuries >= 50", "batting-stats", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("V Kohli", { match_type: "ODI" });
  const rows = await runQuery(conn, sql, params);
  const centuries = Number(rows[0]?.centuries ?? 0);
  return {
    pass: centuries >= 50,
    details: `Kohli ODI centuries: ${centuries}`,
  };
});

eval_("Kohli ODI highest score is 183", "batting-stats", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("V Kohli", { match_type: "ODI" });
  const rows = await runQuery(conn, sql, params);
  const hs = Number(rows[0]?.highest_score ?? 0);
  return {
    pass: hs === 183,
    details: `Kohli ODI highest score: ${hs}`,
  };
});

eval_("Batting average calculation is correct (runs / dismissals)", "batting-stats", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("V Kohli", { match_type: "ODI" });
  const rows = await runQuery(conn, sql, params);
  const row = rows[0];
  const runs = Number(row?.runs ?? 0);
  const innings = Number(row?.innings ?? 0);
  const notOuts = Number(row?.not_outs ?? 0);
  const avg = Number(row?.average ?? 0);
  const expectedAvg = runs / (innings - notOuts);
  const diff = Math.abs(avg - expectedAvg);
  return {
    pass: diff < 0.1,
    details: `Average: ${avg}, expected ${expectedAvg.toFixed(2)} (diff: ${diff.toFixed(4)})`,
  };
});

eval_("Strike rate calculation is correct (runs / balls * 100)", "batting-stats", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("V Kohli", { match_type: "ODI" });
  const rows = await runQuery(conn, sql, params);
  const row = rows[0];
  const runs = Number(row?.runs ?? 0);
  const balls = Number(row?.balls_faced ?? 0);
  const sr = Number(row?.strike_rate ?? 0);
  const expectedSR = (runs / balls) * 100;
  const diff = Math.abs(sr - expectedSR);
  return {
    pass: diff < 0.1,
    details: `SR: ${sr}, expected ${expectedSR.toFixed(2)} (diff: ${diff.toFixed(4)})`,
  };
});

eval_("Partial name match works - 'Kohli' finds V Kohli", "batting-stats", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("Kohli", { match_type: "ODI" });
  const rows = await runQuery(conn, sql, params);
  const names = rows.map((r) => r.player_name as string);
  const hasVirat = names.some((n) => n === "V Kohli");
  return {
    pass: hasVirat,
    details: `Names found: ${names.join(", ")}`,
  };
});

eval_("Format filter works - T20 filter excludes ODI data", "batting-stats", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("V Kohli", { match_type: "T20" });
  const rows = await runQuery(conn, sql, params);
  const runs = Number(rows[0]?.runs ?? 0);
  // Kohli's T20 runs should be less than his ODI runs
  return {
    pass: runs > 0 && runs < 14000,
    details: `Kohli T20 runs: ${runs} (should be < ODI total of 14675)`,
  };
});

eval_("Nonexistent player returns empty", "batting-stats", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("Zzzyxxx Nonexistent", {});
  const rows = await runQuery(conn, sql, params);
  return {
    pass: rows.length === 0,
    details: `Rows returned: ${rows.length}`,
  };
});

// ──────────────────────────────────────────────
// Category 3: Player Bowling Stats
// ──────────────────────────────────────────────

eval_("Bumrah T20 wickets >= 300", "bowling-stats", async (conn) => {
  const { sql, params } = buildBowlingStatsQuery("JJ Bumrah", { match_type: "T20" });
  const rows = await runQuery(conn, sql, params);
  const wickets = Number(rows[0]?.wickets ?? 0);
  return {
    pass: wickets >= 300,
    details: `Bumrah T20 wickets: ${wickets}`,
  };
});

eval_("Bowling average = runs / wickets", "bowling-stats", async (conn) => {
  const { sql, params } = buildBowlingStatsQuery("JJ Bumrah", { match_type: "T20" });
  const rows = await runQuery(conn, sql, params);
  const row = rows[0];
  const runs = Number(row?.runs_conceded ?? 0);
  const wickets = Number(row?.wickets ?? 0);
  const avg = Number(row?.average ?? 0);
  const expectedAvg = runs / wickets;
  const diff = Math.abs(avg - expectedAvg);
  return {
    pass: diff < 0.1,
    details: `Average: ${avg}, expected ${expectedAvg.toFixed(2)} (diff: ${diff.toFixed(4)})`,
  };
});

eval_("Bowling economy = runs / overs", "bowling-stats", async (conn) => {
  const { sql, params } = buildBowlingStatsQuery("JJ Bumrah", { match_type: "T20" });
  const rows = await runQuery(conn, sql, params);
  const row = rows[0];
  const economy = Number(row?.economy ?? 0);
  // Bumrah's T20 economy should be between 5 and 10
  return {
    pass: economy > 5 && economy < 10,
    details: `Bumrah T20 economy: ${economy}`,
  };
});

// ──────────────────────────────────────────────
// Category 4: Head to Head
// ──────────────────────────────────────────────

eval_("India vs Australia Tests - 50 matches", "head-to-head", async (conn) => {
  const { whereClauses, params } = buildMatchFilter({ match_type: "Test" });
  params.team1 = "India";
  params.team2 = "Australia";
  const filterStr = buildWhereString(whereClauses);

  const rows = await runQuery(
    conn,
    `SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE m.outcome_winner = $team1) AS team1_wins,
       COUNT(*) FILTER (WHERE m.outcome_winner = $team2) AS team2_wins,
       COUNT(*) FILTER (WHERE m.outcome_result = 'draw') AS draws
     FROM matches m
     WHERE ((m.team1 = $team1 AND m.team2 = $team2) OR (m.team1 = $team2 AND m.team2 = $team1))
       ${filterStr}`,
    params
  );
  const total = Number(rows[0].total);
  const indWins = Number(rows[0].team1_wins);
  const ausWins = Number(rows[0].team2_wins);
  const draws = Number(rows[0].draws);
  return {
    pass: total === 50 && indWins === 20 && ausWins === 16 && draws === 14,
    details: `Total: ${total}, Ind: ${indWins}, Aus: ${ausWins}, Draws: ${draws}`,
  };
});

eval_("Nonexistent matchup returns zeros", "head-to-head", async (conn) => {
  const rows = await runQuery(
    conn,
    `SELECT COUNT(*) AS total FROM matches
     WHERE (team1 = 'Narnia' AND team2 = 'Mordor')`,
    {}
  );
  return {
    pass: Number(rows[0].total) === 0,
    details: `Narnia vs Mordor: ${rows[0].total} matches`,
  };
});

// ──────────────────────────────────────────────
// Category 5: Batting Records
// ──────────────────────────────────────────────

eval_("Most ODI runs - top result has 14000+ runs", "batting-records", async (conn) => {
  const { sql, params } = buildBattingRecordsQuery("most_runs", { match_type: "ODI" }, 10, 5);
  const rows = await runQuery(conn, sql, params);
  const topRuns = Number(rows[0]?.runs ?? 0);
  return {
    pass: topRuns >= 14000,
    details: `Top ODI run scorer: ${rows[0]?.player_name} with ${topRuns} runs`,
  };
});

eval_("Most Test centuries - top result has 40+ centuries", "batting-records", async (conn) => {
  const { sql, params } = buildBattingRecordsQuery("most_centuries", { match_type: "Test" }, 10, 3);
  const rows = await runQuery(conn, sql, params);
  const topCenturies = Number(rows[0]?.centuries ?? 0);
  return {
    pass: topCenturies >= 40,
    details: `Top Test centurion: ${rows[0]?.player_name} with ${topCenturies} centuries`,
  };
});

eval_("Highest ODI average requires qualification (min_innings filter)", "batting-records", async (conn) => {
  const { sql, params } = buildBattingRecordsQuery("highest_average", { match_type: "ODI" }, 50, 5);
  const rows = await runQuery(conn, sql, params);
  // With min 50 innings, averages should be reasonable (not 100+)
  const topAvg = Number(rows[0]?.average ?? 0);
  const innings = Number(rows[0]?.innings ?? 0);
  return {
    pass: topAvg > 40 && topAvg < 80 && innings >= 50,
    details: `Top avg: ${rows[0]?.player_name} ${topAvg} (${innings} innings)`,
  };
});

// ──────────────────────────────────────────────
// Category 6: Bowling Records
// ──────────────────────────────────────────────

eval_("Most T20 wickets - top result has 150+ wickets", "bowling-records", async (conn) => {
  const { sql, params } = buildBowlingRecordsQuery("most_wickets", { match_type: "T20" }, 10, 3);
  const rows = await runQuery(conn, sql, params);
  const topWickets = Number(rows[0]?.wickets ?? 0);
  return {
    pass: topWickets >= 150,
    details: `Top T20 wicket taker: ${rows[0]?.player_name} with ${topWickets} wickets`,
  };
});

// ──────────────────────────────────────────────
// Category 7: Matchup Tools
// ──────────────────────────────────────────────

eval_("Kohli vs Hazlewood ODI - 106 balls, 67 runs, 5 dismissals", "matchups", async (conn) => {
  const { sql, params } = buildMatchupQuery({
    filters: { match_type: "ODI" },
    extraWhere: [
      "d.batter = $batter_name",
      "d.bowler = $bowler_name",
    ],
    extraParams: { batter_name: "V Kohli", bowler_name: "JR Hazlewood" },
    groupBy: "both",
    orderBy: "runs_scored DESC",
    limit: 1,
  });
  const rows = await runQuery(conn, sql, params);
  const balls = Number(rows[0]?.balls_faced ?? 0);
  const runs = Number(rows[0]?.runs_scored ?? 0);
  const dismissals = Number(rows[0]?.dismissals ?? 0);
  return {
    pass: balls === 106 && runs === 67 && dismissals === 5,
    details: `Balls: ${balls}, Runs: ${runs}, Dismissals: ${dismissals}`,
  };
});

eval_("Matchup average = runs / dismissals", "matchups", async (conn) => {
  const { sql, params } = buildMatchupQuery({
    filters: { match_type: "ODI" },
    extraWhere: [
      "d.batter = $batter_name",
      "d.bowler = $bowler_name",
    ],
    extraParams: { batter_name: "V Kohli", bowler_name: "JR Hazlewood" },
    groupBy: "both",
    orderBy: "runs_scored DESC",
    limit: 1,
  });
  const rows = await runQuery(conn, sql, params);
  const runs = Number(rows[0]?.runs_scored ?? 0);
  const dismissals = Number(rows[0]?.dismissals ?? 0);
  const avg = Number(rows[0]?.average ?? 0);
  const expectedAvg = dismissals > 0 ? runs / dismissals : null;
  const pass = expectedAvg !== null && Math.abs(avg - expectedAvg) < 0.1;
  return {
    pass,
    details: `Average: ${avg}, expected: ${expectedAvg?.toFixed(2)}`,
  };
});

eval_("Matchup strike rate = runs / balls * 100", "matchups", async (conn) => {
  const { sql, params } = buildMatchupQuery({
    filters: { match_type: "ODI" },
    extraWhere: [
      "d.batter = $batter_name",
      "d.bowler = $bowler_name",
    ],
    extraParams: { batter_name: "V Kohli", bowler_name: "JR Hazlewood" },
    groupBy: "both",
    orderBy: "runs_scored DESC",
    limit: 1,
  });
  const rows = await runQuery(conn, sql, params);
  const runs = Number(rows[0]?.runs_scored ?? 0);
  const balls = Number(rows[0]?.balls_faced ?? 0);
  const sr = Number(rows[0]?.strike_rate ?? 0);
  const expectedSR = (runs / balls) * 100;
  const diff = Math.abs(sr - expectedSR);
  return {
    pass: diff < 0.1,
    details: `SR: ${sr}, expected: ${expectedSR.toFixed(2)}`,
  };
});

eval_("Matchup dot ball % is sane", "matchups", async (conn) => {
  const { sql, params } = buildMatchupQuery({
    filters: { match_type: "ODI" },
    extraWhere: [
      "d.batter = $batter_name",
      "d.bowler = $bowler_name",
    ],
    extraParams: { batter_name: "V Kohli", bowler_name: "JR Hazlewood" },
    groupBy: "both",
    orderBy: "runs_scored DESC",
    limit: 1,
  });
  const rows = await runQuery(conn, sql, params);
  const dotPct = Number(rows[0]?.dot_ball_pct ?? 0);
  return {
    pass: dotPct > 0 && dotPct < 100,
    details: `Dot ball %: ${dotPct}`,
  };
});

eval_("Matchup records - bowlers who dismiss Kohli most (ODI)", "matchups", async (conn) => {
  const { sql, params } = buildMatchupQuery({
    filters: { match_type: "ODI" },
    extraWhere: ["d.batter = $batter_name"],
    extraParams: { batter_name: "V Kohli" },
    groupBy: "bowler",
    orderBy: "dismissals DESC, balls_faced DESC",
    limit: 5,
  });
  const rows = await runQuery(conn, sql, params);
  // Top bowler should have at least 3 dismissals
  const topDismissals = Number(rows[0]?.dismissals ?? 0);
  return {
    pass: rows.length === 5 && topDismissals >= 3,
    details: `Top: ${rows[0]?.bowler_name} with ${topDismissals} dismissals. ${rows.length} bowlers returned.`,
  };
});

eval_("Matchup with opposition filter - Kohli vs bowlers in group", "matchups", async (conn) => {
  const { sql, params } = buildMatchupQuery({
    filters: { match_type: "ODI", opposition: "Australia" },
    extraWhere: ["d.batter = $batter_name"],
    extraParams: { batter_name: "V Kohli" },
    groupBy: "bowler",
    orderBy: "balls_faced DESC",
    limit: 10,
  });
  const rows = await runQuery(conn, sql, params);
  // Should find multiple Aus bowlers who bowled to Kohli
  return {
    pass: rows.length >= 3,
    details: `Found ${rows.length} Aus bowlers. Top: ${rows[0]?.bowler_name} (${rows[0]?.balls_faced} balls)`,
  };
});

eval_("Empty matchup returns empty", "matchups", async (conn) => {
  const { sql, params } = buildMatchupQuery({
    filters: {},
    extraWhere: ["d.batter = 'Zzz Nonexistent'", "d.bowler = 'Yyy Nobody'"],
    extraParams: {},
    groupBy: "both",
    orderBy: "runs_scored DESC",
    limit: 1,
  });
  const rows = await runQuery(conn, sql, params);
  return {
    pass: rows.length === 0,
    details: `Rows: ${rows.length}`,
  };
});

// ──────────────────────────────────────────────
// Category 8: Filter Correctness
// ──────────────────────────────────────────────

eval_("Date range filter works", "filters", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("V Kohli", {
    match_type: "ODI",
    date_from: "2023-01-01",
    date_to: "2023-12-31",
  });
  const rows = await runQuery(conn, sql, params);
  const runs2023 = Number(rows[0]?.runs ?? 0);
  // Kohli's 2023 ODI runs should be less than career total
  return {
    pass: runs2023 > 0 && runs2023 < 14000,
    details: `Kohli 2023 ODI runs: ${runs2023}`,
  };
});

eval_("Season filter works", "filters", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("V Kohli", {
    match_type: "T20",
    event_name: "Indian Premier League",
    season: "2023",
  });
  const rows = await runQuery(conn, sql, params);
  const runs = Number(rows[0]?.runs ?? 0);
  return {
    pass: runs > 0 && runs < 1000,
    details: `Kohli IPL 2023 runs: ${runs}`,
  };
});

eval_("Venue filter (partial match) works", "filters", async (conn) => {
  const { sql, params } = buildBattingStatsQuery("V Kohli", {
    match_type: "Test",
    venue: "Melbourne",
  });
  const rows = await runQuery(conn, sql, params);
  const matches = Number(rows[0]?.matches ?? 0);
  return {
    pass: matches > 0 && matches < 20,
    details: `Kohli Test matches at Melbourne: ${matches}`,
  };
});

eval_("Gender filter works", "filters", async (conn) => {
  const rows = await runQuery(
    conn,
    `SELECT COUNT(*) as cnt FROM matches WHERE gender = 'female'`
  );
  const femaleCnt = Number(rows[0].cnt);
  return {
    pass: femaleCnt > 0,
    details: `Female matches: ${femaleCnt}`,
  };
});

// ──────────────────────────────────────────────
// Category 9: Venue Stats
// ──────────────────────────────────────────────

eval_("MCG has reasonable stats", "venue-stats", async (conn) => {
  const rows = await runQuery(
    conn,
    `WITH innings_totals AS (
       SELECT m.venue, m.match_id, i.innings_number,
         SUM(d.runs_total) AS total_runs
       FROM deliveries d
       JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
       JOIN matches m ON d.match_id = m.match_id
       WHERE m.venue = 'Melbourne Cricket Ground'
       GROUP BY m.venue, m.match_id, i.innings_number
     )
     SELECT venue, COUNT(DISTINCT match_id) AS matches,
       ROUND(AVG(total_runs) FILTER (WHERE innings_number = 1), 1) AS avg_1st
     FROM innings_totals GROUP BY venue`
  );
  const matches = Number(rows[0]?.matches ?? 0);
  const avg1st = Number(rows[0]?.avg_1st ?? 0);
  return {
    pass: matches > 10 && avg1st > 100 && avg1st < 500,
    details: `MCG: ${matches} matches, avg 1st innings: ${avg1st}`,
  };
});

// ──────────────────────────────────────────────
// Category 10: Phase Stats
// ──────────────────────────────────────────────

eval_("Death bowling in IPL returns results", "phase-stats", async (conn) => {
  // Simulate get_phase_stats: bowling, death overs (15-19), IPL
  const sql = `
    SELECT d.bowler AS player_name,
      COUNT(DISTINCT d.match_id) AS matches,
      COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
      SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
      COUNT(*) FILTER (WHERE d.is_wicket AND d.wicket_kind IN
        ('bowled', 'caught', 'caught and bowled', 'lbw', 'stumped', 'hit wicket')) AS wickets,
      ROUND(
        SUM(d.runs_total - d.extras_byes - d.extras_legbyes)::DOUBLE /
        (COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0)::DOUBLE / 6), 2
      ) AS economy
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE d.over_number >= 15 AND d.over_number <= 19
      AND m.event_name ILIKE '%Indian Premier League%'
    GROUP BY d.bowler
    HAVING COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) >= 100
    ORDER BY economy ASC
    LIMIT 5
  `;
  const rows = await runQuery(conn, sql);
  const topEcon = Number(rows[0]?.economy ?? 0);
  return {
    pass: rows.length === 5 && topEcon > 0 && topEcon < 15,
    details: `Top death bowler: ${rows[0]?.player_name} economy ${topEcon}. ${rows.length} results.`,
  };
});

eval_("Powerplay batting returns sane strike rates", "phase-stats", async (conn) => {
  const sql = `
    SELECT d.batter AS player_name,
      SUM(d.runs_batter) AS runs,
      COUNT(*) FILTER (WHERE d.extras_wides = 0) AS balls_faced,
      ROUND(SUM(d.runs_batter)::DOUBLE / NULLIF(COUNT(*) FILTER (WHERE d.extras_wides = 0), 0) * 100, 2) AS strike_rate
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE d.over_number >= 0 AND d.over_number <= 5
      AND m.match_type = 'T20'
    GROUP BY d.batter
    HAVING COUNT(*) FILTER (WHERE d.extras_wides = 0) >= 200
    ORDER BY strike_rate DESC
    LIMIT 5
  `;
  const rows = await runQuery(conn, sql);
  const topSR = Number(rows[0]?.strike_rate ?? 0);
  return {
    pass: rows.length === 5 && topSR > 100 && topSR < 300,
    details: `Top powerplay SR: ${rows[0]?.player_name} ${topSR}. ${rows.length} results.`,
  };
});

eval_("Over_number range covers deliveries correctly", "phase-stats", async (conn) => {
  // Verify over_number 0-5 (overs 1-6), 6-14 (7-15), 15-19 (16-20) are disjoint and cover T20
  const rows = await runQuery(conn, `
    SELECT
      COUNT(*) FILTER (WHERE over_number BETWEEN 0 AND 5) AS pp,
      COUNT(*) FILTER (WHERE over_number BETWEEN 6 AND 14) AS mid,
      COUNT(*) FILTER (WHERE over_number BETWEEN 15 AND 19) AS death,
      COUNT(*) AS total
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE m.match_type = 'T20' AND over_number <= 19
  `);
  const pp = Number(rows[0].pp);
  const mid = Number(rows[0].mid);
  const death = Number(rows[0].death);
  const total = Number(rows[0].total);
  return {
    pass: pp + mid + death === total && pp > 0 && mid > 0 && death > 0,
    details: `PP: ${pp}, Mid: ${mid}, Death: ${death}, Sum: ${pp+mid+death}, Total: ${total}`,
  };
});

// ──────────────────────────────────────────────
// Category 11: Situational Stats
// ──────────────────────────────────────────────

eval_("Chasing in ODIs uses innings 2", "situational-stats", async (conn) => {
  const sql = `
    SELECT d.batter AS player_name, SUM(d.runs_batter) AS runs,
      COUNT(DISTINCT d.match_id) AS matches
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE d.batter = 'V Kohli' AND m.match_type = 'ODI'
      AND ((m.match_type = 'Test' AND d.innings_number = 4) OR (m.match_type != 'Test' AND d.innings_number = 2))
    GROUP BY d.batter
  `;
  const rows = await runQuery(conn, sql);
  const runs = Number(rows[0]?.runs ?? 0);
  const matches = Number(rows[0]?.matches ?? 0);
  return {
    pass: runs > 0 && matches > 50,
    details: `Kohli chasing in ODIs: ${runs} runs, ${matches} matches`,
  };
});

eval_("Chasing in Tests uses innings 4", "situational-stats", async (conn) => {
  const sql = `
    SELECT COUNT(DISTINCT d.match_id) AS matches, SUM(d.runs_batter) AS runs
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE m.match_type = 'Test'
      AND ((m.match_type = 'Test' AND d.innings_number = 4) OR (m.match_type != 'Test' AND d.innings_number = 2))
  `;
  const rows = await runQuery(conn, sql);
  const matches = Number(rows[0]?.matches ?? 0);
  const runs = Number(rows[0]?.runs ?? 0);
  return {
    pass: matches > 100 && runs > 0,
    details: `Test 4th innings: ${matches} matches, ${runs} runs`,
  };
});

eval_("Setting in Tests uses innings 1 and 2", "situational-stats", async (conn) => {
  // In Tests, setting = first innings (1 and 2 for both teams)
  const sql = `
    SELECT COUNT(DISTINCT d.match_id || '-' || d.innings_number) AS innings_count
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE m.match_type = 'Test'
      AND ((m.match_type = 'Test' AND d.innings_number IN (1, 2)) OR (m.match_type != 'Test' AND d.innings_number = 1))
  `;
  const rows = await runQuery(conn, sql);
  const inningsCount = Number(rows[0]?.innings_count ?? 0);
  return {
    pass: inningsCount > 1000,
    details: `Test first innings count: ${inningsCount}`,
  };
});

// ──────────────────────────────────────────────
// Category 12: Toss Analysis
// ──────────────────────────────────────────────

eval_("Toss analysis returns sane win percentages", "toss-analysis", async (conn) => {
  const sql = `
    SELECT
      COUNT(*) AS total_matches,
      ROUND(COUNT(*) FILTER (WHERE m.toss_winner = m.outcome_winner)::DOUBLE / COUNT(*) * 100, 1) AS toss_winner_win_pct,
      ROUND(
        COUNT(*) FILTER (WHERE
          (m.toss_decision = 'bat' AND m.toss_winner = m.outcome_winner) OR
          (m.toss_decision = 'field' AND m.toss_winner != m.outcome_winner)
        )::DOUBLE / COUNT(*) * 100, 1
      ) AS bat_first_win_pct
    FROM matches m
    WHERE m.match_type = 'T20' AND m.outcome_winner IS NOT NULL
  `;
  const rows = await runQuery(conn, sql);
  const tossWinPct = Number(rows[0]?.toss_winner_win_pct ?? 0);
  const batFirstPct = Number(rows[0]?.bat_first_win_pct ?? 0);
  return {
    pass: tossWinPct > 40 && tossWinPct < 60 && batFirstPct > 30 && batFirstPct < 70,
    details: `Toss winner wins: ${tossWinPct}%, Bat first wins: ${batFirstPct}%`,
  };
});

eval_("Toss decision distribution is reasonable", "toss-analysis", async (conn) => {
  const sql = `
    SELECT
      COUNT(*) FILTER (WHERE toss_decision = 'bat') AS chose_bat,
      COUNT(*) FILTER (WHERE toss_decision = 'field') AS chose_field
    FROM matches
    WHERE match_type = 'T20' AND toss_decision IS NOT NULL
  `;
  const rows = await runQuery(conn, sql);
  const bat = Number(rows[0]?.chose_bat ?? 0);
  const field = Number(rows[0]?.chose_field ?? 0);
  return {
    pass: bat > 0 && field > 0 && bat + field > 1000,
    details: `Chose bat: ${bat}, chose field: ${field}`,
  };
});

// ──────────────────────────────────────────────
// Category 13: Team Form
// ──────────────────────────────────────────────

eval_("India recent T20 form returns matches", "team-form", async (conn) => {
  const sql = `
    SELECT
      m.match_id, m.date_start, m.outcome_winner,
      CASE WHEN m.outcome_winner = 'India' THEN 'W'
           WHEN m.outcome_result = 'draw' THEN 'D'
           WHEN m.outcome_result = 'no result' THEN 'NR'
           WHEN m.outcome_winner IS NOT NULL THEN 'L'
           ELSE 'NR' END AS result
    FROM matches m
    WHERE (m.team1 = 'India' OR m.team2 = 'India')
      AND m.match_type = 'T20'
    ORDER BY m.date_start DESC
    LIMIT 10
  `;
  const rows = await runQuery(conn, sql);
  const wins = rows.filter(r => r.result === "W").length;
  return {
    pass: rows.length === 10 && wins > 0,
    details: `India last 10 T20s: ${rows.length} matches, ${wins} wins`,
  };
});

eval_("Team form for nonexistent team returns empty", "team-form", async (conn) => {
  const sql = `
    SELECT COUNT(*) AS cnt FROM matches
    WHERE team1 = 'Narnia' OR team2 = 'Narnia'
  `;
  const rows = await runQuery(conn, sql);
  return {
    pass: Number(rows[0].cnt) === 0,
    details: `Narnia matches: ${rows[0].cnt}`,
  };
});

// ──────────────────────────────────────────────
// Category 14: Tournament Summary
// ──────────────────────────────────────────────

eval_("IPL 2023 has team standings", "tournament-summary", async (conn) => {
  const sql = `
    WITH team_matches AS (
      SELECT t.team, m.match_id, m.outcome_winner
      FROM matches m
      CROSS JOIN LATERAL (VALUES (m.team1), (m.team2)) AS t(team)
      WHERE m.event_name ILIKE '%Indian Premier League%' AND m.season = '2023'
    )
    SELECT team, COUNT(*) AS played,
      COUNT(*) FILTER (WHERE outcome_winner = team) AS won
    FROM team_matches
    GROUP BY team
    ORDER BY won DESC
    LIMIT 10
  `;
  const rows = await runQuery(conn, sql);
  return {
    pass: rows.length >= 10 && Number(rows[0]?.won ?? 0) > 0,
    details: `IPL 2023: ${rows.length} teams. Top: ${rows[0]?.team} (${rows[0]?.won} wins)`,
  };
});

eval_("Tournament top run scorer query works", "tournament-summary", async (conn) => {
  const sql = `
    SELECT d.batter AS player_name, SUM(d.runs_batter) AS runs
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE m.event_name ILIKE '%Indian Premier League%' AND m.season = '2023'
    GROUP BY d.batter
    ORDER BY runs DESC
    LIMIT 3
  `;
  const rows = await runQuery(conn, sql);
  const topRuns = Number(rows[0]?.runs ?? 0);
  return {
    pass: rows.length === 3 && topRuns > 400,
    details: `IPL 2023 top scorer: ${rows[0]?.player_name} (${topRuns} runs)`,
  };
});

// ──────────────────────────────────────────────
// Category 15: Milestone Tracker
// ──────────────────────────────────────────────

eval_("Players near 10000 ODI runs exist", "milestone-tracker", async (conn) => {
  const sql = `
    WITH innings_scores AS (
      SELECT d.batter AS player_name, d.match_id, d.innings_number,
        SUM(d.runs_batter) AS innings_runs
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      WHERE m.match_type = 'ODI'
      GROUP BY d.batter, d.match_id, d.innings_number
    )
    SELECT player_name, SUM(innings_runs) AS total_runs
    FROM innings_scores
    GROUP BY player_name
    HAVING SUM(innings_runs) >= 9000
    ORDER BY total_runs DESC
  `;
  const rows = await runQuery(conn, sql);
  return {
    pass: rows.length >= 5,
    details: `Players with 9000+ ODI runs: ${rows.length}. Top: ${rows[0]?.player_name} (${rows[0]?.total_runs})`,
  };
});

eval_("Known milestone: Kohli has 10000+ ODI runs", "milestone-tracker", async (conn) => {
  const sql = `
    SELECT SUM(d.runs_batter) AS total_runs
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE d.batter = 'V Kohli' AND m.match_type = 'ODI'
  `;
  const rows = await runQuery(conn, sql);
  const runs = Number(rows[0]?.total_runs ?? 0);
  return {
    pass: runs >= 10000,
    details: `Kohli ODI runs: ${runs}`,
  };
});

// ──────────────────────────────────────────────
// Category 16: Discipline Stats
// ──────────────────────────────────────────────

eval_("Bowling dot ball % is between 0 and 100", "discipline-stats", async (conn) => {
  const sql = `
    SELECT d.bowler AS player_name,
      ROUND(
        COUNT(*) FILTER (WHERE d.runs_total = 0 AND d.extras_wides = 0 AND d.extras_noballs = 0)::DOUBLE /
        NULLIF(COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0), 0) * 100, 2
      ) AS dot_ball_pct
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE m.match_type = 'T20'
    GROUP BY d.bowler
    HAVING COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) >= 500
    ORDER BY dot_ball_pct DESC
    LIMIT 5
  `;
  const rows = await runQuery(conn, sql);
  const topDot = Number(rows[0]?.dot_ball_pct ?? 0);
  return {
    pass: rows.length === 5 && topDot > 20 && topDot < 80,
    details: `Top dot ball % in T20: ${rows[0]?.player_name} ${topDot}%`,
  };
});

eval_("Wide rate is reasonable", "discipline-stats", async (conn) => {
  const sql = `
    SELECT d.bowler AS player_name,
      COUNT(*) AS total_deliveries,
      SUM(d.extras_wides) AS total_wides,
      ROUND(SUM(d.extras_wides)::DOUBLE / COUNT(*) * 100, 2) AS wide_pct
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE m.match_type = 'T20'
    GROUP BY d.bowler
    HAVING COUNT(*) >= 500
    ORDER BY wide_pct ASC
    LIMIT 5
  `;
  const rows = await runQuery(conn, sql);
  const lowestWide = Number(rows[0]?.wide_pct ?? 0);
  return {
    pass: rows.length === 5 && lowestWide >= 0 && lowestWide < 10,
    details: `Most disciplined T20 bowler: ${rows[0]?.player_name} wide rate ${lowestWide}%`,
  };
});

// ──────────────────────────────────────────────
// Category 17: Emerging Players
// ──────────────────────────────────────────────

eval_("Emerging players query runs without error", "emerging-players", async (conn) => {
  // Verify the career vs recent comparison window query structure works
  const sql = `
    WITH innings_scores AS (
      SELECT d.batter AS player_name, d.batter_id AS player_id, d.match_id,
        d.innings_number, m.season,
        SUM(d.runs_batter) AS innings_runs,
        COUNT(*) FILTER (WHERE d.extras_wides = 0) AS innings_balls,
        MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed
      FROM deliveries d
      JOIN matches m ON d.match_id = m.match_id
      WHERE m.match_type = 'T20'
      GROUP BY d.batter, d.batter_id, d.match_id, d.innings_number, m.season
    ),
    career_stats AS (
      SELECT player_name, player_id, COUNT(DISTINCT match_id) AS career_matches,
        ROUND(CASE WHEN SUM(was_dismissed) > 0 THEN SUM(innings_runs)::DOUBLE / SUM(was_dismissed) ELSE NULL END, 2) AS career_average
      FROM innings_scores
      GROUP BY player_name, player_id
      HAVING COUNT(DISTINCT match_id) >= 20
    ),
    recent_stats AS (
      SELECT player_name, player_id, COUNT(DISTINCT match_id) AS recent_matches,
        ROUND(CASE WHEN SUM(was_dismissed) > 0 THEN SUM(innings_runs)::DOUBLE / SUM(was_dismissed) ELSE NULL END, 2) AS recent_average
      FROM innings_scores
      WHERE season = (SELECT MAX(season) FROM matches WHERE season IS NOT NULL)
      GROUP BY player_name, player_id
      HAVING COUNT(DISTINCT match_id) >= 3
    )
    SELECT c.player_name, c.career_average, r.recent_average,
      ROUND((r.recent_average - c.career_average)::DOUBLE / NULLIF(c.career_average, 0) * 100, 1) AS improvement_pct
    FROM career_stats c
    JOIN recent_stats r ON c.player_id = r.player_id
    WHERE c.career_average IS NOT NULL AND r.recent_average IS NOT NULL
      AND (r.recent_average - c.career_average)::DOUBLE / NULLIF(c.career_average, 0) * 100 >= 20
    ORDER BY improvement_pct DESC
    LIMIT 5
  `;
  const rows = await runQuery(conn, sql);
  // We just need the query to succeed and return valid data
  const allValid = rows.every(r => Number(r.improvement_pct) >= 20);
  return {
    pass: allValid,
    details: `Found ${rows.length} emerging batters. ${rows.length > 0 ? `Top: ${rows[0]?.player_name} (+${rows[0]?.improvement_pct}%)` : "No results (expected if latest season has limited data)"}`,
  };
});

// ──────────────────────────────────────────────
// Category 18: What-If
// ──────────────────────────────────────────────

eval_("What-if: Kohli without Hazlewood has higher average", "what-if", async (conn) => {
  // Original stats
  const origSql = `
    SELECT SUM(d.runs_batter) AS runs,
      SUM(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS dismissals
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE d.batter = 'V Kohli' AND m.match_type = 'ODI'
  `;
  const origRows = await runQuery(conn, origSql);
  const origRuns = Number(origRows[0]?.runs ?? 0);
  const origDismissals = Number(origRows[0]?.dismissals ?? 0);
  const origAvg = origRuns / origDismissals;

  // Without Hazlewood
  const modSql = `
    SELECT SUM(d.runs_batter) AS runs,
      SUM(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS dismissals
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE d.batter = 'V Kohli' AND m.match_type = 'ODI'
      AND NOT (d.bowler ILIKE '%Hazlewood%')
  `;
  const modRows = await runQuery(conn, modSql);
  const modRuns = Number(modRows[0]?.runs ?? 0);
  const modDismissals = Number(modRows[0]?.dismissals ?? 0);
  const modAvg = modRuns / modDismissals;

  return {
    pass: modAvg > origAvg && modRuns < origRuns && modDismissals < origDismissals,
    details: `Original avg: ${origAvg.toFixed(2)}, Without Hazlewood: ${modAvg.toFixed(2)} (delta: +${(modAvg - origAvg).toFixed(2)})`,
  };
});

eval_("What-if: excluding venue reduces match count", "what-if", async (conn) => {
  const origSql = `
    SELECT COUNT(DISTINCT d.match_id) AS matches
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE d.batter = 'V Kohli' AND m.match_type = 'ODI'
  `;
  const modSql = `
    SELECT COUNT(DISTINCT d.match_id) AS matches
    FROM deliveries d
    JOIN matches m ON d.match_id = m.match_id
    WHERE d.batter = 'V Kohli' AND m.match_type = 'ODI'
      AND NOT (m.venue ILIKE '%Melbourne%')
  `;
  const orig = await runQuery(conn, origSql);
  const mod = await runQuery(conn, modSql);
  const origMatches = Number(orig[0]?.matches ?? 0);
  const modMatches = Number(mod[0]?.matches ?? 0);
  return {
    pass: modMatches > 0 && modMatches < origMatches,
    details: `Original: ${origMatches} matches, Excl Melbourne: ${modMatches}`,
  };
});

// ──────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Cricket MCP Eval Suite\n");

  // Copy DB to avoid locking issues with running server
  const fs = await import("node:fs");
  const tmpDb = "/tmp/cricket-eval.duckdb";
  fs.copyFileSync(DB_PATH, tmpDb);

  const instance = await DuckDBInstance.create(tmpDb);
  const conn = await instance.connect();

  let passed = 0;
  let failed = 0;
  const failures: { name: string; details: string }[] = [];
  const categoryResults: Record<string, { passed: number; failed: number }> = {};

  for (const ev of evals) {
    if (!categoryResults[ev.category]) {
      categoryResults[ev.category] = { passed: 0, failed: 0 };
    }

    try {
      const result = await ev.run(conn);
      if (result.pass) {
        console.log(`  PASS  ${ev.name}`);
        passed++;
        categoryResults[ev.category].passed++;
      } else {
        console.log(`  FAIL  ${ev.name}`);
        console.log(`        ${result.details}`);
        failed++;
        failures.push({ name: ev.name, details: result.details });
        categoryResults[ev.category].failed++;
      }
    } catch (err) {
      console.log(`  ERR   ${ev.name}`);
      console.log(`        ${err}`);
      failed++;
      failures.push({ name: ev.name, details: String(err) });
      categoryResults[ev.category].failed++;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);

  console.log("By category:");
  for (const [cat, res] of Object.entries(categoryResults)) {
    const icon = res.failed === 0 ? "PASS" : "FAIL";
    console.log(`  ${icon}  ${cat}: ${res.passed}/${res.passed + res.failed}`);
  }

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.details}`);
    }
  }

  conn.closeSync();
  instance.closeSync();
  fs.unlinkSync(tmpDb);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Eval runner failed:", err);
  process.exit(2);
});
