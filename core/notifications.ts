import {createNotificationRegistry,EMPLOYEE_LOOP_DIGEST_EVENT,type NotificationRecipientReaders,type EventRef} from './notification-registry';
export {renderRewardRouted} from './notification-registry';
import {probationNotificationRecipientsTx} from '../packs/probation/service';
import {contractNotificationRecipientsTx} from '../packs/contracts/service';
import {currentFollowupTargetsTx} from './automatic-followups';
import type { Tx as AiReadTx } from '../db/client';
import { withCanonicalAiReadTx } from './ai-read-transaction';
import { assessmentReviewTaskRecipientsTx,assessmentReminderRecipientsTx } from '../packs/performance/service';
import { rewardConfigChangeRecipients,rewardUploadCheckerRecipients,rewardAccessSuspensionEventRecipients,rewardNotificationRecipients,rewardPoolNotificationRecipients,rewardPreparationNotificationRecipients } from '../packs/rewards/notification-recipients';
/**
 * Notification engine (ADR-0034) — 34-2 registry + dispatch + reads. A sweep reads new domain events after a
 * per-tenant cursor and turns the mapped ones into recipient-scoped notifications. Gated by the per-tenant
 * billable `notifications` MODULE (`enabled()` below ⇒ `isModuleEnabled(ctx, 'notifications')`, ADR-0077
 * slice 3; off ⇒ dispatch is a no-op). It is NOT gated by `process.env.NOTIFICATIONS_ENABLED` — that was the
 * pre-slice-3 gate and no application code reads it any more. v1 producers notify the event's SUBJECT (the
 * affected employee); approver-facing events (e.g. leave-request.submitted → the manager) need a
 * reporting-graph resolver and are deferred. A notification is a derived projection with its own table acting
 * as its audit, so dispatch does NOT append a DomainEvent (per CLAUDE.md — an event storm + a derivation loop).
 *
 * Delivery: the in-app bell always receives mapped notifications. Workflow email is conditional on the
 * tenant's category policy, explicit recipient consent and the active managed SMTP relay. The dispatcher
 * queues routing metadata only; the private service receives no frozen HR title/body. The delivery worker
 * resolves the SAME registry again before leasing a job. SMTP acceptance is not human receipt.
 * See ADR-0034 §7 and test/r292-notification-channel-truth.test.ts for the copy/transport agreement.

 */
import { randomUUID } from 'node:crypto';
import { notificationEmailCategory } from '../lib/notification-email-model';
import {assertNotificationSweepConnection,noticeNotificationRecipientsTx,noticeSnapshotIdsTx,type NoticeRecipientReader,type NoticeEventReader,probationSweepRecipientsForTx,type NoticeSweepAccess,type NotificationSweepConnection} from './notice-projection';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  appUser,
  attendanceCorrection,
  claimRequest,
  domainEvent,
  notificationEventProcessing,
  employment,
  employmentReview,
  leaveApprovalStep,
  leaveRequest,
  notification,
  notificationCursor,
  payslip,
  peerFeedbackRequest,
  replacementLeaveRequest,
  reportingLine,
  roleAssignment,
  type NotificationSeverity,
} from '../db/schema';
import { resolveSubjectHead } from './leave';
import { sanitizeApprovalLevels } from './leave-approval-policy';
import { isModuleEnabled } from './entitlements';

/** All HR-admin employments in the same company as `employmentId` (0110, employment-review fan-out).
 *  Resolves via role_assignment (hr_admin/super_admin) → app_user → person → that company's employment.
 *  super_admin grants are group-wide; an hr_admin grant may be group-wide (company_id null) or scoped.
 *
 *  Switched-off logins are excluded (0279). A notification row
 *  OUTLIVES the block and is not re-authorized when it is read:
 *    • `notification_recipient_rls` (0078) is PERSON-scoped and ROLE-BLIND — it matches on
 *      app.is_self_person(employment.person_id) and asks nothing about hr_admin;
 *    • the title/body are FROZEN TEXT about ANOTHER employee, rendered once at dispatch and stored, so the
 *      HR record's own RLS never gets a second say at read time;
 *    • app.login_blocked() is reversible in BOTH directions — an archived user can be restored, and a
 *      person whose employments all ended is unblocked again by a rehire into a new open employment.
 *  Without this filter, an admin who had lost access would silently accrue a backlog of HR notices about
 *  other people that becomes readable in full the moment the login comes back — and readable then whether
 *  or not the person still holds the grant that justified them. Filtering at RECIPIENT RESOLUTION is what
 *  stops the backlog existing. app.login_blocked() is the same predicate the auth path enforces.
 *
 *  PER-SITE DECISION, do not generalise: the actor-attribution and creator-filter reads (core/read.ts
 *  ~2496/2558/2611/2657, core/payroll-view.ts ~262/325) are deliberately NOT filtered. Showing an
 *  archived user's name as the author of a past action is CORRECT; filtering there would blank out
 *  history. Only recipient resolution — where a switched-off login would receive something new — is
 *  filtered. */
