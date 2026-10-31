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
 */
import {assignedApprovalHref,type AssignedApprovalKind} from '../lib/assigned-approval-focus';
import type {SessionContext} from '../db/client';
import type {AssignedApprovalMetadata} from '../lib/assigned-work';
import {pendingLeaveTaskMetadata,pendingLeaveCancellationTaskMetadata,listPendingReplacementLeaveTasks} from '../packs/leave/service';
import {pendingClaimTaskMetadata} from '../packs/claims/service';
import {pendingAttendanceTaskMetadata} from '../packs/attendance/service';
import {pendingProfileTaskMetadata} from './profile';
import {pendingResignationTaskMetadata} from './offboarding';
import {pendingNoticeAcknowledgementTasks} from './notice';
import {pendingReviewTaskMetadata} from './employment-review';
import {pendingPerformanceTasks} from '../packs/performance/service';
import {pendingRewardTasks} from '../packs/rewards/service';
import type {PackTaskItem,PackTaskKind,PackTaskProvider} from '../lib/assigned-work';

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
 * `app/(app)/layout.tsx` — the ROOT layout, on every authenticated render — where a throw 500s every route in
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

type ApprovalOnlyTaskItem=Omit<PendingTaskItem,'kind'>&{kind:Exclude<PendingTaskKind,'noticeAcknowledgement'>};
export function listPendingTasks(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,
  options:{noticeAcknowledgements:false}):Promise<ApprovalOnlyTaskItem[]>;
export function listPendingTasks(ctx:SessionContext,scopeIds:string[]|undefined,modules:InboxModules,
  options?:{noticeAcknowledgements?:boolean}):Promise<PendingTaskItem[]>;
export async function listPendingTasks(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  modules: InboxModules,
  options:{noticeAcknowledgements?:boolean}={},
): Promise<PendingTaskItem[]> {
  // Each owner proves actual current assignment without selecting its private decision workspace.
  // A platform role or broad read permission alone is not an actionable task assignment.
  const [leave,cancellations,replacement,attendance,profile,claims,resignations,managerReviews,hrReviews,noticeAcknowledgements,packTaskLists]=await Promise.all([
    pendingLeaveTaskMetadata(ctx,scopeIds),pendingLeaveCancellationTaskMetadata(ctx,scopeIds),
    listPendingReplacementLeaveTasks(ctx,{companyIds:scopeIds}),
    modules.attendance?pendingAttendanceTaskMetadata(ctx,scopeIds):Promise.resolve([]),
    pendingProfileTaskMetadata(ctx,scopeIds),
    modules.claims?pendingClaimTaskMetadata(ctx,scopeIds):Promise.resolve([]),
    pendingResignationTaskMetadata(ctx,scopeIds),pendingReviewTaskMetadata(ctx,'manager',scopeIds),pendingReviewTaskMetadata(ctx,'hr',scopeIds),
    options.noticeAcknowledgements===false?Promise.resolve([]):pendingNoticeAcknowledgementTasks(ctx),
    Promise.all(PACK_TASK_SOURCES.map(source=>modules[source.module]?source.load(ctx,scopeIds):Promise.resolve([]))),
  ]);
  const packTasks:PackTaskItem[]=packTaskLists.flat();
  const iso=(value:Date|string)=>value instanceof Date?value.toISOString():new Date(value).toISOString();
  const project=(rows:readonly Pick<AssignedApprovalMetadata,'id'|'employee'|'createdAt'>[],kind:AssignedApprovalKind):PendingTaskItem[]=>
    rows.map(row=>({id:row.id,kind,subjectName:row.employee,createdAt:iso(row.createdAt),linkPath:assignedApprovalHref({kind,id:row.id})}));
  const items:PendingTaskItem[]=[
    ...noticeAcknowledgements.map(row=>({id:`${row.noticeId}:${row.employmentId}:${row.contentVersion}`,kind:'noticeAcknowledgement' as const,subjectName:row.title,createdAt:iso(row.sourceUpdatedAt),linkPath:`/notices/${row.noticeId}?employmentId=${row.employmentId}`})),
    ...project(leave,'leave'),
    ...project(cancellations,'leaveCancellation'),
    ...project(replacement,'replacementLeave'),
    ...project(attendance,'attendance'),
    ...profile.map(row=>({id:row.id,kind:'profile' as const,subjectName:row.employee,createdAt:iso(row.createdAt),linkPath:`/admin/personnel/profile-changes?assigned=1&requestId=${row.id}#request-${row.id}`})),
    ...project(claims,'claim'),...project(resignations,'resignation'),
    ...project(managerReviews,'managerReview'),...project(hrReviews,'hrReview'),
    ...packTasks.map(({id,kind,subjectName,createdAt,linkPath})=>({id,kind,subjectName,createdAt,linkPath})),
  ];
  return items.sort((a,b)=>a.createdAt<b.createdAt?1:a.createdAt>b.createdAt?-1:a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
}

export async function pendingApprovalsCount(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  modules: InboxModules,
): Promise<number> {
  return (await listPendingTasks(ctx, scopeIds, modules,{noticeAcknowledgements:false})).length;
}
