import test from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { createSchema } from '../src/db/schema.js';
import type { InvestigationContext, Manifest } from '../src/investigation/context.js';
import { loadChaseStates } from '../src/queries/chase-state.js';
import { findSimilarSituations, getEvidence, stateAt } from '../src/investigation/time-machine.js';
import { SimilarInputSchema, EvidenceInputSchema } from '../src/investigation/time-machine-contracts.js';
const scope={match_type:'T20' as const,event_name:'Indian Premier League' as const,gender:'male' as const};
const args={scope,state:{runs_required:45,legal_balls_remaining:24,wickets_remaining:6},tolerances:{runs:0,balls:0,wickets:0}};
async function fixture() {
 const instance=await DuckDBInstance.create(':memory:'),db=await instance.connect();await createSchema(db);
 for(const [id,date,winner] of [['a','2024-01-01','A'],['b','2025-01-01','B'],['c','2026-01-01','A'],['excluded','2024-01-01','A']]) {
  await db.run(`INSERT INTO matches(match_id,match_type,gender,date_start,event_name,team1,team2,outcome_winner) VALUES ($id,'T20','male',$date,'Indian Premier League','A','B',$winner)`,{id,date,winner});
  await db.run(`INSERT INTO innings(match_id,innings_number,batting_team,bowling_team,target_runs,target_overs) VALUES ($id,2,'A','B',49,20)`,{id});
  // Synthetic prefixes provide a hand-checkable 45/24/6 state. Not real audited cricket.
  for(let n=0;n<98;n++) await db.run(`INSERT INTO deliveries(match_id,innings_number,over_number,ball_number,batter,bowler,non_striker,runs_total,is_wicket,wicket_kind,extras_wides,extras_noballs) VALUES ($id,2,$over,$ball,'P','Q','R',$runs,$wicket,$kind,0,0)`,{id,over:Math.floor(n/6),ball:n%6,runs:n<4?1:0,wicket:n<4,kind:n<4?'run out':null});
 }
 const manifest:Manifest={version:1,definition_version:'ipl-standard-chase-v1',database_sha256:'a'.repeat(64),source_archive_sha256:'b'.repeat(64),innings:['a','b','c','excluded'].map(match_id=>({match_id,innings_number:2,source_sha256:'c'.repeat(64),source_revision:1,eligible:match_id!=='excluded',reasons:match_id==='excluded'?['synthetic_exclusion']:[]}))};
 const context:InvestigationContext={db:Promise.resolve(db),snapshot:async()=>({revision:{status:'verified',id:'fixture-revision',reason:null},manifest})};
 return {db,manifest,context,close(){db.closeSync();instance.closeSync();}};
}
test('full cohort counts, one state per innings and stable pagination',async()=>{
 const f=await fixture();try{
  const one=await findSimilarSituations(f.context,{...args,page_size:1});
  const d=one.data as any;assert.equal(d.independent_innings,3);assert.deepEqual(d.outcomes,{won:2,lost:1,tie:0,unknown:0});assert.equal(d.cases.length,1);assert.equal(d.cases[0].point.match_id,'a');assert.equal(d.coverage.excluded_innings,1);
  const two=await findSimilarSituations(f.context,{...args,page_size:2,cursor:d.pagination.next_cursor});assert.deepEqual(two.data.outcomes,d.outcomes);assert.deepEqual((two.data as any).cases.map((x:any)=>x.point.match_id),['b','c']);assert.equal((two.data as any).pagination.next_cursor,null);
  const broad=await findSimilarSituations(f.context,{...args,tolerances:{runs:5,balls:2,wickets:1}});assert.equal(broad.data.independent_innings,3);
  const changed=await findSimilarSituations(f.context,{...args,tolerances:{runs:1,balls:0,wickets:0},cursor:d.pagination.next_cursor});assert.equal(changed.status,'unsupported_scope');
  const future=await findSimilarSituations(f.context,{...args,scope:{...scope,as_of:'2024-12-31'}});assert.equal(future.data.independent_innings,1);
  const none=await findSimilarSituations(f.context,{...args,state:{...args.state,runs_required:999}});assert.equal(none.status,'empty');assert.equal(none.data.independent_innings,0);
 }finally{f.close();}
});
test('outcome changes do not change selection; reference excludes its own innings',async()=>{
 const f=await fixture();try{
  const first=await findSimilarSituations(f.context,args);
  await f.db.run("UPDATE matches SET outcome_winner='B'");
  const second=await findSimilarSituations(f.context,args);
  const points=(r:any)=>r.data.cases.map((x:any)=>({point:x.point,state:x.state,distance:x.distance}));assert.deepEqual(points(first),points(second));assert.notDeepEqual(first.data.outcomes,second.data.outcomes);
  const reference=(first.data as any).cases[0].point;
  const r=await findSimilarSituations(f.context,{scope,tolerances:args.tolerances,reference});assert.equal(r.data.independent_innings,2);assert.ok(!(r.data as any).cases.some((x:any)=>x.point.match_id===reference.match_id));
  const after=await findSimilarSituations(f.context,{scope,tolerances:args.tolerances,reference,boundary:'after'});assert.equal((after.data as any).evidence_set.selection.state.legal_balls_remaining,23);
  await f.db.run("UPDATE deliveries SET runs_total=50 WHERE match_id='a' AND over_number=16 AND ball_number=1");
  const terminal=await findSimilarSituations(f.context,{scope,tolerances:args.tolerances,reference:{...reference,ball_number:1},boundary:'after'});assert.equal(terminal.status,'unsupported_scope');
  const both=await findSimilarSituations(f.context,{...args,reference});assert.equal(both.status,'unsupported_scope');
  const unknown=await findSimilarSituations(f.context,{scope,tolerances:args.tolerances,reference:{...reference,match_id:'excluded'}});assert.equal(unknown.status,'unavailable_data');
 }finally{f.close();}
});
test('wide/no-ball arithmetic and before/after boundaries do not include the future',async()=>{
 const f=await fixture();try{
  await f.db.run("UPDATE deliveries SET extras_wides=1,runs_total=1,is_wicket=false,wicket_kind=NULL WHERE match_id='a' AND over_number=0 AND ball_number=0");
  await f.db.run("UPDATE deliveries SET extras_noballs=1,runs_total=3,is_wicket=false,wicket_kind=NULL WHERE match_id='a' AND over_number=0 AND ball_number=1");
  const first=await loadChaseStates(f.context,f.manifest,scope);const rs=first.rows.filter(r=>r.match_id==='a');
  assert.deepEqual(stateAt(rs[0],'before'),{runs_required:49,legal_balls_remaining:120,wickets_remaining:10});
  assert.deepEqual(stateAt(rs[1],'after'),{runs_required:45,legal_balls_remaining:120,wickets_remaining:10});
  const before=stateAt(rs[2],'before');await f.db.run("UPDATE deliveries SET runs_total=6 WHERE match_id='a' AND over_number=0 AND ball_number>=2");
  const second=await loadChaseStates(f.context,f.manifest,scope);assert.deepEqual(stateAt(second.rows.filter(r=>r.match_id==='a')[2],'before'),before);
 }finally{f.close();}
});
test('evidence checks membership, revision and detail-bound pagination across contexts',async()=>{
 const f=await fixture();try{
  const found=await findSimilarSituations(f.context,args);const ref=(found.data as any).cases[0].evidence_ref;
  const replay={...f.context};
  const evidence=await getEvidence(replay,{evidence_ref:ref,detail:'deliveries',page_size:50});assert.equal(evidence.status,'ok');assert.equal((evidence.data as any).records.length,50);assert.equal((evidence.data as any).pagination.total_records,98);
  const next=await getEvidence(replay,{evidence_ref:ref,detail:'deliveries',page_size:50,cursor:(evidence.data as any).pagination.next_cursor});assert.equal((next.data as any).records.length,48);assert.equal((next.data as any).records[46].selected_delivery,true);
  const overs=await getEvidence(f.context,{evidence_ref:ref,detail:'overs'});assert.equal((overs.data as any).records[0].runs,4);
  assert.equal((await getEvidence(f.context,{evidence_ref:{...ref,revision:'old'}})).status,'stale_reference');
  assert.equal((await getEvidence(f.context,{evidence_ref:{...ref,point:{...ref.point,ball_number:1}}})).status,'unavailable_data');
  assert.equal((await getEvidence(f.context,{evidence_ref:ref,detail:'overs',cursor:(evidence.data as any).pagination.next_cursor})).status,'stale_reference');
  assert.throws(()=>SimilarInputSchema.parse({...args,page_size:1000}));assert.throws(()=>EvidenceInputSchema.parse({evidence_ref:ref,sql:'drop table'}));
 }finally{f.close();}
});
test('missing/stale revisions and mid-query invalidation never produce evidence',async()=>{
 const f=await fixture();try{
  const unavailable:InvestigationContext={...f.context,snapshot:async()=>({revision:{status:'unavailable',id:null,reason:'no proof'}})};
  assert.equal((await findSimilarSituations(unavailable,args)).status,'unavailable_data');
  const stale:InvestigationContext={...f.context,snapshot:async()=>({revision:{status:'stale',id:null,reason:'changed'}})};
  assert.equal((await findSimilarSituations(stale,args)).status,'stale_reference');
  let n=0;const changing:InvestigationContext={...f.context,snapshot:async()=>++n===1?f.context.snapshot():stale.snapshot()};
  const result=await findSimilarSituations(changing,args);assert.equal(result.status,'stale_reference');assert.deepEqual(result.data,{});
 }finally{f.close();}
});