export async function hrAdminsForCompany(tx: Tx, employmentId: string): Promise<string[]> {
  const [emp] = await tx
    .select({ companyId: employment.companyId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) return [];
  const rows = await tx
    .select({ employmentId: employment.id })
    .from(roleAssignment)
    .innerJoin(appUser, eq(appUser.id, roleAssignment.appUserId))
    .innerJoin(employment, eq(employment.personId, appUser.personId))
    .where(
      and(
        sql`${roleAssignment.role} in ('hr_admin','super_admin')`,
        eq(employment.companyId, emp.companyId),
        // group-wide grant (null company) OR scoped to this company
        or(isNull(roleAssignment.companyId), eq(roleAssignment.companyId, emp.companyId)),
        // archived, or every employment ended — see the header note on why only recipients are filtered
        sql`not app.login_blocked(${appUser.id})`,
      ),
    );
  return [...new Set(rows.map((r) => r.employmentId))];
}

/** Global Delegation (Phase 1) — the stand-in (delegate) of a delegation row, resolved off the
 *  reporting_line manager side by the row id (the event's aggregateId). Empty when the row is gone. */
export async function delegateRecipient(tx: Tx, reportingLineId: string): Promise<string[]> {
  const [row] = await tx
    .select({ delegate: reportingLine.managerEmploymentId })
    .from(reportingLine)
    .where(eq(reportingLine.id, reportingLineId))
    .limit(1);
  return row?.delegate ? [row.delegate] : [];
}

/** R51 722904dc — the employments holding a leave approval LEVEL KIND for `subjectEmploymentId`, used by
 *  the escalation fan-out. Assembly of existing snippets, not new logic:
 *  - direct_manager uses THE CHAIN'S reporting-line predicate (generateApprovalSteps: administrative,
 *    validFrom <= current_date, validTo null-or-future). This deliberately differs from the self-cancelled
 *    resolver above (validTo IS NULL AND supersededAt IS NULL, no validFrom check) — escalation must agree
 *    with whoever the CHAIN says the approver is. That divergence between the two existing predicates is
 *    pre-existing and NOT unified here.
 *  - department_head / business_unit_head reuse resolveSubjectHead (core/leave.ts) — never a second copy.
 *  - hr_admin / hr_manager / custom_role resolve to HR authority (hrAdminsForCompany), matching
 *    assertCanDecideLeaveStep's decision-time gates.
 *  - payroll is the role_assignment payroll_partner check from assertCanDecideLeaveStep, lifted here. */
/** Active stand-ins for exactly these current approvers; the SQL owner checks task, company and window. */
export async function withApprovalDelegatesTx(tx:Tx,subjectEmploymentId:string,module:string,task:string,approvers:string[]):Promise<string[]>{
 if(!approvers.length)return [];
 const rows=await tx.execute<{id:string}>(sql`select app.active_delegate_employments(${subjectEmploymentId}::uuid,${module},${task},ARRAY[${sql.join(approvers.map(id=>sql`${id}::uuid`),sql`, `)}]) as id`);
 return [...new Set([...approvers,...rows.map(row=>row.id)])].filter(id=>id!==subjectEmploymentId);
}

export async function approverEmploymentsForKind(
  tx: Tx,
  subjectEmploymentId: string,
  kind: string,
  /** r293 phase 3 — the step's own named approver, for FIXED kinds. Read off the SNAPSHOT row by the
   *  caller, never from the template: an escalation must chase whoever the request was actually routed
   *  to, not whoever the template names today. */
  approverEmploymentId?: string | null,
): Promise<string[]> {
  switch (kind) {
    // r293 phase 3 — a named approver IS the recipient; there is nothing to resolve.
    case 'specific_employee':
      return approverEmploymentId ? [approverEmploymentId] : [];
    case 'manager_manager': {
      // r293 phase 2 — the second hop, resolved with THE CHAIN'S predicate (the same one the
      // direct_manager branch below uses), so escalation agrees with whoever the chain says approves.
      const [mgr] = await tx
        .select({ id: reportingLine.managerEmploymentId })
        .from(reportingLine)
        .where(
          and(
            eq(reportingLine.subordinateEmploymentId, subjectEmploymentId),
            eq(reportingLine.lineType, 'administrative'),
            lte(reportingLine.validFrom, sql`current_date`),
            or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
          ),
        )
        .limit(1);
      if (!mgr?.id) return [];
      const rows = await tx
        .select({ id: reportingLine.managerEmploymentId })
        .from(reportingLine)
        .where(
          and(
            eq(reportingLine.subordinateEmploymentId, mgr.id),
            eq(reportingLine.lineType, 'administrative'),
            lte(reportingLine.validFrom, sql`current_date`),
            or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
          ),
        );
      // Never chase the requester: a two-person cycle would otherwise notify the person who raised it.
      return [...new Set(rows.map((r) => r.id))].filter((id) => id !== subjectEmploymentId);
    }
    case 'direct_manager': {
      // WP13: a superseded (corrected or replaced) line is not current authority. assertCanDecide
      // (core/approvals.ts) refuses its manager, and so does a leave direct_manager step, which decides through
      // assertCanDecide; chasing that person would ask someone who cannot act.
      const rows = await tx
        .select({ id: reportingLine.managerEmploymentId })
        .from(reportingLine)
        .where(
          and(
            eq(reportingLine.subordinateEmploymentId, subjectEmploymentId),
            eq(reportingLine.lineType, 'administrative'),
            lte(reportingLine.validFrom, sql`current_date`),
            or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
            isNull(reportingLine.supersededAt),
          ),
        );
      return [...new Set(rows.map((r) => r.id))];
    }
    case 'department_head':
    case 'business_unit_head': {
      const head = await resolveSubjectHead(tx, subjectEmploymentId, kind);
      return head ? [head] : [];
    }
    case 'hr_admin':
    case 'hr_manager':
    case 'custom_role':
      return hrAdminsForCompany(tx, subjectEmploymentId);
    case 'payroll': {
      const [emp] = await tx
        .select({ companyId: employment.companyId })
        .from(employment)
        .where(eq(employment.id, subjectEmploymentId))
        .limit(1);
      if (!emp) return [];
      const rows = await tx
        .select({ employmentId: employment.id })
        .from(roleAssignment)
        .innerJoin(appUser, eq(appUser.id, roleAssignment.appUserId))
        .innerJoin(employment, eq(employment.personId, appUser.personId))
        .where(
          and(
            eq(roleAssignment.role, 'payroll_partner'),
            eq(employment.companyId, emp.companyId),
            or(isNull(roleAssignment.companyId), eq(roleAssignment.companyId, emp.companyId)),
            sql`not app.login_blocked(${appUser.id})`,
          ),
        );
      return [...new Set(rows.map((r) => r.employmentId))];
    }
    default:
      return [];
  }
}

/** WP13 — who can decide a chased approval NOW, re-read at dispatch. Claims and replacement leave follow
 *  assertCanDecide (the subject's administrative manager, else the company's HR admins); an attendance request
 *  with a frozen workflow chases the current stage's effective approvers who have not yet decided, as the
 *  workflow resolves them. Returns null when the item is no longer pending at `stage`. Active matching stand-ins
 *  are chased only where the native route supports delegation; frozen v3/v4 participants remain exact. */
export async function currentApproverEmploymentsTx(tx: Tx, source: string, itemId: string, subjectEmploymentId: string, stage: string): Promise<string[] | null> {
  let out: string[] = [];
  if (source === 'claim' || source === 'replacement_leave') {
    const [row] = source === 'claim'
      ? await tx.select({ status: claimRequest.status, employmentId: claimRequest.employmentId }).from(claimRequest).where(eq(claimRequest.id, itemId)).limit(1)
      : await tx.select({ status: replacementLeaveRequest.status, employmentId: replacementLeaveRequest.employmentId }).from(replacementLeaveRequest).where(eq(replacementLeaveRequest.id, itemId)).limit(1);
    if (!row || row.status !== 'pending' || row.employmentId !== subjectEmploymentId || stage !== 'pending') return null;
    out = await withApprovalDelegatesTx(tx,subjectEmploymentId,source==='claim'?'claims':'leave',source==='claim'?'claims.claim':'leave.replacement',await approverEmploymentsForKind(tx, subjectEmploymentId, 'direct_manager'));
  } else if (source === 'attendance_correction') {
    const [row] = await tx.select({ status: attendanceCorrection.status, employmentId: attendanceCorrection.employmentId })
      .from(attendanceCorrection).where(eq(attendanceCorrection.id, itemId)).limit(1);
    if (!row || row.status !== 'pending' || row.employmentId !== subjectEmploymentId) return null;
    // Loaded on use: the attendance workflow owner is large and this registry is imported widely.
    const { attendanceWorkflowForTx } = await import('../packs/attendance/service');
    const flow = await attendanceWorkflowForTx(tx, itemId);
    // The chased stage key: level and participant decisions recorded at it (0697 agent_overdue_approvals).
    const key = flow ? `${flow.currentStage}.${flow.participantDecisions.filter((d) => d.stageIndex === flow.currentStage).length}` : '0.0';
    if (key !== stage) return null;
    const approver = async (a: { kind: string; employmentId?: string | null },delegatable=false) => {
      if (a.kind === 'hr_admin') out.push(...(await hrAdminsForCompany(tx, subjectEmploymentId)));
      else if (a.kind === 'direct_manager'&&delegatable) {
        const assigned=a.employmentId?[a.employmentId]:await approverEmploymentsForKind(tx,subjectEmploymentId,'direct_manager');
        out.push(...await withApprovalDelegatesTx(tx,subjectEmploymentId,'attendance','attendance.correction',assigned));
      } else if (a.employmentId) out.push(a.employmentId);
      else if (a.kind === 'direct_manager') out.push(...(await approverEmploymentsForKind(tx, subjectEmploymentId, 'direct_manager')));
    };
    if (!flow) out = await withApprovalDelegatesTx(tx,subjectEmploymentId,'attendance','attendance.correction',await approverEmploymentsForKind(tx, subjectEmploymentId, 'direct_manager'));
    else if (flow.routingVersion === 3 || flow.routingVersion === 4) {
      // Participant routes: only who can act NOW, by the workflow's own outstanding rule (a sequential level
      // has exactly one; 0697 app.attendance_chase_outstanding over 0592's attendance_workflow_v3_outstanding).
      const rows = await tx.execute<{ participant_kind: string; participant_employment_id: string | null }>(
        sql`select participant_kind, participant_employment_id from app.attendance_chase_outstanding(${itemId}::uuid)`);
      for (const r of Array.from(rows)) await approver({ kind: r.participant_kind, employmentId: r.participant_employment_id });
    } else {
      for (const a of flow.effectiveStages[flow.currentStage]?.approvers ?? []) await approver(a,true);
    }
  } else return null;
  // Never the requester; an item with nobody to decide it falls back to HR, so a chase never silently vanishes.
  out = out.filter((id) => id !== subjectEmploymentId);
  if (out.length === 0) out = (await hrAdminsForCompany(tx, subjectEmploymentId)).filter((id) => id !== subjectEmploymentId);
  return [...new Set(out)];
}

/** Notifications are a per-tenant module now (ADR-0077 slice 3), not a deployment flag. */
const enabled = (ctx: SessionContext) => isModuleEnabled(ctx, 'notifications');

const webNotificationRecipients:NotificationRecipientReaders<Tx>={
  probation:(tx,ev)=>probationNotificationRecipientsTx(tx,ev),
  contract:(tx,ev)=>contractNotificationRecipientsTx(tx,ev.aggregateId),
  onboardingDigest:async(tx,ev,payload)=>{
      if(typeof payload?.recipientUserId!=='string'||typeof payload?.caseId!=='string')return [];
      const result=await tx.execute(sql`select * from app.onboarding_mail_recipient(${payload.caseId}::uuid,${payload.recipientUserId}::uuid) as employment_id`);
      return (result as unknown as {employment_id:string}[]).map(row=>row.employment_id);
    },
  assessmentReminder:(tx,ev)=>assessmentReminderRecipientsTx(tx,ev.aggregateId),
  rewardSuspension:(tx,ev)=>rewardAccessSuspensionEventRecipients(tx,ev.id),
  rewardUploadChecker:(tx,event)=>rewardUploadCheckerRecipients(tx,event.aggregateId),
  rewardUploadReady:(tx,event)=>rewardNotificationRecipients(tx,event.aggregateId,'draft'),
  rewardRouted:(tx, ev, payload) => rewardNotificationRecipients(tx, ev.aggregateId, payload?.to),
  rewardPreparationReleased:(tx,event,payload)=>rewardPreparationNotificationRecipients(tx,event.aggregateId,payload?.to,true),
  rewardPreparationChanged:(tx,event,payload)=>rewardPreparationNotificationRecipients(tx,event.aggregateId,payload?.to,false),
  rewardPreparationInvalidated:(tx,event,payload)=>rewardPreparationNotificationRecipients(tx,event.aggregateId,payload?.to,false),
  rewardPoolChanged:(tx,event)=>rewardPoolNotificationRecipients(tx,event.aggregateId),
  rewardApproved:(tx, ev) => rewardNotificationRecipients(tx, ev.aggregateId, 'approved'),
  rewardConfigChanged:(tx,event)=>rewardConfigChangeRecipients(tx,event.aggregateId),
  leaveSubmitted:async (tx, ev) => {
      if (!ev.subjectEmploymentId) return [];
      const hr = await hrAdminsForCompany(tx, ev.subjectEmploymentId);
      const mgrs = await tx
        .select({ id: reportingLine.managerEmploymentId })
        .from(reportingLine)
        .where(
          and(
            eq(reportingLine.subordinateEmploymentId, ev.subjectEmploymentId),
            eq(reportingLine.lineType, 'administrative'),
            isNull(reportingLine.validTo),
            isNull(reportingLine.supersededAt),
          ),
        );
      const out = [...mgrs.map((m) => m.id), ...hr].filter((id) => id !== ev.subjectEmploymentId);
      return [...new Set(out)];
    },
  leaveCancellationSubmitted:async (tx, ev, payload) => {
      if (payload?.notify !== true || !ev.subjectEmploymentId) return [];
      // WHO APPROVES: the first level of the cancellation's copied chain — resolved through the SAME per-kind
      // resolver the escalation fan-out uses, alternates included — or, for a single-level chain (no steps),
      // the subject's current administrative manager, who decides a single-level cancellation today.
      const first = (payload.firstStep ?? null) as { kind?: unknown; employmentId?: unknown; alternates?: unknown } | null;
      let approvers: string[] = [];
      if (first && typeof first.kind === 'string') {
        approvers = await approverEmploymentsForKind(
          tx,
          ev.subjectEmploymentId,
          first.kind,
          typeof first.employmentId === 'string' ? first.employmentId : null,
        );
        for (const alt of sanitizeApprovalLevels(Array.isArray(first.alternates) ? first.alternates : [])) {
          approvers = approvers.concat(
            await approverEmploymentsForKind(tx, ev.subjectEmploymentId, alt.kind, alt.employmentId),
          );
        }
      } else {
        approvers = await approverEmploymentsForKind(tx, ev.subjectEmploymentId, 'direct_manager');
      }
      approvers=await withApprovalDelegatesTx(tx,ev.subjectEmploymentId,'leave','leave.cancellation',approvers);
      const hr = await hrAdminsForCompany(tx, ev.subjectEmploymentId);
      // Never the employee who asked (an HR admin or a manager cancelling their own leave).
      return [...new Set([...approvers, ...hr])].filter((id) => id !== ev.subjectEmploymentId);
    },
  overtimeSubmitted:async (tx, ev, payload) => {
      if (!ev.subjectEmploymentId || payload?.requestedOtMinutes == null) return [];
      let out = await approverEmploymentsForKind(tx, ev.subjectEmploymentId, 'direct_manager');
      out=await withApprovalDelegatesTx(tx,ev.subjectEmploymentId,'attendance','attendance.correction',out);
      if (out.length === 0) out = await hrAdminsForCompany(tx, ev.subjectEmploymentId);
      // Never notify the requester about their own request (an employee who is their own manager, or an
      // HR admin filing for themselves).
      return [...new Set(out)].filter((id) => id !== ev.subjectEmploymentId);
    },
  readinessNudge:async (tx, ev, payload) => {
      if (!ev.subjectEmploymentId) return [];
      if (payload?.audience === 'employee') return [ev.subjectEmploymentId];
      if (payload?.audience === 'hr') return hrAdminsForCompany(tx, ev.subjectEmploymentId);
      return [];
    },
  peerFeedback:async(tx,ev)=>{
      const rows=await tx.select({id:employment.id}).from(peerFeedbackRequest).innerJoin(employment,eq(employment.id,peerFeedbackRequest.peerEmploymentId)).innerJoin(appUser,and(eq(appUser.personId,employment.personId),eq(appUser.tenantId,employment.tenantId))).where(and(eq(peerFeedbackRequest.id,ev.aggregateId),eq(peerFeedbackRequest.status,'pending'),isNull(appUser.archivedAt),sql`not app.login_blocked(${appUser.id})`,sql`(${employment.terminatedOn} is null or ${employment.terminatedOn}>(now() at time zone 'Asia/Kuala_Lumpur')::date)`));return [...new Set(rows.map(r=>r.id))];
    },
  assessmentReviewTask:(tx,ev,phase)=>assessmentReviewTaskRecipientsTx(tx,ev.aggregateId,phase),
  assessmentKpiApproval:(tx,ev,payload)=>payload?.phase==='setting'||payload?.phase==='results'?assessmentReviewTaskRecipientsTx(tx,ev.aggregateId,payload.phase):Promise.resolve([]),
  legacyReviewStarted:async (tx, ev) => {
      const [rev] = await tx
        .select({ managerEmploymentId: employmentReview.managerEmploymentId, employmentId: employmentReview.employmentId })
        .from(employmentReview)
        .where(eq(employmentReview.id, ev.aggregateId))
        .limit(1);
      if (!rev) return [];
      const hr = await hrAdminsForCompany(tx, rev.employmentId);
      const out = [...hr];
      if (rev.managerEmploymentId) out.unshift(rev.managerEmploymentId);
      return [...new Set(out)];
    },
  legacyReviewEvaluated:async (tx, ev) => {
      const [rev] = await tx
        .select({ employmentId: employmentReview.employmentId })
        .from(employmentReview)
        .where(eq(employmentReview.id, ev.aggregateId))
        .limit(1);
      if (!rev) return [];
      return hrAdminsForCompany(tx, rev.employmentId);
    },
  legacyReviewDecidedLetter:async (tx, ev) => {
        const [rev] = await tx
          .select({ employmentId: employmentReview.employmentId })
          .from(employmentReview)
          .where(eq(employmentReview.id, ev.aggregateId))
          .limit(1);
        if (!rev) return [];
        return hrAdminsForCompany(tx, rev.employmentId);
      },
  legacyReviewReminder:async (tx, ev) => {
      const [rev] = await tx
        .select({ managerEmploymentId: employmentReview.managerEmploymentId, employmentId: employmentReview.employmentId })
        .from(employmentReview)
        .where(eq(employmentReview.id, ev.aggregateId))
        .limit(1);
      if (!rev) return [];
      const hr = await hrAdminsForCompany(tx, rev.employmentId);
      const out = [...hr];
      if (rev.managerEmploymentId) out.unshift(rev.managerEmploymentId);
      return [...new Set(out)];
    },
  delegationStarted:(tx, ev) => delegateRecipient(tx, ev.aggregateId),
  delegationEnded:(tx, ev) => delegateRecipient(tx, ev.aggregateId),
  leaveEscalation:async (tx, ev, payload) => {
      const p = payload ?? {};
      const leaveRequestId = typeof p.leaveRequestId === 'string' ? p.leaveRequestId : null;
      const stepIndex = typeof p.stepIndex === 'number' ? p.stepIndex : null;
      if (!leaveRequestId || stepIndex == null || !ev.subjectEmploymentId) return [];
      // Freshness re-check: the step AND its parent request must still be pending.
      const [req] = await tx
        .select({ status: leaveRequest.status })
        .from(leaveRequest)
        .where(eq(leaveRequest.id, leaveRequestId))
        .limit(1);
      if (req?.status !== 'pending') return [];
      const [step] = await tx
        .select({ status: leaveApprovalStep.status })
        .from(leaveApprovalStep)
        .where(and(eq(leaveApprovalStep.leaveRequestId, leaveRequestId), eq(leaveApprovalStep.stepIndex, stepIndex)))
        .limit(1);
      if (step?.status !== 'pending') return [];
      // Fan-out: the snapshotted target kind (next chain level, or the configured role). A null target
      // (the stuck step was the LAST one) — or a branch that resolves to nobody (e.g. a department head
      // is unset) — falls back to the company's HR admins, so an escalation never silently disappears.
      const targetKind = typeof p.targetKind === 'string' ? p.targetKind : null;
      // r293 phase 3 — `targetEmploymentId` is the SNAPSHOT taken beside `targetKind` at sweep time, so a
      // fixed target chases the person the request was actually routed to. Null for every other kind.
      const targetEmploymentId = typeof p.targetEmploymentId === 'string' ? p.targetEmploymentId : null;
      let out = targetKind
        ? await approverEmploymentsForKind(tx, ev.subjectEmploymentId, targetKind, targetEmploymentId)
        : [];
      // r293 phase 4 — an ANY-ONE level is chased to every approver who could clear it, not only the one
      // the level is named after. Resolved through the SAME per-kind resolver, so an alternate's
      // recipients are found by the rule its kind is found by everywhere else.
      for (const alt of sanitizeApprovalLevels(Array.isArray(p.targetAlternates) ? p.targetAlternates : [])) {
        out = out.concat(await approverEmploymentsForKind(tx, ev.subjectEmploymentId, alt.kind, alt.employmentId));
      }
      out = out.filter((id) => id !== ev.subjectEmploymentId); // never chase the requester
      if (out.length === 0) {
        out = (await hrAdminsForCompany(tx, ev.subjectEmploymentId)).filter((id) => id !== ev.subjectEmploymentId);
      }
      return [...new Set(out)];
    },
  automaticReviewChase:async (tx, ev, payload) => {
      const stage = typeof payload?.stage === 'string' ? payload.stage : null;
      if (!ev.subjectEmploymentId || !stage) return [];
      const [rev] = await tx
        .select({ status: employmentReview.status, employmentId: employmentReview.employmentId, managerEmploymentId: employmentReview.managerEmploymentId })
        .from(employmentReview)
        .where(eq(employmentReview.id, ev.aggregateId))
        .limit(1);
      if (!rev || rev.status !== stage || rev.employmentId !== ev.subjectEmploymentId) return [];
      const subject = ev.subjectEmploymentId;
      let out = stage === 'pending_manager' && rev.managerEmploymentId ? [rev.managerEmploymentId] : [];
      out = out.filter((id) => id !== subject);
      if (out.length === 0) out = (await hrAdminsForCompany(tx, subject)).filter((id) => id !== subject);
      return [...new Set(out)];
    },
  missingClockFollowup:async(tx,ev,p)=>p?.source==='missing_clock'&&typeof p.stage==='string'&&ev.subjectEmploymentId?currentFollowupTargetsTx(tx,'missing_clock',ev.aggregateId,p.stage,ev.subjectEmploymentId):[],
  passportFollowup:async(tx,ev,p)=>p?.source==='passport_expiry'&&typeof p.stage==='string'&&ev.subjectEmploymentId?currentFollowupTargetsTx(tx,'passport_expiry',ev.aggregateId,p.stage,ev.subjectEmploymentId):[],
  lifecycleFollowup:async(tx,ev,p)=>p?.source==='lifecycle_step'&&typeof p.stage==='string'&&ev.subjectEmploymentId?currentFollowupTargetsTx(tx,'lifecycle_step',ev.aggregateId,p.stage,ev.subjectEmploymentId):[],
  // Projection and delivery both recheck ai_centre_event_allowed before invoking this port.
  employeeLoopDigest:async(_tx,ev)=>ev.id&&ev.subjectEmploymentId===ev.aggregateId?[ev.aggregateId]:[],
  noticePublished:async (tx, ev, payload,noticeReader) => {
      // The publisher's `notifyOnPublish` choice, snapshotted into the event. That checkbox reads "Notify
      // recipients when it is published" (`notices.fNotify`, components/notice/notice-form.tsx) — it is NOT
      // an unconditional email switch. Category permission and recipient consent still apply. Read from the PAYLOAD
      // rather than re-queried: switching the flag off after publication must not retroactively un-notify,
      // and re-reading the row would make it look as though it had.
      return noticeReader?noticeReader(ev.aggregateId):noticeNotificationRecipientsTx(tx,ev.aggregateId);
    },
  payrollClosed:async (tx, ev) => {
      const rows = await tx.select({ e: payslip.employmentId }).from(payslip).where(eq(payslip.batchId, ev.aggregateId));
      return [...new Set(rows.map((r) => r.e))];
    },
  approvalChase:source=>async(tx,ev,payload)=>{if(payload?.source!==source||typeof payload?.stage!=='string'||!ev.subjectEmploymentId)return [];return (await currentApproverEmploymentsTx(tx,source,ev.aggregateId,ev.subjectEmploymentId,payload.stage))??[];},
  // The creator's own current employment, only for the bulk job's recorded notice event (migration 5011).
  bulkJobInitiator:async(tx,ev)=>{
      if(!ev.id)return [];
      const rows=await tx.execute<{id:string}>(sql`select r as id from app.bulk_job_notice_recipients(${ev.id}::uuid) r`);
      return [...new Set(rows.map(row=>row.id))];
    },
};
const REGISTRY=createNotificationRegistry(webNotificationRecipients);

export type DispatchResult = { processed: number; created: number };

// Opportunistic page catch-up can skip a concurrent attempt before it borrows a pool connection.
const pageCatchUps = new Set<string>();

/** Complete global projection is owned by a fresh group administrator or the authenticated sweep.
 * A company-scoped web request cannot consume a partially visible global event stream. */
export async function dispatchNotifications(ctx:SessionContext,opts:{limit?:number;skipIfBusy?:boolean}={}):Promise<DispatchResult>{
  const allCategories=enabled(ctx);
  if(!allCategories&&!hasScopedReminders(ctx))return {processed:0,created:0};
  const catchUpKey = opts.skipIfBusy ? ctx.tenantId.toLowerCase() : undefined;
  if(catchUpKey !== undefined && pageCatchUps.has(catchUpKey))return {processed:0,created:0};
  if(catchUpKey !== undefined)pageCatchUps.add(catchUpKey);
  try{
    return await withTenant(ctx,async tx=>{
      if(allCategories){
        const [scope]=await tx.execute(sql`select app.principal_snapshot_current() AND app.is_group_admin() AS allowed`) as unknown as {allowed:boolean}[];
        if(!scope?.allowed)return {processed:0,created:0};
      }
      return projectNotificationsTx(tx,ctx,allCategories,projectionLimit(opts.limit),{skipIfBusy:opts.skipIfBusy});
    });
  }finally{
    if(catchUpKey !== undefined)pageCatchUps.delete(catchUpKey);
  }
}

/** Cron already holds this explicit owner connection. Keep projection and cursor in one transaction;
 * all registry reads and business writes are downgraded to APP before projection. */
export async function dispatchNotificationsFromSweep(ctx:SessionContext,connection:NotificationSweepConnection,opts:{limit?:number}={}):Promise<DispatchResult>{
  if(ctx.userId)throw Error('Notification sweep requires a maintenance context.');
  const allCategories=enabled(ctx);
  if(!allCategories&&!hasScopedReminders(ctx))return {processed:0,created:0};
  return connection.withTenant(ctx,async tx=>{
    const priorRole=await assertNotificationSweepConnection(tx);
    const [scope]=await tx.execute(sql`select app.is_group_admin() AS allowed`) as unknown as {allowed:boolean}[];
    if(!scope?.allowed)throw Error('Notification sweep requires the complete tenant scope.');
    return projectNotificationsTx(tx,ctx,allCategories,projectionLimit(opts.limit),{priorRole});
  });
}
function hasScopedReminders(ctx:SessionContext){return (ctx.entitlements?.scopedModules.notifications??[]).some(companyId=>isModuleEnabled(ctx,'notifications',companyId));}
function projectionLimit(value?:number){return Math.min(Math.max(value??1000,1),5000);}
async function projectNotificationsTx(
  tx:Tx,ctx:SessionContext,allCategories:boolean,limit:number,
  {priorRole,skipIfBusy}:{priorRole?:string;skipIfBusy?:boolean},
):Promise<DispatchResult>{
    const cursorKey=`notification-cursor:${ctx.tenantId}`;
    if(skipIfBusy){
      const [lock]=await tx.execute<{acquired:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${cursorKey},0)) as acquired`);
      if(!lock?.acquired)return {processed:0,created:0};
    }else{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${cursorKey},0))`);
    }
    const [cur] = await tx.select().from(notificationCursor).where(eq(notificationCursor.tenantId, ctx.tenantId)).limit(1);
    const consumer=allCategories?'notifications':'assessment-reminders';
    const rows = await tx
      .select({
        id: domainEvent.id,
        aggregateId: domainEvent.aggregateId,
        eventType: domainEvent.eventType,
        subjectEmploymentId: domainEvent.subjectEmploymentId,
        payload: domainEvent.payload,
        sequence: domainEvent.sequence,
      })
      .from(domainEvent)
      .innerJoin(notificationEventProcessing,and(eq(notificationEventProcessing.eventId,domainEvent.id),eq(notificationEventProcessing.tenantId,domainEvent.tenantId)))
      // Leave digest receipts pending for the sweep. Bell catch-up must not wait for its AI control guard.
      .where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(notificationEventProcessing.consumer,consumer),isNull(notificationEventProcessing.disposition),
        skipIfBusy?ne(domainEvent.eventType,EMPLOYEE_LOOP_DIGEST_EVENT):undefined))
      .orderBy(asc(notificationEventProcessing.eventSequence))
      .limit(limit);
    if (rows.length === 0) return { processed: 0, created: 0 };

    let noticeReader:NoticeRecipientReader|undefined;
    const existingProjections=new Set<string>();
    const projectionKey=(eventId:string,recipient:string,kind:string)=>JSON.stringify([eventId,recipient,kind]);
    if(priorRole!==undefined){
      const existing=await tx.select({eventId:notification.sourceEventId,recipient:notification.recipientEmploymentId,kind:notification.kind})
        .from(notification).where(and(eq(notification.tenantId,ctx.tenantId),inArray(notification.sourceEventId,rows.map(row=>row.id))));
      for(const prior of existing)if(prior.eventId&&prior.recipient)existingProjections.add(projectionKey(prior.eventId,prior.recipient,prior.kind));
      const audiences=new Map<string,string[]>();
      for(const ev of rows){
        if(ev.eventType==='notice.published'&&(ev.payload as Record<string,unknown>|null)?.notify===true&&!audiences.has(ev.aggregateId)){
          audiences.set(ev.aggregateId,await noticeSnapshotIdsTx(tx,ctx.tenantId,ev.aggregateId));
        }
      }
      noticeReader=async id=>{const ids=audiences.get(id);if(!ids)throw Error('Complete Notice projection snapshot is unavailable.');return ids;};
      // Every canonical resolver and notification/outbox write retains APP RLS. Only the bounded event
      // batch, immutable Notice snapshots and final cursor use this explicit maintenance connection.
      await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
    }

    let created = 0;
    const ignoredIds:string[]=[];
    for (const ev of rows) {
      const entry = REGISTRY[ev.eventType];
      if (!entry){ignoredIds.push(ev.id);continue;}
      if(!(await tx.execute<{allowed:boolean}>(sql`select app.ai_centre_event_allowed(${ev.id}::uuid) as allowed`))[0]?.allowed){ignoredIds.push(ev.id);continue;}
      if(await legacyProbationNotificationIsObsolete(tx,ev.eventType,ev.aggregateId)){ignoredIds.push(ev.id);continue;}
      if(ev.eventType==='reward-access.suspended'){
        const [account]=await tx.execute<{created:number}>(sql`select app.reward_access_project_account_suspension(${ev.id}::uuid) as created`);
        created+=account.created;
      }
      const evRef: EventRef = { id:ev.id,aggregateId: ev.aggregateId, subjectEmploymentId: ev.subjectEmploymentId };
      for (const spec of Array.isArray(entry) ? entry : [entry]) {
        // Recipients: a fan-out resolver (e.g. all payslips in a batch), else the event's single subject.
        const recipients = spec.recipients
          ? await spec.recipients(tx, evRef, (ev.payload as Record<string, unknown> | null) ?? null,noticeReader)
          : ev.subjectEmploymentId
            ? [ev.subjectEmploymentId]
            : [];
        if (recipients.length === 0) continue;
        const r = spec.render((ev.payload as Record<string, unknown> | null) ?? null, evRef);
        for (const recipient of recipients) {
          // A company-only reminder cursor never consumes other categories. Global dispatch may later
          // encounter the same event, so retain one projection per event/kind/recipient.
          if(spec.kind==='performance.reminder'){const [prior]=await tx.execute<{present:boolean}>(sql`select app.assessment_reminder_projected(${ev.id}::uuid,${recipient}::uuid) as present`);if(prior?.present)continue;}
          const key=projectionKey(ev.id,recipient,spec.kind);
          if(existingProjections.has(key))continue;
          if(priorRole===undefined){
            const [existing]=await tx.execute<{present:boolean}>(sql`select app.notification_projection_exists(${ev.id}::uuid,${recipient}::uuid,${spec.kind}) as present`);
            if(existing?.present)continue;
          }
          const notificationId = randomUUID();
          await tx.insert(notification).values({
            id: notificationId,
            tenantId: ctx.tenantId,
            recipientEmploymentId: recipient,
            kind: spec.kind,
            title: r.title,
            body: r.body,
            linkPath: r.linkPath,
            severity: r.severity,
            sourceEventId: ev.id,
          });
          if(spec.category!==null)await tx.execute(sql`select app.notification_email_enqueue(${notificationId}::uuid,${spec.category},${ev.sequence}::bigint)`);
          existingProjections.add(key);
          created += 1;
        }
      }
    }

    // On an error the transaction rolls back both writes and SET LOCAL ROLE. Do not attempt a role
    // restore inside a failed transaction and obscure the original error. Restore only on success.
    if(priorRole!==undefined)await tx.execute(sql`select set_config('role',${priorRole},true)`);
    const ignored=new Set(ignoredIds);
    for(const disposition of ['processed','ignored'] as const){
      const ids=rows.filter(row=>ignored.has(row.id)===(disposition==='ignored')).map(row=>row.id);
      if(ids.length){
        const completed=await tx.update(notificationEventProcessing).set({disposition,processedAt:sql`now()`})
          .where(and(eq(notificationEventProcessing.tenantId,ctx.tenantId),eq(notificationEventProcessing.consumer,consumer),inArray(notificationEventProcessing.eventId,ids)))
          .returning({id:notificationEventProcessing.eventId});
        if(completed.length!==ids.length)throw Error('Notification processing authority changed.');
      }
    }
    const last = rows[rows.length - 1];
    if (cur) {
      await tx
        .update(notificationCursor)
        .set({...(allCategories?{lastSequence:sql`greatest(${notificationCursor.lastSequence},${last.sequence})`}:{assessmentLastSequence:sql`greatest(${notificationCursor.assessmentLastSequence},${last.sequence})`}),updatedAt:sql`now()`})
        .where(eq(notificationCursor.tenantId, ctx.tenantId));
    } else {
      await tx.insert(notificationCursor).values({tenantId:ctx.tenantId,...(allCategories?{lastSequence:last.sequence}:{assessmentLastSequence:last.sequence})});
    }
    return { processed: rows.length, created };
}

