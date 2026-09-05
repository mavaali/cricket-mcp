import test from 'node:test';
import assert from 'node:assert/strict';
import {DuckDBInstance} from '@duckdb/node-api';
import {createSchema} from '../src/db/schema.js';
import {loadCareerTeams} from '../src/queries/career-teams.js';
import {cachedChase,CHASE_CACHE_MAX_ROWS} from '../src/investigation/chase-cache.js';
import type {InvestigationContext,Manifest} from '../src/investigation/context.js';
const manifest={innings:[]} as unknown as Manifest;
function context(){let revision='one';const ctx:InvestigationContext={db:Promise.resolve(null as any),cacheable:true,snapshot:async()=>({revision:{status:'verified',id:revision,reason:null},manifest})};return {ctx,change(){revision='two';}};}
test('cache reuses one immutable scope, coalesces concurrent loads and evicts on scope/revision changes',async()=>{
 const f=context();let calls=0;const load=async()=>{calls++;return {rows:[{runs:4}],coverage:{reasons:{unknown:1}}};};
 const [a,b]=await Promise.all([cachedChase(f.ctx,manifest,{season:'2025'},load),cachedChase(f.ctx,manifest,{season:'2025'},load)]);assert.equal(calls,1);assert.equal(a,b);assert.throws(()=>{a.rows[0].runs=0;});assert.throws(()=>{a.coverage.reasons.unknown=0;});
 await cachedChase(f.ctx,manifest,{season:'2024'},load);await cachedChase(f.ctx,manifest,{season:'2025'},load);assert.equal(calls,3);
 f.change();await cachedChase(f.ctx,manifest,{season:'2025'},load);assert.equal(calls,4);
});
test('failed, oversized, mutable and invalidated loads are never reused',async()=>{
 const f=context();let calls=0;const load=async()=>{calls++;return {rows:[],coverage:{}};};
 const mutable={...f.ctx,cacheable:false};await cachedChase(mutable,manifest,{},load);await cachedChase(mutable,manifest,{},load);assert.equal(calls,2);
 await assert.rejects(cachedChase(f.ctx,manifest,{},async()=>{throw Error('query failed');}));await cachedChase(f.ctx,manifest,{},load);assert.equal(calls,3);
 let largeCalls=0;const large=async()=>{largeCalls++;return {rows:Array(CHASE_CACHE_MAX_ROWS+1).fill({}),coverage:{}};};await cachedChase(f.ctx,manifest,{large:true},large);await cachedChase(f.ctx,manifest,{large:true},large);assert.equal(largeCalls,2);
 const g=context();let changingCalls=0;await cachedChase(g.ctx,manifest,{},async()=>{changingCalls++;g.change();return {rows:[],coverage:{}};});await cachedChase(g.ctx,manifest,{},async()=>{changingCalls++;return {rows:[],coverage:{}};});assert.equal(changingCalls,2);
});
test('career team resolution handles bowling-only, all-round participation and conflicting identities',async()=>{
 const instance=await DuckDBInstance.create(':memory:'),db=await instance.connect();try{
  await createSchema(db);
  for(const [id,batter,bowler] of [['bowl','Other','Player'],['all','Player','Other'],['conflict','Player','Player']]){
   await db.run("INSERT INTO innings(match_id,innings_number,batting_team,bowling_team) VALUES ($id,1,'A','B'),($id,2,'B','A')",{id});
   await db.run("INSERT INTO deliveries(match_id,innings_number,over_number,ball_number,batter,bowler,non_striker) VALUES ($id,1,0,0,$batter,$bowler,'Other')",{id,batter,bowler});
  }
  await db.run("INSERT INTO deliveries(match_id,innings_number,over_number,ball_number,batter,bowler,non_striker) VALUES ('all',2,0,0,'Other','Player','Other')");
  const rows=await loadCareerTeams(Promise.resolve(db),['bowl','all','conflict'],'Player');const teams=Object.fromEntries(rows.map(r=>[r.match_id,r.player_team]));assert.deepEqual(teams,{all:'A',bowl:'B',conflict:null});assert.deepEqual(await loadCareerTeams(Promise.resolve(db),['missing'],'Player'),[]);
 }finally{db.closeSync();instance.closeSync();}
});
