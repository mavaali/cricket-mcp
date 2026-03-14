import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "../queries/run.js";
import {
  MatchFilterSchema,
  buildMatchFilter,
  buildWhereString,
  BOWLING_WICKET_KINDS,
} from "../queries/common.js";

// ── Tunable constants ──────────────────────────────────────────────────────
// All weights are intentionally exposed as top-level constants for easy
// crowdsource adjustment.

// Batting — scale up so batting parity with bowling in high-scoring matches
const BATTING_SCALE = 1.5;
const MIN_BALLS_FOR_SR_FACTOR = 10;
const ENTRY_DIFFICULTY_BASE = 1.0;
const ENTRY_DIFFICULTY_PER_WICKET = 0.1; // +0.1x per wicket down at entry (max +0.5)
const ENTRY_DIFFICULTY_MAX = 1.5;
const NOT_OUT_FIRST_INNINGS_DISCOUNT = 0.9;
// Lost chase: batting discount when chasing team lost (scales with margin)
// Formula: max(LOST_CHASE_FLOOR, 1 - margin / (2 * target))
const LOST_CHASE_FLOOR = 0.6;

// Bowling — base wicket value × quality multiplier + economy contribution
const BASE_WICKET_VALUE = 6;
const TOP_ORDER_BONUS = 1.3; // extra mult for dismissing positions 1-3
const SET_BATTER_THRESHOLD = 25; // runs at dismissal to count as "set"
const STAR_BATTER_THRESHOLD = 40;
const SET_BATTER_MULT = 1.5;
const STAR_BATTER_MULT = 2.5;
const TAILENDER_MULT = 0.5;
const PARTNERSHIP_BREAK_BONUS_50 = 3;
const PARTNERSHIP_BREAK_BONUS_100 = 6;
const ECONOMY_SCALE_FACTOR = 2.0;
// Defence bonus: bowlers defending a total in a close win get a multiplier
// Formula: 1 + max(0, 1 - margin/DEFENCE_MARGIN_CAP)
const DEFENCE_MARGIN_CAP = 25; // margins above this get no defence bonus
const MIN_OVERS_FOR_ECONOMY = 2;
const DEATH_PHASE_MULTIPLIER = 1.3;
const MIDDLE_PHASE_MULTIPLIER = 1.1;
const POWERPLAY_PHASE_MULTIPLIER = 1.0;

// Fielding — supporting contribution, not primary
const CATCH_BASE = 2;
const DIRECT_RUNOUT_BASE = 3;
const INDIRECT_RUNOUT_BASE = 1.5;
const STUMPING_BASE = 2;

// Match importance
const STAGE_WEIGHTS: Record<string, number> = {
  Final: 1.5,
  "Semi Final": 1.3,
  "Quarter Final": 1.2,
  Qualifier: 1.2,
  "Qualifier 1": 1.2,
  "Qualifier 2": 1.2,
  Eliminator: 1.2,
  Playoff: 1.15,
  "Super Eight": 1.1,
  "Super Six": 1.1,
  "Super 12": 1.05,
  Group: 1.0,
};
const DEFAULT_STAGE_WEIGHT = 1.0;

const CLOSE_MATCH_VERY = { runs: 10, wickets: 2, bonus: 0.2 };
const CLOSE_MATCH_MODERATE = { runs: 20, wickets: 4, bonus: 0.1 };
const TIE_BONUS = 0.2;

