import { buildMatchFilter, buildWhereClause } from "../queries/common.js";
import { runQuery } from "../queries/run.js";
import { CoverageInputSchema, envelope, type Envelope } from "./contracts.js";
import type { InvestigationContext } from "./context.js";
import { resolveIdentity } from "./identity.js";

export async function getDataCoverage(context: InvestigationContext, raw: unknown): Promise<Envelope> {
  const args = CoverageInputSchema.parse(raw);
  const { expected_revision, ...filters } = args;
  const { revision, manifest } = await context.snapshot();
  if (revision.status === "stale" || (expected_revision && expected_revision !== revision.id)) return envelope("stale_reference", {}, revision, filters);
  if ((args.date_from && args.date_to && args.date_from > args.date_to) || ((args.player_id || args.player_name) && !args.perspective)) return envelope("unsupported_scope", { reason: "Use an ordered date range and specify perspective for a player scope." }, revision, filters);
  if (args.capability === "chase_state" && (args.match_type !== "T20" || args.event_name !== "Indian Premier League")) return envelope("unsupported_scope", { reason: "Audited chase coverage currently requires match_type T20 and event_name Indian Premier League." }, revision, filters);
  const identity = await resolveIdentity(context, args.player_id, args.player_name);
  if (identity.status !== "ok") return envelope(identity.status, { candidates: identity.candidates, truncated: identity.truncated }, revision, filters);
  const subjects = identity.candidates;
  const { whereClauses, params } = buildMatchFilter(args);
  if (subjects.length) {
    params.subject_id = subjects[0].player_id;
    whereClauses.push(args.perspective === "batting" ? "d.batter_id = $subject_id" : "d.bowler_id = $subject_id");
  }
  if (args.capability === "chase_state") whereClauses.push("i.innings_number = 2 AND NOT i.is_super_over");
  const from = `FROM matches m LEFT JOIN innings i ON i.match_id=m.match_id
    LEFT JOIN deliveries d ON d.match_id=i.match_id AND d.innings_number=i.innings_number
    LEFT JOIN players bp ON bp.player_id=d.bowler_id
    LEFT JOIN players ap ON ap.player_id=d.batter_id
    ${buildWhereClause(whereClauses)}`;
  const [r] = await runQuery(context.db, `SELECT
    COUNT(DISTINCT m.match_id) AS matches,
    COUNT(DISTINCT (i.match_id,i.innings_number)) FILTER (WHERE i.match_id IS NOT NULL) AS innings,
    COUNT(d.match_id) AS deliveries,
    MIN(m.date_start) AS earliest, MAX(m.date_start) AS latest,
    COUNT(DISTINCT m.match_id) FILTER (WHERE m.event_stage IS NULL) AS unknown_stage_matches,
    COUNT(d.match_id) FILTER (WHERE ap.player_id IS NULL) AS unresolved_batter_deliveries,
    COUNT(d.match_id) FILTER (WHERE bp.player_id IS NULL) AS unresolved_bowler_deliveries,
    COUNT(d.match_id) FILTER (WHERE bp.bowling_style_broad IN ('Pace','Spin')) AS known_style_deliveries,
    COUNT(DISTINCT d.bowler_id) AS bowlers,
    COUNT(DISTINCT d.bowler_id) FILTER (WHERE bp.bowling_style_broad IS NULL OR bp.bowling_style_broad NOT IN ('Pace','Spin')) AS unknown_style_bowlers
    ${from}`, params);
  const n = (key: string) => Number(r[key] ?? 0);
  const data: Record<string, unknown> = {
    matches: n("matches"), innings: n("innings"), deliveries: n("deliveries"),
    date_range: { earliest: r.earliest ?? null, latest: r.latest ?? null },
    identity: { unresolved_batter_deliveries: n("unresolved_batter_deliveries"), unresolved_bowler_deliveries: n("unresolved_bowler_deliveries") },
    bowling_style: { known_deliveries: n("known_style_deliveries"), unknown_deliveries: n("deliveries") - n("known_style_deliveries"), bowlers: n("bowlers"), unknown_style_bowlers: n("unknown_style_bowlers") },
    unknown_stage_matches: n("unknown_stage_matches"),
  };
  const warnings = ["Coverage describes stored records, not completeness against all real-world cricket.", "Style coverage does not establish enrichment accuracy."];
  if (revision.status !== "verified") warnings.push(revision.reason!);
  let status: Envelope["status"] = n("matches") === 0 ? "empty" : "ok";
  if (args.capability === "bowling_style" && n("matches") > 0 && n("known_style_deliveries") === 0) status = "insufficient_evidence";
  if (args.capability === "chase_state") {
    if (!manifest || revision.status !== "verified") {
      data.chase_state = { eligible_innings: null, excluded_innings: null, unverified_innings: n("innings") };
      if (status !== "empty") status = "unavailable_data";
    } else {
      const selected = await runQuery(context.db, `SELECT DISTINCT i.match_id,i.innings_number ${from}`, params);
      const audit = new Map(manifest.innings.map(i => [`${i.match_id}/${i.innings_number}`, i]));
      let eligible = 0, excluded = 0, unverified = 0;
      const reasons: Record<string, number> = {};
      for (const i of selected) {
        const entry = audit.get(`${i.match_id}/${i.innings_number}`);
        if (!entry) unverified++;
        else if (entry.eligible) eligible++;
        else { excluded++; for (const reason of entry.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1; }
      }
      data.chase_state = { eligible_innings: eligible, excluded_innings: excluded, unverified_innings: unverified, exclusion_reasons: reasons, definition_version: manifest.definition_version };
      warnings.push("Exclusion reasons overlap. Eligibility applies to whole innings, not independent observations for every delivery.");
      if (status !== "empty" && !eligible) status = "insufficient_evidence";
    }
  }
  // Reject a changed dataset even when the change happens during the queries.
  const after = await context.snapshot();
  if (after.revision.status === "stale" || after.revision.id !== revision.id) return envelope("stale_reference", {}, after.revision, filters);
  return envelope(status, data, revision, filters, subjects, warnings);
}
