import type { DuckDBConnection } from '@duckdb/node-api';
import { runQuery } from './run.js';

/** A batter belongs to the batting team; a bowler belongs to the bowling team.
 * Conflicting names/metadata must not arbitrarily select one opponent. */
export async function loadCareerTeams(db: Promise<DuckDBConnection>, matchIds: string[], playerName: string) {
  return runQuery(db, `WITH appearances AS (
    SELECT d.match_id, i.batting_team AS player_team
    FROM deliveries d JOIN innings i USING(match_id,innings_number)
    WHERE d.match_id IN (SELECT json_extract_string(value, '$') FROM json_each($mids)) AND d.batter=$pname
    UNION ALL
    SELECT d.match_id, i.bowling_team AS player_team
    FROM deliveries d JOIN innings i USING(match_id,innings_number)
    WHERE d.match_id IN (SELECT json_extract_string(value, '$') FROM json_each($mids)) AND d.bowler=$pname
  ) SELECT match_id, CASE WHEN COUNT(DISTINCT player_team)=1 THEN MIN(player_team) ELSE NULL END AS player_team
    FROM appearances GROUP BY match_id`, {mids:JSON.stringify(matchIds),pname:playerName});
}