/** Reauthorize queued mail with the same live recipient graph that created the in-app projection. */
async function legacyProbationNotificationIsObsolete(tx:Tx,eventType:string,reviewId:string):Promise<boolean>{if(!eventType.startsWith('employment-review.'))return false;const[row]=await tx.execute<{owned:boolean}>(sql`select app.probation_legacy_review_owned(${reviewId}::uuid) as owned`);return row?.owned===true;}

export async function notificationStillTargets(tx: Tx, eventId: string, kind: string, category: string, recipient: string,noticeReader?:NoticeRecipientReader,noticeEventReader?:NoticeEventReader,probationSweep?:NoticeSweepAccess): Promise<boolean> {
  if (!notificationEmailCategory.safeParse(category).success) return false;
  if(kind==='probation.notification'&&category==='review'&&probationSweep){
    return (await probationSweepRecipientsForTx(tx,probationSweep,eventId)).includes(recipient);
  }
  const [visible] = await tx.select({id:domainEvent.id,aggregateId:domainEvent.aggregateId,eventType:domainEvent.eventType,subjectEmploymentId:domainEvent.subjectEmploymentId,payload:domainEvent.payload})
    .from(domainEvent).where(and(eq(domainEvent.id,eventId),sql`${domainEvent.tenantId}=app.current_tenant_id()`)).limit(1);
  let ev:Awaited<ReturnType<NoticeEventReader>>=visible;
  if(!ev&&category==='notice'){
    if(!noticeEventReader)throw Error('Notice projection requires the complete authorized audience and source event.');
    ev=await noticeEventReader(eventId);
    if(!ev)throw Error('Notice source event is unavailable; retain the queued delivery for investigation.');
  }
  if (!ev) return false;
  if(!(await tx.execute<{allowed:boolean}>(sql`select app.ai_centre_event_allowed(${eventId}::uuid) as allowed`))[0]?.allowed)return false;
  if(await legacyProbationNotificationIsObsolete(tx,ev.eventType,ev.aggregateId))return false;
  const entry = REGISTRY[ev.eventType];
  if (!entry) return false;
  const ref: EventRef = {id:eventId,aggregateId:ev.aggregateId,subjectEmploymentId:ev.subjectEmploymentId};
  for (const spec of Array.isArray(entry) ? entry : [entry]) {
    if (spec.kind !== kind || spec.category !== category) continue;
    const recipients = spec.recipients ? await spec.recipients(tx,ref,(ev.payload as Record<string,unknown>|null)??null,noticeReader)
      : ev.subjectEmploymentId ? [ev.subjectEmploymentId] : [];
    if (recipients.includes(recipient)) return true;
  }
  return false;
}

