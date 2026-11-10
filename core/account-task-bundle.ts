/** Home's account-grained task sources in ONE statement (docs/adr/2026-11-10-home-request-read-scope.md, decision 6).
 *
 * The Home Tasks card and the Summary count read every workflow owner of core/approvals-inbox.ts and Home's personal
 * owners (core/employee-home-tasks.ts). Each owner opened its own reads: about thirty statements per Home stream even
 * for someone with no work at all. Here every owner's section is one sub-select of a single statement, built next to
 * the owner it reproduces (the owner and the section share their SQL text), and evaluated in the caller's own session,
 * so row-level security, delegation, organisation scope and the self-approval ban are the owner's own:
 *  - decided in SQL: Leave (current step authority, leaveApproverDecisionSql), Leave Credit and the Claims preview with
 *    its exact count (decisionEmploymentAuthoritySql), Notice acknowledgements, standard feedback and the performance
 *    review queue (the owner's TypeScript combination runs on the rows);
 *  - empty answers: every other owner's own first probe. Its empty result is the owner's empty result; a candidate is
 *    never decided here.
 * A section the statement cannot answer exactly returns `null` from its owner's `FromBundle` and that owner alone runs
 * itself, unchanged, in the same snapshot: a Leave chain outside the exact step kinds, decision-header candidates,
 * Attendance, Profile, Rewards, assessment, calibration, OneHR feedback and onboarding candidates, a module gate that
 * would refuse, an AI Centre activity, or a Claims guard outside a repeatable snapshot. Without a login, or when the
 * principal proof fails, or when the statement itself fails, every owner runs exactly as before.
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
import {pendingLeaveTaskBundleSql,pendingLeaveTasksFromBundle,pendingLeaveCancellationCandidatesExistSql,
 pendingReplacementLeaveTaskBundleSql,pendingReplacementLeaveTasksFromBundle} from '../packs/leave/service';
import {pendingClaimTaskPreviewBundleSql,pendingClaimTaskPreviewFromBundle} from '../packs/claims/service';
import {pendingAttendanceTaskBundleSql,pendingAttendanceTasksFromBundle} from '../packs/attendance/service';
import {pendingProfileTaskBundleSql,pendingProfileTasksFromBundle} from './profile';
import {pendingResignationCandidatesExistSql} from './offboarding';
import {pendingReviewCandidatesExistSql} from './employment-review';
import {pendingNoticeAcknowledgementTaskBundleSql,pendingNoticeAcknowledgementTasksFromBundle} from './notice';
import {pendingPerformanceTasksBundleSql,pendingPerformanceTasksFromBundle,pendingStandardFeedbackTaskBundleSql,
 pendingStandardFeedbackTasksFromBundle,pendingOnehrFeedbackCandidatesBundleSql} from '../packs/performance/service';
import {pendingRewardTasksBundleSql,pendingRewardTasksFromBundle} from '../packs/rewards/service';
import {onboardingAssignedTasksBundleSql,onboardingAssignedTasksFromBundle} from '../packs/lifecycle/service';
import type {AssignedApprovalMetadata,AssignedPersonalTaskMetadata,PackTaskItem} from '../lib/assigned-work';

/** The Home preview's claim page, exactly core/approvals-inbox.ts loadClaimTaskSource's preview. */
export const ACCOUNT_TASK_CLAIM_PREVIEW=25;
export type AccountTaskModules={attendance:boolean;claims:boolean;performance:boolean;rewards:boolean;lifecycle:boolean};

/** Each section's owner result, or null where that owner must run itself. A module the caller did not enable is the
 * owner's absence ([] / an empty claim page), exactly as core/approvals-inbox.ts treats it. */
export type AccountTaskBundle=Readonly<{
 /** The module flags this statement was built for; a consumer whose own flag differs reads its owner. */
 modules:AccountTaskModules;
 leave:AssignedApprovalMetadata[]|null;
 /** The preview probe of core/approvals-inbox.ts loadDecisionHeaders: false is its empty answer. */
 decisionCandidates:boolean;
 replacement:{id:string;personId:string;employee:string|null;createdAt:Date}[]|null;
 attendance:AssignedApprovalMetadata[]|null;
 profile:AssignedApprovalMetadata[]|null;
 notices:ReturnType<typeof pendingNoticeAcknowledgementTasksFromBundle>|null;
 performance:PackTaskItem[]|null;
 rewards:PackTaskItem[]|null;
 claims:{items:AssignedApprovalMetadata[];total:number}|null;
 standardFeedback:AssignedPersonalTaskMetadata[]|null;
 onehrFeedback:AssignedPersonalTaskMetadata[]|null;
 onboarding:AssignedPersonalTaskMetadata[]|null;
}>;

