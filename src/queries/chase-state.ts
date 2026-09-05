import { cachedChase } from "../investigation/chase-cache.js";
import type { InvestigationContext, Manifest } from "../investigation/context.js";
import type { Scope } from "../investigation/time-machine-contracts.js";
import { runQuery } from "./run.js";

/** Only source-audited normal second innings are admitted. Filtering a delivery
 * boundary happens AFTER these full-innings windows, never inside them. */
export async function loadChaseStates(context: InvestigationContext, manifest: Manifest, scope: Scope) {
  return cachedChase(context, manifest, scope, () => queryChaseStates(context, manifest, scope));
}
async function queryChaseStates(context: InvestigationContext, manifest: Manifest, scope: Scope) {
  const clauses = ["m.event_name = $event", "m.match_type = 'T20'", "m.gender = $gender", "i.innings_number=2", "NOT i.is_super_over"];
  const params: Record<string, string | number> = { event: scope.event_name, gender: scope.gender };
  for (const [key, column, op] of [["season","m.season","="],["venue","m.venue","="],["date_from","m.date_start",">="],["date_to","m.date_start","<="],["as_of","COALESCE(m.date_end,m.date_start)","<="]] as const) {
    const value = scope[key]; if (value) { clauses.push(`${column} ${op} $${key}`); params[key] = value; }
  }
  const population = await runQuery(context.db, `SELECT m.match_id FROM matches m JOIN innings i USING(match_id) WHERE ${clauses.join(" AND ")}`, params);
  const audit = new Map(manifest.innings.map(i=>[i.match_id,i]));
  const eligible: string[] = []; let excluded = 0, unverified = 0;
  const reasons: Record<string, number> = {};
  for (const m of population) {
    const entry = audit.get(String(m.match_id));
    if (!entry) unverified++;
    else if (entry.eligible) eligible.push(entry.match_id);
    else { excluded++; for (const reason of entry.reasons) reasons[reason]=(reasons[reason]??0)+1; }
  }
  const coverage = { eligible_innings_in_scope: eligible.length, excluded_innings: excluded, unverified_innings: unverified, exclusion_reasons: reasons };
  if (!eligible.length) return { rows: [], coverage };
  const rows = await runQuery(context.db, `SELECT d.*, m.date_start,m.season,m.venue,m.outcome_winner,m.outcome_result,
    i.batting_team,i.bowling_team,i.target_runs,
    i.target_runs-COALESCE(SUM(d.runs_total) OVER beforew,0) AS before_runs_required,
    120-COALESCE(SUM(CASE WHEN d.extras_wides=0 AND d.extras_noballs=0 THEN 1 ELSE 0 END) OVER beforew,0) AS before_balls_remaining,
    10-COALESCE(SUM(CASE WHEN d.is_wicket AND d.wicket_kind<>'retired hurt' THEN 1 ELSE 0 END) OVER beforew,0) AS before_wickets_remaining,
    i.target_runs-SUM(d.runs_total) OVER afterw AS after_runs_required,
    120-SUM(CASE WHEN d.extras_wides=0 AND d.extras_noballs=0 THEN 1 ELSE 0 END) OVER afterw AS after_balls_remaining,
    10-SUM(CASE WHEN d.is_wicket AND d.wicket_kind<>'retired hurt' THEN 1 ELSE 0 END) OVER afterw AS after_wickets_remaining
    FROM deliveries d JOIN innings i USING(match_id,innings_number) JOIN matches m USING(match_id)
    WHERE d.innings_number=2 AND d.match_id IN (SELECT json_extract_string(value, '$') FROM json_each($ids))
    WINDOW beforew AS (PARTITION BY d.match_id ORDER BY d.over_number,d.ball_number ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
    afterw AS (PARTITION BY d.match_id ORDER BY d.over_number,d.ball_number ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ORDER BY d.match_id,d.over_number,d.ball_number`, { ids: JSON.stringify(eligible) });
  return { rows, coverage };
}