/** Explicit Home delivery uses the same registry/render owner, inside the originating command's
 * transaction. A posted recipient/event cannot choose the projection target. No email is enqueued. */
export async function projectHomeGreetingInTx(tx:Tx,greetingId:string):Promise<void>{
 const [target]=await tx.execute<{source_event_id:string;recipient_employment_id:string}>(sql`SELECT * FROM app.home_greeting_projection_target(${greetingId}::uuid)`);
 if(!target)return; // Already committed nonce: SQL supplied no new projection admission.
 const spec=REGISTRY['employee-home.greeting.sent'];
 if(!spec||Array.isArray(spec)||spec.category!==null)throw Error('Greeting projection unavailable');
 const rendered=spec.render(null,{aggregateId:greetingId,subjectEmploymentId:target.recipient_employment_id});
 await tx.insert(notification).values({id:randomUUID(),tenantId:sql`app.current_tenant_id()`,recipientEmploymentId:target.recipient_employment_id,
  kind:spec.kind,title:rendered.title,body:rendered.body,linkPath:rendered.linkPath,severity:rendered.severity,sourceEventId:target.source_event_id});
}

// ─── recipient reads (RLS scopes every query to the caller's own notifications, across all the person's
// employments; pass employmentId only to narrow to one) ──────────────────────────────────────────────

