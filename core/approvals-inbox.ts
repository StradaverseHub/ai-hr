/**
 * Pending-approvals inbox for the topbar notification bell. Originally a bare COUNT (consultant
 * feedback #11); feedback 1514d366 (3-tab bell) turned it into a LIST API — `listPendingTasks`
 * returns the individual items awaiting THIS user's decision (pending leave from others + leave
 * cancellations + replacement-leave claims + attendance corrections + profile changes + claims + resignations +
 * manager and HR employment reviews), each with a deep-link to the page where the user acts on it.
 * b833a077 (r362) — TRAVEL LEFT THIS LIST. My Travel was removed completely, so no travel request can be
 * created and none can be decided; the `travel` PendingTaskKind, its queue, its self-exclusion and its
 * bell label went with it. The travel_request rows are kept for audit and are reachable from no screen.
 * `pendingApprovalsCount` stays as the length of that list, so the dashboard card and every
 * existing caller keep their exact semantics. The viewer's own pending requests are excluded —
 * a task means "things needing your action", not "your own requests in flight".
 *
 * Current assignment comes from each canonical decision owner, including named Attendance participants,
 * actual reporting assignments without a manager platform role and stored manager reviews across employments.
 * Broad row visibility and a role label alone do not create a task; private workspace rows are not selected.
 *
 * WP-A1 — module-owned work joins through PACK_TASK_SOURCES below: Performance (the /performance "Reviews
 * awaiting you" queue, OneHR assessment work and career plans awaiting their reviewer) and Rewards (units at
 * the viewer's approval stage). They deep-link to their own screens, so the layout's /approvals badge,
 * which counts only /approvals links, is unchanged by them.
 *
 * Recruitment slice 9 joins the same table with live recruitment to-dos (packs/recruitment/tasks.ts), but ONLY for a
 * surface that asks for them with `recruitment` (see InboxModulesWithRecruitment): the bell and My tasks (`listMyTasks`),
 * whose badge is the bell's count. Home, the AI Centre launcher's count and the mobile task contract do not carry them
 * (D-034); `withoutRecruitmentTasks` takes them out of a list that has them.
 */
import {assignedApprovalHref,type AssignedApprovalKind} from '../lib/assigned-approval-focus';
import {settleReadGroup} from '../lib/settle-read-group';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {assertAssignedWorkPrincipalTx} from './approvals';
import type {AssignedApprovalMetadata} from '../lib/assigned-work';
import {pendingLeaveTaskMetadata,pendingLeaveCancellationTaskMetadata,pendingLeaveCancellationCandidatesExistSql,listPendingReplacementLeaveTasks} from '../packs/leave/service';
import {countPendingClaimTasks,pendingClaimTaskMetadata,pendingClaimTaskSummary} from '../packs/claims/service';
import {pendingAttendanceTaskMetadata} from '../packs/attendance/service';
import {pendingProfileTaskMetadata,pendingProfileTasksFromCandidates} from './profile';
import {pendingResignationCandidatesExistSql,pendingResignationTaskMetadata} from './offboarding';
import {pendingNoticeAcknowledgementTasks} from './notice';
import {pendingReviewCandidatesExistSql,pendingReviewTaskMetadata} from './employment-review';
import {pendingPerformanceTasks} from '../packs/performance/service';
import {pendingRewardTasks} from '../packs/rewards/service';
import {pendingRecruitmentTasks} from '../packs/recruitment/service';
import {RECRUITMENT_TASK_KINDS,type PackTaskItem,type PackTaskKind,type PackTaskProvider,type RecruitmentTaskKind} from '../lib/assigned-work';
import type {AccountTaskBundle,AccountTaskModules,AccountTaskRead} from './account-task-bundle';

/** The account task statement, loaded on first use: this file is reached from the root layout and from narrow unit
 * harnesses, and a statement that cannot be built or sent leaves every owner to read on its own. */
