import { z } from "zod";

export const MatchFilterSchema = z.object({
  match_type: z
    .string()
    .optional()
    .describe(
      'Cricket format: "Test", "ODI", "T20", "IT20", "MDM", "ODM". T20 includes domestic T20 leagues. IT20 is international T20 only.'
    ),
  gender: z
    .enum(["male", "female"])
    .optional()
    .describe("Filter by gender. Default: both."),
  team: z
    .string()
    .optional()
    .describe("Filter to matches involving this team."),
  opposition: z
    .string()
    .optional()
    .describe("Filter to matches against this specific opposition."),
  venue: z
    .string()
    .optional()
    .describe("Filter to matches at this venue/ground (partial match)."),
  city: z
    .string()
    .optional()
    .describe("Filter to matches in this city (partial match)."),
  season: z
    .string()
    .optional()
    .describe('Filter to this season (e.g., "2023", "2023/24").'),
  event_name: z
    .string()
    .optional()
    .describe(
      'Filter to this tournament/series (e.g., "Indian Premier League", "ICC Cricket World Cup"). Partial match.'
    ),
  date_from: z
    .string()
    .optional()
    .describe("Start date filter (YYYY-MM-DD format)."),
  date_to: z
    .string()
    .optional()
    .describe("End date filter (YYYY-MM-DD format)."),
});

export type MatchFilter = z.infer<typeof MatchFilterSchema>;

export interface FilterResult {
  whereClauses: string[];
  params: Record<string, string | number>;
}

export function buildMatchFilter(filters: MatchFilter): FilterResult {
  const clauses: string[] = [];
  const params: Record<string, string | number> = {};

  if (filters.match_type) {
    clauses.push("m.match_type = $match_type");
    params.match_type = filters.match_type;
  }
  if (filters.gender) {
    clauses.push("m.gender = $gender");
    params.gender = filters.gender;
  }
  if (filters.team) {
    clauses.push("(m.team1 = $team OR m.team2 = $team)");
    params.team = filters.team;
  }
  if (filters.opposition) {
    clauses.push("(m.team1 = $opposition OR m.team2 = $opposition)");
    params.opposition = filters.opposition;
  }
  if (filters.venue) {
    clauses.push("m.venue ILIKE '%' || $venue || '%'");
    params.venue = filters.venue;
  }
  if (filters.city) {
    clauses.push("m.city ILIKE '%' || $city || '%'");
    params.city = filters.city;
  }
  if (filters.season) {
    clauses.push("m.season = $season");
    params.season = filters.season;
  }
  if (filters.event_name) {
    clauses.push("m.event_name ILIKE '%' || $event_name || '%'");
    params.event_name = filters.event_name;
  }
  if (filters.date_from) {
    clauses.push("m.date_start >= $date_from");
    params.date_from = filters.date_from;
  }
  if (filters.date_to) {
    clauses.push("m.date_start <= $date_to");
    params.date_to = filters.date_to;
  }

  return { whereClauses: clauses, params };
}

export function buildWhereString(clauses: string[]): string {
  if (clauses.length === 0) return "";
  return "AND " + clauses.join(" AND ");
}
