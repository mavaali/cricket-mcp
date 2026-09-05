# Investigation performance and resource limits

The local investigation context retains at most one normalized chase scope, bound to the verified database revision. Repeating a situation search, comparison and evidence lookup in that scope reuses the same canonical rows. Calls with the same pending scope share a load. Changing scope replaces the entry; changing the revision invalidates it. Failed loads are not retained. Rows and coverage metadata are frozen to prevent response mutation from corrupting later requests.

Retention is capped at 150,000 rows and 192 MiB of serialized data per context. These caps are **not** a total JavaScript heap or process RSS limit. Queries larger than either cap still execute but are not cached. Different in-flight scopes can allocate concurrently. The supplied audit contains 133,194 eligible chase deliveries. One HTTP server shares its context across sessions; separate server processes each have their own cache. Custom mutable/in-memory contexts do not cache by default.

To favor lower retained heap over repeated-query speed, start with:

```sh
cricket-mcp serve --db /path/to/cricket.duckdb \
  --investigation-manifest /path/to/investigation-manifest.json \
  --no-investigation-cache
```

Programmatic callers can use `ServerOptions.investigationCache: false` or `InvestigationOptions.cache: false`. Disabling caching does not disable revision verification or change evidence semantics. The first verified call still hashes the database. Cold filesystem, OneLake, client network and model reasoning costs are separate from warm local handler latency.

Career impact batches the five scoring aggregates and role-aware team membership over its bounded selected match list. A nonempty call uses eight queries for both 10 and 50 matches, compared with the previous `2 + 6N`. No materialized tables, indexes, dependency changes or database writes are introduced. Impact scoring formulas remain unchanged.

The opponent field has an intentional correctness fix: batting participation identifies the batting team, and bowling participation identifies the bowling team. Previously an unordered row could identify the opposition as the player's own team. Conflicting team identities now return `Unknown` instead of selecting one arbitrarily. Legacy partial-name resolution is otherwise unchanged.

Existing comparison and evidence pages remain bounded at 50 records. Full-cohort statistics still cover all selected innings regardless of page size. Text and structured MCP results remain equivalent. There is no response truncation or hidden top-k selection to meet a latency target.

The external task-5 report contains before/after measurements, cold-call observations, response sizes, a controlled memory comparison, SDK checks and compatibility differences. Measurements are representative warm medians on one local dataset, not production SLOs or p95 estimates. Investigations remain limited to the previously documented supported scope; this optimization does not broaden data-quality claims.