export function registerMatchImpact(
  server: McpServer,
  db: Promise<DuckDBConnection>
): void {
  server.registerTool(
    "get_match_impact",
    {
      title: "Match Impact Score",
      description:
        "Who had the biggest impact in a specific match? Computes a context-weighted impact score for every player, combining batting, bowling, and fielding contributions. " +
        "Scores account for run contribution as % of team total, strike rate relative to match tempo, situation difficulty (entry point, chasing pressure), " +
        "wicket quality (set batters, partnership breaks), economy relative to match run rate, and fielding dismissals. " +
        "Multiplied by match importance (tournament stage, match closeness). " +
        "Use for 'Who was the MVP of the 2024 T20 WC final?', 'Impact scores for IND vs AUS at Ahmedabad'. " +
        "Requires a match_id — use search_matches first to find it. " +
        "Not for career aggregates (use get_career_impact).",
      inputSchema: {
        match_id: z
          .string()
          .describe(
            "Match ID. Use search_matches to find this first."
          ),
        player_name: z
          .string()
          .optional()
          .describe(
            "Optional: filter to a specific player (partial match). Omit to get all players in the match."
          ),
      },
    },
    async (args) => {
      const { match_id, player_name } = args;
      const params: Record<string, string | number> = { match_id };
      if (player_name) params.player_name = player_name;

      // ── 1. Get match metadata ────────────────────────────────────────
      const matchRows = await runQuery(
        db,
        `SELECT * FROM matches WHERE match_id = $match_id`,
        { match_id }
      );
      if (matchRows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No match found with ID "${match_id}".`,
            },
          ],
        };
      }
      const match = matchRows[0];

      // ── 2. Compute match-level aggregates ────────────────────────────
      const matchAggRows = await runQuery(
        db,
        `SELECT
           SUM(runs_total) AS total_runs,
           COUNT(*) FILTER (WHERE extras_wides = 0 AND extras_noballs = 0) AS total_legal_balls
         FROM deliveries
         WHERE match_id = $match_id`,
        { match_id }
      );
      const matchTotalRuns = Number(matchAggRows[0]?.total_runs ?? 0);
      const matchTotalBalls = Number(matchAggRows[0]?.total_legal_balls ?? 1);
      const matchAvgSR =
        matchTotalBalls > 0
          ? (matchTotalRuns / matchTotalBalls) * 100
          : 100;
      const matchRR =
        matchTotalBalls > 0
          ? matchTotalRuns / (matchTotalBalls / 6)
          : 6;

      // ── 3. Team totals per innings ───────────────────────────────────
      const teamTotalRows = await runQuery(
        db,
        `SELECT
           d.innings_number,
           i.batting_team,
           i.bowling_team,
           i.target_runs,
           SUM(d.runs_total) AS team_total,
           COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS team_balls
         FROM deliveries d
         JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
         WHERE d.match_id = $match_id AND i.is_super_over = FALSE
         GROUP BY d.innings_number, i.batting_team, i.bowling_team, i.target_runs
         ORDER BY d.innings_number`,
        { match_id }
      );
      const inningsMap = new Map<
        number,
        {
          batting_team: string;
          bowling_team: string;
          team_total: number;
          team_balls: number;
          target_runs: number | null;
          team_rr: number;
        }
      >();
      for (const row of teamTotalRows) {
        const inn = Number(row.innings_number);
        const total = Number(row.team_total ?? 0);
        const balls = Number(row.team_balls ?? 1);
        inningsMap.set(inn, {
          batting_team: String(row.batting_team),
          bowling_team: String(row.bowling_team),
          team_total: total,
          team_balls: balls,
          target_runs: row.target_runs != null ? Number(row.target_runs) : null,
          team_rr: balls > 0 ? total / (balls / 6) : 0,
        });
      }

      // ── 4. Batting impact ────────────────────────────────────────────
      const playerFilter = player_name
        ? "AND d.batter ILIKE '%' || $player_name || '%'"
        : "";
      const battingRows = await runQuery(
        db,
        `WITH batter_entry AS (
           -- First ball faced by each batter in each innings
           SELECT
             batter,
             batter_id,
             match_id,
             innings_number,
             MIN(over_number * 1000 + ball_number) AS entry_seq
           FROM deliveries
           WHERE match_id = $match_id
           GROUP BY batter, batter_id, match_id, innings_number
         ),
         wickets_at_entry AS (
           -- Count wickets that fell before each batter's first ball
           SELECT
             be.batter,
             be.innings_number,
             COUNT(*) AS wickets_down
           FROM batter_entry be
           JOIN deliveries d ON d.match_id = be.match_id
             AND d.innings_number = be.innings_number
             AND d.is_wicket = TRUE
             AND (d.over_number * 1000 + d.ball_number) < be.entry_seq
           GROUP BY be.batter, be.innings_number
         )
         SELECT
           d.batter AS player_name,
           d.batter_id AS player_id,
           d.innings_number,
           SUM(d.runs_batter) AS runs,
           COUNT(*) FILTER (WHERE d.extras_wides = 0) AS balls_faced,
           COUNT(*) FILTER (WHERE d.runs_batter = 4 AND d.runs_non_boundary = FALSE) AS fours,
           COUNT(*) FILTER (WHERE d.runs_batter = 6) AS sixes,
           MAX(CASE WHEN d.is_wicket AND d.wicket_player_out = d.batter THEN 1 ELSE 0 END) AS was_dismissed,
           COALESCE(we.wickets_down, 0) AS wickets_at_entry
         FROM deliveries d
         LEFT JOIN wickets_at_entry we
           ON we.batter = d.batter AND we.innings_number = d.innings_number
         WHERE d.match_id = $match_id
           ${playerFilter}
         GROUP BY d.batter, d.batter_id, d.innings_number, we.wickets_down`,
        params
      );

      const battingImpact = new Map<string, number>();
      const battingDetails = new Map<
        string,
        { runs: number; balls: number; sr: number; contribution_pct: number; situation_mult: number; impact: number }
      >();

      for (const row of battingRows) {
        const name = String(row.player_name);
        const innings = Number(row.innings_number);
        const runs = Number(row.runs ?? 0);
        const balls = Number(row.balls_faced ?? 0);
        const wasDismissed = Number(row.was_dismissed) === 1;
        const wicketsAtEntry = Number(row.wickets_at_entry ?? 0);

        const innData = inningsMap.get(innings);
        if (!innData || innData.team_total === 0) continue;

        // Run contribution (0-100 scale)
        // For chasing team: use max(team_total, target) as denominator
        // This deflates % contribution for teams that fell well short
        const isChasing = innings === 2 && innData.target_runs != null && innData.target_runs > 0;
        const denominator = isChasing
          ? Math.max(innData.team_total, innData.target_runs!)
          : innData.team_total;
        const runContribution = (runs / denominator) * 100;

        // Strike rate factor
        let srFactor = 1.0;
        if (balls >= MIN_BALLS_FOR_SR_FACTOR && matchAvgSR > 0) {
          const playerSR = (runs / balls) * 100;
          srFactor = playerSR / matchAvgSR;
          // Clamp to avoid extreme values
          srFactor = Math.max(0.5, Math.min(2.0, srFactor));
        }

        // Situation multiplier
        let situationMult = 1.0;

        // Entry difficulty
        const entryDiff = Math.min(
          ENTRY_DIFFICULTY_MAX,
          ENTRY_DIFFICULTY_BASE + wicketsAtEntry * ENTRY_DIFFICULTY_PER_WICKET
        );
        situationMult *= entryDiff;

        // Not-out adjustment (first innings only)
        if (!wasDismissed && innings === 1) {
          situationMult *= NOT_OUT_FIRST_INNINGS_DISCOUNT;
        }

        // Lost chase discount: if chasing team lost, discount batting based on margin
        let lostChaseDiscount = 1.0;
        if (isChasing && innData.batting_team !== String(match.outcome_winner)) {
          const margin = Number(match.outcome_by_runs ?? 0);
          if (margin > 0 && innData.target_runs! > 0) {
            lostChaseDiscount = Math.max(LOST_CHASE_FLOOR, 1 - margin / (2 * innData.target_runs!));
          }
        }

        const impact = runContribution * srFactor * situationMult * BATTING_SCALE * lostChaseDiscount;
        const prev = battingImpact.get(name) ?? 0;
        battingImpact.set(name, prev + impact);

        // Store details for the best innings
        const prevDetail = battingDetails.get(name);
        if (!prevDetail || impact > prevDetail.impact) {
          battingDetails.set(name, {
            runs,
            balls,
            sr: balls > 0 ? Math.round((runs / balls) * 100 * 100) / 100 : 0,
            contribution_pct: Math.round(runContribution * 100) / 100,
            situation_mult: Math.round(situationMult * 100) / 100,
            impact: Math.round(impact * 100) / 100,
          });
        }
      }

      // ── 5. Bowling impact ────────────────────────────────────────────
      const bowlerFilter = player_name
        ? "AND d.bowler ILIKE '%' || $player_name || '%'"
        : "";

      // Get per-wicket details for quality scoring
      const wicketRows = await runQuery(
        db,
        `WITH batter_runs_at_dismissal AS (
           SELECT
             d2.match_id,
             d2.innings_number,
             d2.wicket_player_out AS dismissed_batter,
             d2.bowler,
             d2.bowler_id,
             d2.wicket_kind,
             d2.over_number,
             -- Sum batter's runs up to and including this ball
             (SELECT SUM(d3.runs_batter)
              FROM deliveries d3
              WHERE d3.match_id = d2.match_id
                AND d3.innings_number = d2.innings_number
                AND d3.batter = d2.wicket_player_out
             ) AS batter_runs_in_innings,
             -- Batting position: count distinct batters who appeared before this one
             (SELECT COUNT(DISTINCT d3.batter)
              FROM deliveries d3
              WHERE d3.match_id = d2.match_id
                AND d3.innings_number = d2.innings_number
                AND d3.over_number * 1000 + d3.ball_number <=
                    (SELECT MIN(d4.over_number * 1000 + d4.ball_number)
                     FROM deliveries d4
                     WHERE d4.match_id = d2.match_id
                       AND d4.innings_number = d2.innings_number
                       AND d4.batter = d2.wicket_player_out)
             ) AS batting_position
           FROM deliveries d2
           WHERE d2.match_id = $match_id
             AND d2.is_wicket = TRUE
             AND d2.wicket_kind IN ${BOWLING_WICKET_KINDS}
             ${bowlerFilter}
         )
         SELECT * FROM batter_runs_at_dismissal`,
        params
      );

      // Get partnership sizes at each wicket
      const partnershipRows = await runQuery(
        db,
        `WITH wicket_balls AS (
           SELECT
             innings_number,
             over_number * 1000 + ball_number AS seq,
             wicket_player_out
           FROM deliveries
           WHERE match_id = $match_id AND is_wicket = TRUE
           ORDER BY innings_number, seq
         ),
         partnership_runs AS (
           SELECT
             d.innings_number,
             d.over_number * 1000 + d.ball_number AS seq,
             d.runs_total
           FROM deliveries d
           WHERE d.match_id = $match_id
         )
         SELECT
           wb.innings_number,
           wb.wicket_player_out,
           wb.seq AS wicket_seq,
           (SELECT COALESCE(SUM(pr.runs_total), 0)
            FROM partnership_runs pr
            WHERE pr.innings_number = wb.innings_number
              AND pr.seq <= wb.seq
              AND pr.seq > COALESCE(
                (SELECT MAX(wb2.seq)
                 FROM wicket_balls wb2
                 WHERE wb2.innings_number = wb.innings_number
                   AND wb2.seq < wb.seq),
                0)
           ) AS partnership_runs
         FROM wicket_balls wb`,
        { match_id }
      );

      const partnershipMap = new Map<string, number>();
      for (const row of partnershipRows) {
        const key = `${row.innings_number}_${row.wicket_player_out}`;
        partnershipMap.set(key, Number(row.partnership_runs ?? 0));
      }

      // Compute wicket values per bowler
      const bowlerWicketValue = new Map<string, number>();
      const bowlerWicketCount = new Map<string, number>();
      for (const row of wicketRows) {
        const bowler = String(row.bowler);
        const batterRuns = Number(row.batter_runs_in_innings ?? 0);
        const batPos = Number(row.batting_position ?? 6);
        const dismissed = String(row.dismissed_batter);
        const inn = Number(row.innings_number);

        let value = BASE_WICKET_VALUE;

        // Batter quality multiplier
        let qualityMult = 1.0;
        if (batPos >= 8 && batterRuns < 10) {
          qualityMult = TAILENDER_MULT;
        } else if (batterRuns >= STAR_BATTER_THRESHOLD) {
          qualityMult = STAR_BATTER_MULT;
        } else if (batterRuns >= SET_BATTER_THRESHOLD) {
          qualityMult = SET_BATTER_MULT;
        }
        // Top-order bonus (positions 1-3 are always harder to get)
        if (batPos <= 3) {
          qualityMult *= TOP_ORDER_BONUS;
        }
        value *= qualityMult;

        // Partnership break bonus
        const partKey = `${inn}_${dismissed}`;
        const partRuns = partnershipMap.get(partKey) ?? 0;
        if (partRuns >= 100) {
          value += PARTNERSHIP_BREAK_BONUS_100;
        } else if (partRuns >= 50) {
          value += PARTNERSHIP_BREAK_BONUS_50;
        }

        const prev = bowlerWicketValue.get(bowler) ?? 0;
        bowlerWicketValue.set(bowler, prev + value);
        bowlerWicketCount.set(bowler, (bowlerWicketCount.get(bowler) ?? 0) + 1);
      }

      // Get bowling economy per bowler
      const bowlingEconRows = await runQuery(
        db,
        `SELECT
           d.bowler AS player_name,
           d.bowler_id AS player_id,
           d.innings_number,
           COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS legal_balls,
           SUM(d.runs_total - d.extras_byes - d.extras_legbyes) AS runs_conceded,
           -- Phase breakdown for phase multiplier
           COUNT(*) FILTER (WHERE d.over_number <= 5 AND d.extras_wides = 0 AND d.extras_noballs = 0) AS pp_balls,
           SUM(CASE WHEN d.over_number <= 5 THEN d.runs_total - d.extras_byes - d.extras_legbyes ELSE 0 END) AS pp_runs,
           COUNT(*) FILTER (WHERE d.over_number BETWEEN 6 AND 14 AND d.extras_wides = 0 AND d.extras_noballs = 0) AS mid_balls,
           SUM(CASE WHEN d.over_number BETWEEN 6 AND 14 THEN d.runs_total - d.extras_byes - d.extras_legbyes ELSE 0 END) AS mid_runs,
           COUNT(*) FILTER (WHERE d.over_number >= 15 AND d.extras_wides = 0 AND d.extras_noballs = 0) AS death_balls,
           SUM(CASE WHEN d.over_number >= 15 THEN d.runs_total - d.extras_byes - d.extras_legbyes ELSE 0 END) AS death_runs
         FROM deliveries d
         WHERE d.match_id = $match_id
           ${bowlerFilter}
         GROUP BY d.bowler, d.bowler_id, d.innings_number`,
        params
      );

      const bowlingImpact = new Map<string, number>();
      const bowlingDetails = new Map<
        string,
        { wickets: number; wicket_value: number; economy_value: number; overs: string; runs_conceded: number; impact: number }
      >();

      for (const row of bowlingEconRows) {
        const name = String(row.player_name);
        const legalBalls = Number(row.legal_balls ?? 0);
        const runsConceded = Number(row.runs_conceded ?? 0);
        const oversNum = legalBalls / 6;

        // Wicket value (already computed above)
        const wktValue = bowlerWicketValue.get(name) ?? 0;
        const wktCount = bowlerWicketCount.get(name) ?? 0;

        // Economy value
        let econValue = 0;
        if (oversNum >= MIN_OVERS_FOR_ECONOMY && matchRR > 0) {
          const bowlerEcon = runsConceded / oversNum;
          // Phase-weighted economy: compute weighted average phase multiplier
          const ppBalls = Number(row.pp_balls ?? 0);
          const midBalls = Number(row.mid_balls ?? 0);
          const deathBalls = Number(row.death_balls ?? 0);
          const totalPhaseBalls = ppBalls + midBalls + deathBalls;

          let phaseMult = 1.0;
          if (totalPhaseBalls > 0) {
            phaseMult =
              (ppBalls * POWERPLAY_PHASE_MULTIPLIER +
                midBalls * MIDDLE_PHASE_MULTIPLIER +
                deathBalls * DEATH_PHASE_MULTIPLIER) /
              totalPhaseBalls;
          }

          econValue =
            (matchRR / Math.max(bowlerEcon, 0.1)) *
            oversNum *
            ECONOMY_SCALE_FACTOR *
            phaseMult;
        }

        // Defence bonus: bowlers defending in 2nd innings of a close win
        let defenceBonus = 1.0;
        const bowlInnings = Number(row.innings_number);
        const bowlInnData = inningsMap.get(bowlInnings);
        if (bowlInnings === 2 && bowlInnData) {
          // Bowler's team is the bowling_team of this innings
          const bowlerTeam = bowlInnData.bowling_team;
          const marginRuns = Number(match.outcome_by_runs ?? 0);
          if (bowlerTeam === String(match.outcome_winner) && marginRuns > 0) {
            defenceBonus = 1 + Math.max(0, 1 - marginRuns / DEFENCE_MARGIN_CAP);
          }
        }

        const impact = (wktValue + econValue) * defenceBonus;
        const prev = bowlingImpact.get(name) ?? 0;
        bowlingImpact.set(name, prev + impact);

        const prevDetail = bowlingDetails.get(name);
        const thisDetail = {
          wickets: wktCount,
          wicket_value: Math.round(wktValue * 100) / 100,
          economy_value: Math.round(econValue * 100) / 100,
          overs:
            Math.floor(oversNum).toString() +
            "." +
            (legalBalls % 6).toString(),
          runs_conceded: runsConceded,
          impact: Math.round(impact * 100) / 100,
        };
        if (!prevDetail || impact > prevDetail.impact) {
          bowlingDetails.set(name, thisDetail);
        } else {
          // Sum across innings
          bowlingDetails.set(name, {
            wickets: prevDetail.wickets + thisDetail.wickets,
            wicket_value: Math.round((prevDetail.wicket_value + thisDetail.wicket_value) * 100) / 100,
            economy_value: Math.round((prevDetail.economy_value + thisDetail.economy_value) * 100) / 100,
            overs: prevDetail.overs, // simplified
            runs_conceded: prevDetail.runs_conceded + thisDetail.runs_conceded,
            impact: Math.round((prevDetail.impact + thisDetail.impact) * 100) / 100,
          });
        }
      }

      // ── 6. Fielding impact ───────────────────────────────────────────
      const fielderFilter = player_name
        ? "AND (d.wicket_fielder1 ILIKE '%' || $player_name || '%' OR d.wicket_fielder2 ILIKE '%' || $player_name || '%')"
        : "";
      const fieldingRows = await runQuery(
        db,
        `SELECT
           d.wicket_fielder1 AS fielder,
           d.wicket_kind,
           d.wicket_player_out,
           d.innings_number,
           d.over_number,
           (SELECT SUM(d3.runs_batter)
            FROM deliveries d3
            WHERE d3.match_id = d.match_id
              AND d3.innings_number = d.innings_number
              AND d3.batter = d.wicket_player_out
           ) AS batter_runs
         FROM deliveries d
         WHERE d.match_id = $match_id
           AND d.is_wicket = TRUE
           AND d.wicket_fielder1 IS NOT NULL
           AND d.wicket_kind IN ('caught', 'stumped', 'run out')
           ${fielderFilter}`,
        params
      );

      const fieldingImpact = new Map<string, number>();
      const fieldingDetails = new Map<string, { dismissals: number; impact: number }>();

      for (const row of fieldingRows) {
        const fielder = String(row.fielder);
        const kind = String(row.wicket_kind);
        const batterRuns = Number(row.batter_runs ?? 0);

        let base = CATCH_BASE;
        if (kind === "stumped") base = STUMPING_BASE;
        else if (kind === "run out") base = DIRECT_RUNOUT_BASE;

        // Batter value
        let bvMult = 1.0;
        if (batterRuns >= STAR_BATTER_THRESHOLD) bvMult = 2.0;
        else if (batterRuns >= SET_BATTER_THRESHOLD) bvMult = 1.5;

        const impact = base * bvMult;
        const prev = fieldingImpact.get(fielder) ?? 0;
        fieldingImpact.set(fielder, prev + impact);

        const prevDetail = fieldingDetails.get(fielder);
        fieldingDetails.set(fielder, {
          dismissals: (prevDetail?.dismissals ?? 0) + 1,
          impact: Math.round(((prevDetail?.impact ?? 0) + impact) * 100) / 100,
        });
      }

      // ── 7. Match importance multiplier ───────────────────────────────
      const stage = String(match.event_stage ?? "");
      const stageWeight = STAGE_WEIGHTS[stage] ?? DEFAULT_STAGE_WEIGHT;

      const marginRuns = Number(match.outcome_by_runs ?? 0);
      const marginWickets = Number(match.outcome_by_wickets ?? 0);
      const outcomeResult = String(match.outcome_result ?? "");

      let closenessBonus = 0;
      if (outcomeResult === "tie" || outcomeResult === "no result") {
        closenessBonus = TIE_BONUS;
      } else if (marginRuns > 0) {
        if (marginRuns <= CLOSE_MATCH_VERY.runs) closenessBonus = CLOSE_MATCH_VERY.bonus;
        else if (marginRuns <= CLOSE_MATCH_MODERATE.runs) closenessBonus = CLOSE_MATCH_MODERATE.bonus;
      } else if (marginWickets > 0) {
        if (marginWickets <= CLOSE_MATCH_VERY.wickets) closenessBonus = CLOSE_MATCH_VERY.bonus;
        else if (marginWickets <= CLOSE_MATCH_MODERATE.wickets) closenessBonus = CLOSE_MATCH_MODERATE.bonus;
      }

      const matchImportance = stageWeight + closenessBonus;

      // ── 8. Combine all players ───────────────────────────────────────
      const allPlayers = new Set<string>();
      for (const name of battingImpact.keys()) allPlayers.add(name);
      for (const name of bowlingImpact.keys()) allPlayers.add(name);
      for (const name of fieldingImpact.keys()) allPlayers.add(name);

      const results = Array.from(allPlayers).map((name) => {
        const bat = battingImpact.get(name) ?? 0;
        const bowl = bowlingImpact.get(name) ?? 0;
        const field = fieldingImpact.get(name) ?? 0;
        const raw = bat + bowl + field;
        const total = raw * matchImportance;

        return {
          player_name: name,
          total_impact: Math.round(total * 100) / 100,
          batting_impact: Math.round(bat * matchImportance * 100) / 100,
          bowling_impact: Math.round(bowl * matchImportance * 100) / 100,
          fielding_impact: Math.round(field * matchImportance * 100) / 100,
          match_importance: Math.round(matchImportance * 100) / 100,
          breakdown: {
            batting: battingDetails.get(name) ?? null,
            bowling: bowlingDetails.get(name) ?? null,
            fielding: fieldingDetails.get(name) ?? null,
          },
        };
      });

      results.sort((a, b) => b.total_impact - a.total_impact);

      const matchInfo = {
        match_id,
        date: match.date_start,
        teams: `${match.team1} vs ${match.team2}`,
        venue: match.venue,
        result: match.outcome_winner
          ? `${match.outcome_winner} won${marginRuns ? ` by ${marginRuns} runs` : ""}${marginWickets ? ` by ${marginWickets} wickets` : ""}`
          : outcomeResult || "Unknown",
        event: match.event_name ?? null,
        stage: stage || null,
        match_importance: Math.round(matchImportance * 100) / 100,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ match: matchInfo, impact_scores: results }, null, 2),
          },
        ],
      };
    }
  );

  // ── Career Impact Tool ───────────────────────────────────────────────
  server.registerTool(
    "get_career_impact",
    {
      title: "Career Impact Score",
      description:
        "How impactful is this player across their career? Aggregates per-match impact scores to show average impact, peak match, and batting/bowling/fielding contribution breakdown. " +
        "Uses the same context-weighted formula as get_match_impact, computed across all qualifying matches. " +
        "Use for 'Who has the highest career impact in T20s?', 'Bumrah\\'s impact in World Cups', 'Compare Kohli and Smith by impact'. " +
        "Not for a single match breakdown (use get_match_impact).",
      inputSchema: {
        player_name: z
          .string()
          .min(2)
          .describe("Player name (partial match supported)."),
        match_type: MatchFilterSchema.shape.match_type,
        gender: MatchFilterSchema.shape.gender,
        team: MatchFilterSchema.shape.team,
        opposition: MatchFilterSchema.shape.opposition,
        venue: MatchFilterSchema.shape.venue,
        event_name: MatchFilterSchema.shape.event_name,
        season: MatchFilterSchema.shape.season,
        date_from: MatchFilterSchema.shape.date_from,
        date_to: MatchFilterSchema.shape.date_to,
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Maximum matches to compute impact for (default 50, max 200). More matches = slower query."),
      },
    },
    async (args) => {
      const { player_name, limit, ...filters } = args;
      const { whereClauses, params } = buildMatchFilter(filters);
      params.player_name = player_name;
      params.limit = limit;

      // Find matches where this player participated
      whereClauses.push(
        `m.match_id IN (
          SELECT DISTINCT match_id FROM deliveries
          WHERE batter ILIKE '%' || $player_name || '%'
             OR bowler ILIKE '%' || $player_name || '%'
        )`
      );
      const filterStr = buildWhereString(whereClauses);

      const matchListRows = await runQuery(
        db,
        `SELECT m.match_id, m.date_start, m.team1, m.team2, m.venue,
                m.event_name, m.event_stage, m.match_type,
                m.outcome_winner, m.outcome_by_runs, m.outcome_by_wickets, m.outcome_result
         FROM matches m
         WHERE 1=1 ${filterStr}
         ORDER BY m.date_start DESC
         LIMIT $limit`,
        params
      );

      if (matchListRows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matches found for "${player_name}" with the given filters.`,
            },
          ],
        };
      }

      // Compute impact for each match by calling the same logic
      // For efficiency, we'll use a simplified per-match computation via SQL
      const matchImpacts: Array<{
        match_id: string;
        date: string;
        opponent: string;
        venue: string;
        event: string | null;
        batting_impact: number;
        bowling_impact: number;
        fielding_impact: number;
        total_impact: number;
      }> = [];

      // Resolve the actual player name from the first match
      const nameResolveRows = await runQuery(
        db,
        `SELECT DISTINCT batter AS name FROM deliveries
         WHERE match_id = $mid AND batter ILIKE '%' || $player_name || '%'
         UNION
         SELECT DISTINCT bowler AS name FROM deliveries
         WHERE match_id = $mid AND bowler ILIKE '%' || $player_name || '%'
         LIMIT 1`,
        { mid: String(matchListRows[0].match_id), player_name }
      );
      const resolvedName = nameResolveRows.length > 0 ? String(nameResolveRows[0].name) : player_name;

      for (const matchRow of matchListRows) {
        const mid = String(matchRow.match_id);

        // Match aggregates
        const maRows = await runQuery(
          db,
          `SELECT
             SUM(runs_total) AS total_runs,
             COUNT(*) FILTER (WHERE extras_wides = 0 AND extras_noballs = 0) AS total_balls
           FROM deliveries WHERE match_id = $mid`,
          { mid }
        );
        const mTotalRuns = Number(maRows[0]?.total_runs ?? 0);
        const mTotalBalls = Number(maRows[0]?.total_balls ?? 1);
        const mAvgSR = mTotalBalls > 0 ? (mTotalRuns / mTotalBalls) * 100 : 100;
        const mRR = mTotalBalls > 0 ? mTotalRuns / (mTotalBalls / 6) : 6;

        // Team totals
        const ttRows = await runQuery(
          db,
          `SELECT innings_number, i.batting_team, i.target_runs,
                  SUM(d.runs_total) AS team_total,
                  COUNT(*) FILTER (WHERE d.extras_wides = 0 AND d.extras_noballs = 0) AS team_balls
           FROM deliveries d
           JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
           WHERE d.match_id = $mid AND i.is_super_over = FALSE
           GROUP BY d.innings_number, i.batting_team, i.target_runs`,
          { mid }
        );
        const innMap = new Map<number, { team: string; total: number; balls: number; target: number | null }>();
        for (const r of ttRows) {
          innMap.set(Number(r.innings_number), {
            team: String(r.batting_team),
            total: Number(r.team_total ?? 0),
            balls: Number(r.team_balls ?? 1),
            target: r.target_runs != null ? Number(r.target_runs) : null,
          });
        }

        // Batting impact for this player in this match
        const batRows = await runQuery(
          db,
          `SELECT
             innings_number,
             SUM(runs_batter) AS runs,
             COUNT(*) FILTER (WHERE extras_wides = 0) AS balls_faced,
             MAX(CASE WHEN is_wicket AND wicket_player_out = batter THEN 1 ELSE 0 END) AS was_dismissed,
             (SELECT COUNT(*) FROM deliveries d2
              WHERE d2.match_id = $mid AND d2.innings_number = d.innings_number
                AND d2.is_wicket = TRUE
                AND d2.over_number * 1000 + d2.ball_number <
                    (SELECT MIN(d3.over_number * 1000 + d3.ball_number)
                     FROM deliveries d3
                     WHERE d3.match_id = $mid AND d3.innings_number = d.innings_number
                       AND d3.batter = $pname)
             ) AS wickets_at_entry
           FROM deliveries d
           WHERE match_id = $mid AND batter = $pname
           GROUP BY innings_number`,
          { mid, pname: resolvedName }
        );

        let batImpact = 0;
        for (const r of batRows) {
          const inn = Number(r.innings_number);
          const runs = Number(r.runs ?? 0);
          const balls = Number(r.balls_faced ?? 0);
          const dismissed = Number(r.was_dismissed) === 1;
          const wktsAtEntry = Number(r.wickets_at_entry ?? 0);
          const id = innMap.get(inn);
          if (!id || id.total === 0) continue;

          const isChasing2 = inn === 2 && id.target != null && id.target > 0;
          const denom2 = isChasing2 ? Math.max(id.total, id.target!) : id.total;
          const runCont = (runs / denom2) * 100;
          let srF = 1.0;
          if (balls >= MIN_BALLS_FOR_SR_FACTOR && mAvgSR > 0) {
            srF = Math.max(0.5, Math.min(2.0, ((runs / balls) * 100) / mAvgSR));
          }
          let sitMult = Math.min(ENTRY_DIFFICULTY_MAX, ENTRY_DIFFICULTY_BASE + wktsAtEntry * ENTRY_DIFFICULTY_PER_WICKET);
          if (!dismissed && inn === 1) sitMult *= NOT_OUT_FIRST_INNINGS_DISCOUNT;
          // Lost chase discount
          let lcd = 1.0;
          if (isChasing2 && id.team !== String(matchRow.outcome_winner)) {
            const mrgn = Number(matchRow.outcome_by_runs ?? 0);
            if (mrgn > 0 && id.target! > 0) lcd = Math.max(LOST_CHASE_FLOOR, 1 - mrgn / (2 * id.target!));
          }
          batImpact += runCont * srF * sitMult * BATTING_SCALE * lcd;
        }

        // Bowling impact
        const bwlRows = await runQuery(
          db,
          `SELECT
             innings_number,
             COUNT(*) FILTER (WHERE extras_wides = 0 AND extras_noballs = 0) AS legal_balls,
             SUM(runs_total - extras_byes - extras_legbyes) AS runs_conceded,
             COUNT(*) FILTER (WHERE is_wicket AND wicket_kind IN ${BOWLING_WICKET_KINDS}) AS wickets,
             COUNT(*) FILTER (WHERE over_number >= 15 AND extras_wides = 0 AND extras_noballs = 0) AS death_balls
           FROM deliveries
           WHERE match_id = $mid AND bowler = $pname
           GROUP BY innings_number`,
          { mid, pname: resolvedName }
        );

        let bwlImpact = 0;
        for (const r of bwlRows) {
          const lballs = Number(r.legal_balls ?? 0);
          const rc = Number(r.runs_conceded ?? 0);
          const wkts = Number(r.wickets ?? 0);
          const deathB = Number(r.death_balls ?? 0);
          const overs = lballs / 6;

          // Simplified wicket value (use base * count, no per-wicket quality in career mode for speed)
          bwlImpact += wkts * BASE_WICKET_VALUE;

          if (overs >= MIN_OVERS_FOR_ECONOMY && mRR > 0) {
            const econ = rc / overs;
            const phaseMult =
              deathB > lballs * 0.4
                ? DEATH_PHASE_MULTIPLIER
                : MIDDLE_PHASE_MULTIPLIER;
            bwlImpact +=
              (mRR / Math.max(econ, 0.1)) * overs * ECONOMY_SCALE_FACTOR * phaseMult;
          }
        }

        // Fielding impact (simplified)
        const fldRows = await runQuery(
          db,
          `SELECT COUNT(*) AS dismissals
           FROM deliveries
           WHERE match_id = $mid
             AND is_wicket = TRUE
             AND wicket_fielder1 = $pname
             AND wicket_kind IN ('caught', 'stumped', 'run out')`,
          { mid, pname: resolvedName }
        );
        const fldImpact = Number(fldRows[0]?.dismissals ?? 0) * CATCH_BASE;

        // Match importance
        const stage2 = String(matchRow.event_stage ?? "");
        const sw = STAGE_WEIGHTS[stage2] ?? DEFAULT_STAGE_WEIGHT;
        const mr = Number(matchRow.outcome_by_runs ?? 0);
        const mw = Number(matchRow.outcome_by_wickets ?? 0);
        const ores = String(matchRow.outcome_result ?? "");
        let cb = 0;
        if (ores === "tie") cb = TIE_BONUS;
        else if (mr > 0 && mr <= 10) cb = CLOSE_MATCH_VERY.bonus;
        else if (mr > 0 && mr <= 20) cb = CLOSE_MATCH_MODERATE.bonus;
        else if (mw > 0 && mw <= 2) cb = CLOSE_MATCH_VERY.bonus;
        else if (mw > 0 && mw <= 4) cb = CLOSE_MATCH_MODERATE.bonus;
        const mi = sw + cb;

        const total = (batImpact + bwlImpact + fldImpact) * mi;

        // Determine opponent
        const t1 = String(matchRow.team1);
        const t2 = String(matchRow.team2);
        // Find which team the player was on
        const teamCheck = await runQuery(
          db,
          `SELECT DISTINCT i.batting_team FROM deliveries d
           JOIN innings i ON d.match_id = i.match_id AND d.innings_number = i.innings_number
           WHERE d.match_id = $mid AND (d.batter = $pname OR d.bowler = $pname)
           LIMIT 1`,
          { mid, pname: resolvedName }
        );
        const playerTeam = teamCheck.length > 0 ? String(teamCheck[0].batting_team) : t1;
        const opponent = playerTeam === t1 ? t2 : t1;

        matchImpacts.push({
          match_id: mid,
          date: String(matchRow.date_start),
          opponent,
          venue: String(matchRow.venue ?? ""),
          event: matchRow.event_name ? String(matchRow.event_name) : null,
          batting_impact: Math.round(batImpact * mi * 100) / 100,
          bowling_impact: Math.round(bwlImpact * mi * 100) / 100,
          fielding_impact: Math.round(fldImpact * mi * 100) / 100,
          total_impact: Math.round(total * 100) / 100,
        });
      }

      // Sort by total impact descending
      matchImpacts.sort((a, b) => b.total_impact - a.total_impact);

      const totalImpact = matchImpacts.reduce((s, m) => s + m.total_impact, 0);
      const avgImpact =
        matchImpacts.length > 0 ? totalImpact / matchImpacts.length : 0;
      const avgBat =
        matchImpacts.length > 0
          ? matchImpacts.reduce((s, m) => s + m.batting_impact, 0) /
            matchImpacts.length
          : 0;
      const avgBowl =
        matchImpacts.length > 0
          ? matchImpacts.reduce((s, m) => s + m.bowling_impact, 0) /
            matchImpacts.length
          : 0;
      const avgField =
        matchImpacts.length > 0
          ? matchImpacts.reduce((s, m) => s + m.fielding_impact, 0) /
            matchImpacts.length
          : 0;

      const peak = matchImpacts[0] ?? null;

      const result = {
        player: resolvedName,
        matches_analyzed: matchImpacts.length,
        career_summary: {
          avg_impact_per_match: Math.round(avgImpact * 100) / 100,
          total_impact: Math.round(totalImpact * 100) / 100,
          avg_batting_impact: Math.round(avgBat * 100) / 100,
          avg_bowling_impact: Math.round(avgBowl * 100) / 100,
          avg_fielding_impact: Math.round(avgField * 100) / 100,
        },
        peak_match: peak,
        matches: matchImpacts,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