/** Indexed candidate narrowing only. The notification table's unchanged RLS still adjudicates every
 * returned row. Resolve actual account ownership from the database, never a posted person/role or
 * an active-employment filter: old notifications across ended own employments remain reachable. */
async function notificationRecipientCandidatesTx(tx:Tx,ctx:SessionContext){
 const own=await tx.select({id:employment.id}).from(employment).innerJoin(appUser,
  and(eq(appUser.personId,employment.personId),eq(appUser.tenantId,employment.tenantId)))
  .where(and(eq(employment.tenantId,ctx.tenantId),eq(appUser.tenantId,ctx.tenantId),sql`${appUser.id}=app.current_user_id()`));
 return and(eq(notification.tenantId,ctx.tenantId),or(
  own.length?inArray(notification.recipientEmploymentId,own.map(row=>row.id)):sql`false`,
  eq(notification.recipientUserId,ctx.userId??'00000000-0000-0000-0000-000000000000'),
 ));
}

/** 3-tab bell (feedback 1514d366): `action` splits the severity-'action' task notices ("do something")
 *  from the informational rest — true ⇒ only action, false ⇒ only non-action, undefined ⇒ all (the
 *  pre-existing behaviour, so every current caller is unchanged). */
export function unreadNotificationCount(
  ctx: SessionContext,
  employmentId?: string,
  opts: { action?: boolean;letterCompanyIds?:string[] } = {}, existingTx?: AiReadTx
): Promise<number> {
  ctx = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  opts = { ...opts, letterCompanyIds:opts.letterCompanyIds?.slice() };


  return withCanonicalAiReadTx(ctx, existingTx, 'notifications', withTenant, async (tx) => {
    const recipients=await notificationRecipientCandidatesTx(tx,ctx);
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notification)
      .where(
        and(
          recipients,
          isNull(notification.readAt),
          employmentId ? or(eq(notification.recipientEmploymentId, employmentId),eq(notification.recipientUserId,ctx.userId??'00000000-0000-0000-0000-000000000000')) : undefined,
          opts.letterCompanyIds!==undefined?and(isNotNull(notification.recipientUserId),inArray(notification.companyId,opts.letterCompanyIds)):undefined,
          opts.action === true ? eq(notification.severity, 'action') : undefined,
          opts.action === false ? ne(notification.severity, 'action') : undefined,
        ),
      );
    return r?.n ?? 0;
  });
}

