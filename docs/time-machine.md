# Match Time Machine and evidence

`find_similar_situations` retrieves historical standard IPL chase states from the
operator's verified audit manifest. `get_evidence` exposes the innings behind a
selected case. Configure the manifest as described in investigation-coverage.md.
Both tools require a verified local revision; they do not fall back to unaudited
rows or OneLake without a pinned snapshot.

## Find cases

```json
{
  "scope": {"match_type":"T20","event_name":"Indian Premier League"},
  "state": {"runs_required":45,"legal_balls_remaining":24,"wickets_remaining":6},
  "tolerances": {"runs":5,"balls":0,"wickets":0},
  "page_size":10
}
```

Tolerances are explicit and never widened automatically. The scope supports exact
season and venue, date_from/date_to (match start dates), and as_of (match end date,
falling back to start date). All dates are day-level, not intraday. Gender defaults
to male and is recorded in the normalized selection. Only explicit T20/IPL scope
is supported initially. Venue matching here is exact, unlike the older coverage
tool's partial venue filter. A date filter that yields no cases returns `empty`.

Instead of `state`, provide `reference`:

```json
{
  "scope": {"match_type":"T20","event_name":"Indian Premier League"},
  "reference": {"match_id":"1473479","innings_number":2,"over_number":16,"ball_number":0},
  "boundary":"before",
  "tolerances": {"runs":5,"balls":2,"wickets":1}
}
```

The reference illustrates the input shape; its resulting state is calculated from
the audited data. Exactly one of state/reference is required. `over_number` and
`ball_number` are zero-based source positions; ball_number includes extras and is
not a decimal over or legal-ball count. `boundary` defaults to before; after
includes the referenced delivery. The reference resolves in the audited IPL
population independently of comparator date/venue filters. Its entire innings is
excluded from comparisons. Unsupported, absent or terminal reference states do
not produce a cohort. A manual state describes an active chase: runs, balls and
wickets remaining must all be positive.

## Selection and denominators

The query computes before/after states over complete innings before applying
state matching. A legal ball excludes wides and no-balls. Wicket arithmetic is
valid for the source-verified subset; unsupported retirements, miscounts and other
special cases must stay excluded by the audit manifest. Raw target-minus-score
can be nonpositive after the target is reached; terminal states are visible in
evidence but never selected as active situations.

For each candidate state, distance is the sum of absolute run/ball/wicket
differences divided by their respective nonzero tolerances. Zero tolerance means
exact equality on that component. Select the nearest state per innings; ties use
the earliest source over/delivery. Sort cases by distance, then textual match ID
and source position. Outcome fields do not participate in this selection.

`independent_innings` and `outcomes` cover the full selected cohort, not just the
page. `coverage` reports audited eligible innings in scope, exclusions and
unverified innings. It includes the reference innings in the eligible population
count if that innings is in scope, while `independent_innings` excludes it.
Historical results describe completed, audited cases; they are not predictions,
proof of tactics, or independent observations for every adjacent delivery.

## Evidence and pagination

Pass a returned case's complete `evidence_ref` into `get_evidence`, with detail
`summary`, `overs`, or `deliveries`. Summary is the default; detailed pages have
at most 50 records. Evidence includes source hash/revision, normalized selection,
matched before/after states and terminal state. Detailed evidence spans the whole
innings, including events after the matched boundary, and labels the selected
delivery. It is evidence for inspection, not additional state-matching input.

References contain a validated recipe, not a server-side session ID. The server
recomputes membership; a point that is no longer a selected case is rejected.
References can be replayed after restart while the exact database and manifest
revision remain available. They are not signed proof that a previous caller used
that recipe, and do not archive superseded database contents.

For another page, repeat the same request with its returned `next_cursor`.
A cursor binds the revision and normalized selection; evidence cursors also bind
the case and detail level. Page size can change without changing aggregate counts.
Offsets outside the result set, stale revisions and changed recipes are rejected.
No data from a newer revision is silently substituted. Query failures return MCP
`isError`; empty cohorts return structured `empty` results.

## Validation and limits

Tests cover explicit before/after arithmetic, extras, outcome-independent
selection, one state per innings, date exclusion, reference exclusion, pagination,
reference validation and revision failure paths. The task-3 audit also compares
all canonical states in the audited IPL subset with raw source arithmetic and
checks real stdio calls plus replay across server processes.

This implementation scans and reconstructs the scoped audited innings on each
call; it does not yet cache or materialize state. Large scopes and repeated
inspection have a measurable cost. Responses are page-bounded; performance tuning
and richer cohort comparisons remain separate tasks. No live-feed, prediction,
Cross-examiner prompt or causal-comparison engine is included here.
