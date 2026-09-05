import type { InvestigationContext } from '../investigation/context.js';
import type { Scope } from '../investigation/time-machine-contracts.js';
import { runQuery } from './run.js';
import { BAT, BOWL } from './innings.js';
import { PHASE_OVERS } from './common.js';

/** Aggregate scoring uses the same expressions as existing batting tools. Unknown
 * style stays a separate bucket. All rows are from the requested batter/scope. */
export async function loadStyleUnits(context: InvestigationContext, scope: Scope, playerId: string) {
 const clauses=["m.match_type='T20'","m.event_name=$event","m.gender=$gender","d.batter_id=$player","NOT i.is_super_over","m.balls_per_over=6","d.over_number BETWEEN 0 AND 19"];
 const params:Record<string,string>={event:scope.event_name,gender:scope.gender,player:playerId};
 for(const [key,column,op] of [['season','m.season','='],['venue','m.venue','='],['date_from','m.date_start','>='],['date_to','m.date_start','<='],['as_of','COALESCE(m.date_end,m.date_start)','<=']] as const)if(scope[key]){clauses.push(`${column} ${op} $${key}`);params[key]=scope[key]!;}
 const phase=`CASE WHEN d.over_number<=${PHASE_OVERS.powerplay[1]} THEN 'powerplay' WHEN d.over_number<=${PHASE_OVERS.middle[1]} THEN 'middle' ELSE 'death' END`;
 const cte=`WITH scoped AS (SELECT d.*,m.season,m.date_start,${phase} AS phase,CASE WHEN lower(p.bowling_style_broad) IN ('pace','spin') THEN lower(p.bowling_style_broad) ELSE 'unknown' END AS style FROM deliveries d JOIN matches m USING(match_id) JOIN innings i USING(match_id,innings_number) LEFT JOIN players p ON p.player_id=d.bowler_id WHERE ${clauses.join(' AND ')})`;
 const units=await runQuery(context.db,`${cte} SELECT d.match_id,d.innings_number,d.season,d.phase,d.style,COUNT(*) AS deliveries,SUM(d.runs_batter) AS runs,${BAT.ballsFaced} AS balls_faced,${BOWL.legalBalls} AS legal_balls,(${BAT.fours}+${BAT.sixes}) AS boundaries FROM scoped d GROUP BY d.match_id,d.innings_number,d.season,d.phase,d.style ORDER BY d.match_id,d.innings_number,d.phase,d.style`,params);
 return {units, async records(matchId:string,innings:number){return runQuery(context.db,`${cte} SELECT * FROM scoped WHERE match_id=$match AND innings_number=$innings ORDER BY over_number,ball_number`,{...params,match:matchId,innings});}};
}
