/** Home's account-grained task sources in ONE statement (docs/adr/2026-11-10-home-request-read-scope.md, decisions 7 and 10).
 *
 * The Home Tasks card and the Summary count read every workflow owner of core/approvals-inbox.ts and Home's personal
 * owners (core/employee-home-tasks.ts). Each owner opened its own reads: about thirty statements per Home stream even
 * for someone with no work at all. Here every owner's section is one sub-select of a single statement, built next to
 * the owner it reproduces (the owner and the section share their SQL text), and evaluated in the caller's own session,
 * so row-level security, delegation, organisation scope and the self-approval ban are the owner's own:
 *  - decided in SQL: Leave and leave cancellations (the current step's approvers in order, leaveStepDecisionSql), the
 *    resignation and employment review headers, Attendance (frozen workflow decision functions, or
 *    decisionEmploymentAuthoritySql), Leave Credit and the Claims preview with its exact count;
 *  - the owner's rows, with the owner's TypeScript run on them: Notice acknowledgements, standard and OneHR feedback,
 *    the performance review queue, assessment and calibration work, Rewards (when no access observation is due) and the
 *    onboarding interpreter;
 *  - the owner's first transaction: Profile candidates, whose locked decision transaction still runs for them.
 * A section the statement cannot answer exactly returns `null` from its owner's `FromBundle` (or its projection throws)
 * and that owner alone runs itself, unchanged, in the same snapshot: a Leave or cancellation step whose `limit 1` rows
 * disagree, an alternate id the owner would trim, an unknown step kind or a named step naming nobody (the owner's own
 * error), an Attendance request whose frozen subject differs, a Rewards observation that is due (a write), a cycle,
 * policy or case id the owner's parse would refuse, a module gate that would refuse or an AI Centre activity. Without a
 * login, or when the principal proof fails, or when the statement itself fails, every owner runs exactly as before.
 *
 * Module entitlements stay the caller's decision (core/approvals-inbox.ts InboxModules): a module the caller did not
 * enable contributes no sub-select and no owner call. test/performance/home-manager-card-reads.test.ts compares every
 * section with its owner for each fixture person. Read only; never cached beyond one Home response. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {aiCentreActivity} from '../lib/ai/centre-activity';
import {todayInKualaLumpur} from '../lib/hr-date';
import {assertModuleGate} from './module-gate';
import {pendingLeaveTaskBundleSql,pendingLeaveTasksFromBundle,pendingLeaveCancellationTaskBundleSql,
 pendingReplacementLeaveTaskBundleSql,pendingReplacementLeaveTasksFromBundle} from '../packs/leave/service';
import {pendingClaimTaskPreviewBundleSql,pendingClaimTaskPreviewFromBundle} from '../packs/claims/service';
import {pendingAttendanceTaskBundleSql,pendingAttendanceTasksFromBundle} from '../packs/attendance/service';
import {pendingProfileTaskBundleSql,pendingProfileCandidatesFromBundle} from './profile';
import {pendingResignationTaskBundleSql,pendingResignationTasksFromBundle} from './offboarding';
import {pendingReviewTaskBundleSql,pendingReviewTasksFromBundle} from './employment-review';
import {pendingNoticeAcknowledgementTaskBundleSql,pendingNoticeAcknowledgementTasksFromBundle} from './notice';
import {pendingPerformanceTasksBundleSql,pendingPerformanceTasksFromBundle,pendingStandardFeedbackTaskBundleSql,
 pendingStandardFeedbackTasksFromBundle,pendingOnehrFeedbackTaskBundleSql,pendingOnehrFeedbackTasksFromBundle} from '../packs/performance/service';
import {pendingRewardTasksBundleSql,pendingRewardTasksFromBundle} from '../packs/rewards/service';
import {onboardingAssignedTasksBundleSql,onboardingAssignedTasksFromBundle} from '../packs/lifecycle/service';
import type {AssignedApprovalMetadata,AssignedPersonalTaskMetadata,PackTaskItem} from '../lib/assigned-work';

/** The Home preview's claim page, exactly core/approvals-inbox.ts loadClaimTaskSource's preview. */
export const ACCOUNT_TASK_CLAIM_PREVIEW=25;
export type AccountTaskModules={attendance:boolean;claims:boolean;performance:boolean;rewards:boolean;lifecycle:boolean};

