import { assertWindow,kpiApprovers,pendingKpiApprover,pendingSettingApprover,ratedPerformance,type KpiWork,type Policy,type Tier,type WindowCell } from './model';
export type WorkspaceAxis='performance'|'potential'|'both';
export type CalibrationWorkDecision={tier:Tier;performanceLocked:boolean;potentialLocked:boolean};
export type CalibrationWorkEntry={reviewId:string;companyId:string;employmentId:string;personId:string;performanceLocked:boolean;potentialLocked:boolean;performanceReady:boolean;frozen:boolean;decisions:CalibrationWorkDecision[]};
/** Same downstream-lock predicate used by the canonical calibration writer. */
export function calibrationPredecessorOpen(rows:CalibrationWorkDecision[],tier:Tier,pm:boolean,pot:boolean){
 if(tier==='bu')return !rows.some(row=>row.tier==='bg'&&(pm&&row.performanceLocked||pot&&row.potentialLocked));
 if(tier==='hod')return !rows.some(row=>['bu','bg'].includes(row.tier)&&(pm&&row.performanceLocked||pot&&row.potentialLocked));
 return true;
}
export function leaderPendingEntries(policy:Pick<Policy,'modules'|'kind'>,tier:Tier,axis:WorkspaceAxis,entries:CalibrationWorkEntry[]){
 const pm=ratedPerformance(policy)&&axis!=='potential',pot=policy.modules.tm&&axis!=='performance';
 return entries.filter(entry=>{
  if(entry.frozen||!calibrationPredecessorOpen(entry.decisions,tier,pm,pot))return false;
  // HOD person saves still need the separate department Submit. BG and Group person locks are final.
  if(tier==='hod')return true;
  return (pm&&!entry.performanceLocked&&(tier!=='group'&&tier!=='final'||entry.performanceReady))||pot&&!entry.potentialLocked;
 });
}
export type ReviewWorkFacts={kpis:KpiWork[];competenciesAssigned:boolean;competencyStatus:string;resultsSubmitted:boolean;managerPerformance:string|null;planStatus:string|null};
export type ReviewWorkActor={self:boolean;manager:boolean;employmentIds:string[]};
export type ReviewWorkPart={module:'pm'|'tm'|'idp';stage:string;state:'open'|'waiting'|'done'|'later';locked:boolean;cell:WindowCell};
/** A shared derivation for the person's worklist and actor-neutral notification/reminder readers. */
export function reviewWorkspaceParts(policy:Pick<Policy,'modules'|'kind'>,facts:ReviewWorkFacts,actor:ReviewWorkActor):ReviewWorkPart[]{
 const {kpis}=facts,{self,manager,employmentIds}=actor,parts:ReviewWorkPart[]=[];
 let state:ReviewWorkPart['state']='open',stage='results';
 if(!kpis.length||kpis.some(k=>['draft','returned'].includes(k.setting))){stage='setting';state=self?'open':'waiting';}
 else if(kpis.some(k=>k.setting==='proposed')){stage='setting';state=self?'waiting':kpis.some(k=>employmentIds.includes(pendingSettingApprover(k)??''))?'open':'waiting';}
 else if(policy.kind==='quarterly'){stage='checkin';state=kpis.every(k=>k.checkIn)?'done':self?'open':'waiting';}
 else if(facts.managerPerformance)state='done';
 else if(facts.resultsSubmitted){stage=self?'results':'moderation';state=self?'done':reviewerModerationState(kpis,employmentIds);}
 else state=self?'open':'waiting';
 if(policy.modules.pm)parts.push({module:'pm',stage,state,locked:false,cell:stage==='setting'?self?'pm_setting':'pm_setting_approve':self?'pm_results':'pm_approve'});
 const tcState=facts.competencyStatus==='reviewed'?'done':facts.competencyStatus==='submitted'?self?'done':'open':self?'open':'waiting';
 if(policy.modules.tm&&facts.competenciesAssigned&&(self||manager))parts.push({module:'tm',stage:'competency',state:tcState,locked:false,cell:self?'tc_self':'tc_approve'});
 if(policy.modules.idp&&policy.kind==='year_end'){
  const locked=self&&(policy.modules.pm&&['open','waiting'].includes(state)||policy.modules.tm&&facts.competenciesAssigned&&['open','waiting'].includes(tcState));
  const planState=facts.planStatus==='closed'?'done':locked?'later':facts.planStatus==='shared'?self?'done':'open':self?'open':'waiting';
  parts.push({module:'idp',stage:'career',state:planState,locked,cell:self?'idp_self':'idp_review'});
 }
 return parts;
}
/** The person's OWN career-plan lock, exactly as reviewWorkspaceParts raises it for the self actor. */
export function ownPlanLocked(policy:Pick<Policy,'modules'|'kind'>,facts:Omit<ReviewWorkFacts,'planStatus'>){
 return reviewWorkspaceParts(policy,{...facts,planStatus:null},{self:true,manager:false,employmentIds:[]}).some(part=>part.module==='idp'&&part.locked);
}
export function assessmentWorkWindowOpen(policy:Pick<Policy,'windows'>,cell:WindowCell,now=new Date()){
 try{assertWindow(policy,cell,now);return true;}catch{return false;}
}
/** Completion belongs to this approver's steps, even while a colleague still owes their review. */
export function reviewerModerationState(kpis:KpiWork[],ownEmploymentIds:string[]):'open'|'waiting'|'done'{
 const mine=kpis.filter(k=>!k.hrOwned&&kpiApprovers(k).some(id=>ownEmploymentIds.includes(id)));
 if(mine.some(k=>ownEmploymentIds.includes(pendingKpiApprover(k)??'')))return 'open';
 const acted=mine.some(k=>k.approvalChain?.some(s=>ownEmploymentIds.includes(s.employmentId)&&!!s.at)||k.locked&&ownEmploymentIds.includes(k.moderatorEmploymentId??''));
 return acted?'done':'waiting';
}
/** Source journey modules: Dept/BU have independent parts in CAL; BG is the combined Talent Box. */
export function leaderWorkspaceParts(policy:Pick<Policy,'modules'|'kind'>,tier:Tier,locks:{lockedAt:unknown;performanceLockedAt:unknown;potentialLockedAt:unknown}){
 if(policy.kind!=='year_end'||policy.modules.calibration===false)return [];
 const pm=ratedPerformance(policy),pot=policy.modules.tm;
 const part=(stage:string,axis:WorkspaceAxis,done:boolean)=>({stage,axis,module:'cal' as const,state:(done?'done':'open') as 'done'|'open'|'waiting'});
 if(tier==='bg')return pm||pot?[part('talent_box','both',!!locks.lockedAt)]:[];
 if(tier==='group'||tier==='final')return pm?[part('group_calibration','performance',!!(locks.performanceLockedAt||locks.lockedAt))]:[];
 return [...(pm?[part(tier==='hod'?'department_review':'calibration','performance',!!(locks.performanceLockedAt||locks.lockedAt))]:[]),...(pot?[part(tier==='hod'?'department_potential_review':'potential_calibration','potential',!!(locks.potentialLockedAt||locks.lockedAt))]:[])];
}
export const workspaceViews=['mine','team','dept','bu','bg','group'] as const;
export const workspaceModules=['pm','tm','idp','cal'] as const;
export type WorkspaceView=typeof workspaceViews[number];
export type WorkspaceModule=typeof workspaceModules[number];
/** The facts module selection reads from a worklist item. `locked` is reviewWorkspaceParts' own IDP lock. */
export type WorkspaceSelectionItem={cycleId:string;view:WorkspaceView;module:WorkspaceModule;state:'open'|'waiting'|'done'|'later';locked:boolean};
/**
 * The review journey's module offer for navigation: Talent when the viewer holds any TM item in an open cycle,
 * Development when they hold any IDP item. Development is 'locked' only when every IDP item they hold is locked,
 * which reviewWorkspaceParts raises only for the person's OWN plan; a team plan is never locked.
 */
