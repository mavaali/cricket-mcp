import { createHash } from 'node:crypto';
import type { Json } from '@duckdb/node-api';
import { envelope, type Envelope, type Revision } from './contracts.js';
import type { InvestigationContext, Manifest } from './context.js';
import { CompareInputSchema, CohortEvidenceSchema, type Recipe } from './cohort-contracts.js';
import { loadStyleUnits } from '../queries/cohorts.js';
import { loadChaseStates } from '../queries/chase-state.js';
import { selectCases } from './time-machine.js';
import { resolveIdentity } from './identity.js';
import { PHASE_OVERS } from '../queries/common.js';

type Row=Record<string,Json>;
type Unit={match_id:string;innings_number:number;season:string|null;phase:string;numerator:number;denominator:number;deliveries:number;legal_balls:number;short_window:boolean};
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const key=(u:Unit)=>`${u.match_id}/${u.innings_number}`;
const phase=(over:number)=>over<=PHASE_OVERS.powerplay[1]?'powerplay':over<=PHASE_OVERS.middle[1]?'middle':'death';
function response(status:Envelope['status'],data:Record<string,unknown>,revision:Revision,filters:Record<string,unknown>):Envelope{
 const r=envelope(status,data,revision,filters,[],['Descriptive comparisons only: no causal verdict, calibrated prediction, confidence interval or significance claim.','Deliveries within innings are dependent. Overlapping innings are disclosed. No sample-size threshold establishes statistical sufficiency.','Report every inspected split and sensitivity; do not select only favorable results.']);
 r.provenance.definition_version='cohort-v1';return r;
}
async function finish(context:InvestigationContext,revision:Revision,r:Envelope){const current=await context.snapshot();return current.revision.status==='verified'&&current.revision.id===revision.id?r:response('stale_reference',{},current.revision,r.applied_filters);}
function valid(recipe:Recipe){const s=recipe.kind==='chase'?recipe.evidence_set.selection.scope:recipe.scope;return !(s.date_from&&((s.date_to&&s.date_from>s.date_to)||(s.as_of&&s.date_from>s.as_of)))&&recipe.groups[0].label!==recipe.groups[1].label;}
function aggregate(units:Unit[],metric:Recipe['metric']){
 const numerator=units.reduce((n,u)=>n+u.numerator,0),denominator=units.reduce((n,u)=>n+u.denominator,0);
 return {numerator,denominator,value:denominator?numerator/denominator*(metric==='next_six_or_end_runs'?1:100):null,independent_innings:new Set(units.map(key)).size,deliveries:units.reduce((n,u)=>n+u.deliveries,0),legal_balls:units.reduce((n,u)=>n+u.legal_balls,0),short_windows:units.filter(u=>u.short_window).length};
}
function byInnings(units:Unit[]):Unit[]{const result=new Map<string,Unit>();for(const u of units){const previous=result.get(key(u));if(!previous)result.set(key(u),{...u});else{previous.numerator+=u.numerator;previous.denominator+=u.denominator;previous.deliveries+=u.deliveries;previous.legal_balls+=u.legal_balls;previous.short_window||=u.short_window;previous.phase='multiple';}}return [...result.values()].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);}
function contrast(groups:Unit[][],metric:Recipe['metric']){
 const stats=groups.map(g=>aggregate(g,metric));const a=new Set(groups[0].map(key));
 return {groups:stats,difference_a_minus_b:stats.every(s=>s.value!==null)?stats[0].value!-stats[1].value!:null,overlapping_innings:new Set(groups[1].filter(u=>a.has(key(u))).map(key)).size};
}
async function load(context:InvestigationContext,manifest:Manifest,recipe:Recipe){
 const groups:Unit[][]=[[],[]];let coverage:Record<string,unknown>={};let records:(group:number,id:string,innings:number)=>Promise<Row[]>;
 if(recipe.kind==='batting_style'){
  const source=await loadStyleUnits(context,recipe.scope,recipe.player_id);
  const phases=new Set(recipe.groups.flatMap(g=>g.phases));const selected=source.units.filter(r=>phases.has(r.phase as 'powerplay'|'middle'|'death'));
  coverage={population:'Stored non-super-over, six-ball-over IPL batting deliveries; chase-source eligibility is not applied to batting aggregates.',style_provenance:'Stored enrichment labels are file-revision-bound but not independently source-audited.',phase_deliveries:selected.reduce((n,r)=>n+Number(r.deliveries),0),unknown_style_deliveries:selected.filter(r=>r.style==='unknown').reduce((n,r)=>n+Number(r.deliveries),0),unknown_style_by_phase:[...phases].map(p=>({phase:p,deliveries:selected.filter(r=>r.phase===p&&r.style==='unknown').reduce((n,r)=>n+Number(r.deliveries),0)}))};
  recipe.groups.forEach((g,index)=>{groups[index]=source.units.filter(r=>r.style===g.style&&g.phases.includes(r.phase as 'powerplay'|'middle'|'death')).map(r=>({match_id:String(r.match_id),innings_number:Number(r.innings_number),season:r.season===null?null:String(r.season),phase:String(r.phase),numerator:Number(r[recipe.metric==='strike_rate'?'runs':'boundaries']),denominator:Number(r.balls_faced),deliveries:Number(r.deliveries),legal_balls:Number(r.legal_balls),short_window:false}));});
  records=async(index,id,innings)=>(await source.records(id,innings)).filter(r=>r.style===recipe.groups[index].style&&recipe.groups[index].phases.includes(r.phase as 'powerplay'|'middle'|'death'));
 }else{
  const selection=recipe.evidence_set.selection,source=await loadChaseStates(context,manifest,selection.scope),cases=selectCases(source.rows,selection);
  coverage={...source.coverage,selected_innings:cases.length,grouping_uses_outcomes:recipe.groups.some(g=>!!g.outcome)};
  const windows=new Map<string,Row[]>();
  const inningsRows=new Map<string,Row[]>();for(const row of source.rows){const id=String(row.match_id);if(!inningsRows.has(id))inningsRows.set(id,[]);inningsRows.get(id)!.push(row);}
  for(const c of cases){
   const row=c.row,id=String(row.match_id),all=inningsRows.get(id)!;
   const start=all.indexOf(row)+(selection.boundary==='after'?1:0);let legal=0;const window:Row[]=[];
   for(const r of all.slice(start)){window.push(r);if(Number(r.extras_wides)===0&&Number(r.extras_noballs)===0)legal++;if(legal===6)break;}
   windows.set(id,recipe.metric==='win_rate'?all:window);
   const outcome=row.outcome_result==='tie'?'tie':row.outcome_winner===null?'unknown':row.outcome_winner===row.batting_team?'won':'lost';
   recipe.groups.forEach((g,index)=>{
    for(const k of ['runs_required','legal_balls_remaining','wickets_remaining'] as const){const range=g[k];if(range&&(c.state[k]<range.min||c.state[k]>range.max))return;}
    if(g.batting_team&&g.batting_team!==row.batting_team||g.outcome&&g.outcome!==outcome)return;
    groups[index].push({match_id:id,innings_number:2,season:row.season===null?null:String(row.season),phase:phase(Number(row.over_number)),numerator:recipe.metric==='win_rate'?Number(outcome==='won'):window.reduce((n,r)=>n+Number(r.runs_total),0),denominator:recipe.metric==='win_rate'?Number(outcome!=='unknown'):1,deliveries:recipe.metric==='win_rate'?all.length:window.length,legal_balls:recipe.metric==='win_rate'?all.filter(r=>Number(r.extras_wides)===0&&Number(r.extras_noballs)===0).length:legal,short_window:recipe.metric!=='win_rate'&&legal<6});
   });
  }
  records=async(_index,id)=>windows.get(id)??[];
 }
 return {groups,coverage,records};
}
export async function compareCohorts(context:InvestigationContext,raw:unknown):Promise<Envelope>{
 const args=CompareInputSchema.parse(raw),recipe=args.comparison,snapshot=await context.snapshot(),revision=snapshot.revision;
 if(revision.status==='stale'||args.expected_revision&&args.expected_revision!==revision.id||args.cursor&&args.cursor.revision!==revision.id||recipe.kind==='chase'&&recipe.evidence_set.revision!==revision.id)return response('stale_reference',{},revision,args);
 if(revision.status!=='verified'||!snapshot.manifest)return response('unavailable_data',{},revision,args);
 if(!valid(recipe))return response('unsupported_scope',{reason:'Use ordered dates and two distinct group labels.'},revision,args);
 const identity=recipe.kind==='batting_style'?await resolveIdentity(context,recipe.player_id):undefined;
 if(identity&&identity.status!=='ok')return finish(context,revision,response(identity.status,{candidates:identity.candidates},revision,args));
 const source=await load(context,snapshot.manifest,recipe),units=source.groups.map(byInnings),stats=contrast(units,recipe.metric);
 const ref=(u:Unit,group:number)=>({version:'cohort-v1',revision:revision.id,comparison:recipe,group,match_id:u.match_id,innings_number:u.innings_number});
 const all=units.flatMap((group,index)=>group.map(u=>({...u,group:index,evidence_ref:ref(u,index)})));
 const offset=args.cursor?.offset??0,cursorHash=hash({recipe,stratify_by:args.stratify_by});
 if(args.cursor&&args.cursor.selection_hash!==cursorHash||offset>all.length)return finish(context,revision,response('unsupported_scope',{reason:'Cursor does not belong to this comparison.'},revision,args));
 const strata=args.stratify_by==='none'?[]:[...new Set(source.groups.flat().map(u=>u[args.stratify_by as 'season'|'phase']))].sort((a,b)=>String(a).localeCompare(String(b))).map(value=>({value,...contrast(source.groups.map(g=>g.filter(u=>u[args.stratify_by as 'season'|'phase']===value)),recipe.metric)}));
 // Contrary cases use the direction of the complete aggregate, never a hidden subgroup search.
 const difference=stats.difference_a_minus_b;
 const contrary=units.map((g,index)=>{const other=stats.groups[1-index].value;return g.filter(u=>{const value=aggregate([u],recipe.metric).value;if(value===null||other===null||difference===null||difference===0)return false;return (index===0?difference:-difference)>0?value<other:value>other;}).map(u=>({match_id:u.match_id,innings_number:u.innings_number,value:aggregate([u],recipe.metric).value,evidence_ref:ref(u,index)}));});
 const status=all.length===0?'empty':stats.groups.some(g=>g.denominator===0||g.independent_innings<2)?'insufficient_evidence':'ok';
 const result=response(status,{metric:recipe.metric,definition:recipe.metric==='win_rate'?'100 * won innings / known-outcome innings; ties count in denominator.':recipe.metric==='next_six_or_end_runs'?'Team runs in the next six legal deliveries or until innings end, averaged per selected innings; includes extras. Short windows are retained and counted.':recipe.metric==='strike_rate'?'100 * batter runs / balls faced (wides excluded; no-balls included).':'100 * bat boundaries / balls faced (wides excluded; no-balls included; non-boundary fours/sixes excluded).',observation_unit:'innings; aggregate rate ratios use their declared delivery denominator',labels:recipe.groups.map(g=>g.label),...stats,coverage:source.coverage,strata,stratify_by:args.stratify_by,contrary_cases:contrary.map(c=>({total:c.length,cases:c.slice(0,args.page_size)})),contrary_rule:'Cases on the opposite side of the other full-cohort mean from the aggregate difference. Examples do not disprove an average tendency; all contributions are paginated.',contributions:all.slice(offset,offset+args.page_size),pagination:{offset,total:all.length,page_size:args.page_size,next_cursor:offset+args.page_size<all.length?{revision:revision.id,selection_hash:cursorHash,offset:offset+args.page_size}:null}},revision,args);
 result.resolved_subjects=identity?.candidates??[];
 return finish(context,revision,result);
}
export async function getCohortEvidence(context:InvestigationContext,raw:unknown):Promise<Envelope>{
 const args=CohortEvidenceSchema.parse(raw),ref=args.evidence_ref,recipe=ref.comparison,snapshot=await context.snapshot(),revision=snapshot.revision;
 if(revision.status==='stale'||revision.id!==ref.revision||recipe.kind==='chase'&&recipe.evidence_set.revision!==revision.id)return response('stale_reference',{},revision,ref);
 if(revision.status!=='verified'||!snapshot.manifest)return response('unavailable_data',{},revision,ref);
 if(!valid(recipe))return response('unsupported_scope',{},revision,ref);
 const source=await load(context,snapshot.manifest,recipe),unit=byInnings(source.groups[ref.group]).find(u=>u.match_id===ref.match_id&&u.innings_number===ref.innings_number);
 if(!unit)return finish(context,revision,response('unavailable_data',{reason:'Innings is not a member of this comparison group.'},revision,ref));
 const rows=await source.records(ref.group,ref.match_id,ref.innings_number);let records:unknown[]=args.detail==='deliveries'?rows:[];
 if(args.detail==='overs'){const overs=new Map<number,Row[]>();for(const r of rows){const n=Number(r.over_number);if(!overs.has(n))overs.set(n,[]);overs.get(n)!.push(r);}records=[...overs.entries()].map(([over,rs])=>({over_number:over,selected_deliveries:rs.length,runs_batter:rs.reduce((n,r)=>n+Number(r.runs_batter),0),runs_total:rs.reduce((n,r)=>n+Number(r.runs_total),0),balls_faced:rs.filter(r=>Number(r.extras_wides)===0).length,legal_balls:rs.filter(r=>Number(r.extras_wides)===0&&Number(r.extras_noballs)===0).length}));}
 const offset=args.cursor?.offset??0,cursorHash=hash({ref,detail:args.detail});
 if(args.cursor&&(args.cursor.revision!==revision.id||args.cursor.selection_hash!==cursorHash)||offset>records.length)return finish(context,revision,response('unsupported_scope',{reason:'Evidence cursor mismatch.'},revision,ref));
 return finish(context,revision,response('ok',{evidence_ref:ref,contribution:unit,metric:aggregate([unit],recipe.metric),coverage:source.coverage,evidence_scope:recipe.kind==='batting_style'?'Only this batter against the declared style and phases.':recipe.metric==='win_rate'?'Whole selected innings; outcome is match metadata.':'Selected next-six-legal-deliveries-or-innings-end window.',records:records.slice(offset,offset+args.page_size),pagination:{offset,total_records:records.length,next_cursor:offset+args.page_size<records.length?{revision:revision.id,selection_hash:cursorHash,offset:offset+args.page_size}:null}},revision,ref));
}