/** Each section's owner result, or null where that owner must run itself. A module the caller did not enable is the
 * owner's absence ([] / an empty claim page), exactly as core/approvals-inbox.ts treats it. */
export type AccountTaskBundle=Readonly<{
 /** The module flags and read this statement was built for; a consumer whose own differ reads its owners. */
 modules:AccountTaskModules;
 read:AccountTaskRead;
 leave:AssignedApprovalMetadata[]|null;
 /** core/approvals-inbox.ts loadDecisionHeaders' four owners. */
 cancellations:AssignedApprovalMetadata[]|null;
 resignations:AssignedApprovalMetadata[]|null;
 managerReviews:AssignedApprovalMetadata[]|null;
 hrReviews:AssignedApprovalMetadata[]|null;
 replacement:{id:string;personId:string;employee:string|null;createdAt:Date}[]|null;
 attendance:AssignedApprovalMetadata[]|null;
 /** The Profile owner's result where its first transaction found no candidate ([]); null otherwise. */
 profile:AssignedApprovalMetadata[]|null;
 /** The Profile owner's candidates (its first transaction), for its locked decision transaction
  * (core/profile.ts pendingProfileTasksFromCandidates); null where the owner must run whole. */
 profileCandidates:AssignedApprovalMetadata[]|null;
 notices:ReturnType<typeof pendingNoticeAcknowledgementTasksFromBundle>|null;
 performance:PackTaskItem[]|null;
 rewards:PackTaskItem[]|null;
 claims:{items:AssignedApprovalMetadata[];total:number}|null;
 standardFeedback:AssignedPersonalTaskMetadata[]|null;
 onehrFeedback:AssignedPersonalTaskMetadata[]|null;
 onboarding:AssignedPersonalTaskMetadata[]|null;
}>;

/** `companyIds`: each owner's own company filter (undefined: none, Home's whole account). `personal`: also Home's
 * personal owners (feedback, onboarding). `notices`: the Notice acknowledgement owner (the approvals-only lists skip it). */
export type AccountTaskRead=Readonly<{companyIds?:readonly string[];personal:boolean;notices:boolean}>;
export const HOME_ACCOUNT_TASK_READ:AccountTaskRead=Object.freeze({personal:true,notices:true});

const ownerReads=new AsyncLocalStorage<true>();
/** Every task owner inside `work` reads on its own, as before this statement existed. Equivalence proofs only. */
export function withOwnerTaskReads<T>(work:()=>Promise<T>):Promise<T>{return ownerReads.run(true,work);}

const gateOpen=(ctx:SessionContext,code:string)=>{try{assertModuleGate(ctx,code);return true;}catch{return false;}};

