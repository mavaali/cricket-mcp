import { z } from 'zod';
import { ScopeSchema, SelectionSchema, CursorSchema } from './time-machine-contracts.js';
const label=z.string().trim().min(1).max(80);
const range=z.object({min:z.number().int().min(0).max(1000),max:z.number().int().min(0).max(1000)}).strict().refine(x=>x.min<=x.max);
export const PhaseSchema=z.enum(['powerplay','middle','death']);
export const ChaseGroupSchema=z.object({label,runs_required:range.optional(),legal_balls_remaining:range.optional(),wickets_remaining:range.optional(),batting_team:z.string().min(1).max(100).optional(),outcome:z.enum(['won','lost','tie']).optional()}).strict();
const styleGroup=z.object({label,style:z.enum(['pace','spin']),phases:z.array(PhaseSchema).min(1).max(3).refine(x=>new Set(x).size===x.length)}).strict();
export const RecipeSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('chase'),evidence_set:z.object({version:z.literal('chase-v1'),revision:z.string().max(300),selection:SelectionSchema}).strict(),groups:z.array(ChaseGroupSchema).length(2),metric:z.enum(['win_rate','next_six_or_end_runs'])}).strict(),
 z.object({kind:z.literal('batting_style'),scope:ScopeSchema,player_id:z.string().trim().min(1).max(100),groups:z.array(styleGroup).length(2),metric:z.enum(['strike_rate','boundary_rate'])}).strict(),
]);
export const CompareInputSchema=z.object({comparison:RecipeSchema,expected_revision:z.string().max(300).optional(),stratify_by:z.enum(['none','season','phase']).default('none'),page_size:z.number().int().min(1).max(50).default(10),cursor:CursorSchema.optional()}).strict();
export const CohortRefSchema=z.object({version:z.literal('cohort-v1'),revision:z.string().max(300),comparison:RecipeSchema,group:z.number().int().min(0).max(1),match_id:z.string().max(100),innings_number:z.number().int().min(1).max(2)}).strict();
export const CohortEvidenceSchema=z.object({evidence_ref:CohortRefSchema,detail:z.enum(['summary','overs','deliveries']).default('summary'),page_size:z.number().int().min(1).max(50).default(20),cursor:CursorSchema.optional()}).strict();
export type Recipe=z.infer<typeof RecipeSchema>;
