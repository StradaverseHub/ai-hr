/** Home projects the existing workflow owners. It never creates tasks, decisions or capabilities. */
import type {SessionContext} from '../db/client';
import {settleReadGroup} from '../lib/settle-read-group';
import {HomeAccessError} from './employee-home';
import {readOwnEmployeeHomeConfiguration,type OwnHomeConfigurationRead} from './employee-home-configuration';
import {createAccountTaskPreviewRead,listPendingTasks} from './approvals-inbox';
import {readAccountTaskBundle,type AccountTaskBundle} from './account-task-bundle';
import {pendingStandardFeedbackTaskMetadata,pendingOnehrFeedbackTaskMetadata} from '../packs/performance/service';
import {onboardingAssignedTaskMetadata} from '../packs/lifecycle/service';
import {isModuleEnabled} from './entitlements';
import {todayInKualaLumpur} from '../lib/hr-date';
import {projectHomeAssignedWork,type EmployeeHomeTasks} from '../lib/employee-home-tasks';
import {ASSIGNED_APPROVAL_KINDS,assignedApprovalHref,type AssignedApprovalKind} from '../lib/assigned-approval-focus';

const taskModules=(ctx:SessionContext)=>({attendance:isModuleEnabled(ctx,'attendance'),claims:isModuleEnabled(ctx,'claims'),
 performance:isModuleEnabled(ctx,'performance'),rewards:isModuleEnabled(ctx,'rewards')});

async function loadAdditionalTasks(ctx:SessionContext,performance:boolean,bundle?:Promise<AccountTaskBundle|null>){
 const lifecycle=isModuleEnabled(ctx,'lifecycle');
 // Each owner the account task statement answered for the same module flags takes that answer (core/account-task-bundle.ts).
 const read=bundle?await bundle:null;
 const answered=<T,>(value:T|null|undefined,same:boolean)=>same&&value!=null?value:null;
 const feedback=read?.modules.performance===performance,onboarding=read?.modules.lifecycle===lifecycle;
 return settleReadGroup([
  ()=>performance?answered(read?.standardFeedback,feedback)??pendingStandardFeedbackTaskMetadata(ctx):Promise.resolve([]),
  ()=>performance?answered(read?.onehrFeedback,feedback)??pendingOnehrFeedbackTaskMetadata(ctx):Promise.resolve([]),
  ()=>lifecycle?answered(read?.onboarding,onboarding)??onboardingAssignedTaskMetadata(ctx):Promise.resolve([]),
 ]);
}
/** One account task statement per Home response, for the module flags the owners above are called with. A module
 * whose flag cannot be resolved is left to its owner (and its own failure). */
function startAccountTaskBundle(ctx:SessionContext,modules:ReturnType<typeof taskModules>){
 let lifecycle:boolean|null=null;
 try{lifecycle=isModuleEnabled(ctx,'lifecycle');}catch{lifecycle=null;}
 return readAccountTaskBundle(ctx,{...modules,lifecycle:lifecycle??false}).then(read=>read&&lifecycle===null?{...read,onboarding:null}:read);
}

/** Summary needs the exact account total, without materializing the full Claims queue. */
export async function countEmployeeHomeTasks(ctx:SessionContext):Promise<number>{
 const modules=taskModules(ctx),bundle=startAccountTaskBundle(ctx,modules);
 // The account preview's exact count (core/approvals-inbox.ts createAccountTaskPreviewRead) is countPendingTasks' total;
 // with the account task statement both read the same one statement.
 const [inboxCount,[standardFeedback,onehrFeedback,onboarding]]=await settleReadGroup([
  ()=>createAccountTaskPreviewRead(ctx,modules,bundle).count(),()=>loadAdditionalTasks(ctx,modules.performance,bundle),
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
   const modules=taskModules(session),bundle=startAccountTaskBundle(session,modules);
   this.pending={inbox:createAccountTaskPreviewRead(session,modules,bundle),additional:loadAdditionalTasks(session,modules.performance,bundle)};
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
 if((page??1)<=1){
  // The first page is the account preview: the same owners, read through one account task statement.
  const bundle=startAccountTaskBundle(ctx,modules);
  return settleReadGroup([()=>createAccountTaskPreviewRead(ctx,modules,bundle).summary(),()=>loadAdditionalTasks(ctx,modules.performance,bundle)]);
 }
 return settleReadGroup([
  ()=>listPendingTasks(ctx,undefined,modules).then(items=>({items,total:items.length})),
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
