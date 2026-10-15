import type { Policy,Tier,WindowCell } from './model';
import { assessmentWorkWindowOpen,leaderPendingEntries,leaderWorkspaceParts,reviewWorkspaceParts,type CalibrationWorkEntry,type ReviewWorkFacts } from './workspace-model';
import { assessmentReminderMailSchema,assessmentReminderTaskKeys,type AssessmentReminderTask } from './reminder-model';

export type ReminderWorkGraph={
 cycle:{id:string;companyId:string|null;name:string;periodEnd:string;policy:Pick<Policy,'kind'|'modules'|'windows'>};
 actors:{userId:string;personId:string;name:string;employmentIds:string[];cycleAdmin:boolean}[];
 reviews:{id:string;companyId:string;employmentId:string;personId:string;name:string;reviewerEmploymentId:string|null;moderatorIds:string[];frozen:boolean;facts:ReviewWorkFacts}[];
 panels:{id:string;employmentId:string;reviewId:string}[];
 sessions:{id:string;companyId:string|null;tier:Tier;reviewerUserIds:string[];adminUserIds:string[];lockedAt:unknown;performanceLockedAt:unknown;potentialLockedAt:unknown;entries:CalibrationWorkEntry[]}[];
};
type TaskKey=AssessmentReminderTask['key'];
type TaskBucket={ids:Set<string>;closesAt:string|null;people:Map<string,string>};
export type ReminderWorkRecipient={userId:string;personId:string;employmentIds:string[];tasks:AssessmentReminderTask[]};

/** One current work graph, one summary per login. The same phase/lock/window rules power the workspace.
 * Company entitlements are supplied explicitly, including for a group-wide cycle. No user impersonation.
 */
export function assessmentReminderWork(graph:ReminderWorkGraph,enabledCompanies:ReadonlySet<string>,now=new Date()):ReminderWorkRecipient[]{
 const {policy}=graph.cycle,byEmployment=new Map<string,typeof graph.actors>(),byUser=new Map(graph.actors.map(actor=>[actor.userId,actor]));
 const buckets=new Map<string,Map<TaskKey,TaskBucket>>(),reviews=new Map(graph.reviews.map(review=>[review.id,review]));
 for(const actor of graph.actors)for(const id of actor.employmentIds){const actors=byEmployment.get(id)??[];actors.push(actor);byEmployment.set(id,actors);}
 const bgOnly=new Set(graph.sessions.filter(session=>session.tier==='bg'&&(!session.companyId||enabledCompanies.has(session.companyId))).flatMap(session=>session.reviewerUserIds.filter(id=>!byUser.get(id)?.cycleAdmin)));
 function add(userId:string,key:TaskKey,id:string,cell:WindowCell|null,person?:{personId:string;name:string}){
  if(cell&&!assessmentWorkWindowOpen(policy,cell,now))return;
  const tasks=buckets.get(userId)??new Map<TaskKey,TaskBucket>();buckets.set(userId,tasks);
  const bucket=tasks.get(key)??{ids:new Set<string>(),closesAt:null,people:new Map<string,string>()};tasks.set(key,bucket);
  bucket.ids.add(id);const closesAt=cell?policy.windows[cell]?.closesAt??null:null;
  if(closesAt&&(!bucket.closesAt||Date.parse(closesAt)<Date.parse(bucket.closesAt)))bucket.closesAt=closesAt;
  if(person)bucket.people.set(person.personId,person.name);
 }
 for(const review of graph.reviews){
  if(!enabledCompanies.has(review.companyId))continue;
  const candidates=new Map<string,typeof graph.actors[number]>();
  for(const id of new Set([review.employmentId,review.reviewerEmploymentId,...review.moderatorIds].filter((id):id is string=>!!id)))for(const actor of byEmployment.get(id)??[])candidates.set(actor.userId,actor);
  for(const actor of candidates.values()){
   const self=actor.personId===review.personId,manager=!self&&actor.employmentIds.includes(review.reviewerEmploymentId??''),assigned=actor.employmentIds.some(id=>review.moderatorIds.includes(id));
   if(self&&bgOnly.has(actor.userId)||!self&&!manager&&!assigned)continue;
   const parts=reviewWorkspaceParts(policy,review.facts,{self,manager,employmentIds:actor.employmentIds});
   for(const part of parts){
    if(part.state!=='open'||part.locked||review.frozen&&part.module!=='idp')continue;
    let key:TaskKey;
    if(self){
     // The source reminder omits own KPI setting: it reminds own results/check-in, TC and career plan.
     if(part.module==='pm'&&part.stage==='setting')continue;
     key=part.module==='pm'?part.stage==='checkin'?'own_checkin':'own_results':part.module==='tm'?'own_competency':'own_plan';
    }else key=part.module==='pm'?part.stage==='setting'?'team_setting':'team_results':part.module==='tm'?'team_competency':'team_plan';
    add(actor.userId,key,review.id,part.cell,self?undefined:review);
   }
  }
 }
 if(policy.modules.tm)for(const panel of graph.panels){
  const review=reviews.get(panel.reviewId);if(!review||review.frozen||!enabledCompanies.has(review.companyId))continue;
  for(const actor of byEmployment.get(panel.employmentId)??[])if(actor.personId!==review.personId)add(actor.userId,'feedback',panel.id,'f360');
 }
 for(const session of graph.sessions){
  if(session.companyId&&!enabledCompanies.has(session.companyId))continue;
  for(const userId of session.reviewerUserIds){
   const actor=byUser.get(userId);if(!actor)continue;
   const entries=session.entries.filter(entry=>entry.personId!==actor.personId&&enabledCompanies.has(entry.companyId));
   if(!entries.length)continue;
   const parts=leaderWorkspaceParts(policy,session.tier,session);
   for(const part of parts){
    if(part.state!=='open')continue;
    const key:TaskKey=session.tier==='bg'?'bg_talent':session.tier==='group'||session.tier==='final'?'group_performance':session.tier==='hod'?part.axis==='performance'?'hod_performance':'hod_potential':part.axis==='performance'?'bu_performance':'bu_potential';
    const cell:WindowCell|null=session.tier==='bg'?'tb_bgceo':session.tier==='group'||session.tier==='final'?null:session.tier==='hod'?part.axis==='performance'?'pm_hod':'pot_hod':part.axis==='performance'?'pm_buceo':'pot_buceo';
    for(const entry of leaderPendingEntries(policy,session.tier,part.axis,entries))add(userId,key,entry.reviewId,cell);
   }
  }
 }
 return [...buckets].sort(([a],[b])=>a.localeCompare(b)).map(([userId,buckets])=>{
  const actor=byUser.get(userId)!;
  const tasks=assessmentReminderTaskKeys.flatMap(key=>{
   const bucket=buckets.get(key);if(!bucket?.ids.size)return [];
   const people=[...bucket.people].sort(([a],[b])=>a.localeCompare(b)).slice(0,3).map(([,name])=>name);
   return [{key,count:bucket.ids.size,closesAt:bucket.closesAt,...(people.length?{people}:{})}];
  });
  return {userId,personId:actor.personId,employmentIds:actor.employmentIds,tasks:assessmentReminderMailSchema.parse({tasks}).tasks};
 });
}
