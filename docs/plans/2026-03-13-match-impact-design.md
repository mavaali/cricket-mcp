# Match Impact Score — Design Document

## Problem

Standard cricket stats (batting average, bowling economy, strike rate) treat all performances equally regardless of context. A 50 in a dead rubber group match counts the same as a 50 in a World Cup final chase. This metric fills that gap.

## What It Answers

- "Who had the biggest impact in match X?" — per-match ranking of all players
- "How impactful is player X over their career?" — aggregated impact across matches

## Philosophy

Inspired by Jaideep Varma's Impact Index and ESPNcricinfo's Smart Stats MVP system. Key principles:

1. **Context over volume** — a 30 in a tight chase at 20/3 is worth more than a 100 in a 400-run win
2. **Relative to the match** — performance measured against what others did in the same game
3. **All contributions count** — batting, bowling, fielding combined into a single score
4. **Match importance matters** — knockout performances weighted higher than group stage
5. **Transparent and tunable** — breakdown always visible, weights easy to adjust for crowdsourcing

## Formula

```
Match Impact = (Batting Impact + Bowling Impact + Fielding Impact) × Match Importance
```

Scores are **unbounded** — not normalized to 100. A dominant all-round performance could score 80+, a quiet game 5-10. This matches the scale used by ESPNcricinfo's MVP system (e.g. Samson 69.74, Farhan 59.84 per match in the 2026 T20 WC).

---

## Component 1: Batting Impact

```
Batting Impact = Run Contribution × Strike Rate Factor × Situation Multiplier
```

### Run Contribution (0-100 base)
- `(runs_scored / team_total) × 100`
- A 50 out of 120 (41.7) vs 50 out of 350 (14.3) — naturally rewards scarcity

### Strike Rate Factor (multiplier, centered at 1.0)
- `player_SR / match_average_SR`
- Rewards batters who outpaced the match tempo
- A SR of 150 in a 120-SR match (1.25x) > SR of 150 in a 180-SR match (0.83x)
- **Minimum 10 balls faced** to qualify (avoids 6-off-1 outliers)
- Players facing fewer than 10 balls: use raw runs contribution only (no SR factor)

### Situation Multiplier (1.0x to 2.0x)
Factors combined multiplicatively:

**Entry difficulty (1.0x to 1.5x):**
- Based on wickets fallen when batter arrives AND team's position relative to par
- Opening: 1.0x (no pressure context yet)
- 1-2 wickets down, on track: 1.0x
- 3+ wickets down or behind required rate: 1.2x-1.5x scaling

**Chasing pressure (1.0x to 1.3x):**
- Batting second only
- `required_run_rate / current_run_rate` at time of entry, capped at 1.3x
- Not applicable to first-innings batting

**Not-out adjustment:**
- Not out in successful chase: no penalty (job done)
- Not out batting first with overs remaining: 0.9x discount (could have scored more)
- Dismissed: 1.0x (neutral)

---

## Component 2: Bowling Impact

```
Bowling Impact = Wicket Value + Economy Value
```

### Wicket Value (per wicket, summed)
Each wicket scored on three dimensions:

**Base wicket value: 10 points**

**Batter quality multiplier (0.5x to 2.0x):**
- Based on dismissed batter's innings score at dismissal + batting position
- Tailender (pos 8-11) on single digits: 0.5x
- Middle order on < 15: 1.0x
- Set batter (25+): 1.5x
- Set top-order batter (40+ runs, pos 1-5): 2.0x

**Partnership breaker bonus:**
- If the dismissed batter was in a partnership worth 50+: +5 bonus points
- Partnership worth 100+: +10 bonus points

**Situation multiplier (1.0x to 1.5x):**
- Wicket while opponent is on track to win/post big total: 1.3x-1.5x
- Wicket during collapse (3+ wickets already fallen in last 5 overs): 1.0x (mop-up)

### Economy Value
- `(match_run_rate / bowler_economy_rate) × overs_bowled × 5`
- The `× 5` scaling factor puts economy contribution on a comparable scale to wickets
- Naturally rewards containing spells: Ngidi's 0/15 in 4 overs when match RR was 10 = (10/3.75) × 4 × 5 = 53.3 economy points
- Phase-aware bonus: death overs (17-20) economy gets 1.3x multiplier, powerplay 1.0x, middle 1.1x (death containment is hardest)
- **Minimum 2 overs bowled** to get economy value (avoids 1-over cameo distortion)

---

## Component 3: Fielding Impact

```
Fielding Impact = Sum of (base_credit × batter_value × situation)
```

### Base credit per dismissal type
- Catch: 5 points
- Run out (direct hit): 5 points
- Run out (indirect): 3 points
- Stumping: 4 points

### Batter value multiplier (0.5x to 2.0x)
Same scale as bowling — based on dismissed batter's innings score and position.

### Situation multiplier (1.0x to 1.5x)
Same as bowling — context when the dismissal happened.

Fielding impact will naturally be smaller than batting/bowling, which is correct — it's a supporting contribution.

---

## Component 4: Match Importance Multiplier

Applied to the total (batting + bowling + fielding) score.

