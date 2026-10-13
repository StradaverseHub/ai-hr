import { ratedPerformance,type Policy,type Tier } from './model';
export type WorkspaceAxis='performance'|'potential'|'both';
/** Source journey modules: Dept/BU have independent parts in CAL; BG is the combined Talent Box. */
export function leaderWorkspaceParts(policy:Policy,tier:Tier,locks:{lockedAt:unknown;performanceLockedAt:unknown;potentialLockedAt:unknown}){
 if(policy.kind!=='year_end'||policy.modules.calibration===false)return [];
 const pm=ratedPerformance(policy),pot=policy.modules.tm;
 const part=(stage:string,axis:WorkspaceAxis,done:boolean)=>({stage,axis,module:'cal' as const,state:done?'done' as const:'open' as const});
 if(tier==='bg')return pm||pot?[part('talent_box','both',!!locks.lockedAt)]:[];
 if(tier==='group'||tier==='final')return pm?[part('group_calibration','performance',!!(locks.performanceLockedAt||locks.lockedAt))]:[];
 return [...(pm?[part(tier==='hod'?'department_review':'calibration','performance',!!(locks.performanceLockedAt||locks.lockedAt))]:[]),...(pot?[part(tier==='hod'?'department_potential_review':'potential_calibration','potential',!!(locks.potentialLockedAt||locks.lockedAt))]:[])];
}
