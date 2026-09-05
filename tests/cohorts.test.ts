import test from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { createSchema } from '../src/db/schema.js';
import type { InvestigationContext, Manifest } from '../src/investigation/context.js';
import { compareCohorts,getCohortEvidence } from '../src/investigation/cohorts.js';
import { CompareInputSchema } from '../src/investigation/cohort-contracts.js';
import { findSimilarSituations } from '../src/investigation/time-machine.js';
const scope={match_type:'T20',event_name:'Indian Premier League'};
const comparison={kind:'batting_style',scope,player_id:'p',metric:'strike_rate',groups:[{label:'pace',style:'pace',phases:['powerplay','middle','death']},{label:'spin',style:'spin',phases:['powerplay','middle','death']}]};
async function fixture(){
 const instance=await DuckDBInstance.create(':memory:'),db=await instance.connect();await createSchema(db);
 await db.run("INSERT INTO players(player_id,player_name,bowling_style_broad) VALUES ('p','Player',NULL),('q','Quick','Pace'),('s','Spinner','Spin'),('u','Unknown',NULL)");
 for(const id of ['a','b']){
  await db.run("INSERT INTO matches(match_id,match_type,gender,date_start,event_name,team1,team2,outcome_winner,season) VALUES ($id,'T20','male','2025-01-01','Indian Premier League','A','B',$winner,'2025')",{id,winner:id==='a'?'A':'B'});
  await db.run("INSERT INTO innings(match_id,innings_number,batting_team,bowling_team,target_runs,target_overs) VALUES ($id,2,'A','B',100,20)",{id});
  // Each innings: pace 4+2 off 2 balls faced, including no-ball; spin 1 off 1.
  for(const [ball,bowler,runs,wide,noball] of [[0,'q',4,0,0],[1,'q',0,1,0],[2,'q',2,0,1],[3,'s',1,0,0],[4,'u',6,0,0]] as const)
   await db.run("INSERT INTO deliveries(match_id,innings_number,over_number,ball_number,batter,batter_id,bowler,bowler_id,non_striker,runs_batter,runs_total,extras_wides,extras_noballs) VALUES ($id,2,0,$ball,'Player','p',$bowler,$bowler,'Other',$runs,$total,$wide,$noball)",{id,ball,bowler,runs,total:runs+wide+noball,wide,noball});
 }
 const manifest:Manifest={version:1,definition_version:'ipl-standard-chase-v1',database_sha256:'a'.repeat(64),source_archive_sha256:'b'.repeat(64),innings:['a','b'].map(match_id=>({match_id,innings_number:2,source_sha256:'c'.repeat(64),source_revision:1,eligible:true,reasons:[]}))};
 const context:InvestigationContext={db:Promise.resolve(db),snapshot:async()=>({revision:{status:'verified',id:'fixture',reason:null},manifest})};
 return {db,context,close(){db.closeSync();instance.closeSync();}};
}
test('batting denominators, unknown styles, overlap, pagination and evidence reconcile',async()=>{
 const f=await fixture();try{
  const r=await compareCohorts(f.context,{comparison,stratify_by:'phase',page_size:1});const d=r.data as any;
  assert.equal(r.status,'ok');assert.equal(d.groups[0].numerator,12);assert.equal(d.groups[0].denominator,4);assert.equal(d.groups[0].legal_balls,2);assert.equal(d.groups[0].value,300);assert.equal(d.groups[1].value,100);assert.equal(d.overlapping_innings,2);assert.equal(d.coverage.unknown_style_deliveries,2);assert.equal(d.strata[0].value,'powerplay');assert.equal(d.contributions.length,1);
  const next=await compareCohorts(f.context,{comparison,stratify_by:'phase',page_size:3,cursor:d.pagination.next_cursor});assert.deepEqual(next.data.groups,d.groups);assert.equal((next.data as any).contributions.length,3);
  const ref=d.contributions[0].evidence_ref;const evidence=await getCohortEvidence({...f.context},{evidence_ref:ref,detail:'deliveries',page_size:1});assert.equal(evidence.status,'ok');assert.equal((evidence.data as any).pagination.total_records,3);assert.equal((evidence.data as any).contribution.numerator,6);
  const rest=await getCohortEvidence(f.context,{evidence_ref:ref,detail:'deliveries',cursor:(evidence.data as any).pagination.next_cursor});const rows=[...(evidence.data.records as any[]),...(rest.data.records as any[])];assert.equal(rows.reduce((n,x)=>n+x.runs_batter,0),6);assert.equal(rows.filter(x=>x.extras_wides===0).length,2);
  const boundary=await compareCohorts(f.context,{comparison:{...comparison,metric:'boundary_rate'}});assert.equal((boundary.data as any).groups[0].value,50);
  const noMember=await getCohortEvidence(f.context,{evidence_ref:{...ref,match_id:'absent'}});assert.equal(noMember.status,'unavailable_data');
 }finally{f.close();}
});
test('honest empty, insufficient, identity, scope and revision failures',async()=>{
 const f=await fixture();try{
  const missing=await compareCohorts(f.context,{comparison:{...comparison,player_id:'missing'}});assert.equal(missing.status,'unavailable_data');
  const none=await compareCohorts(f.context,{comparison:{...comparison,scope:{...scope,season:'1900'}}});assert.equal(none.status,'empty');assert.equal((none.data as any).groups[0].value,null);
  await f.db.run("DELETE FROM deliveries WHERE match_id='b'");const small=await compareCohorts(f.context,{comparison});assert.equal(small.status,'insufficient_evidence');
  assert.equal((await compareCohorts(f.context,{comparison,expected_revision:'old'})).status,'stale_reference');
  assert.equal((await compareCohorts(f.context,{comparison:{...comparison,scope:{...scope,date_from:'2025-01-02',date_to:'2025-01-01'}}})).status,'unsupported_scope');
  assert.throws(()=>CompareInputSchema.parse({comparison:{...comparison,sql:'SELECT 1'}}));
  let n=0;const changing={...f.context,snapshot:async()=>++n===1?f.context.snapshot():{revision:{status:'stale' as const,id:null,reason:'changed'}}};const stale=await compareCohorts(changing,{comparison});assert.equal(stale.status,'stale_reference');assert.deepEqual(stale.data,{});
 }finally{f.close();}
});
test('chase comparisons use selected cases, explicit outcome groups and before/after windows',async()=>{
 const f=await fixture();try{
  const found=await findSimilarSituations(f.context,{scope,state:{runs_required:100,legal_balls_remaining:120,wickets_remaining:10},tolerances:{runs:0,balls:0,wickets:0}});
  const chase={kind:'chase',evidence_set:found.data.evidence_set,groups:[{label:'all'},{label:'won',outcome:'won'}],metric:'next_six_or_end_runs'};
  const r=await compareCohorts(f.context,{comparison:chase});const d=r.data as any;assert.equal(d.groups[0].value,15);assert.equal(d.groups[0].short_windows,2);assert.equal(d.groups[0].legal_balls,6);assert.equal(d.overlapping_innings,1);assert.equal(d.coverage.grouping_uses_outcomes,true);
  const ev=await getCohortEvidence(f.context,{evidence_ref:d.contributions[0].evidence_ref,detail:'deliveries'});assert.equal((ev.data.records as any[]).reduce((n,r)=>n+r.runs_total,0),15);
  const wins=await compareCohorts(f.context,{comparison:{...chase,metric:'win_rate'}});assert.equal((wins.data as any).groups[0].value,50);assert.equal((wins.data as any).contrary_cases[0].total,0);
  const selection=(found.data as any).evidence_set.selection;
  const after={...chase,evidence_set:{...(found.data as any).evidence_set,selection:{...selection,boundary:'after',state:{runs_required:96,legal_balls_remaining:119,wickets_remaining:10}}}};
  const ar=await compareCohorts(f.context,{comparison:after});assert.equal((ar.data as any).groups[0].value,11);
 }finally{f.close();}
});
test('contrary evidence is deterministic and phase pooling does not multiply innings',async()=>{
 const f=await fixture();try{
  await f.db.run("UPDATE deliveries SET runs_batter=0,runs_total=extras_wides+extras_noballs WHERE match_id='a' AND bowler_id='q'");
  const r=await compareCohorts(f.context,{comparison});const d=r.data as any;
  assert.equal(d.contrary_cases[0].total,1);assert.equal(d.contrary_cases[0].cases[0].match_id,'a');
  await f.db.run("INSERT INTO deliveries(match_id,innings_number,over_number,ball_number,batter,batter_id,bowler,bowler_id,non_striker,runs_batter,runs_total) VALUES ('a',2,7,0,'Player','p','Quick','q','Other',4,4)");
  const pooled=await compareCohorts(f.context,{comparison,stratify_by:'phase'});assert.equal((pooled.data as any).groups[0].independent_innings,2);assert.equal((pooled.data as any).strata.length,2);assert.equal((pooled.data as any).contributions.filter((u:any)=>u.group===0&&u.match_id==='a').length,1);
  const unknown={...comparison,groups:comparison.groups.map(g=>({...g,phases:['death']}))};assert.equal((await compareCohorts(f.context,{comparison:unknown})).status,'empty');
 }finally{f.close();}
});
test('next-six window stops at six legal balls while retaining preceding extras',async()=>{
 const f=await fixture();try{
  for(let ball=0;ball<6;ball++)await f.db.run("INSERT INTO deliveries(match_id,innings_number,over_number,ball_number,batter,batter_id,bowler,bowler_id,non_striker,runs_batter,runs_total) VALUES ('a',2,1,$ball,'Player','p','Quick','q','Other',1,1)",{ball});
  const found=await findSimilarSituations(f.context,{scope,state:{runs_required:100,legal_balls_remaining:120,wickets_remaining:10},tolerances:{runs:0,balls:0,wickets:0}});
  const chase={kind:'chase',evidence_set:found.data.evidence_set,groups:[{label:'all'},{label:'all again'}],metric:'next_six_or_end_runs'};
  const r=await compareCohorts(f.context,{comparison:chase});const a=(r.data as any).contributions.find((u:any)=>u.group===0&&u.match_id==='a');assert.equal(a.numerator,18);assert.equal(a.legal_balls,6);assert.equal(a.deliveries,8);assert.equal(a.short_window,false);
 }finally{f.close();}
});