async function startAccountTaskBundle(ctx:SessionContext,modules:AccountTaskModules,read:AccountTaskRead):Promise<AccountTaskBundle|null>{
  try{return await (await import('./account-task-bundle')).readAccountTaskBundle(ctx,modules,read);}catch{return null;}
}
/** core/account-task-bundle.ts sameAccountTaskRead, kept here so the type-only import above stays type-only. */
function sameRead(built:AccountTaskRead,wanted:AccountTaskRead){
  const ids=(read:AccountTaskRead)=>read.companyIds===undefined?null:JSON.stringify(read.companyIds);
  return ids(built)===ids(wanted)&&built.notices===wanted.notices&&(built.personal||!wanted.personal);
}

/** The per-module task vocabulary — each key maps to an i18n label (notifications.task.*). */
export type PendingTaskKind =
  | 'leave'
  | 'leaveCancellation'
  | 'replacementLeave'
  | 'attendance'
  | 'profile'
  | 'claim'
  | 'resignation'
  | 'managerReview'
  | 'hrReview'
  | 'noticeAcknowledgement'
  | PackTaskKind;

/** One item awaiting the viewer's decision — serializable (ISO date) so the client bell can render it. */
export type PendingTaskItem = {
  id: string;
  kind: PendingTaskKind;
  subjectName: string | null;
  /** ISO timestamp of when the request was filed (sorts the Task tab, newest first). */
  createdAt: string;
  /** Where the user acts on it — the matching /approvals section where one exists. */
  linkPath: string;
};

/**
 * Which OPTIONAL-module queues the caller may include (r292).
 *
 * THE CALLER DECIDES, AND THAT IS THE POINT. The Attendance and Claims metadata owners are
 * service-gated now (core/module-gate.ts) and throw `ModuleNotEnabledError` for a tenant that declined
 * the pack — so this read model has to know, and the two honest ways to find out have OPPOSITE failure
 * behaviour. `isModuleEnabled` is loud on an infrastructure fault, which is right for a service; the
 * quiet `isModuleEnabledOrFalse` degrades, which is right for a page. This function is reached from
 * `app/layout.tsx` — the ROOT layout, on every authenticated render — where a throw 500s every route in
 * the application, and that file already says so about the notifications gate two lines above its call.
 *
 * So the decision is NOT taken here. `test/module-catalog-drift.test.ts` ratchets the quiet readers to
 * `app/` for exactly this reason, and the correct answer is to honour that boundary rather than to widen
 * its owners set: each caller resolves the two booleans with the form appropriate to where IT sits, and
 * this file stays a plain read model with no entitlement read in it at all.
 *
 * REQUIRED, not optional with a default. A default would be a silent answer to a commercial question —
 * `true` would throw for a declined tenant and `false` would hide real tasks from a paying one — and the
 * next caller would inherit whichever was guessed. Making it a parameter puts the compiler on the hook.
 */
export type InboxModules = { attendance: boolean; claims: boolean; performance: boolean; rewards: boolean };
/**
 * Recruitment slice 9 — the caller ALSO answers whether Recruitment is enabled, which is how a surface asks for the
 * recruitment to-dos at all. Required on this type for the same reason as the four above; a surface that passes plain
 * `InboxModules` has not asked and gets no recruitment kind (the overloads below type its result without them). Only the
 * bell (app/layout.tsx) and My tasks (app/tasks/page.tsx through listMyTasks) ask: Home's task kinds (lib/employee-home.ts)
 * and the mobile v2 task enum do not carry them (D-034).
 */
export type InboxModulesWithRecruitment = InboxModules & { recruitment: boolean };

