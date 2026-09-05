import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InvestigationContext } from '../investigation/context.js';
import { EnvelopeSchema } from '../investigation/contracts.js';
import { CompareInputSchema } from '../investigation/cohort-contracts.js';
import { compareCohorts } from '../investigation/cohorts.js';
export function registerCohorts(server:McpServer,context:InvestigationContext){
 server.registerTool('compare_cohorts',{description:'Compare two declared groups: chase evidence_set groups by entry state/team/outcome, or a stable player_id against pace/spin and explicit phases in IPL T20. Metrics: win_rate, next_six_or_end_runs for chases; strike_rate, boundary_rate for batting_style. Returns full-cohort numerators/denominators, overlapping innings, phase/season splits, contrary cases and paginated contributions with get_evidence references. Unknown styles excluded visibly. Repeat with one declared changed assumption for sensitivity; report every result. No causal inference or significance. Requires verified local revision.',inputSchema:CompareInputSchema.shape,outputSchema:EnvelopeSchema.shape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async args=>{
  try{const result=await compareCohorts(context,args);return {structuredContent:result,content:[{type:'text' as const,text:JSON.stringify(result)}]};}
  catch(err){console.error('[compare_cohorts]',err);return {isError:true,content:[{type:'text' as const,text:'Comparison failed; no cricket conclusion was produced.'}]};}
 });
}
