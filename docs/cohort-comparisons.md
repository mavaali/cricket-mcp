# Cricket Cross-examiner

`compare_cohorts` computes bounded, descriptive contrasts. `investigate_cricket_claim` guides the host through metric clarification, coverage, comparison, contrary evidence and one declared sensitivity. It does not run a server-side model or establish causal effects.

## Direct player claim

Resolve names with `search_players` and use a unique ID. Example request:

```json
{
  "comparison": {
    "kind": "batting_style",
    "scope": {"match_type":"T20","event_name":"Indian Premier League"},
    "player_id": "ba607b88",
    "metric": "strike_rate",
    "groups": [
      {"label":"pace","style":"pace","phases":["powerplay","middle","death"]},
      {"label":"spin","style":"spin","phases":["powerplay","middle","death"]}
    ]
  },
  "stratify_by": "phase"
}
```

The current scope is IPL T20, with optional gender, season, exact venue and dates/as-of. Default gender is male. Only non-super-over innings, six-ball overs, and source over ordinals 0–19 qualify. The tool does not claim complete real-world career coverage. Player IDs are required; names are deliberately not fuzzy-matched in a comparison.

Batting metrics are `strike_rate` (100 × batter runs / balls faced) and `boundary_rate` (100 × bat boundaries / balls faced). Wides do not count as balls faced; no-balls do. Legal balls exclude both. Boundaries exclude non-boundary fours/sixes. SQL reuses the existing BAT/BOWL definitions. Phases reuse the existing zero-based boundaries: powerplay 0–5, middle 6–14, death 15–19.

Style labels come from stored player enrichment. They are tied to the file revision, but the chase audit does **not** verify them. Unknown styles are excluded and counted across the union of requested phases, including phase-specific missing counts. This population can include first innings and matches excluded from chase-state reconstruction; it does not need a valid chase target to measure batting strike rate.

## Retrieved chase groups

Call `find_similar_situations`, then pass the exact returned `data.evidence_set`:

```json
{
  "comparison": {
    "kind": "chase",
    "evidence_set": "REPLACE WITH RETURNED OBJECT",
    "metric": "win_rate",
    "groups": [
      {"label":"5 or 6 wickets remaining","wickets_remaining":{"min":5,"max":6}},
      {"label":"7 wickets remaining","wickets_remaining":{"min":7,"max":7}}
    ]
  },
  "stratify_by":"season"
}
```

The placeholder above must be replaced with the object, not passed as a string. Predicates can specify inclusive entry-state ranges for runs required, legal balls remaining or wickets remaining, exact batting team, and/or outcome. Omitted predicates mean all selected cases. Predicates combine with AND. Groups can overlap; overlapping innings are counted explicitly. Outcome-defined groups are flagged and only descriptive.

`win_rate` is 100 × wins / known outcomes; ties are in the denominator. `next_six_or_end_runs` is mean team runs from the selected boundary through the next six legal deliveries or innings end, whichever occurs first. Before includes the referenced delivery; after excludes it. Extras contribute runs without necessarily using a legal ball. Short windows are retained and counted, so this metric is not a rate per six balls and must not be described as one. Only audited eligible innings selected by the original recipe qualify; no future outcome affects selection.

## Results and evidence

Numerators, denominators and aggregate values always cover the full groups. Deliveries are not independent observations. An innings spanning phases is counted once in the group total; phase strata can share innings. Differences are group A minus B, in percentage points for rates and runs for the chase-window mean. No confidence intervals or significance are computed.

`stratify_by` is `none`, `phase` or `season`. Unknown seasons remain null. All strata are returned. Contrary cases are observations on the opposite side of the other group's aggregate mean from the overall contrast, sorted by match/innings ID. Their total count is reported with bounded examples. Equality is not contrary evidence; one contrary innings does not refute an average tendency. There is no hidden subgroup search.

All per-innings contributions are paginated (1–50 rows), with a cursor bound to the revision, recipe and stratification. Evidence refs contain `cohort-v1`, revision, recipe, group and innings. Pass a ref to `get_evidence` with summary, overs or deliveries; membership and revision are recomputed. Batting evidence contains only the selected batter/style/phases; chase evidence contains the metric window or full innings for outcome metrics. Overs summarize only selected records, not necessarily an entire over. Refs survive process restarts on the same data; changed data returns stale_reference.

An empty result has null rates. A missing group denominator or fewer than two innings in either group yields insufficient_evidence; this is a minimal descriptive guard, not a statistical-power threshold. `ok` is never evidence of significance. Missing IDs, invalid scopes, absent audit capability, stale revisions and execution errors remain distinct. No arbitrary SQL, unknown metrics, comparison-name matching or automatic scope widening is supported.

## Sensitivity and limits

Declare an alternative before querying, run another explicit comparison, and retain both requests and results. For example, repeat all-phase pace/spin with middle only; repeat a chase with legal-ball tolerance reduced from two to zero. Report membership counts, overlapping innings, exclusions and both results. A prior-comparison API and automated sensitivity search are not implemented. The host must retain the explicit investigation ledger; no hidden session history is required by evidence replay.

This version deliberately displaces automatic causal verdicts, batting averages, significance testing, other competitions and arbitrary predicates. It adds no dependency, database migration or derived cache. Repeated state scans and payload tuning belong to task 5.

## Reproduction

Build with `npm run build`; run `node_modules/.bin/tsx --test tests/*.test.ts`. Supply the task-2 audit manifest to the existing `--investigation-manifest` CLI option and open the bound database read-only. Tests use isolated in-memory databases; they do not write the production file. End-to-end scripts/results are kept with the external task deliverables, not bundled into the package.
