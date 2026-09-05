import { z } from "zod";

export const StatusSchema = z.enum(["ok", "empty", "insufficient_evidence", "ambiguous_subject", "unsupported_scope", "unavailable_data", "stale_reference"]);
export type Status = z.infer<typeof StatusSchema>;
export const RevisionSchema = z.object({
  status: z.enum(["verified", "unavailable", "stale"]),
  id: z.string().nullable(),
  reason: z.string().nullable(),
});
export type Revision = z.infer<typeof RevisionSchema>;
export const EnvelopeSchema = z.object({
  status: StatusSchema,
  data: z.record(z.unknown()),
  resolved_subjects: z.array(z.object({ player_id: z.string(), player_name: z.string() })),
  applied_filters: z.record(z.unknown()),
  provenance: z.object({ revision: RevisionSchema, definition_version: z.enum(["coverage-v1", "chase-v1", "cohort-v1"]) }),
  warnings: z.array(z.string()),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;
export function envelope(status: Status, data: Record<string, unknown>, revision: Revision, filters: Record<string, unknown>, subjects: Envelope["resolved_subjects"] = [], warnings: string[] = []): Envelope {
  return { status, data, resolved_subjects: subjects, applied_filters: filters, provenance: { revision, definition_version: "coverage-v1" }, warnings };
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const time = Date.parse(s);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === s;
}, "Use a valid calendar date");
export const CoverageInputSchema = z.object({
  match_type: z.enum(["Test", "ODI", "T20", "IT20", "MDM", "ODM"]).optional(),
  gender: z.enum(["male", "female"]).optional(),
  event_name: z.string().trim().min(1).max(200).optional(),
  season: z.string().trim().min(1).max(30).optional(),
  venue: z.string().trim().min(1).max(200).optional(),
  date_from: date.optional(), date_to: date.optional(),
  player_id: z.string().trim().min(1).max(100).optional(),
  player_name: z.string().trim().min(2).max(200).optional(),
  perspective: z.enum(["batting", "bowling"]).optional(),
  capability: z.enum(["inventory", "bowling_style", "chase_state"]).default("inventory"),
  expected_revision: z.string().max(300).optional(),
}).strict();
export type CoverageInput = z.infer<typeof CoverageInputSchema>;
