# Stats without context are damned lies

Most cricket statistics treat all performances as equal. A 50 in a dead rubber group match counts the same as a 50 in a World Cup final chase with the team at 20/3. The numbers say equal. Anyone who watched both innings knows they're not.

ESPNcricinfo's Smart Stats MVP system accounts for this. Their impact ratings for the 2026 T20 World Cup told stories that raw stats couldn't — Samson's 83.05 in the final, Bumrah's 54.46 for a devastating 4/15, Lungi Ngidi's zero-wicket strangling spell against India in the group stage getting proper credit. I wanted that kind of contextual scoring in cricket-mcp.

So I built it. Then I tested it against the actual Cricinfo scores. Some of it works. Some of it is arbit. Here's the fundaes.

## Three components, one score

The Match Impact Score combines batting, bowling, and fielding contributions, each computed from ball-by-ball data with context multipliers, then scaled by match importance.

```
Match Impact = (Batting + Bowling + Fielding) x Match Importance
```

Scores are unbounded — not normalized to 100. A dominant all-round performance might hit 80+. A quiet day in the field, 5-10.

## Batting: when you scored it matters more than what you scored

Batting impact starts with run contribution as a percentage of the team total. 50 out of 120 (41.7%) is worth more than 50 out of 350 (14.3%).

That gets multiplied by a strike rate factor — your SR relative to the match tempo — and a situation multiplier. Entry difficulty accounts for what you walked into. Dube coming in at 69/3 faces a fundamentally different task than an opener on a flat pitch. The formula scales from 1.0x to 1.5x based on wickets down at entry.

For chasing teams that lost, a discount scales with the margin. Scored 52 in a 96-run defeat? Your contribution didn't change the outcome. The denominator also shifts: max(team_total, target), so 52 out of 159 chasing 256 registers as 52/256, not an inflated 52/159.

## Bowling: wickets + economy, weighted by context

Each wicket starts at 6 base points, multiplied by batter quality. Tailender on 3 is 0.5x. Set top-order batter on 40+ is 2.5x with a 1.3x top-order bonus. Partnership breaker bonuses add extra for busting 50+ stands.

Economy value rewards containment: `(match_run_rate / bowler_economy) x overs x 2.0 x phase_multiplier`. Death overs (1.3x) are harder to contain than the powerplay (1.0x).

Bowlers defending a total in a close win get a defence bonus. Win by 7 runs? 1.72x multiplier. Win by 96? No bonus.

## How it stacks up

I ran the model against the 2026 T20 World Cup Final (India 255/5, won by 96 runs) and compared to Cricinfo's MVP scores:

| Player | Ours | Cricinfo | Verdict |
|---|---|---|---|
| Samson | 85.88 | 83.05 | Cracked it |
| Dube | 30.97 | 31.10 | Cracked it |
| Seifert | 47.98 | 38.96 | Close |
| Abhishek | 68.72 | 78.15 | Undervalued |
| Axar | 45.17 | 59.05 | Undervalued |
| Bumrah | 82.26 | 54.46 | Overvalued |
| Neesham | 98.92 | 55.43 | Hugged it |
| Kishan | 75.99 | 52.31 | Overvalued |
| Santner | 51.97 | 31.19 | Overvalued |

Samson at 85.88 vs 83.05 is a 3% delta for the Player of the Series. Dube at 30.97 vs 31.10 is essentially exact.

But the model has clear flaws.

**Bowling economy is over-rewarded.** Bumrah's 4/15 scored 82.26 against Cricinfo's 54.46. His economy value alone was 26 points — nearly half his total. The economy scale factor (currently 2.0) probably needs to come down.

**Wicket quality multipliers are too aggressive.** Neesham scored 98.92, the highest in the match, vs Cricinfo's 55.43. His 3 wickets had a combined value of 51 points because the star batter multiplier (2.5x) and top-order bonus (1.3x) stack multiplicatively. That's 6 x 2.5 x 1.3 = 19.5 for a single top-order wicket of a set batter. Should probably be additive, not multiplicative.

**Fielding inflates supporting players.** Kishan got 12 points from 3 outfield catches, pushing him to 75.99 vs 52.31. Fielding should be more of a tie-breaker.

**Lost chase entry difficulty is still too generous.** Santner scored 51.97 vs 31.19. His 1.5x entry difficulty for coming in deep in a hopeless chase inflates the score. If you didn't overcome the difficulty, maybe it shouldn't count.

## What I'm not going to do

I'm not tuning constants in private until the numbers match Cricinfo's. That's overfitting to one proprietary model. The scores need to make cricket sense on their own terms.

What I need is more signal. More matches with known Cricinfo scores to triangulate against. More cricket brains arguing about whether dismissing a set opener should be worth 2.5x or 2.0x, whether economy should scale linearly or with diminishing returns, whether a 96-run blowout deserves any entry difficulty bonus at all.

## Help me tune the weights

Every constant in the formula is at the top of `src/tools/match-impact.ts`:

```typescript
const BATTING_SCALE = 1.5;
const BASE_WICKET_VALUE = 6;
const STAR_BATTER_MULT = 2.5;
const TOP_ORDER_BONUS = 1.3;
const ECONOMY_SCALE_FACTOR = 2.0;
const DEFENCE_MARGIN_CAP = 25;
const CATCH_BASE = 2;
// ... and 15+ more
```

If you think a weight is wrong, here's what would actually help:

1. **Run the model against a match with known Cricinfo scores.** Use `get_match_impact` with a match ID. Compare. Tell me where the gaps are and why.
2. **Propose specific constant changes.** "ECONOMY_SCALE_FACTOR should be 1.2 because X" is actionable. "Bowling is too high" is not.
3. **Argue about the structural formula.** Should quality multipliers stack multiplicatively or additively? Should entry difficulty apply in lost chases? Should there be a minimum-runs threshold for situation bonuses?

Open a PR or just tell me.

## Limitations

This isn't Win Probability Added per ball — that would need a pre-trained probability model. It doesn't factor in opponent team strength at a career level. It doesn't measure intent or shot control because Cricsheet doesn't tag that.

It's a heuristic. Built on 10.9 million deliveries and real cricket logic, but a heuristic. The goal isn't to replicate Cricinfo's proprietary model — it's to build something the community can see into, argue about, and improve.

---

*All data from Cricsheet. Neesham at 98.92 means my weights are arbit, not that he was the MVP.*