export type WorkspaceNavigationOffer={tm:boolean;idp:'none'|'open'|'locked'};
export function workspaceNavigationOffer(items:readonly Pick<WorkspaceSelectionItem,'module'|'locked'>[]):WorkspaceNavigationOffer{
 const idp=items.filter(item=>item.module==='idp');
 return {tm:items.some(item=>item.module==='tm'),idp:!idp.length?'none':idp.some(item=>!item.locked)?'open':'locked'};
}
/**
 * Which cycle, view and module a workspace request lands on. A module is selectable in a view only through an
 * unlocked item, so a crafted request for a locked plan, or for a module the viewer does not hold, cannot select
 * it: it falls back to the first module with open work (the resume point), otherwise the first selectable one.
 * A request for a module held in another view of the cycle lands in that view; without a cycle, in the first
 * cycle that holds it.
 */
export function resolveWorkspaceSelection(items:readonly WorkspaceSelectionItem[],query:{cycle?:string;view?:string;module?:string}){
 const cycleIds=[...new Set(items.map(item=>item.cycleId))];
 const want=workspaceModules.find(m=>m===query.module);
 const holds=(item:WorkspaceSelectionItem)=>!item.locked&&item.module===want;
 const cycle:string|undefined=query.cycle&&cycleIds.includes(query.cycle)?query.cycle:(want&&cycleIds.find(id=>items.some(item=>item.cycleId===id&&holds(item))))||cycleIds[0];
 const current=items.filter(item=>item.cycleId===cycle);
 const availableViews=workspaceViews.filter(v=>current.some(item=>item.view===v));
 const viewHolds=(v:WorkspaceView)=>current.some(item=>item.view===v&&holds(item));
 const asked=availableViews.find(v=>v===query.view);
 const view:WorkspaceView=(asked&&(!want||viewHolds(asked)||!availableViews.some(viewHolds))?asked:undefined)??(want?availableViews.find(viewHolds):undefined)??availableViews[0]??'mine';
 const inView=current.filter(item=>item.view===view);
 const availableModules=workspaceModules.filter(m=>inView.some(item=>item.module===m));
 const selectableModules=availableModules.filter(m=>inView.some(item=>item.module===m&&!item.locked));
 const resume=selectableModules.find(m=>inView.some(item=>item.module===m&&!item.locked&&item.state==='open'));
 const module:WorkspaceModule=selectableModules.find(m=>m===want)??resume??selectableModules[0]??availableModules[0]??'pm';
 return {cycleIds,cycle,availableViews,view,availableModules,lockedModules:availableModules.filter(m=>!selectableModules.includes(m)),module};
}
