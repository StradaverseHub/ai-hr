import { rewardNotificationRecipients } from '../packs/rewards/service';
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
 * ── DELIVERY IS IN-APP ONLY. NOTHING IN THIS FILE SENDS EMAIL. ───────────────────────────────────────────
 *
 * `dispatchNotifications` inserts one `notification` row per recipient and stops. The only consumers of those
 * rows are the topbar bell (app/layout.tsx → components/notification-center.tsx) and the mark-read server
 * actions (app/notification-actions.ts). Nothing else reads them.
 *
 * THERE IS NO EMAIL TRANSPORT IN THIS REPOSITORY — no nodemailer, SMTP, SendGrid, Postmark, Mailgun, SES or
 * Resend, in package.json or anywhere else. The one mail the product really sends is WorkOS's invitation,
 * from the auth path, and it is not this engine's.
 *
 * The schema LOOKS like more than that and is not: `notification_channel` has an 'email' member, and
 * `notification_pref` (per recipient/category/channel) and `notification_delivery` (out-of-app attempts)
 * are real tables. NO CODE READS OR WRITES EITHER ONE — zero references outside db/schema.ts. So no
 * preference is consulted, no channel is chosen, and no delivery row is ever written. They are a design
 * that was migrated and never built. Do not describe them as behaviour.
 *
 * This matters beyond tidiness: a comment claiming a delivery channel is how somebody ends up telling a
 * customer that leave approvals are emailed. Only 9 of 83 production employments even have a login, so an
 * in-app notification to the other 74 reaches nobody at all. `test/r292-notification-channel-truth.test.ts`
 * is a SOURCE-SHAPE guard pinning the absence of a transport and the absence of the claim TOGETHER, so the
 * two can never drift apart again. Adding a transport is a vendor and cost decision for the owner; if that
 * day comes, that test is the checklist of what has to change with it.
 */
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  appUser,
  domainEvent,
  employment,
  employmentReview,
  leaveApprovalStep,
  leaveRequest,
  notification,
  notificationCursor,
  noticeRecipient,
  payslip,
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
 *  Switched-off logins are excluded (0279). THE REASON IS NOT EMAIL — nothing here sends any; see the file
 *  header, which used to be contradicted from this very line. The reason is that a notification row
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
      const rows = await tx
        .select({ id: reportingLine.managerEmploymentId })
        .from(reportingLine)
        .where(
          and(
            eq(reportingLine.subordinateEmploymentId, subjectEmploymentId),
            eq(reportingLine.lineType, 'administrative'),
            lte(reportingLine.validFrom, sql`current_date`),
            or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
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

/** Notifications are a per-tenant module now (ADR-0077 slice 3), not a deployment flag. */
const enabled = (ctx: SessionContext) => isModuleEnabled(ctx, 'notifications');

type Rendered = { severity: NotificationSeverity; title: string; body: string; linkPath: string };
type EventRef = { aggregateId: string; subjectEmploymentId: string | null };
type Spec = {
  kind: string;
  category: string;
  /** `ev` is optional context (6522d26a) — most renders are payload-only; a spec may use the event ref
   *  for a recipient-specific deep-link (e.g. the HR issue-letter task links to the subject's profile). */
  render: (payload: Record<string, unknown> | null, ev: EventRef) => Rendered;
  /** Fan-out resolver. When present, recipients come from here (e.g. every employee in a closed payroll
   *  batch) instead of the event's single subjectEmploymentId. `payload` (R51 722904dc) is the event's
   *  payload — a two-parameter resolver is still assignable, so existing resolvers compile unchanged. */
  recipients?: (tx: Tx, ev: EventRef, payload: Record<string, unknown> | null) => Promise<string[]>;
};

// eventType → notification (or SEVERAL — 6522d26a: one event may fan out to different audiences with
// different bodies, e.g. employment-review.decided → subject "complete" + HR "issue the letter").
// Recipient defaults to the event's subjectEmploymentId. Keep titles/bodies short; deep-link into the
// app where the full, gated detail lives.
const REGISTRY: Record<string, Spec | Spec[]> = {
  'reward-unit.routed': {
    kind: 'rewards.review', category: 'rewards',
    render: (_p, ev) => ({ severity: 'action', title: 'Rewards review needs attention', body: 'Open Reward Desk to review the assigned request.', linkPath: `/rewards/${ev.aggregateId}?view=approvals` }),
    recipients: (tx, ev, payload) => rewardNotificationRecipients(tx, ev.aggregateId, payload?.to),
  },
  'reward-unit.approved': {
    kind: 'rewards.approved', category: 'rewards',
    render: (_p, ev) => ({ severity: 'action', title: 'Rewards ready for payroll', body: 'The review is approved and ready for the payroll handoff.', linkPath: `/rewards/${ev.aggregateId}?view=approvals` }),
    recipients: (tx, ev) => rewardNotificationRecipients(tx, ev.aggregateId, 'approved'),
  },
  'leave-request.approved': {
    kind: 'leave.approved',
    category: 'leave',
    // Partial Leave Approval notification fix: a MIXED per-date outcome (finalizeLeaveApproval sets
    // payload.mixed === true when ≥1 date was approved AND ≥1 rejected) renders an honest "partially
    // approved" body that deep-links to /me, where the existing per-date breakdown shows which dates were
    // approved/rejected and why. Every other approval (whole-request, all-approved per-date) has no `mixed`
    // flag and keeps the flat "approved" body — byte-identical to today.
    render: (p) => {
      if (p?.mixed === true) {
        // R17 600be8ac ask #5: list the approved + rejected dates and the rejection reason so the notice is
        // self-contained. perDateOutcome is attached by finalizeLeaveApproval only for the mixed case; fall
        // back to the generic body if an older event lacks it. Cap the listing so the body stays short.
        const o = (p.perDateOutcome ?? null) as
          | { approved?: string[]; rejected?: { date: string; reason?: string | null }[] }
          | null;
        const cap = 6;
        const fmt = (arr: string[]) =>
          arr.length > cap ? `${arr.slice(0, cap).join(', ')} +${arr.length - cap} more` : arr.join(', ');
        const approved = o?.approved ?? [];
        const rejected = o?.rejected ?? [];
        const parts: string[] = [];
        if (approved.length) parts.push(`Approved: ${fmt(approved)}`);
        if (rejected.length) {
          parts.push(`Rejected: ${fmt(rejected.map((r) => r.date))}`);
          const reason = rejected.find((r) => r.reason)?.reason;
          if (reason) parts.push(`Reason: ${reason}`);
        }
        const body = parts.length
          ? `Some dates were approved and some were not. ${parts.join('. ')}.`
          : 'Some dates in your leave request were approved and some were not — tap to see the breakdown.';
        return { severity: 'info', title: 'Leave partially approved', body, linkPath: '/me' };
      }
      return { severity: 'info', title: 'Leave approved', body: 'Your leave request was approved.', linkPath: '/me' };
    },
  },
  'leave-request.rejected': {
    kind: 'leave.rejected',
    category: 'leave',
    render: () => ({ severity: 'warning', title: 'Leave not approved', body: 'Your leave request was rejected.', linkPath: '/me' }),
  },
  // HR cancelled a leave on the employee's behalf (feedback 22e68ff0). Default recipient = the event's
  // subjectEmploymentId (the affected employee) — no fan-out resolver. The payload carries the display facts
  // (type + dates) the ticket wants in the notice. English-only strings, matching every other registry entry.
  'leave-request.admin-cancelled': {
    kind: 'leave.admin-cancelled',
    category: 'leave',
    render: (p) => ({
      severity: 'warning',
      title: 'Leave cancelled by HR',
      body: `Your ${p?.leaveTypeName ?? 'leave'} (${p?.startDate ?? ''} → ${p?.endDate ?? ''}) has been cancelled by an HR administrator.`,
      linkPath: '/me',
    }),
  },
  // The employee withdrew their OWN pending leave (item c9a19e34, expected_function 4.v — "notify the approver
  // and HR"). Unlike the other leave notices, the SUBJECT here is the person who took the action, so a subject
  // notice would be pointless — a fan-out resolver targets the approver (the subject's current administrative
  // manager) + the company's HR admins instead, excluding the subject. English-only body (registry convention).
  'leave-request.self-cancelled': {
    kind: 'leave.self-cancelled',
    category: 'leave',
    render: (p) => ({
      severity: 'info',
      title: 'Leave application withdrawn',
      body: `An employee withdrew their ${p?.leaveTypeName ?? 'leave'} application (${p?.startDate ?? ''} → ${p?.endDate ?? ''}).`,
      linkPath: '/approvals',
    }),
    recipients: async (tx, ev) => {
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
  },
  // ── r301 (board 83511d3b) — Cancel Approved Leave. The reporter's complaint was that an employee was never
  // told what became of their cancellation, so the two DECISIONS go to the employee ALWAYS (the event's
  // subject — the default recipient). The REQUEST goes to the approver and HR only when the leave type's
  // "Notify the approver and HR" box was ticked, a choice SNAPSHOTTED into the event payload at request time
  // (re-reading the leave type at dispatch would let a later untick retroactively un-notify). In-app only:
  // see the file header — nothing here sends email. English-only strings, the registry convention.
  'leave-cancellation.requested': {
    kind: 'leave.cancellation-requested',
    category: 'leave',
    render: (p) => {
      const what = `${p?.leaveTypeName ?? 'leave'} (${Array.isArray(p?.cancelDates) ? (p.cancelDates as string[]).join(', ') : ''})`;
      return p?.autoApproved === true
        ? {
            severity: 'info',
            title: 'Leave cancelled by an employee',
            body: `An employee cancelled ${what}. It was approved automatically by the leave type setting.`,
            linkPath: '/approvals',
          }
        : {
            severity: 'action',
            title: 'Leave cancellation awaiting approval',
            body: `An employee asked to cancel ${what}. It is waiting for approval.`,
            linkPath: '/approvals',
          };
    },
    recipients: async (tx, ev, payload) => {
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
      const hr = await hrAdminsForCompany(tx, ev.subjectEmploymentId);
      // Never the employee who asked (an HR admin or a manager cancelling their own leave).
      return [...new Set([...approvers, ...hr])].filter((id) => id !== ev.subjectEmploymentId);
    },
  },
  'leave-cancellation.approved': {
    kind: 'leave.cancellation-approved',
    category: 'leave',
    render: (p) => {
      const dates = Array.isArray(p?.cancelDates) ? (p.cancelDates as string[]).join(', ') : '';
      const days = typeof p?.restoredDays === 'number' ? p.restoredDays : null;
      return {
        severity: 'info',
        title: 'Leave cancellation approved',
        body:
          `Your cancellation of ${p?.leaveTypeName ?? 'leave'}${dates ? ` on ${dates}` : ''} was approved` +
          `${p?.autoApproved === true ? ' automatically' : ''}. The leave is cancelled` +
          `${days != null ? ` and ${days} day(s) went back to your balance` : ''}.`,
        linkPath: '/leave',
      };
    },
  },
  'leave-cancellation.rejected': {
    kind: 'leave.cancellation-rejected',
    category: 'leave',
    render: (p) => {
      const dates = Array.isArray(p?.cancelDates) ? (p.cancelDates as string[]).join(', ') : '';
      return {
        severity: 'warning',
        title: 'Leave cancellation not approved',
        body: `Your cancellation of ${p?.leaveTypeName ?? 'leave'}${dates ? ` on ${dates}` : ''} was not approved. The leave stays approved.`,
        linkPath: '/leave',
      };
    },
    // The subject — EXCEPT when HR cancelled the whole leave on the employee's behalf and the pending
    // give-back was closed as superseded (adminCancelLeave): the employee is already told "Leave cancelled
    // by HR", and "your cancellation was not approved… the leave stays approved" would be untrue.
    recipients: async (_tx, ev, payload) =>
      payload?.supersededByAdminCancellation === true || !ev.subjectEmploymentId ? [] : [ev.subjectEmploymentId],
  },
  'toil.accrued': {
    kind: 'toil.accrued',
    category: 'toil',
    render: (p) => ({
      severity: 'info',
      title: 'Time off in lieu banked',
      body: `${p?.daysCredited ?? ''} day(s) banked in lieu${p?.workedDate ? ` for ${p.workedDate}` : ''}.`.trim(),
      linkPath: '/me',
    }),
  },
  'toil.converted': {
    kind: 'toil.converted',
    category: 'toil',
    render: (p) => ({ severity: 'info', title: 'In-lieu converted to pay', body: `Your unused time in lieu (${p?.daysCredited ?? ''} day(s)) was converted to pay.`, linkPath: '/me' }),
  },
  'toil.lapsed': {
    kind: 'toil.lapsed',
    category: 'toil',
    render: (p) => ({ severity: 'warning', title: 'In-lieu expired', body: `Your unused time in lieu (${p?.daysCredited ?? ''} day(s)) has lapsed.`, linkPath: '/me' }),
  },
  // 34-2b producers — the rest of the "your request was actioned" decisions (each already carries the
  // requester as subjectEmploymentId) plus the payslip-ready fan-out.
  'resignation.accepted': {
    kind: 'resignation.accepted',
    category: 'offboarding',
    render: () => ({ severity: 'info', title: 'Resignation accepted', body: 'Your resignation has been accepted by HR.', linkPath: '/me' }),
  },
  'resignation.rejected': {
    kind: 'resignation.rejected',
    category: 'offboarding',
    render: () => ({ severity: 'warning', title: 'Resignation not accepted', body: 'Your resignation was not accepted — please speak with HR.', linkPath: '/me' }),
  },
  /**
   * ADR-0084 §2.7 — the input-triage question. The BODY is written by the SWEEP, not here, for the same
   * reason the nudge's is: it may be a model draft, and by the time it reaches this registry it has
   * already passed `adjudicateTriage` (or it was never emitted). Re-deciding that here would be two
   * places deciding, which is how they drift.
   *
   * ⚠️ IT GOES TO THE CLAIMANT, NOT THE APPROVER, and that is the whole design (see core/input-triage.ts).
   * `subjectEmploymentId` is the person who filed it, so the DEFAULT recipient resolver is already right
   * and no `recipients` override is needed — the absence of one here is deliberate, not an oversight.
   */
  'claim-request.triage-queried': {
    kind: 'claim.triageQueried',
    // The claims category, so muting claim notifications mutes this too. It is a question about a claim.
    category: 'claims',
    render: (p) => ({
      // `info`, never `warning`. Nothing is wrong with the claim, nothing is refused, and nothing is
      // required of them — a warning colour would tell the employee they are in trouble, which is exactly
      // the accusation §2.7 forbids.
      severity: 'info',
      title: 'A question about your claim',
      body:
        typeof p?.reason === 'string' && p.reason.length > 0
          ? p.reason
          : 'There is a question about a claim you filed. Please check it before it is approved.',
      linkPath: '/me',
    }),
  },
  'claim-request.approved': {
    kind: 'claim.approved',
    category: 'claims',
    render: () => ({ severity: 'info', title: 'Claim approved', body: 'Your expense claim was approved.', linkPath: '/me' }),
  },
  'claim-request.rejected': {
    kind: 'claim.rejected',
    category: 'claims',
    render: () => ({ severity: 'warning', title: 'Claim not approved', body: 'Your expense claim was not approved.', linkPath: '/me' }),
  },
  // ── 1e9145d4 Plan OT — three notices, because today NOTHING is sent about an attendance or overtime
  // request at all. Overtime agreed before it is worked only works if the approver learns a plan is waiting
  // while saying no is still cheap, and if the employee learns the answer without going to look.
  //
  // SCOPED TO OVERTIME, DELIBERATELY. The same three event types are also appended by a clock-time
  // correction, which shares the record. Widening these notices to cover clock fixes would be a real
  // improvement — they are equally silent today — but it is a behaviour change on a neighbouring flow that
  // nobody asked for, so each resolver below returns NO RECIPIENTS for a non-overtime row. Widening later
  // is deleting one guard clause. The discriminator is `requestedOtMinutes` on the request event and the
  // explicit `overtime` flag on the decision events (which carry no minutes of their own).
  //
  // English-only strings, the registry convention — a notification body is rendered once and STORED, so
  // there is no per-language version of it.
  'attendance-correction.requested': {
    kind: 'attendance.ot-requested',
    category: 'attendance',
    render: (p) => {
      const hours = p?.requestedOtMinutes != null ? (Number(p.requestedOtMinutes) / 60).toFixed(1) : '';
      const date = typeof p?.date === 'string' ? p.date : '';
      return {
        severity: 'action',
        title: 'Overtime plan awaiting approval',
        body: `An overtime plan for ${date} (${hours} hours) is waiting for your approval.`,
        linkPath: '/approvals',
      };
    },
    // THE APPROVER, not the subject — the event's subjectEmploymentId is the person who FILED it, so the
    // default subject notice would tell the requester what they just did. Same routing as the decide path
    // (assertCanDecide): the subject's current administrative manager, falling back to the company's HR
    // admins when they have no line — otherwise a plan filed by someone reporting to nobody is silent.
    // Both resolvers already exist and are used by the leave escalation fan-out; neither is new ground.
    recipients: async (tx, ev, payload) => {
      if (!ev.subjectEmploymentId || payload?.requestedOtMinutes == null) return [];
      let out = await approverEmploymentsForKind(tx, ev.subjectEmploymentId, 'direct_manager');
      if (out.length === 0) out = await hrAdminsForCompany(tx, ev.subjectEmploymentId);
      // Never notify the requester about their own request (an employee who is their own manager, or an
      // HR admin filing for themselves).
      return [...new Set(out)].filter((id) => id !== ev.subjectEmploymentId);
    },
  },
  // The subject IS the employee whose plan was decided, so these two would take the default recipient —
  // but the resolver is spelled out anyway to carry the overtime-only scope above.
  'attendance-correction.approved': {
    kind: 'attendance.ot-approved',
    category: 'attendance',
    render: (p) => ({
      severity: 'info',
      title: 'Overtime plan approved',
      // `deferred` is set by decideAttendanceCorrection when the plan was agreed AHEAD of its date, which
      // is the case worth saying out loud: approved is not the same as counted, and the hours appear on the
      // day once it is worked.
      body:
        p?.deferred === true
          ? `Your overtime plan for ${typeof p.date === 'string' ? p.date : 'the requested date'} was approved. The hours are counted once the day is worked.`
          : 'Your overtime request was approved.',
      linkPath: '/attendance/plan-ot',
    }),
    recipients: async (_tx, ev, payload) =>
      payload?.overtime === true && ev.subjectEmploymentId ? [ev.subjectEmploymentId] : [],
  },
  'attendance-correction.rejected': {
    kind: 'attendance.ot-rejected',
    category: 'attendance',
    render: () => ({
      severity: 'warning',
      title: 'Overtime plan not approved',
      body: 'Your overtime request was not approved.',
      linkPath: '/attendance/plan-ot',
    }),
    recipients: async (_tx, ev, payload) =>
      payload?.overtime === true && ev.subjectEmploymentId ? [ev.subjectEmploymentId] : [],
  },
  // ADR-0084 §2.5 — the nudge agent. `body` is rendered by the SWEEP, not here, because it may be a
  // model draft that passed `nudgeIsFaithful` — and if it did not, the sweep already substituted the
  // deterministic template, so by the time it reaches this registry there is exactly one body and it is
  // trustworthy. Rendering here would have to re-decide that, and two places deciding is how they drift.
  'readiness.nudge-raised': {
    kind: 'readiness.nudge',
    // Its OWN category, so the existing per-category preference is a precise opt-out: somebody can mute
    // record chasers without muting leave approvals.
    category: 'readiness',
    render: (p) => ({
      severity: 'warning',
      title: p?.audience === 'employee' ? 'Something is missing from your record' : 'An employee record needs completing',
      // The fallback is unreachable in practice (the sweep never emits without a body) and is here so a
      // hand-replayed or malformed event degrades to a true sentence rather than the string "undefined".
      body: typeof p?.body === 'string' && p.body.length > 0 ? p.body : 'A record is incomplete and is holding up payroll or a statutory filing.',
      // Deep-link to the screen the RECIPIENT can actually act on — the whole point of the routing split.
      linkPath: p?.audience === 'employee' ? '/me' : '/control-tower/readiness',
    }),
    recipients: async (tx, ev, payload) => {
      if (!ev.subjectEmploymentId) return [];
      if (payload?.audience === 'employee') return [ev.subjectEmploymentId];
      if (payload?.audience === 'hr') return hrAdminsForCompany(tx, ev.subjectEmploymentId);
      return [];
    },
  },
  'profile-change.approved': {
    kind: 'profile.approved',
    category: 'profile',
    render: () => ({ severity: 'info', title: 'Profile change approved', body: 'Your requested profile change was approved.', linkPath: '/me' }),
  },
  'profile-change.rejected': {
    kind: 'profile.rejected',
    category: 'profile',
    render: () => ({ severity: 'warning', title: 'Profile change not approved', body: 'Your requested profile change was not approved.', linkPath: '/me' }),
  },
  // Performance closure (lifecycle G4). Release-safe: closeReview asserts the cycle is released before
  // closing, and the body says only that the review was finalized — never the score or ABC class (the
  // /me review surface gates the actual figures behind the existing release/showManager rules).
  'performance-review.closed': {
    kind: 'performance.closed',
    category: 'performance',
    render: () => ({ severity: 'info', title: 'Performance review finalized', body: 'Your performance review has been finalized.', linkPath: '/me' }),
  },
  // Employment-review workflow (0110). started → fan out to the resolved direct manager (from the review
  // row) + the company's HR admins; manager-evaluated → HR admins; decided → the subject (default path).
  'employment-review.started': {
    kind: 'review.started',
    category: 'review',
    render: () => ({
      severity: 'action',
      title: 'Review due',
      body: 'A probation / contract / internship review is due — confirm, extend or terminate.',
      linkPath: '/approvals',
    }),
    recipients: async (tx, ev) => {
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
  },
  'employment-review.manager-evaluated': {
    kind: 'review.manager-evaluated',
    category: 'review',
    render: () => ({
      severity: 'action',
      title: 'Review ready for decision',
      body: 'A manager evaluation is ready — record the HR decision.',
      linkPath: '/approvals',
    }),
    recipients: async (tx, ev) => {
      const [rev] = await tx
        .select({ employmentId: employmentReview.employmentId })
        .from(employmentReview)
        .where(eq(employmentReview.id, ev.aggregateId))
        .limit(1);
      if (!rev) return [];
      return hrAdminsForCompany(tx, rev.employmentId);
    },
  },
  'employment-review.decided': [
    {
      kind: 'review.decided',
      category: 'review',
      // Default subject path (no resolver) — notify the subject only. The decision itself is gated behind
      // the /me review surface; the body says only that the review is complete.
      render: () => ({ severity: 'info', title: 'Your review is complete', body: 'Your review has been finalized.', linkPath: '/me' }),
    },
    {
      // 6522d26a Fn 5.2 — the follow-up "issue letter" HR task: same event, HR fan-out, deep-link to the
      // subject's profile review section where the save/upload affordances live. The notification IS the
      // task (a dedicated task table is deliberately out of scope).
      kind: 'review.issue-letter',
      category: 'review',
      render: (_p, ev) => ({
        severity: 'action',
        title: 'Issue review letter',
        body: 'A review was decided — generate the outcome letter and upload the signed copy.',
        linkPath: ev.subjectEmploymentId ? `/admin/personnel/${ev.subjectEmploymentId}` : '/approvals',
      }),
      recipients: async (tx, ev) => {
        const [rev] = await tx
          .select({ employmentId: employmentReview.employmentId })
          .from(employmentReview)
          .where(eq(employmentReview.id, ev.aggregateId))
          .limit(1);
        if (!rev) return [];
        return hrAdminsForCompany(tx, rev.employmentId);
      },
    },
  ],
  // 6522d26a Fn 2 — configurable reminder cadence: the sweep appends one reminder-due per (review,
  // offset window); recipients = assigned manager + the company's HR admins (clone of .started).
  'employment-review.reminder-due': {
    kind: 'review.reminder',
    category: 'review',
    render: (p) => ({
      severity: 'action',
      title: 'Review reminder',
      body: `A ${p?.reviewType ?? ''} review is awaiting action — the period ends on ${p?.dueOn ?? ''}.`.replace('  ', ' '),
      linkPath: '/approvals',
    }),
    recipients: async (tx, ev) => {
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
  },
  // Global Delegation (Phase 1) — tell the STAND-IN (the delegate) when their cover starts / ends. The
  // event's subjectEmploymentId is the delegator (the person handing over), so a subject-default notice
  // would be wrong; a fan-out resolver reads the delegate off the reporting_line row (aggregateId) instead.
  // Deep-links to /delegations, where the full picture (who covers whom, windows, revoke) lives.
  'delegation.started': {
    kind: 'delegation.started',
    category: 'delegation',
    render: (p) => ({
      severity: 'action',
      title: 'You are now a stand-in approver',
      body: `You have been assigned to cover approvals${p?.validFrom ? ` from ${p.validFrom}` : ''}${p?.validTo ? ` to ${p.validTo}` : ''}.`,
      linkPath: '/delegations',
    }),
    recipients: (tx, ev) => delegateRecipient(tx, ev.aggregateId),
  },
  'delegation.ended': {
    kind: 'delegation.ended',
    category: 'delegation',
    render: (p) => ({
      severity: 'info',
      title: 'Your stand-in cover has ended',
      body: `Your approval cover has ended${p?.endDate ? ` (${p.endDate})` : ''}.`,
      linkPath: '/delegations',
    }),
    recipients: (tx, ev) => delegateRecipient(tx, ev.aggregateId),
  },
  // R51 722904dc/71b9143a — a leave approval step sat pending past the company's escalation threshold
  // (core/leave-escalation.ts, carried by the nightly review-sweep). WHO to chase rides in the payload
  // (targetKind, snapshotted at sweep time); WHETHER to chase is re-decided HERE, because dispatch is
  // cursor-driven and may run hours after the sweep (opportunistically on admin page render): if the step
  // — or the request — has since been decided, no notification is created. That re-check is what makes
  // "if the approver acts in time, nothing is sent" actually hold. English-only strings, the registry
  // convention (notification bodies are rendered once and STORED — there is no per-language version).
  'leave-request.escalation-due': {
    kind: 'leave.escalation',
    category: 'leave',
    render: (p) => ({
      severity: 'action',
      title: 'Leave approval overdue',
      body: `A ${p?.leaveTypeName ?? 'leave'} request (${p?.startDate ?? ''} → ${p?.endDate ?? ''}) has been waiting for approval for ${p?.daysWaiting ?? ''} working day(s) and needs attention.`,
      linkPath: '/approvals',
    }),
    recipients: async (tx, ev, payload) => {
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
  },
  // 6e122302 — a Notice Board notice is A NOTIFICATION WITH A DIFFERENT PAYLOAD, which is why core/notice.ts
  // carries no delivery code of its own. Publishing appends notice.published; this entry fans it out to the
  // audience SNAPSHOT (notice_recipient) as ordinary in-app notifications, shown by the same bell as
  // everything else. There is NO preference or channel step to describe — see the file header: dispatch
  // inserts a row and stops, and `notification_pref` is dead schema nothing reads. Routing notices through
  // this engine is still right, because the day a second channel exists it gets built ONCE, here.
  'notice.published': {
    kind: 'notice.published',
    category: 'notice',
    // 'info', not 'action': release one has no acknowledgement, so there is nothing the employee must DO.
    // Severity 'action' would put it in the bell's Task tab and count toward a to-do list it cannot clear.
    render: (p, ev) => ({
      severity: 'info',
      title: 'New notice',
      body: String(p?.title ?? 'A new notice has been published.'),
      linkPath: `/notices/${ev.aggregateId}`,
    }),
    recipients: async (tx, ev, payload) => {
      // The publisher's `notifyOnPublish` choice, snapshotted into the event. That checkbox reads "Notify
      // recipients when it is published" (`notices.fNotify`, components/notice/notice-form.tsx) — it is NOT
      // an email switch, and there is no email switch, because there is no email. Read from the PAYLOAD
      // rather than re-queried: switching the flag off after publication must not retroactively un-notify,
      // and re-reading the row would make it look as though it had.
      if (payload?.notify !== true) return [];
      const rows = await tx
        .select({ e: noticeRecipient.employmentId })
        .from(noticeRecipient)
        .where(eq(noticeRecipient.noticeId, ev.aggregateId));
      return [...new Set(rows.map((r) => r.e))];
    },
  },
  // The batch event has no single subject — fan out to every employee with a payslip in the closed batch.
  'payroll-batch.closed': {
    kind: 'payslip.ready',
    category: 'payroll',
    render: () => ({ severity: 'info', title: 'Payslip ready', body: 'Your payslip is ready to view.', linkPath: '/me' }),
    recipients: async (tx, ev) => {
      const rows = await tx.select({ e: payslip.employmentId }).from(payslip).where(eq(payslip.batchId, ev.aggregateId));
      return [...new Set(rows.map((r) => r.e))];
    },
  },
};

export type DispatchResult = { processed: number; created: number };

/**
 * Project new domain events into notifications (admin/system context — reads the whole tenant event log and
 * inserts for any recipient, both RLS-gated to is_admin). Keyset-paginated by (created_at, id) via the
 * per-tenant cursor; idempotent (only events after the cursor are processed). Gated ⇒ no-op.
 */
export async function dispatchNotifications(ctx: SessionContext, opts: { limit?: number } = {}): Promise<DispatchResult> {
  if (!enabled(ctx)) return { processed: 0, created: 0 };
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
  return withTenant(ctx, async (tx) => {
    const [cur] = await tx.select().from(notificationCursor).where(eq(notificationCursor.tenantId, ctx.tenantId)).limit(1);
    const after = cur?.lastSequence != null ? gt(domainEvent.sequence, cur.lastSequence) : undefined;
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
      .where(after)
      .orderBy(asc(domainEvent.sequence))
      .limit(limit);
    if (rows.length === 0) return { processed: 0, created: 0 };

    let created = 0;
    for (const ev of rows) {
      const entry = REGISTRY[ev.eventType];
      if (!entry) continue;
      const evRef: EventRef = { aggregateId: ev.aggregateId, subjectEmploymentId: ev.subjectEmploymentId };
      for (const spec of Array.isArray(entry) ? entry : [entry]) {
        // Recipients: a fan-out resolver (e.g. all payslips in a batch), else the event's single subject.
        const recipients = spec.recipients
          ? await spec.recipients(tx, evRef, (ev.payload as Record<string, unknown> | null) ?? null)
          : ev.subjectEmploymentId
            ? [ev.subjectEmploymentId]
            : [];
        if (recipients.length === 0) continue;
        const r = spec.render((ev.payload as Record<string, unknown> | null) ?? null, evRef);
        for (const recipient of recipients) {
          await tx.insert(notification).values({
            tenantId: ctx.tenantId,
            recipientEmploymentId: recipient,
            kind: spec.kind,
            title: r.title,
            body: r.body,
            linkPath: r.linkPath,
            severity: r.severity,
            sourceEventId: ev.id,
          });
          created += 1;
        }
      }
    }

    const last = rows[rows.length - 1];
    if (cur) {
      await tx
        .update(notificationCursor)
        .set({ lastSequence: last.sequence, updatedAt: sql`now()` })
        .where(eq(notificationCursor.tenantId, ctx.tenantId));
    } else {
      await tx.insert(notificationCursor).values({ tenantId: ctx.tenantId, lastSequence: last.sequence });
    }
    return { processed: rows.length, created };
  });
}

// ─── recipient reads (RLS scopes every query to the caller's own notifications, across all the person's
// employments; pass employmentId only to narrow to one) ──────────────────────────────────────────────

/** 3-tab bell (feedback 1514d366): `action` splits the severity-'action' task notices ("do something")
 *  from the informational rest — true ⇒ only action, false ⇒ only non-action, undefined ⇒ all (the
 *  pre-existing behaviour, so every current caller is unchanged). */
export function unreadNotificationCount(
  ctx: SessionContext,
  employmentId?: string,
  opts: { action?: boolean } = {},
): Promise<number> {
  return withTenant(ctx, async (tx) => {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notification)
      .where(
        and(
          isNull(notification.readAt),
          employmentId ? eq(notification.recipientEmploymentId, employmentId) : undefined,
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

/** 3-tab bell (feedback 1514d366): `read` filters by readAt (true ⇒ only read — the History tab;
 *  false ⇒ only unread) and `action` by severity (see unreadNotificationCount). Both undefined ⇒
 *  the pre-existing unfiltered read, so current callers are byte-identical. */
export function listNotifications(
  ctx: SessionContext,
  employmentId?: string,
  opts: { limit?: number; read?: boolean; action?: boolean } = {},
): Promise<NotificationRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: notification.id,
        kind: notification.kind,
        title: notification.title,
        body: notification.body,
        linkPath: notification.linkPath,
        severity: notification.severity,
        readAt: notification.readAt,
        createdAt: notification.createdAt,
      })
      .from(notification)
      .where(
        and(
          employmentId ? eq(notification.recipientEmploymentId, employmentId) : undefined,
          opts.read === true ? isNotNull(notification.readAt) : undefined,
          opts.read === false ? isNull(notification.readAt) : undefined,
          opts.action === true ? eq(notification.severity, 'action') : undefined,
          opts.action === false ? ne(notification.severity, 'action') : undefined,
        ),
      )
      .orderBy(desc(notification.createdAt))
      .limit(Math.min(Math.max(opts.limit ?? 20, 1), 100)),
  );
}

/** Mark one notification read. RLS confines the update to the caller's own rows. */
export async function markNotificationRead(ctx: SessionContext, notificationId: string): Promise<void> {
  await withTenant(ctx, (tx) =>
    tx.update(notification).set({ readAt: sql`now()` }).where(and(eq(notification.id, notificationId), isNull(notification.readAt))),
  );
}

export async function markAllNotificationsRead(ctx: SessionContext, employmentId?: string): Promise<void> {
  await withTenant(ctx, (tx) =>
    tx
      .update(notification)
      .set({ readAt: sql`now()` })
      .where(and(isNull(notification.readAt), employmentId ? eq(notification.recipientEmploymentId, employmentId) : undefined)),
  );
}
