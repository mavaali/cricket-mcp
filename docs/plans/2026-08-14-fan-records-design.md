# Fan Records & Drama Tools — Design

Date: 2026-08-14
Target release: v0.9.0

## Problem

All 28 existing tools answer career-aggregate or single-match questions. The questions
cricket fans actually argue about are missing:

- "Fastest hundred in IPL history?" — no tool ranks single-innings performances
- "Highest successful chase at Eden Gardens?" — no team-level records at all
- "Is Kohli a big-match player?" — `event_stage` is ingested but unused
- "How do Kohli and Rohit do batting together?" — partnerships tool only lists stands
- "Who's won the most super overs?" — `is_super_over` is ingested but unused
- "Longest streak of 50+ scores?" — no streak analysis

Also: `evals/runner.ts` imports `buildWhereString`, which no longer exists — the eval
suite crashes on startup.

## New tools

### 1. `get_innings_records` — single-performance leaderboards

`record_type` enum:

| record_type | Ranks | Notes |
|---|---|---|
| `highest_score` | innings runs desc | runs, balls, 4s/6s, SR, not out, match context |
| `fastest_fifty` | balls to reach 50 asc | cumulative sum over ball order within innings |
| `fastest_hundred` | balls to reach 100 asc | same mechanism |
| `most_sixes` | sixes in one innings desc | |
| `most_fours` | fours in one innings desc | |
| `best_bowling_figures` | innings wickets desc, runs asc | bowling wickets only, bowler runs convention |
| `most_runs_in_over` | batter runs off one over desc | off the bat |
| `most_expensive_over` | runs conceded in one over desc | includes wides/noballs, excludes byes/legbyes |

Params: `record_type`, optional `player_name` (partial match), all `MatchFilterSchema`
filters, `limit`. Every row carries match context (opposition, venue, date, event).

Fastest-milestone mechanics: window `SUM(runs_batter) OVER (PARTITION BY match_id,
innings_number, batter ORDER BY over_number, ball_number)` with balls counted excluding
wides; first ball where cumulative runs >= threshold.

### 2. `get_team_records` — team-level extremes

`record_type` enum:

| record_type | Ranks | Notes |
|---|---|---|
| `highest_total` | innings total desc | excludes super overs |
| `lowest_total` | innings total asc | completed innings only: all out (10 wickets) or lost the match batting full quota |
| `biggest_win_runs` | `outcome_by_runs` desc | |
| `biggest_win_wickets` | `outcome_by_wickets` desc, balls remaining desc | balls remaining computed from chase deliveries |
| `narrowest_win_runs` | `outcome_by_runs` asc | |
| `narrowest_win_wickets` | `outcome_by_wickets` asc | 1-wicket thrillers |
| `highest_successful_chase` | winning 2nd-innings (4th in Tests) total desc | uses `innings.target_runs` where present |
| `tied_matches` | list, date desc | `outcome_result = 'tie'` |

Params: `record_type`, `MatchFilterSchema` filters, `limit`.

### 3. `get_clutch_performance` — big-match splits

"Is X a big-match player?" Splits a player's record across stage buckets:

- **overall** — everything matching the filters
- **league** — group/league stage (event_stage NULL or non-knockout)
- **knockouts** — event_stage matching final/semi/quarter/eliminator/qualifier/knockout/
  play-off/challenger patterns (case-insensitive; data has "Semi Final", "Semi-final", etc.)
- **finals** — `%final%` excluding semi/quarter/place/preliminary

Params: `player_name` (required), `perspective` (batting | bowling), filters.
Batting rows: matches, innings, runs, average, SR, 50s, 100s, HS. Bowling rows: matches,
wickets, average, economy, SR, best figures. Plus a `knockout_vs_league` delta so the
model can editorialize with numbers.

Placement play-offs (3rd/5th/7th place) count as knockouts structurally but are listed in
the per-stage breakdown so the model can caveat.

### 4. `get_super_overs` — tie-breaker history

Lists super-over matches: teams, date, venue, event, per-team super-over scores
(deliveries of `is_super_over` innings grouped by batting team), and match winner.
Optional `team` filter and `MatchFilterSchema`. Also returns an aggregate block: per-team
super-over match W/L.

### 5. `get_streaks` — streaks and droughts

`streak_type` enum:

| streak_type | Meaning |
|---|---|
| `fifty_plus` | most consecutive innings with 50+ (per batter) |
| `duck_streak` | most consecutive ducks (dismissed for 0) |
| `team_wins` | most consecutive match wins (per team) |
| `team_losses` | most consecutive match losses (per team) |

Gaps-and-islands over innings (ordered by date) or match results. Optional
`player_name`/`team` to focus; otherwise a leaderboard of the longest streaks with
start/end dates. `limit` applies. No-result matches don't break team streaks; draws do
break win/loss streaks (conservative, stated in output).

### 6. `get_partnerships` extension — pair mode

New optional params: `player2_name` and `aggregate`.

- `player_name` + `player2_name` → stands involving that specific pair
- `aggregate: true` → one summary row for the pair: stands, total runs, runs/stand,
  highest, 50+ and 100+ stand counts

Keeps the existing behavior when the new params are absent. Uses the existing
pair-per-innings convention (LEAST/GREATEST of batter/non-striker).

## Fixes

- `evals/runner.ts`: `buildWhereString` → `buildAndClause` (call site appends to an
  existing WHERE).

## Non-goals (YAGNI)

- Win-probability models, ball-prediction, live data — out of scope
- Bowler spell segmentation — marginal value for complexity
- Nervous-nineties and novelty splits — expressible via existing dismissal tools
- New schema columns or ingest changes — everything above works on current tables

## Implementation shape

- `src/queries/innings-records.ts`, `src/queries/team-records.ts`,
  `src/queries/streaks.ts` — SQL builders (evals import these directly)
- `src/tools/innings-records.ts`, `team-records.ts`, `clutch-performance.ts`,
  `super-overs.ts`, `streaks.ts` — tool registrations following house style
- `src/tools/register.ts` — wire up; README tool count 28 → 33
- `evals/runner.ts` — fix import; add eval categories for each new tool with
  known-answer checks (e.g. highest T20 innings ≥ 175, Chris Gayle 175* should surface;
  fastest T20 fifty ≤ 20 balls; a 1-wicket win exists; super-over count ≥ 100)

## Testing

`npx tsx evals/runner.ts` green, plus `tsc --noEmit` clean.