### Tournament stage
- Group stage: 1.0x
- Super Eight / league knockouts: 1.1x
- Quarter-final: 1.2x
- Semi-final: 1.3x
- Final: 1.5x

### Match closeness bonus (0x to 0.2x additional)
Based on victory margin relative to format norms:
- **Won by < 10 runs or < 2 wickets**: +0.2x
- **Won by < 20 runs or < 4 wickets**: +0.1x
- **Tie / Super Over**: +0.2x
- **Won by 50+ runs or 8+ wickets**: +0.0x (blowout, no bonus)

### Event tier (future consideration)
- ICC events (World Cup, Champions Trophy): 1.0x (baseline)
- Bilateral series: 0.9x
- Domestic T20 leagues: 0.85x

*Note: event tier is optional for v1. Can be added later without changing the core formula.*

---

## Tool API Design

### Tool 1: `get_match_impact`
**Input:** match_id (required), player_name (optional)
**Output:** Impact scores for all players in the match (or one player), ranked by total impact

Returns per player:
- batting_impact, bowling_impact, fielding_impact
- match_importance_multiplier
- total_impact (the final number)
- key contributions (top 2-3 moments that drove the score)

### Tool 2: `get_career_impact` (uses same underlying computation)
**Input:** player_name (required), filters (match_type, date range, opposition, venue, event)
**Output:**
- matches_played
- avg_impact_per_match
- total_impact
- peak_impact (best single match, with match details)
- impact_breakdown (avg batting / bowling / fielding contributions)

Both tools share the same SQL computation engine — `get_career_impact` aggregates per-match scores.

---

## Data Requirements

All inputs are available in the existing schema:

| Need | Source |
|------|--------|
| Runs per batter per innings | `deliveries` grouped by batter + match + innings |
| Team total | `deliveries` grouped by batting_team + match + innings |
| Balls faced | count of deliveries per batter |
| Match average SR | total runs / total balls in match |
| Entry situation (wickets down) | count wickets before batter's first ball |
| Target / required rate | `innings.target_runs`, `innings.target_overs` |
| Wicket details | `deliveries.is_wicket`, `wicket_player_out`, `wicket_kind` |
| Partnership size | computed from consecutive deliveries between wickets |
| Fielder credit | `deliveries.fielders` |
| Match stage | `matches.event_stage` |
| Victory margin | `matches.outcome_by_runs`, `matches.outcome_by_wickets` |
| Over number (phase) | `deliveries.over_number` |

No new tables or data sources needed.

---

## Tunable Constants

All weights defined as constants at the top of the file for easy crowdsource adjustment:

```typescript
// Batting
const MIN_BALLS_FOR_SR_FACTOR = 10;
const ENTRY_DIFFICULTY_MAX = 1.5;
const CHASE_PRESSURE_MAX = 1.3;
const NOT_OUT_FIRST_INNINGS_DISCOUNT = 0.9;

// Bowling
const BASE_WICKET_VALUE = 10;
const PARTNERSHIP_BREAK_BONUS_50 = 5;
const PARTNERSHIP_BREAK_BONUS_100 = 10;
const ECONOMY_SCALE_FACTOR = 5;
const MIN_OVERS_FOR_ECONOMY = 2;
const DEATH_PHASE_MULTIPLIER = 1.3;
const MIDDLE_PHASE_MULTIPLIER = 1.1;
const POWERPLAY_PHASE_MULTIPLIER = 1.0;

// Fielding
const CATCH_BASE = 5;
const DIRECT_RUNOUT_BASE = 5;
const INDIRECT_RUNOUT_BASE = 3;
const STUMPING_BASE = 4;

// Match importance
const STAGE_WEIGHTS = {
  group: 1.0,
  super_eight: 1.1,
  quarter_final: 1.2,
  semi_final: 1.3,
  final: 1.5,
};
const CLOSE_MATCH_THRESHOLDS = {
  very_close: { runs: 10, wickets: 2, bonus: 0.2 },
  close: { runs: 20, wickets: 4, bonus: 0.1 },
  tie: { bonus: 0.2 },
};
```

---

## NOT in Scope (v1)

- **Win Probability Added (WPA) per ball** — too complex for v1, would require a pre-trained model. Impact score approximates this with simpler heuristics.
- **Opponent strength weighting** — "wicket of Virat Kohli" worth more than "wicket of debutant". Career-level data isn't available per-ball. Batting position + innings score is the proxy.
- **Event tier multiplier** — deferred to v2, requires mapping all `event_name` values to tiers.
- **Intent/control metrics** — ESPNcricinfo's boundary-intent and control % require "aggressive shot" tagging not available in Cricsheet data.
- **Captain/leadership impact** — no data signal for this.

## What Already Exists

- `get_player_stats` — raw career aggregates (no context weighting)
- `get_player_form` — recent innings list (no impact scoring)
- `get_situational_stats` — chasing vs setting splits (partial context, not per-match)
- `get_match_scorecard` — raw scorecard (no relative contribution measurement)
- `get_phase_stats` — phase splits (no match-context weighting)

The impact tool sits above all of these — it uses similar underlying data but applies context weighting that none of the existing tools provide.