export type NotificationRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  linkPath: string | null;
  severity: NotificationSeverity;
  readAt: Date | null;
  createdAt: Date;
};

/** D5 (mobile M10) keyset position: the row's exact `created_at` as UTC text with microseconds (`cursorAt`
 *  from listNotificationsPage — a JS Date drops the microseconds and would skip or repeat rows) and its id. */
export type NotificationCursor = { at: string; id: string };
type NotificationFilter = { read?: boolean; action?: boolean; after?: NotificationCursor | null; ids?: readonly string[]; letterCompanyIds?: string[] };
const notificationColumns = {
  id: notification.id, kind: notification.kind, title: notification.title, body: notification.body, linkPath: notification.linkPath,
  severity: notification.severity, readAt: notification.readAt, createdAt: notification.createdAt,
};
/** The one where-builder behind every recipient read: alpha's recipient rule (an employment narrows to its
 *  rows PLUS the rows addressed to the caller's account — letter notices carry recipientUserId and no
 *  employment) and letter-company scoping, with D5's keyset cursor and id narrowing. */
function notificationWhere(ctx: SessionContext, employmentId: string | undefined, opts: NotificationFilter) {
  return and(
    employmentId ? or(eq(notification.recipientEmploymentId, employmentId), eq(notification.recipientUserId, ctx.userId ?? '00000000-0000-0000-0000-000000000000')) : undefined,
    opts.read === true ? isNotNull(notification.readAt) : undefined,
    opts.read === false ? isNull(notification.readAt) : undefined,
    opts.letterCompanyIds !== undefined ? and(isNotNull(notification.recipientUserId), inArray(notification.companyId, opts.letterCompanyIds)) : undefined,
    opts.action === true ? eq(notification.severity, 'action') : undefined,
    opts.action === false ? ne(notification.severity, 'action') : undefined,
    // Strictly after the cursor in the one order below: (created_at desc, id desc).
    opts.after ? sql`(${notification.createdAt}, ${notification.id}) < (${opts.after.at}::timestamptz, ${opts.after.id}::uuid)` : undefined,
    opts.ids ? (opts.ids.length ? inArray(notification.id, [...opts.ids]) : sql`false`) : undefined,
  );
}