/**
 * Module-owned task sources (WP-A1) — the extension point for packs whose work belongs in this list.
 *
 * WHY HERE AND NOT ON `ModulePack` (packs/registry.ts). The registry object is client-safe on purpose:
 * the sidebar imports the pack wiring, and registry.ts keeps even the service FACADE off the object so
 * db/client never reaches the client bundle. A provider function on the pack would drag exactly that in.
 * So the slot is this server-side table: one row per pack, keyed by the `InboxModules` flag that gates
 * it, each provider imported from the pack's service surface. A disabled module's provider is never
 * called — the pack services are module-gated and would refuse, and a declined module has no work.
 *
 * Each provider is its pack's projection of an owner that already decides the work; it returns only
 * id, kind, subject name, owner time and link (lib/assigned-work.ts PackTaskItem).
 */
const PACK_TASK_SOURCES:readonly {module:'performance'|'rewards';load:PackTaskProvider}[]=[
  {module:'performance',load:pendingPerformanceTasks},
  {module:'rewards',load:pendingRewardTasks},
];
/**
 * Recruitment slice 9: the viewer's personal to-dos only — requisition and offer approval steps waiting for them,
 * interview feedback due and the later slices' kinds — read live under their own row security. Per-job counts stay on
 * the Overview (D-035). Not a PACK_TASK_SOURCES row: the account task statement (core/account-task-bundle.ts) and Home's
 * count never carry it, so it joins only the lists whose caller asked with `recruitment: true` (withRecruitmentTasks).
 */
const RECRUITMENT_TASK_SOURCE:PackTaskProvider=pendingRecruitmentTasks;
type InboxResult<T extends {kind:string}=PendingTaskItem>={items:T[];claimTotal:number;total:number;approvalCount:number};
/** Adds the recruitment to-dos to an inbox result when asked. Their links open /recruitment, so approvalCount is unchanged. */
async function withRecruitmentTasks(ctx:SessionContext,scopeIds:string[]|undefined,recruitment:boolean|undefined,inbox:Promise<InboxResult<InboxTaskItem>>):Promise<InboxResult>{
  if(recruitment!==true)return inbox;
  const [result,recruitmentTasks]=await settleReadGroup([()=>inbox,()=>RECRUITMENT_TASK_SOURCE(ctx,scopeIds)]);
  const extra=recruitmentTasks.map(({id,kind,subjectName,createdAt,linkPath})=>({id,kind,subjectName,createdAt,linkPath}));
  return {...result,items:[...result.items,...extra].sort(inboxOrder),total:result.total+extra.length};
}

type ApprovalOnlyTaskItem=Omit<PendingTaskItem,'kind'>&{kind:Exclude<PendingTaskKind,'noticeAcknowledgement'>};
/** What a surface that did not ask for recruitment work receives: every kind except the recruitment ones. */
export type InboxTaskItem=Omit<PendingTaskItem,'kind'>&{kind:Exclude<PendingTaskKind,RecruitmentTaskKind>};
type InboxApprovalOnlyTaskItem=Omit<PendingTaskItem,'kind'>&{kind:Exclude<PendingTaskKind,'noticeAcknowledgement'|RecruitmentTaskKind>};
// The overloads that ask for recruitment come first (they need the `recruitment` key); the last one is what
// ReturnType<typeof listPendingTasks> names, so every existing reader of that type keeps its kinds.
export function listPendingTasks(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModulesWithRecruitment,
  options:{noticeAcknowledgements:false}):Promise<ApprovalOnlyTaskItem[]>;
export function listPendingTasks(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModulesWithRecruitment,
  options?:{noticeAcknowledgements?:boolean}):Promise<PendingTaskItem[]>;
export function listPendingTasks(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,
  options:{noticeAcknowledgements:false}):Promise<InboxApprovalOnlyTaskItem[]>;
export function listPendingTasks(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,
  options?:{noticeAcknowledgements?:boolean}):Promise<InboxTaskItem[]>;
export async function listPendingTasks(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  modules: InboxModules & { recruitment?: boolean },
  options:{noticeAcknowledgements?:boolean}={},
): Promise<PendingTaskItem[]> {
  const {recruitment,...inbox}=modules;
  return (await withRecruitmentTasks(ctx,scopeIds,recruitment,loadPendingTasks(ctx,scopeIds,inbox,options))).items;
}

