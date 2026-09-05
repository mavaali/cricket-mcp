import { z } from "zod";
import { CoverageInputSchema } from "./contracts.js";
export const StateSchema = z.object({
  runs_required: z.number().int().min(1).max(1000),
  legal_balls_remaining: z.number().int().min(1).max(120),
  wickets_remaining: z.number().int().min(1).max(10),
}).strict();
export const TolerancesSchema = z.object({
  runs: z.number().int().min(0).max(50),
  balls: z.number().int().min(0).max(12),
  wickets: z.number().int().min(0).max(3),
}).strict();
export const ScopeSchema = z.object({
  match_type: z.literal("T20"), event_name: z.literal("Indian Premier League"),
  gender: z.enum(["male", "female"]).default("male"),
  season: CoverageInputSchema.shape.season, venue: CoverageInputSchema.shape.venue,
  date_from: CoverageInputSchema.shape.date_from, date_to: CoverageInputSchema.shape.date_to,
  as_of: CoverageInputSchema.shape.date_to,
}).strict();
export const PointSchema = z.object({
  match_id: z.string().min(1).max(100), innings_number: z.literal(2),
  over_number: z.number().int().min(0).max(19),
  ball_number: z.number().int().min(0).max(100),
}).strict();
export const SelectionSchema = z.object({
  state: StateSchema, tolerances: TolerancesSchema, scope: ScopeSchema,
  boundary: z.enum(["before", "after"]), exclude_match_id: z.string().min(1).max(100).optional(),
}).strict();
export const CursorSchema = z.object({ revision: z.string().max(300), selection_hash: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(0).max(10000) }).strict();
export const SimilarInputSchema = z.object({
  state: StateSchema.optional(), reference: PointSchema.optional(),
  boundary: z.enum(["before", "after"]).default("before"),
  tolerances: TolerancesSchema, scope: ScopeSchema,
  page_size: z.number().int().min(1).max(50).default(10), cursor: CursorSchema.optional(),
  expected_revision: z.string().max(300).optional(),
}).strict();
export const EvidenceRefSchema = z.object({
  version: z.literal("chase-v1"), revision: z.string().max(300),
  selection: SelectionSchema, point: PointSchema,
}).strict();
export const EvidenceInputSchema = z.object({
  evidence_ref: EvidenceRefSchema, detail: z.enum(["summary", "overs", "deliveries"]).default("summary"),
  page_size: z.number().int().min(1).max(50).default(20), cursor: CursorSchema.optional(),
}).strict();
export type Selection = z.infer<typeof SelectionSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type Point = z.infer<typeof PointSchema>;
