import fs from "node:fs";
import path from "node:path";
import type {
  CricsheetMatch,
  ParsedMatch,
  MatchRow,
  InningsRow,
  DeliveryRow,
  PlayerRow,
} from "../types/cricsheet.js";

export function parseMatchFile(filePath: string, matchId: string): ParsedMatch {
  const raw = fs.readFileSync(filePath, "utf-8");
  const json: CricsheetMatch = JSON.parse(raw);
  const info = json.info;

  // Build name -> ID registry
  const nameToId: Record<string, string> = {};
  if (info.registry?.people) {
    for (const [name, id] of Object.entries(info.registry.people)) {
      nameToId[name] = id;
    }
  }

  // Extract players
  const players: PlayerRow[] = [];
  for (const [name, id] of Object.entries(nameToId)) {
    players.push({ player_id: id, player_name: name });
  }

  const teams = info.teams;

  // Build match row
  const match: MatchRow = {
    match_id: matchId,
    match_type: info.match_type,
    gender: info.gender,
    season: info.season != null ? String(info.season) : null,
    date_start: info.dates[0],
    date_end: info.dates.length > 1 ? info.dates[info.dates.length - 1] : null,
    team1: teams[0],
    team2: teams[1],
    venue: info.venue ?? null,
    city: info.city ?? null,
    toss_winner: info.toss?.winner ?? null,
    toss_decision: info.toss?.decision ?? null,
    outcome_winner: info.outcome?.winner ?? null,
    outcome_by_runs: info.outcome?.by?.runs ?? null,
    outcome_by_wickets: info.outcome?.by?.wickets ?? null,
    outcome_by_innings: info.outcome?.by?.innings ?? null,
    outcome_result: info.outcome?.result ?? null,
    outcome_method: info.outcome?.method ?? null,
    player_of_match: info.player_of_match?.[0] ?? null,
    event_name: info.event?.name ?? null,
    event_match_number: info.event?.match_number ?? null,
    event_group: info.event?.group ?? null,
    event_stage: info.event?.stage ?? null,
    overs_per_side: info.overs ?? null,
    balls_per_over: info.balls_per_over,
    team_type: info.team_type ?? null,
  };

  // Build innings and deliveries
  const inningsRows: InningsRow[] = [];
  const deliveryRows: DeliveryRow[] = [];

  if (json.innings) {
    for (let inningsIdx = 0; inningsIdx < json.innings.length; inningsIdx++) {
      const inning = json.innings[inningsIdx];
      const battingTeam = inning.team;
      const bowlingTeam = teams.find((t) => t !== battingTeam) ?? teams[1];

      inningsRows.push({
        match_id: matchId,
        innings_number: inningsIdx + 1,
        batting_team: battingTeam,
        bowling_team: bowlingTeam,
        is_super_over: inning.super_over ?? false,
        declared: inning.declared ?? false,
        forfeited: inning.forfeited ?? false,
        target_runs: inning.target?.runs ?? null,
        target_overs: inning.target?.overs ?? null,
      });

      if (inning.overs) {
        for (const over of inning.overs) {
          for (let ballIdx = 0; ballIdx < over.deliveries.length; ballIdx++) {
            const d = over.deliveries[ballIdx];
            const extras = d.extras ?? {};
            const wickets = d.wickets ?? [];
            const firstWicket = wickets[0];

            deliveryRows.push({
              match_id: matchId,
              innings_number: inningsIdx + 1,
              over_number: over.over,
              ball_number: ballIdx,
              batter: d.batter,
              batter_id: nameToId[d.batter] ?? null,
              bowler: d.bowler,
              bowler_id: nameToId[d.bowler] ?? null,
              non_striker: d.non_striker,
              non_striker_id: nameToId[d.non_striker] ?? null,
              runs_batter: d.runs.batter,
              runs_extras: d.runs.extras,
              runs_total: d.runs.total,
              runs_non_boundary: d.runs.non_boundary ?? false,
              extras_wides: extras.wides ?? 0,
              extras_noballs: extras.noballs ?? 0,
              extras_byes: extras.byes ?? 0,
              extras_legbyes: extras.legbyes ?? 0,
              extras_penalty: extras.penalty ?? 0,
              is_wicket: wickets.length > 0,
              wicket_kind: firstWicket?.kind ?? null,
              wicket_player_out: firstWicket?.player_out ?? null,
              wicket_player_out_id: nameToId[firstWicket?.player_out] ?? null,
              wicket_fielder1: firstWicket?.fielders?.[0]?.name ?? null,
              wicket_fielder2: firstWicket?.fielders?.[1]?.name ?? null,
            });
          }
        }
      }
    }
  }

  return { match, innings: inningsRows, deliveries: deliveryRows, players };
}