/** The bell's preview (app/layout.tsx). With `recruitment: true` it also carries the recruitment to-dos (D-034); a caller
 * that passes plain InboxModules (Home, Today, the pre-salary items) gets a result typed without the recruitment kinds. */
export function pendingTaskSummary(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModulesWithRecruitment,options?:{noticeAcknowledgements?:boolean;deferClaimPreview?:true}):Promise<InboxResult>;
export function pendingTaskSummary(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,options?:{noticeAcknowledgements?:boolean;deferClaimPreview?:true}):Promise<InboxResult<InboxTaskItem>>;
export function pendingTaskSummary(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules&{recruitment?:boolean},options:{noticeAcknowledgements?:boolean;deferClaimPreview?:true}={}):Promise<InboxResult>{
  const {recruitment,...inbox}=modules;
  const preview={...options,preview:true} as const;
  // The same owners through one account task statement with this list's company filter (core/account-task-bundle.ts).
  const read:AccountTaskRead={companyIds:scopeIds,personal:false,notices:options.noticeAcknowledgements!==false};
  const bundle=startAccountTaskBundle(ctx,{...inbox,lifecycle:false},read);
  return withRecruitmentTasks(ctx,scopeIds,recruitment,loadPendingTasks(ctx,scopeIds,inbox,preview,loadBundledCommonTaskSources(ctx,scopeIds,inbox,preview,bundle),
    loadBundledClaimTaskSource(ctx,scopeIds,inbox,preview,bundle)));
}

type DecisionHeaders=Pick<AccountTaskBundle,'cancellations'|'resignations'|'managerReviews'|'hrReviews'>;
async function loadDecisionHeaders(ctx:SessionContext,scopeIds:string[]|undefined,preview?:true,known?:DecisionHeaders){
  // known: each owner the account task statement answered for this same read (core/account-task-bundle.ts); every
  // other owner reads on its own, exactly as below.
  if(known)return settleReadGroup([
    ()=>known.cancellations??pendingLeaveCancellationTaskMetadata(ctx,scopeIds),
    ()=>known.resignations??pendingResignationTaskMetadata(ctx,scopeIds),
    ()=>known.managerReviews??pendingReviewTaskMetadata(ctx,'manager',scopeIds),
    ()=>known.hrReviews??pendingReviewTaskMetadata(ctx,'hr',scopeIds),
  ]);
  if(preview){
    const candidates=await withTenant(ctx,async tx=>{
      await assertAssignedWorkPrincipalTx(tx,ctx);
      const [row]=await tx.execute<{has_candidates:boolean}>(sql`
        select (
          ${pendingLeaveCancellationCandidatesExistSql(tx,ctx,scopeIds)}
          or ${pendingResignationCandidatesExistSql(tx,ctx,scopeIds)}
          or ${pendingReviewCandidatesExistSql(tx,ctx,'manager',scopeIds)}
          or ${pendingReviewCandidatesExistSql(tx,ctx,'hr',scopeIds)}
        ) as has_candidates
      `);
      return row?.has_candidates;
    });
    // An empty candidate set needs no per-owner decision checks. A possible
    // match still goes through each owner's fresh authorization.
    if(candidates===false)return [[],[],[],[]] as const;
  }
  return settleReadGroup([
    ()=>pendingLeaveCancellationTaskMetadata(ctx,scopeIds),
    ()=>pendingResignationTaskMetadata(ctx,scopeIds),
    ()=>pendingReviewTaskMetadata(ctx,'manager',scopeIds),
    ()=>pendingReviewTaskMetadata(ctx,'hr',scopeIds),
  ]);
}