/** One Home response's account task statement. Resolves null when the owners must read on their own. */
export async function readAccountTaskBundle(ctx:SessionContext,modules:AccountTaskModules,read:AccountTaskRead=HOME_ACCOUNT_TASK_READ):Promise<AccountTaskBundle|null>{
 if(ownerReads.getStore()||!ctx.userId||ctx.agent)return null;
 const companyIds=read.companyIds===undefined?undefined:[...read.companyIds],personal=read.personal;
 // A gate or AI Centre check that the owner itself would run decides only that owner: it reads on its own.
 const performance=gateOpen(ctx,'performance')&&!aiCentreActivity(ctx.tenantId),rewards=gateOpen(ctx,'rewards'),lifecycle=gateOpen(ctx,'lifecycle');
 const none=sql`null::jsonb`,today=todayInKualaLumpur();
 const person=ctx.personId??null;
 let row:Record<string,unknown>|undefined;
 try{
  row=await withTenant(ctx,async tx=>{
   // The Claims and Attendance owners scope this setting to their read for the same reason: JIT compile time.
   await tx.execute(sql`set local jit=off`);
   const sections:[string,SQL][]=[
    ['leave',pendingLeaveTaskBundleSql(ctx,companyIds)],
    ['cancellations',pendingLeaveCancellationTaskBundleSql(tx,ctx,companyIds)],
    ['resignations',pendingResignationTaskBundleSql(tx,ctx,companyIds)],
    ['manager_reviews',pendingReviewTaskBundleSql(tx,ctx,'manager',companyIds)],
    ['hr_reviews',pendingReviewTaskBundleSql(tx,ctx,'hr',companyIds)],
    ['replacement',pendingReplacementLeaveTaskBundleSql(ctx,companyIds)],
    ['attendance',modules.attendance?pendingAttendanceTaskBundleSql(ctx,companyIds):none],
    ['profile',pendingProfileTaskBundleSql(tx,ctx,companyIds)],
    ['notices',read.notices?pendingNoticeAcknowledgementTaskBundleSql(ctx,today):none],
    ['performance',modules.performance&&performance?pendingPerformanceTasksBundleSql(ctx):none],
    ['rewards',modules.rewards&&rewards?pendingRewardTasksBundleSql(companyIds):none],
    ['claims',modules.claims?pendingClaimTaskPreviewBundleSql(ctx,ACCOUNT_TASK_CLAIM_PREVIEW,companyIds):none],
    ['standard_feedback',personal&&modules.performance?pendingStandardFeedbackTaskBundleSql(ctx):none],
    ['onehr_feedback',personal&&modules.performance&&performance?pendingOnehrFeedbackTaskBundleSql(ctx):none],
    ['onboarding',personal&&modules.lifecycle&&lifecycle?onboardingAssignedTasksBundleSql(ctx):none],
   ];
   const [result]=await tx.execute<Record<string,unknown>>(sql`select (app.principal_snapshot_current()
     and (${person}::uuid is null or app.is_self_person(${person}::uuid))) as principal,
    ${sql.join(sections.map(([name,section])=>sql`${section} as ${sql.raw(name)}`),sql`,\n`)}`);
   return result;
  },{readOnlySnapshot:true});
 }catch{
  // The owners report their own failures (or succeed) exactly as before.
  return null;
 }
 if(row?.principal!==true)return null;
 const result=row;
 // A section whose projection refuses its rows is that owner's to report: it reads on its own.
 const decide=<T,>(read:()=>T|null):T|null=>{try{return read();}catch{return null;}};
 const module=<T,>(enabled:boolean,gate:boolean,read:()=>T|null,absent:T):T|null=>!enabled?absent:gate?decide(read):null;
 const profileCandidates=decide(()=>pendingProfileCandidatesFromBundle(result.profile));
 let onboarding:AssignedPersonalTaskMetadata[]|null=null;
 if(personal){
  if(!modules.lifecycle)onboarding=[];
  else if(lifecycle){try{onboarding=await onboardingAssignedTasksFromBundle(result.onboarding,ctx);}catch{onboarding=null;}}
 }
 return Object.freeze({
  modules:Object.freeze({...modules}),read:Object.freeze({...read,...(companyIds?{companyIds:Object.freeze(companyIds)}:{})}),
  leave:decide(()=>pendingLeaveTasksFromBundle(result.leave)),
  cancellations:decide(()=>pendingLeaveTasksFromBundle(result.cancellations)),
  resignations:decide(()=>pendingResignationTasksFromBundle(result.resignations)),
  managerReviews:decide(()=>pendingReviewTasksFromBundle(result.manager_reviews)),
  hrReviews:decide(()=>pendingReviewTasksFromBundle(result.hr_reviews)),
  replacement:decide(()=>pendingReplacementLeaveTasksFromBundle(result.replacement)),
  attendance:module(modules.attendance,true,()=>pendingAttendanceTasksFromBundle(result.attendance),[]),
  profile:profileCandidates&&profileCandidates.length===0?[]:null,
  profileCandidates,
  notices:read.notices?decide(()=>pendingNoticeAcknowledgementTasksFromBundle(result.notices)):[],
  performance:module(modules.performance,performance,()=>pendingPerformanceTasksFromBundle(result.performance,companyIds,ctx),[]),
  rewards:module(modules.rewards,rewards,()=>pendingRewardTasksFromBundle(result.rewards),[]),
  claims:module(modules.claims,true,()=>pendingClaimTaskPreviewFromBundle(result.claims),{items:[],total:0}),
  standardFeedback:personal?module(modules.performance,true,()=>pendingStandardFeedbackTasksFromBundle(result.standard_feedback),[]):null,
  onehrFeedback:personal?module(modules.performance,performance,()=>pendingOnehrFeedbackTasksFromBundle(result.onehr_feedback),[]):null,
  onboarding,
 });
}
