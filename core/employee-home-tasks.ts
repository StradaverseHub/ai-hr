/** Home projects the existing workflow owners. It never creates tasks, decisions or capabilities. */
import type {SessionContext} from '../db/client';
import {settleReadGroup} from '../lib/settle-read-group';
import {HomeAccessError} from './employee-home';
import {readOwnEmployeeHomeConfiguration,type OwnHomeConfigurationRead} from './employee-home-configuration';
import {countPendingTasks,createAccountTaskPreviewRead,listPendingTasks,pendingTaskSummary} from './approvals-inbox';
import {pendingStandardFeedbackTaskMetadata,pendingOnehrFeedbackTaskMetadata} from '../packs/performance/service';
import {onboardingAssignedTaskMetadata} from '../packs/lifecycle/service';
import {isModuleEnabled} from './entitlements';
import {todayInKualaLumpur} from '../lib/hr-date';
import {projectHomeAssignedWork,type EmployeeHomeTasks} from '../lib/employee-home-tasks';
import {ASSIGNED_APPROVAL_KINDS,assignedApprovalHref,type AssignedApprovalKind} from '../lib/assigned-approval-focus';

const taskModules=(ctx:SessionContext)=>({attendance:isModuleEnabled(ctx,'attendance'),claims:isModuleEnabled(ctx,'claims'),
 performance:isModuleEnabled(ctx,'performance'),rewards:isModuleEnabled(ctx,'rewards')});

async function loadAdditionalTasks(ctx:SessionContext,performance:boolean){
 const lifecycle=isModuleEnabled(ctx,'lifecycle');
 return settleReadGroup([
  ()=>performance?pendingStandardFeedbackTaskMetadata(ctx):Promise.resolve([]),
  ()=>performance?pendingOnehrFeedbackTaskMetadata(ctx):Promise.resolve([]),
  ()=>lifecycle?onboardingAssignedTaskMetadata(ctx):Promise.resolve([]),
 ]);
}

/** Summary needs the exact account total, without materializing the full Claims queue. */
export async function countEmployeeHomeTasks(ctx:SessionContext):Promise<number>{
 const modules=taskModules(ctx);
 const [inboxCount,[standardFeedback,onehrFeedback,onboarding]]=await settleReadGroup([
  ()=>countPendingTasks(ctx,undefined,modules),()=>loadAdditionalTasks(ctx,modules.performance),
 ]);
 return inboxCount+standardFeedback.length+onehrFeedback.length+onboarding.length;
}

/** This carrier is created by one Home response and used after each card's own-subject proof. */
export class OwnHomeTaskSourceRead {
 private pending?:{
  inbox:ReturnType<typeof createAccountTaskPreviewRead>;
  additional:ReturnType<typeof loadAdditionalTasks>;
 };
 constructor(private readonly session:SessionContext,private readonly employmentId:string){}

 private read(session:SessionContext,employmentId:string){
  if(session!==this.session||employmentId!==this.employmentId)throw new HomeAccessError('employmentUnavailable');
  if(!this.pending){
   const modules=taskModules(session);
   this.pending={inbox:createAccountTaskPreviewRead(session,modules),additional:loadAdditionalTasks(session,modules.performance)};
  }
  return this.pending;
 }

 async count(session:SessionContext,employmentId:string){
  const {inbox,additional}=this.read(session,employmentId);
  const [inboxCount,[standardFeedback,onehrFeedback,onboarding]]=await settleReadGroup([()=>inbox.count(),()=>additional]);
  return inboxCount+standardFeedback.length+onehrFeedback.length+onboarding.length;
 }

 summary(session:SessionContext,employmentId:string){
  const {inbox,additional}=this.read(session,employmentId);
  return settleReadGroup([()=>inbox.summary(),()=>additional]);
 }
}

function readTaskPage(ctx:SessionContext,page:number|undefined){
 const modules=taskModules(ctx);
 return settleReadGroup([
  ()=>(page??1)<=1?pendingTaskSummary(ctx,undefined,modules)
   :listPendingTasks(ctx,undefined,modules).then(items=>({items,total:items.length})),
  ()=>loadAdditionalTasks(ctx,modules.performance),
 ]);
}

export async function readEmployeeHomeTasks(ctx:SessionContext,employmentId?:string,page?:number,configurationRead?:OwnHomeConfigurationRead,taskSourceRead?:OwnHomeTaskSourceRead):Promise<EmployeeHomeTasks>{
 const {configuration, employmentId: subjectId} = await (configurationRead?.read(ctx,employmentId)??readOwnEmployeeHomeConfiguration(ctx,employmentId));
 configurationRead?.signal?.throwIfAborted();
 // Selection chooses the company's presentation configuration. Work remains account-grained: a
 // selected own employment must not hide assignments addressed to another of the actor's employments.
 // listPendingTasks already carries replacement-leave decisions; reading them again here duplicated every one,
 // and the projection rightly refuses a duplicate owner identity, which failed the whole list.
 const [inbox,[standardFeedback,onehrFeedback,onboarding]]=await (taskSourceRead&&(page??1)<=1
  ?taskSourceRead.summary(ctx,subjectId):readTaskPage(ctx,page));
 return projectHomeAssignedWork([
  ...inbox.items.map(row=>ASSIGNED_APPROVAL_KINDS.some(kind=>kind===row.kind)?{...row,linkPath:assignedApprovalHref({kind:row.kind as AssignedApprovalKind,id:row.id})}:
   row.kind==='profile'?{...row,linkPath:`/admin/personnel/profile-changes?requestId=${row.id}&assigned=1#request-${row.id}`}:row),
  ...[...standardFeedback,...onehrFeedback,...onboarding].map(row=>({id:row.id,kind:row.kind,subjectName:row.subjectName,createdAt:row.sourceUpdatedAt.toISOString(),linkPath:row.linkPath,...(row.dueDate?{dueDate:row.dueDate}:{})})),
 ],{employmentId:subjectId,today:todayInKualaLumpur(),page,omittedClaims:inbox.total-inbox.items.length,effortMinutes:configuration.effortMinutes});
}