type TaskSourceOptions={noticeAcknowledgements?:boolean;preview?:true;countOnly?:true;deferClaimPreview?:true};
async function loadCommonTaskSources(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,
  options:TaskSourceOptions){
  // Each owner proves actual current assignment without selecting its private decision workspace.
  // A platform role or broad read permission alone is not an actionable task assignment.
  return settleReadGroup([
    ()=>pendingLeaveTaskMetadata(ctx,scopeIds),()=>loadDecisionHeaders(ctx,scopeIds,options.preview),
    ()=>listPendingReplacementLeaveTasks(ctx,{companyIds:scopeIds}),
    ()=>modules.attendance?pendingAttendanceTaskMetadata(ctx,scopeIds):Promise.resolve([]),
    ()=>pendingProfileTaskMetadata(ctx,scopeIds),
    ()=>options.noticeAcknowledgements===false?Promise.resolve([]):pendingNoticeAcknowledgementTasks(ctx),
    ()=>settleReadGroup(PACK_TASK_SOURCES.map(source=>()=>modules[source.module]?source.load(ctx,scopeIds):Promise.resolve([]))),
  ]);
}

/** loadCommonTaskSources(ctx, scopeIds, modules, options) from the account task statement, for a preview: each owner
 * whose section the statement answered for this same read takes that answer; every other owner reads exactly as
 * loadCommonTaskSources reads it. */
async function loadBundledCommonTaskSources(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,options:TaskSourceOptions,
  bundle:Promise<AccountTaskBundle|null>):CommonTaskSources{
  const read=await bundle,notices=options.noticeAcknowledgements!==false;
  if(!read||!options.preview||!sameRead(read.read,{companyIds:scopeIds,personal:false,notices}))return loadCommonTaskSources(ctx,scopeIds,modules,options);
  const same=(module:keyof InboxModules)=>read.modules[module]===modules[module];
  const own=<T,>(value:T|null,owner:()=>Promise<T>)=>()=>value!==null?Promise.resolve(value):owner();
  return settleReadGroup([
    own(read.leave,()=>pendingLeaveTaskMetadata(ctx,scopeIds)),()=>loadDecisionHeaders(ctx,scopeIds,true,read),
    own(read.replacement,()=>listPendingReplacementLeaveTasks(ctx,{companyIds:scopeIds})),
    own(same('attendance')?read.attendance:null,()=>modules.attendance?pendingAttendanceTaskMetadata(ctx,scopeIds):Promise.resolve([])),
    // Profile candidates from the statement still pass the owner's locked decision transaction.
    ()=>read.profile!==null?Promise.resolve(read.profile):read.profileCandidates?pendingProfileTasksFromCandidates(ctx,read.profileCandidates):pendingProfileTaskMetadata(ctx,scopeIds),
    own(notices?read.notices:[],()=>pendingNoticeAcknowledgementTasks(ctx)),
    ()=>settleReadGroup(PACK_TASK_SOURCES.map(source=>own(same(source.module)?read[source.module]:null,
      ()=>modules[source.module]?source.load(ctx,scopeIds):Promise.resolve([])))),
  ]);
}
/** loadClaimTaskSource(ctx, scopeIds, modules, options) from the same statement: its preview, or for a count-only read
 * (countOnly, deferClaimPreview) the same exact total with no rows, as countPendingClaimTasks answers it. */
async function loadBundledClaimTaskSource(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,options:TaskSourceOptions,
  bundle:Promise<AccountTaskBundle|null>):ClaimTaskSource{
  const read=await bundle;
  if(!read?.claims||read.modules.claims!==modules.claims||!options.preview
   ||!sameRead(read.read,{companyIds:scopeIds,personal:false,notices:read.read.notices}))return loadClaimTaskSource(ctx,scopeIds,modules,options);
  return options.countOnly||options.deferClaimPreview?{items:[],total:read.claims.total}:read.claims;
}

