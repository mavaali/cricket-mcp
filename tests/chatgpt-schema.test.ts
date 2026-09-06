import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RecipeSchema, CohortRefSchema } from '../src/investigation/cohort-contracts.js';
import { EvidenceInputSchema } from '../src/investigation/time-machine-contracts.js';

test('comparison and evidence publish homogeneous array items and require exactly two groups', async () => {
 const server = new McpServer({name:'schema-test',version:'1'});
 const evidence = EvidenceInputSchema.extend({evidence_ref:z.union([EvidenceInputSchema.shape.evidence_ref,CohortRefSchema])});
 server.registerTool('get_evidence',{inputSchema:evidence.shape},async()=>({content:[]}));
 server.registerTool('compare_cohorts',{inputSchema:{comparison:RecipeSchema}},async()=>({content:[]}));
 const client = new Client({name:'test',version:'1'});
 const [a,b] = InMemoryTransport.createLinkedPair();
 try {
  await server.connect(a); await client.connect(b);
  const listed=await client.listTools();
  function inspect(value:unknown):void {
   if (!value || typeof value!=='object') return;
   assert.ok(!Array.isArray((value as {items?:unknown}).items),'tuple items are incompatible with ChatGPT');
   for (const child of Object.values(value)) inspect(child);
  }
  for (const tool of listed.tools) inspect(tool.inputSchema);
  const cases=[
   {kind:'chase',evidence_set:{version:'chase-v1',revision:'r',selection:{state:{runs_required:45,legal_balls_remaining:24,wickets_remaining:6},tolerances:{runs:5,balls:2,wickets:1},scope:{match_type:'T20',event_name:'Indian Premier League'},boundary:'before'}},metric:'win_rate',groups:[{label:'a'},{label:'b'}]},
   {kind:'batting_style',scope:{match_type:'T20',event_name:'Indian Premier League'},player_id:'p',metric:'strike_rate',groups:[{label:'pace',style:'pace',phases:['middle']},{label:'spin',style:'spin',phases:['middle']}]}
  ];
  for (const recipe of cases) {
   assert.equal(RecipeSchema.safeParse(recipe).success,true);
   for (const groups of [[],recipe.groups.slice(0,1),[...recipe.groups,recipe.groups[0]]]) assert.equal(RecipeSchema.safeParse({...recipe,groups}).success,false);
  }
 } finally { await client.close(); await server.close(); }
});
