import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InvestigationContext } from "../investigation/context.js";
import { CoverageInputSchema, EnvelopeSchema } from "../investigation/contracts.js";
import { getDataCoverage } from "../investigation/coverage.js";

export function registerDataCoverage(server: McpServer, context: InvestigationContext): void {
  server.registerTool("get_data_coverage", {
    title: "Data Coverage",
    description: "Check the data behind a cricket question: dates, match and innings counts, player identity and bowling-style gaps. Optional player scope requires perspective; ambiguous names return candidates. Chase-state eligibility requires a verified local audit manifest and explicit IPL/T20 scope. Counts are coverage, not predictions or proof that all real-world matches are present.",
    inputSchema: CoverageInputSchema.shape,
    outputSchema: EnvelopeSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try {
      const result = await getDataCoverage(context, args);
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      console.error("[get_data_coverage]", err);
      return { isError: true, content: [{ type: "text" as const, text: "Coverage query failed. No coverage conclusion was produced." }] };
    }
  });
}
