import { createHash } from "node:crypto";
import type { Json } from "@duckdb/node-api";
import { envelope, type Envelope, type Revision } from "./contracts.js";
import type { InvestigationContext } from "./context.js";
import { SimilarInputSchema, EvidenceInputSchema, SelectionSchema, StateSchema, type Selection, type Point } from "./time-machine-contracts.js";
import { loadChaseStates } from "../queries/chase-state.js";

type Row = Record<string, Json>;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const reply = (status: Envelope["status"], data: Record<string, unknown>, revision: Revision, filters: Record<string, unknown>): Envelope => ({
  ...envelope(status, data, revision, filters, [], ["Historical outcomes describe a selected, source-audited cohort; they are not calibrated predictions or causal evidence.", "One deterministic state per innings. Exclusion reasons may overlap. No tolerances are silently widened."]),
  provenance: { revision, definition_version: "chase-v1" },
});
export function stateAt(row: Row, boundary: "before" | "after") {
  return { runs_required: Number(row[`${boundary}_runs_required`]), legal_balls_remaining: Number(row[`${boundary}_balls_remaining`]), wickets_remaining: Number(row[`${boundary}_wickets_remaining`]) };
}
function point(row: Row): Point { return { match_id: String(row.match_id), innings_number: 2, over_number: Number(row.over_number), ball_number: Number(row.ball_number) }; }
function samePoint(row: Row, p: Point) { return row.match_id===p.match_id && Number(row.over_number)===p.over_number && Number(row.ball_number)===p.ball_number; }
const compareText = (a: string,b: string) => a<b?-1:a>b?1:0;

