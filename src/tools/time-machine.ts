import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InvestigationContext } from "../investigation/context.js";
import { EnvelopeSchema } from "../investigation/contracts.js";
import { SimilarInputSchema, EvidenceInputSchema } from "../investigation/time-machine-contracts.js";
import { findSimilarSituations, getEvidence } from "../investigation/time-machine.js";
export function registerTimeMachine(server: McpServer, context: InvestigationContext): void {
  for(const [name,description,schema,handler] of [
    ['find_similar_situations','Find source-audited standard IPL chase situations. Supply exactly one manual state or match reference, explicit scope and tolerances. Boundary uses zero-based source over and delivery ordinal, not decimal overs. Returns one state per innings, full-cohort historical outcomes, stable pages and inspectable evidence references. Reference innings is excluded. No silent widening or predictions.',SimilarInputSchema,findSimilarSituations],
    ['get_evidence','Inspect a Time Machine evidence_ref from find_similar_situations. Validates revision and selection membership; returns summary, overs or paginated deliveries. Whole-innings evidence includes records after the matched state. References survive process restarts on the same audited dataset; stale references never silently rerun on new data.',EvidenceInputSchema,getEvidence],
  ] as const) {
    server.registerTool(name,{description,inputSchema:schema.shape,outputSchema:EnvelopeSchema.shape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async (args: unknown)=>{
      try { const result=await handler(context,args);return {structuredContent:result,content:[{type:'text' as const,text:JSON.stringify(result)}]}; }
      catch(err){console.error(`[${name}]`,err);return {isError:true,content:[{type:'text' as const,text:'Investigation failed; no cricket conclusion was produced.'}]};}
    });
  }
}
