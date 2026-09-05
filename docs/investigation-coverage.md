# Investigation coverage

`get_data_coverage` reports the records available for a selected question. It does
not compute comparisons, retrieve similar situations, or predict match outcomes.

```json
{"capability":"bowling_style","event_name":"Indian Premier League","match_type":"T20","player_name":"Kohli","perspective":"batting"}
```

Player names use literal case-insensitive substring matching. Ambiguous names
return candidates (up to ten, with a truncation flag). Resolve once, then use
`player_id`. If both ID and name are provided, the name must match the canonical
player name, ignoring case. Perspective is required for a player filter and
selects deliveries faced or bowled by that player. Existing name-based tools keep
their previous behavior.

Dates must be valid YYYY-MM-DD calendar dates in ascending order. Event and venue
filters reuse existing partial-match semantics. The coverage tool intentionally
supports a bounded filter set; unsupported arguments are not a SQL interface.

## Responses

Every successful tool invocation returns the same JSON in `structuredContent`
and a text block. An output schema describes the envelope. Fields include status,
data, resolved subjects, applied filters, provenance and warnings. Stored innings,
match and delivery counts are distinct. Style coverage counts null, `Unknown` and
other non-Pace/Spin labels as unknown, over the selected deliveries. Missing stage
is reported as missing, not as a league match. Coverage is not enrichment accuracy
or completeness against every real-world match.

- `ok`: requested coverage is available.
- `empty`: no matches in scope.
- `insufficient_evidence`: matches exist, but no known style deliveries or no
  eligible audited chases support the requested capability.
- `ambiguous_subject`: name matches more than one player; choose an ID.
- `unsupported_scope`: conflicting identity/date/perspective or unsupported chase scope.
- `unavailable_data`: missing identity, or chase verification unavailable.
- `stale_reference`: requested revision differs or the verified database changed.

Execution failures return MCP `isError`, not a successful response with zero counts.

## Verified local chase coverage

Inventory works without an audit manifest. Verified chase coverage requires an
operator-supplied manifest bound to the exact read-only database:

```sh
npm run serve -- --db /path/to/cricket.duckdb --investigation-manifest /path/to/audit.json
```

The manifest is trusted audit input, not something supplied in tool arguments.
Hash checks establish its binding to a file, not that an arbitrary author audited
it correctly. Schema:

```json
{
  "version": 1,
  "definition_version": "ipl-standard-chase-v1",
  "database_sha256": "<64 lowercase hex characters>",
  "source_archive_sha256": "<64 lowercase hex characters>",
  "innings": [
    {
      "match_id": "<source match ID>",
      "innings_number": 2,
      "source_sha256": "<64 lowercase hex characters>",
      "source_revision": 1,
      "eligible": true,
      "reasons": []
    }
  ]
}
```

Rejected innings require at least one reason. Duplicate innings are invalid.
Eligibility must come from source verification, including shortened targets,
retirement/absent-hurt events, miscounted overs, target/terminal reconciliation
and any other unsupported source feature. Missing manifest entries remain
unverified. The manifest is immutable for the process lifetime; restart to load a
new one. `ipl-standard-chase-v1` only supports explicit `match_type: "T20"` and
`event_name: "Indian Premier League"` when requesting `capability: "chase_state"`.

The first manifest-backed call hashes the entire database once; this has startup
cost. Subsequent calls check file identity, size and modification metadata before
and after queries. A WAL, wrong database hash or observed file change prevents
verified results. An observed post-verification change invalidates the context
until restart. This assumes the read-only database is immutable while served,
not an adversarial file system capable of hiding changes. Auto-update can invalidate
an old manifest; re-audit after updates or enrichment. Evidence from older revisions
cannot be recovered merely from an ID.

Without a manifest, verified eligible counts are `null`, not zero. OneLake can
report inventory but currently has no pinned multi-table revision contract, so it
cannot assert audited chase eligibility. These restrictions apply to the new tool;
legacy tools remain available.

`expected_revision` lets callers require the exact revision returned earlier.
The revision incorporates both database and manifest content hashes.

## Validation

```sh
npm run build
node_modules/.bin/tsx --test tests/investigation.test.ts
```

Tests use disposable databases and an actual MCP client/server connection.
Existing handler snapshots should be compared before/after changes on the same
dataset; matching snapshots only establish compatibility for exercised inputs.