/** 3-tab bell (feedback 1514d366): `read` filters by readAt (true ⇒ only read — the History tab;
 *  false ⇒ only unread) and `action` by severity (see unreadNotificationCount). Both undefined ⇒
 *  the pre-existing unfiltered read, so current callers are byte-identical.
 *  D5: newest first with `id` as the tie-break, so equal instants have one stable order; `after`
 *  (optional, keyset) continues strictly past a NotificationCursor. No current caller passes it. */
export function listNotifications(
  ctx: SessionContext,
  employmentId?: string,
  opts: { limit?: number; read?: boolean; action?: boolean; after?: NotificationCursor; letterCompanyIds?: string[] } = {}, existingTx?: AiReadTx
): Promise<NotificationRow[]> {
  ctx = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  opts = { ...opts, letterCompanyIds:opts.letterCompanyIds?.slice(), after: opts.after ? { ...opts.after } : opts.after };

  return withCanonicalAiReadTx(ctx, existingTx, 'notifications', withTenant, async (tx) => {
    const recipients=await notificationRecipientCandidatesTx(tx,ctx);
    return notificationRowsTx(tx, recipients, ctx, employmentId, opts);
  });
}

function notificationRowsTx(
  tx: Tx,
  recipients: Awaited<ReturnType<typeof notificationRecipientCandidatesTx>>,
  ctx: SessionContext,
  employmentId: string | undefined,
  opts: NotificationFilter & { limit?: number },
) {
  return tx
    .select(notificationColumns)
    .from(notification)
    .where(and(recipients, notificationWhere(ctx, employmentId, opts)))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(Math.min(Math.max(opts.limit ?? 20, 1), 100));
}