type CommonTaskSources=ReturnType<typeof loadCommonTaskSources>;
type ClaimTaskSource=ReturnType<typeof loadClaimTaskSource>;
function loadClaimTaskSource(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,options:TaskSourceOptions){
  return modules.claims
    ? options.countOnly || options.deferClaimPreview ? countPendingClaimTasks(ctx,scopeIds).then(total=>({items:[],total}))
      : options.preview ? pendingClaimTaskSummary(ctx,scopeIds,25)
      : pendingClaimTaskMetadata(ctx,scopeIds).then(items=>({items,total:items.length}))
    : Promise.resolve({items:[],total:0});
}

export function countPendingTasks(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules):Promise<number>{
  return countTaskSources(ctx,scopeIds,modules);
}

async function countTaskSources(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,common?:CommonTaskSources,claimTotal?:()=>Promise<{total:number}>){
  const options={preview:true,countOnly:true} as const;
  const [[leave,decisionHeaders,replacement,attendance,profile,notices,packTasks],claims]=await settleReadGroup([
    ()=>common??loadCommonTaskSources(ctx,scopeIds,modules,options),
    ()=>claimTotal?.()??loadClaimTaskSource(ctx,scopeIds,modules,options),
  ]);
  return claims.total+leave.length+replacement.length+attendance.length+profile.length+notices.length+
    decisionHeaders.reduce((total,rows)=>total+rows.length,0)+packTasks.reduce((total,rows)=>total+rows.length,0);
}

/** Reuse the live account-wide preview sources within one Home response. The bounded Claims preview
 * already reads the exact total, so the count shares that one read instead of repeating its subject,
 * authority and count statements. Only a failed preview pays for the separate count owner, so a
 * preview failure still cannot turn the exact count into a failure. */
export function createAccountTaskPreviewRead(ctx:SessionContext,modules:InboxModules,bundle?:Promise<AccountTaskBundle|null>){
  const options={preview:true} as const;
  let pending:CommonTaskSources|undefined,claimPreview:ClaimTaskSource|undefined;
  // With the account task statement, every owner it answered costs no further statement (core/account-task-bundle.ts).
  const common=()=>pending??=bundle?loadBundledCommonTaskSources(ctx,undefined,modules,options,bundle):loadCommonTaskSources(ctx,undefined,modules,options);
  const preview=()=>claimPreview??=bundle?loadBundledClaimTaskSource(ctx,undefined,modules,options,bundle):loadClaimTaskSource(ctx,undefined,modules,options);
  const exactClaimTotal=async()=>{
    try{return await preview();}
    catch{return loadClaimTaskSource(ctx,undefined,modules,{preview:true,countOnly:true});}
  };
  return {
    count:()=>countTaskSources(ctx,undefined,modules,common(),exactClaimTotal),
    summary:()=>loadPendingTasks(ctx,undefined,modules,options,common(),preview()),
  };
}

const projectTasks = (rows:readonly Pick<AssignedApprovalMetadata,'id'|'employee'|'createdAt'>[],kind:AssignedApprovalKind):PendingTaskItem[] =>
  rows.map(row=>({id:row.id,kind,subjectName:row.employee,createdAt:row.createdAt instanceof Date?row.createdAt.toISOString():new Date(row.createdAt).toISOString(),linkPath:assignedApprovalHref({kind,id:row.id})}));

export async function pendingBellClaimPreview(ctx:SessionContext,scopeIds:string[]){
  const {items,total}=await pendingClaimTaskSummary(ctx,scopeIds);
  return {items:projectTasks(items,'claim'),total};
}

