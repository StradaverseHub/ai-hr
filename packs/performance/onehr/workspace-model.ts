import { kpiApprovers,pendingKpiApprover,ratedPerformance,type KPI,type Policy,type Tier } from './model';
export type WorkspaceAxis='performance'|'potential'|'both';
/** Completion belongs to this approver's steps, even while a colleague still owes their review. */
export function reviewerModerationState(kpis:KPI[],ownEmploymentIds:string[]):'open'|'waiting'|'done'{
 const mine=kpis.filter(k=>!k.hrOwned&&kpiApprovers(k).some(id=>ownEmploymentIds.includes(id)));
 if(mine.some(k=>ownEmploymentIds.includes(pendingKpiApprover(k)??'')))return 'open';
 const acted=mine.some(k=>k.approvalChain?.some(s=>ownEmploymentIds.includes(s.employmentId)&&!!s.at)||k.locked&&ownEmploymentIds.includes(k.moderatorEmploymentId??''));
 return acted?'done':'waiting';
}
/** Source journey modules: Dept/BU have independent parts in CAL; BG is the combined Talent Box. */
export function leaderWorkspaceParts(policy:Policy,tier:Tier,locks:{lockedAt:unknown;performanceLockedAt:unknown;potentialLockedAt:unknown}){
 if(policy.kind!=='year_end'||policy.modules.calibration===false)return [];
 const pm=ratedPerformance(policy),pot=policy.modules.tm;
 const part=(stage:string,axis:WorkspaceAxis,done:boolean)=>({stage,axis,module:'cal' as const,state:done?'done' as const:'open' as const});
 if(tier==='bg')return pm||pot?[part('talent_box','both',!!locks.lockedAt)]:[];
 if(tier==='group'||tier==='final')return pm?[part('group_calibration','performance',!!(locks.performanceLockedAt||locks.lockedAt))]:[];
 return [...(pm?[part(tier==='hod'?'department_review':'calibration','performance',!!(locks.performanceLockedAt||locks.lockedAt))]:[]),...(pot?[part(tier==='hod'?'department_potential_review':'potential_calibration','potential',!!(locks.potentialLockedAt||locks.lockedAt))]:[])];
}