const ownerReads=new AsyncLocalStorage<true>();
/** Every task owner inside `work` reads on its own, as before this statement existed. Equivalence proofs only. */
export function withOwnerTaskReads<T>(work:()=>Promise<T>):Promise<T>{return ownerReads.run(true,work);}

const gateOpen=(ctx:SessionContext,code:string)=>{try{assertModuleGate(ctx,code);return true;}catch{return false;}};

/** One Home response's account task statement. Resolves null when the owners must read on their own. */
export async function readAccountTaskBundle(ctx:SessionContext,modules:AccountTaskModules):Promise<AccountTaskBundle|null>{
 if(ownerReads.getStore()||!ctx.userId||ctx.agent)return null;
 // A gate or AI Centre check that the owner itself would run decides only that owner: it reads on its own.
 const performance=gateOpen(ctx,'performance')&&!aiCentreActivity(ctx.tenantId),rewards=gateOpen(ctx,'rewards'),lifecycle=gateOpen(ctx,'lifecycle');
 const none=sql`null::jsonb`,today=todayInKualaLumpur(),person=ctx.personId??null;
 let row:Record<string,unknown>|undefined;
 try{
  row=await withTenant(ctx,async tx=>{
   // The Claims and Attendance owners scope this setting to their read for the same reason: JIT compile time.
   await tx.execute(sql`set local jit=off`);
   const sections:[string,SQL][]=[
    ['leave',pendingLeaveTaskBundleSql(ctx)],
    ['decision_candidates',sql`(${pendingLeaveCancellationCandidatesExistSql(tx,ctx,undefined)}
     or ${pendingResignationCandidatesExistSql(tx,ctx,undefined)}
     or ${pendingReviewCandidatesExistSql(tx,ctx,'manager',undefined)}
     or ${pendingReviewCandidatesExistSql(tx,ctx,'hr',undefined)})`],
    ['replacement',pendingReplacementLeaveTaskBundleSql(ctx)],
    ['attendance',modules.attendance?pendingAttendanceTaskBundleSql(ctx):none],
    ['profile',pendingProfileTaskBundleSql(ctx)],
    ['notices',pendingNoticeAcknowledgementTaskBundleSql(ctx,today)],
    ['performance',modules.performance?pendingPerformanceTasksBundleSql(ctx):none],
    ['rewards',modules.rewards?pendingRewardTasksBundleSql():none],
    ['claims',modules.claims?pendingClaimTaskPreviewBundleSql(ctx,ACCOUNT_TASK_CLAIM_PREVIEW):none],
    ['standard_feedback',modules.performance?pendingStandardFeedbackTaskBundleSql(ctx):none],
    ['onehr_feedback',modules.performance?pendingOnehrFeedbackCandidatesBundleSql(ctx):none],
    ['onboarding',modules.lifecycle?onboardingAssignedTasksBundleSql(ctx):none],
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
 return Object.freeze({
  modules:Object.freeze({...modules}),
  leave:decide(()=>pendingLeaveTasksFromBundle(result.leave)),
  decisionCandidates:result.decision_candidates!==false,
  replacement:decide(()=>pendingReplacementLeaveTasksFromBundle(result.replacement)),
  attendance:module(modules.attendance,true,()=>pendingAttendanceTasksFromBundle(result.attendance),[]),
  profile:decide(()=>pendingProfileTasksFromBundle(result.profile)),
  notices:decide(()=>pendingNoticeAcknowledgementTasksFromBundle(result.notices)),
  performance:module(modules.performance,performance,()=>pendingPerformanceTasksFromBundle(result.performance,undefined),[]),
  rewards:module(modules.rewards,rewards,()=>pendingRewardTasksFromBundle(result.rewards),[]),
  claims:module(modules.claims,true,()=>pendingClaimTaskPreviewFromBundle(result.claims),{items:[],total:0}),
  standardFeedback:module(modules.performance,true,()=>pendingStandardFeedbackTasksFromBundle(result.standard_feedback),[]),
  onehrFeedback:module(modules.performance,performance,()=>result.onehr_feedback===false?[]:null,[]),
  onboarding:module(modules.lifecycle,lifecycle,()=>onboardingAssignedTasksFromBundle(result.onboarding,ctx),[]),
 });
}