async function loadPendingTasks(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,
  options:TaskSourceOptions,common?:CommonTaskSources,claimPreview?:ClaimTaskSource):Promise<InboxResult<InboxTaskItem>>{
  const [[leave,[cancellations,resignations,managerReviews,hrReviews],replacement,attendance,profile,noticeAcknowledgements,packTaskLists],claimResult]=
    await settleReadGroup([
      ()=>common??loadCommonTaskSources(ctx,scopeIds,modules,options),
      ()=>claimPreview??loadClaimTaskSource(ctx,scopeIds,modules,options),
    ]);
  const packTasks:PackTaskItem[]=packTaskLists.flat();
  const iso=(value:Date|string)=>value instanceof Date?value.toISOString():new Date(value).toISOString();
  const items:PendingTaskItem[]=[
    ...noticeAcknowledgements.map(row=>({id:`${row.noticeId}:${row.employmentId}:${row.contentVersion}`,kind:'noticeAcknowledgement' as const,subjectName:row.title,createdAt:iso(row.sourceUpdatedAt),linkPath:`/notices/${row.noticeId}?employmentId=${row.employmentId}`})),
    ...projectTasks(leave,'leave'),
    ...projectTasks(cancellations,'leaveCancellation'),
    ...projectTasks(replacement,'replacementLeave'),
    ...projectTasks(attendance,'attendance'),
    ...profile.map(row=>({id:row.id,kind:'profile' as const,subjectName:row.employee,createdAt:iso(row.createdAt),linkPath:`/admin/personnel/profile-changes?assigned=1&requestId=${row.id}#request-${row.id}`})),
    ...projectTasks(claimResult.items,'claim'),...projectTasks(resignations,'resignation'),
    ...projectTasks(managerReviews,'managerReview'),...projectTasks(hrReviews,'hrReview'),
    ...packTasks.map(({id,kind,subjectName,createdAt,linkPath})=>({id,kind,subjectName,createdAt,linkPath})),
  ];
  items.sort(inboxOrder);
  const omittedClaims=Math.max(0,claimResult.total-claimResult.items.length);
  // No recruitment provider runs here (PACK_TASK_SOURCES has none; withRecruitmentTasks adds them when asked).
  return {items:items as InboxTaskItem[],claimTotal:claimResult.total,total:items.length+omittedClaims,
    approvalCount:items.filter(task=>task.linkPath.split(/[?#]/,1)[0]==='/approvals').length+omittedClaims};
}

/** The inbox's one order: newest first, then kind, then id. */
export const inboxOrder=(a:Pick<PendingTaskItem,'createdAt'|'kind'|'id'>,b:Pick<PendingTaskItem,'createdAt'|'kind'|'id'>)=>
  a.createdAt<b.createdAt?1:a.createdAt>b.createdAt?-1:a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id);

const RECRUITMENT_KINDS:ReadonlySet<string>=new Set<string>(RECRUITMENT_TASK_KINDS);
/** A list without the recruitment kinds: what Home and the AI Centre launcher count (D-034). */
export function withoutRecruitmentTasks<T extends {kind:string}>(items:readonly T[]):T[]{
  return items.filter(item=>!RECRUITMENT_KINDS.has(item.kind));
}

/**
 * My tasks (app/tasks/page.tsx): the inbox as that page has always read it (every company), plus — when the caller says
 * Recruitment is on — the recruitment to-dos for the SAME company selection the root layout gives the bell, so the
 * sidebar's My tasks badge (the bell's count) and the page list the same recruitment items. One provider call, the
 * inbox's order.
 */
export async function listMyTasks(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModulesWithRecruitment):Promise<PendingTaskItem[]>{
  const {recruitment,...rest}=modules;
  const [inbox,recruitmentTasks]=await Promise.all([listPendingTasks(ctx,undefined,rest),recruitment?pendingRecruitmentTasks(ctx,scopeIds):Promise.resolve([])]);
  return [...inbox,...recruitmentTasks].sort(inboxOrder);
}
/** My tasks' page summary: pendingTaskSummary for every company (as the page reads it) with listMyTasks' recruitment to-dos. */
export function myTaskSummary(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModulesWithRecruitment):Promise<InboxResult>{
  const {recruitment,...rest}=modules;
  return withRecruitmentTasks(ctx,scopeIds,recruitment,pendingTaskSummary(ctx,undefined,rest));
}

export async function pendingApprovalsCount(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  modules: InboxModules,
): Promise<number> {
  return (await listPendingTasks(ctx, scopeIds, modules,{noticeAcknowledgements:false})).length;
}