/** The bell's three lists and two badges share one tenant connection and recipient lookup. */
export function notificationBellSummary(ctx: SessionContext, scope: { letterCompanyIds?: string[] } = {}) {
  ctx = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  scope = { letterCompanyIds: scope.letterCompanyIds?.slice() };
  return withTenant(ctx, async tx => {
    const recipients = await notificationRecipientCandidatesTx(tx, ctx);
    const [counts] = await tx.select({
      unread: sql<number>`count(*) filter (where ${notification.severity} <> 'action')::int`,
      taskCount: sql<number>`count(*) filter (where ${notification.severity} = 'action')::int`,
    }).from(notification).where(and(recipients, notificationWhere(ctx, undefined, { ...scope, read: false })));
    // Bound each tab before combining it so history cannot crowd out unread or action items.
    const previews = unionAll(
      notificationRowsTx(tx, recipients, ctx, undefined, { ...scope, limit: 12, read: false, action: false }),
      notificationRowsTx(tx, recipients, ctx, undefined, { ...scope, limit: 12, read: false, action: true }),
      notificationRowsTx(tx, recipients, ctx, undefined, { ...scope, limit: 12, read: true }),
    ).as('bell_previews');
    const rows = await tx.select().from(previews).orderBy(desc(previews.createdAt), desc(previews.id));
    const items = rows.filter(row => row.readAt === null && row.severity !== 'action');
    const tasks = rows.filter(row => row.readAt === null && row.severity === 'action');
    const read = rows.filter(row => row.readAt !== null);
    return { unread: counts?.unread ?? 0, taskCount: counts?.taskCount ?? 0, items, tasks, read };
  });
}

/** D5 — one keyset page in listNotifications' order, each row with its exact cursor text. The caller asks
 *  for one row more than it shows to learn whether another page exists. `ids` narrows to those rows (a
 *  fresh re-read after a command). RLS still decides which rows exist for the caller. */
export function listNotificationsPage(
  ctx: SessionContext,
  opts: { limit: number; after?: NotificationCursor | null; read?: boolean; ids?: readonly string[]; employmentId?: string },
): Promise<(NotificationRow & { cursorAt: string })[]> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  opts={...opts,ids:opts.ids?.slice(),after:opts.after?{...opts.after}:opts.after};
  return withTenant(ctx, async (tx) => {
    const recipients=await notificationRecipientCandidatesTx(tx,ctx);
    return tx
      .select({ ...notificationColumns, cursorAt: sql<string>`to_char(${notification.createdAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
      .from(notification)
      .where(and(recipients,notificationWhere(ctx, opts.employmentId, opts)))
      .orderBy(desc(notification.createdAt), desc(notification.id))
      .limit(Math.min(Math.max(opts.limit, 1), 101));
  });
}

/** Mark one notification read. RLS confines the update to the caller's own rows. */
export async function markNotificationRead(ctx: SessionContext, notificationId: string): Promise<void> {
  await withTenant(ctx, (tx) =>
    tx.update(notification).set({ readAt: sql`now()` }).where(and(eq(notification.id, notificationId), isNull(notification.readAt))),
  );
}

export async function markAllNotificationsRead(ctx: SessionContext, employmentId?: string,opts:{letterCompanyIds?:string[]}={}): Promise<void> {
  await withTenant(ctx, (tx) =>
    tx
      .update(notification)
      .set({ readAt: sql`now()` })
      .where(and(isNull(notification.readAt),opts.letterCompanyIds!==undefined?and(isNotNull(notification.recipientUserId),inArray(notification.companyId,opts.letterCompanyIds)):undefined, employmentId ? or(eq(notification.recipientEmploymentId, employmentId),eq(notification.recipientUserId,ctx.userId??'00000000-0000-0000-0000-000000000000')) : undefined)),
  );
}