/** Outcomes are deliberately not inspected until AFTER state-only ranking. */
export function selectCases(rows: Row[], selection: Selection) {
  const selected = new Map<string, { row: Row; state: ReturnType<typeof stateAt>; distance: number; differences: {runs:number;balls:number;wickets:number} }>();
  for (const row of rows) {
    if (row.match_id===selection.exclude_match_id) continue;
    const state=stateAt(row,selection.boundary);
    if (!StateSchema.safeParse(state).success) continue; // Never match completed innings.
    const differences={runs:Math.abs(state.runs_required-selection.state.runs_required),balls:Math.abs(state.legal_balls_remaining-selection.state.legal_balls_remaining),wickets:Math.abs(state.wickets_remaining-selection.state.wickets_remaining)};
    if (differences.runs>selection.tolerances.runs || differences.balls>selection.tolerances.balls || differences.wickets>selection.tolerances.wickets) continue;
    const distance=differences.runs/(selection.tolerances.runs||1)+differences.balls/(selection.tolerances.balls||1)+differences.wickets/(selection.tolerances.wickets||1);
    const id=String(row.match_id), previous=selected.get(id);
    if (!previous || distance<previous.distance || (distance===previous.distance && (Number(row.over_number)<Number(previous.row.over_number) || (row.over_number===previous.row.over_number && Number(row.ball_number)<Number(previous.row.ball_number))))) selected.set(id,{row,state,distance,differences});
  }
  return [...selected.values()].sort((a,b)=>a.distance-b.distance||compareText(String(a.row.match_id),String(b.row.match_id))||Number(a.row.over_number)-Number(b.row.over_number)||Number(a.row.ball_number)-Number(b.row.ball_number));
}
function outcome(row: Row) { return row.outcome_result==='tie'?'tie':row.outcome_winner==null?'unknown':row.outcome_winner===row.batting_team?'won':'lost'; }
async function finalReply(context: InvestigationContext, original: Revision, result: Envelope) {
  const current=await context.snapshot();
  if(current.revision.status!=='verified'||current.revision.id!==original.id) return reply('stale_reference',{},current.revision,result.applied_filters);
  return result;
}
function scopeValid(selection: { scope: Selection["scope"] }) {
  const s=selection.scope;
  return !(s.date_from && ((s.date_to&&s.date_from>s.date_to)||(s.as_of&&s.date_from>s.as_of)));
}
export async function findSimilarSituations(context: InvestigationContext, raw: unknown): Promise<Envelope> {
  const args=SimilarInputSchema.parse(raw);
  const snapshot=await context.snapshot(), revision=snapshot.revision;
  if(revision.status==='stale'||(args.expected_revision&&revision.id!==args.expected_revision)||(args.cursor&&revision.id!==args.cursor.revision)) return reply('stale_reference',{},revision,args);
  if(revision.status!=='verified'||!snapshot.manifest) return reply('unavailable_data',{},revision,args);
  if(!!args.state===!!args.reference || !scopeValid(args)) return reply('unsupported_scope',{reason:'Supply exactly one state or reference, and an ordered date scope.'},revision,args);
  let state=args.state;
  if(args.reference) {
    // A reference resolves in the audited population, independently of the comparator date/venue filters.
    const source=await loadChaseStates(context,snapshot.manifest,{match_type:'T20',event_name:'Indian Premier League',gender:args.scope.gender});
    const r=source.rows.find(r=>samePoint(r,args.reference!));
    if(!r) return finalReply(context,revision,reply('unavailable_data',{reason:'Reference boundary is absent or not source-audited.'},revision,args));
    const parsed=StateSchema.safeParse(stateAt(r,args.boundary));
    if(!parsed.success) return finalReply(context,revision,reply('unsupported_scope',{reason:'Reference is a completed or unsupported chase state.'},revision,args));
    state=parsed.data;
  }
  const selection=SelectionSchema.parse({state,tolerances:args.tolerances,scope:args.scope,boundary:args.boundary,exclude_match_id:args.reference?.match_id});
  const selectionHash=hash(selection);
  if(args.cursor&&args.cursor.selection_hash!==selectionHash) return reply('unsupported_scope',{reason:'Cursor belongs to a different selection.'},revision,args);
  const {rows,coverage}=await loadChaseStates(context,snapshot.manifest,selection.scope);
  const cases=selectCases(rows,selection), offset=args.cursor?.offset??0;
  if(offset>cases.length) return finalReply(context,revision,reply('unsupported_scope',{reason:'Cursor is outside this result set.'},revision,args));
  const outcomes={won:0,lost:0,tie:0,unknown:0};for(const c of cases)outcomes[outcome(c.row)]++;
  const shown=cases.slice(offset,offset+args.page_size);
  const result=reply(cases.length?'ok':'empty',{
    coverage, independent_innings:cases.length, outcomes,
    ranking:'Sum of absolute differences divided by each nonzero tolerance; ties by earliest boundary, then match ID.',
    evidence_set:{version:'chase-v1',revision:revision.id,selection},
    cases:shown.map(c=>({point:point(c.row),date:c.row.date_start,season:c.row.season,venue:c.row.venue,batting_team:c.row.batting_team,bowling_team:c.row.bowling_team,state:c.state,differences:c.differences,distance:c.distance,outcome:outcome(c.row),evidence_ref:{version:'chase-v1',revision:revision.id,selection,point:point(c.row)}})),
    pagination:{offset,page_size:args.page_size,next_cursor:offset+shown.length<cases.length?{revision:revision.id,selection_hash:selectionHash,offset:offset+shown.length}:null},
  },revision,selection);
  return finalReply(context,revision,result);
}
export async function getEvidence(context: InvestigationContext, raw: unknown): Promise<Envelope> {
  const args=EvidenceInputSchema.parse(raw), ref=args.evidence_ref;
  const snapshot=await context.snapshot(),revision=snapshot.revision;
  if(revision.status==='stale'||revision.id!==ref.revision) return reply('stale_reference',{},revision,ref.selection);
  if(revision.status!=='verified'||!snapshot.manifest) return reply('unavailable_data',{},revision,ref.selection);
  if(!scopeValid(ref.selection)) return reply('unsupported_scope',{},revision,ref.selection);
  const cursorHash=hash({ref,detail:args.detail});
  if(args.cursor&&(args.cursor.revision!==revision.id||args.cursor.selection_hash!==cursorHash)) return reply('stale_reference',{reason:'Evidence cursor does not match this revision, case and detail.'},revision,ref.selection);
  const {rows}=await loadChaseStates(context,snapshot.manifest,ref.selection.scope);
  const matched=selectCases(rows,ref.selection).find(c=>samePoint(c.row,ref.point));
  if(!matched) return finalReply(context,revision,reply('unavailable_data',{reason:'This point is not a selected case under the supplied recipe.'},revision,ref.selection));
  const innings=rows.filter(r=>r.match_id===ref.point.match_id);
  const before=(r:Row)=>stateAt(r,'before'), after=(r:Row)=>stateAt(r,'after');
  let records: unknown[]=[];
  if(args.detail==='deliveries') records=innings.map(r=>({point:point(r),batter:r.batter,batter_id:r.batter_id,bowler:r.bowler,bowler_id:r.bowler_id,non_striker:r.non_striker,runs_batter:r.runs_batter,runs_total:r.runs_total,extras:{wides:r.extras_wides,noballs:r.extras_noballs,byes:r.extras_byes,legbyes:r.extras_legbyes,penalty:r.extras_penalty},wicket:{occurred:r.is_wicket,kind:r.wicket_kind,player_out:r.wicket_player_out},before:before(r),after:after(r),selected_delivery:samePoint(r,ref.point)}));
  if(args.detail==='overs') {
    const groups=new Map<number,Row[]>();for(const r of innings){const n=Number(r.over_number);if(!groups.has(n))groups.set(n,[]);groups.get(n)!.push(r);}
    records=[...groups.entries()].map(([over,rs])=>({over_number:over,first_delivery:point(rs[0]),last_delivery:point(rs.at(-1)!),deliveries:rs.length,before:before(rs[0]),after:after(rs.at(-1)!),runs:rs.reduce((n,r)=>n+Number(r.runs_total),0)}));
  }
  const offset=args.cursor?.offset??0;
  if(offset>records.length) return finalReply(context,revision,reply('unsupported_scope',{reason:'Cursor outside evidence.'},revision,ref.selection));
  const page=records.slice(offset,offset+args.page_size);
  return finalReply(context,revision,reply('ok',{
    evidence_ref:ref,source:snapshot.manifest.innings.find(i=>i.match_id===ref.point.match_id),
    match:{match_id:ref.point.match_id,date:matched.row.date_start,venue:matched.row.venue,batting_team:matched.row.batting_team,bowling_team:matched.row.bowling_team,target_runs:Number(matched.row.target_runs),outcome:outcome(matched.row)},
    matched_state:matched.state,matched_before:before(matched.row),matched_after:after(matched.row),
    terminal_state:after(innings.at(-1)!),evidence_scope:'whole_innings_including_deliveries_after_the_matched_boundary',
    detail:args.detail,records:page,
    pagination:{offset,page_size:args.page_size,total_records:records.length,next_cursor:offset+page.length<records.length?{revision:revision.id,selection_hash:cursorHash,offset:offset+page.length}:null},
  },revision,ref.selection));
}
