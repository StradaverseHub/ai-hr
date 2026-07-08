/**
 * Notification engine (ADR-0034) — 34-2 registry + dispatch + reads. A sweep reads new domain events after a
 * per-tenant cursor and turns the mapped ones into recipient-scoped notifications. Gated by
 * NOTIFICATIONS_ENABLED (off ⇒ dispatch is a no-op). v1 producers notify the event's SUBJECT (the affected
 * employee); approver-facing events (e.g. leave-request.submitted → the manager) need a reporting-graph
 * resolver and are deferred. A notification is a derived projection with its own table acting as its audit,
 * so dispatch does NOT append a DomainEvent (per CLAUDE.md — that would be an event storm + a derivation loop).
 */
import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  appUser,
  domainEvent,
  employment,
  employmentReview,
  notification,
  notificationCursor,
  payslip,
  roleAssignment,
  type NotificationSeverity,
} from '../db/schema';

/** All HR-admin employments in the same company as `employmentId` (0110, employment-review fan-out).
 *  Resolves via role_assignment (hr_admin/super_admin) → app_user → person → that company's employment.
 *  super_admin grants are group-wide; an hr_admin grant may be group-wide (company_id null) or scoped. */
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
      ),
    );
  return [...new Set(rows.map((r) => r.employmentId))];
}

const enabled = () => process.env.NOTIFICATIONS_ENABLED === 'true';

type Rendered = { severity: NotificationSeverity; title: string; body: string; linkPath: string };
type EventRef = { aggregateId: string; subjectEmploymentId: string | null };
type Spec = {
  kind: string;
  category: string;
  /** `ev` is optional context (6522d26a) — most renders are payload-only; a spec may use the event ref
   *  for a recipient-specific deep-link (e.g. the HR issue-letter task links to the subject's profile). */
  render: (payload: Record<string, unknown> | null, ev: EventRef) => Rendered;
  /** Fan-out resolver. When present, recipients come from here (e.g. every employee in a closed payroll
   *  batch) instead of the event's single subjectEmploymentId. */
  recipients?: (tx: Tx, ev: EventRef) => Promise<string[]>;
};

// eventType → notification (or SEVERAL — 6522d26a: one event may fan out to different audiences with
// different bodies, e.g. employment-review.decided → subject "complete" + HR "issue the letter").
// Recipient defaults to the event's subjectEmploymentId. Keep titles/bodies short; deep-link into the
// app where the full, gated detail lives.
const REGISTRY: Record<string, Spec | Spec[]> = {
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
  if (!enabled()) return { processed: 0, created: 0 };
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
          ? await spec.recipients(tx, evRef)
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
export function unreadNotificationCount(ctx: SessionContext, employmentId?: string): Promise<number> {
  return withTenant(ctx, async (tx) => {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notification)
      .where(and(isNull(notification.readAt), employmentId ? eq(notification.recipientEmploymentId, employmentId) : undefined));
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

export function listNotifications(ctx: SessionContext, employmentId?: string, opts: { limit?: number } = {}): Promise<NotificationRow[]> {
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
      .where(employmentId ? eq(notification.recipientEmploymentId, employmentId) : undefined)
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
