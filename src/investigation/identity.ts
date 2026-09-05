import { runQuery } from "../queries/run.js";
import type { InvestigationContext } from "./context.js";
export interface Subject { player_id: string; player_name: string }
export async function resolveIdentity(context: InvestigationContext, id?: string, name?: string): Promise<{ status: "ok" | "ambiguous_subject" | "unavailable_data" | "unsupported_scope"; candidates: Subject[]; truncated: boolean }> {
  if (!id && !name) return { status: "ok", candidates: [], truncated: false };
  const rows = await runQuery(context.db, `SELECT player_id,player_name FROM players WHERE ${id ? "player_id = $value" : "strpos(lower(player_name), lower($value)) > 0"} ORDER BY player_name,player_id LIMIT 11`, { value: id ?? name! });
  const candidates = rows.map(r => ({ player_id: String(r.player_id), player_name: String(r.player_name) }));
  if (id && name && candidates.length && candidates[0].player_name.toLowerCase() !== name.toLowerCase()) return { status: "unsupported_scope", candidates, truncated: false };
  return { status: candidates.length === 0 ? "unavailable_data" : candidates.length > 1 ? "ambiguous_subject" : "ok", candidates: candidates.slice(0, 10), truncated: candidates.length > 10 };
}
