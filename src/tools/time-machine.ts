import { z } from "zod";
import { CohortRefSchema } from "../investigation/cohort-contracts.js";
import { getCohortEvidence } from "../investigation/cohorts.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InvestigationContext } from "../investigation/context.js";
import { EnvelopeSchema } from "../investigation/contracts.js";
import { SimilarInputSchema, EvidenceInputSchema } from "../investigation/time-machine-contracts.js";
import { findSimilarSituations, getEvidence } from "../investigation/time-machine.js";
const CombinedEvidenceSchema=EvidenceInputSchema.extend({evidence_ref:z.union([EvidenceInputSchema.shape.evidence_ref,CohortRefSchema])});
async function evidence(context:InvestigationContext,raw:unknown){const args=CombinedEvidenceSchema.parse(raw);return args.evidence_ref.version==='cohort-v1'?getCohortEvidence(context,args):getEvidence(context,args);}
export function registerTimeMachine(server: McpServer, context: InvestigationContext): void {
  for(const [name,description,schema,handler] of [
    ['find_similar_situations','Find source-audited standard IPL chase situations. Supply exactly one manual state or match reference, explicit scope and tolerances. Boundary uses zero-based source over and delivery ordinal, not decimal overs. Returns one state per innings, full-cohort historical outcomes, stable pages and inspectable evidence references. Reference innings is excluded. No silent widening or predictions.',SimilarInputSchema,findSimilarSituations],
    ['get_evidence','Inspect an evidence_ref from find_similar_situations or compare_cohorts. Validates revision and selection membership; returns summary, overs or paginated deliveries. Chase case evidence covers the whole innings; comparison evidence covers the declared metric window or batter/style/phases. References survive process restarts on the same audited dataset; stale references never silently rerun on new data.',CombinedEvidenceSchema,evidence],
  ] as const) {
    server.registerTool(name,{description,inputSchema:schema.shape,outputSchema:EnvelopeSchema.shape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async (args: unknown)=>{
      try { const result=await handler(context,args);return {structuredContent:result,content:[{type:'text' as const,text:JSON.stringify(result)}]}; }
      catch(err){console.error(`[${name}]`,err);return {isError:true,content:[{type:'text' as const,text:'Investigation failed; no cricket conclusion was produced.'}]};}
    });
  }
}
