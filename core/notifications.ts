/**
 * Notification engine (ADR-0034) — 34-2 registry + dispatch + reads. A sweep reads new domain events after a
 * per-tenant cursor and turns the mapped ones into recipient-scoped notifications. Gated by
 * NOTIFICATIONS_ENABLED (off ⇒ dispatch is a no-op). v1 producers notify the event's SUBJECT (the affected
 * employee); approver-facing events (e.g. leave-request.submitted → the manager) need a reporting-graph
 * resolver and are deferred. A notification is a derived projection with its own table acting as its audit,
 * so dispatch does NOT append a DomainEvent (per CLAUDE.md — that would be an event storm + a derivation loop).
 */
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { domainEvent, notification, notificationCursor, type NotificationSeverity } from '../db/schema';

const enabled = () => process.env.NOTIFICATIONS_ENABLED === 'true';

type Rendered = { severity: NotificationSeverity; title: string; body: string; linkPath: string };
type Spec = { kind: string; category: string; render: (payload: Record<string, unknown> | null) => Rendered };

// eventType → notification. Recipient is always the event's subjectEmploymentId (so these only need the
// payload to render). Keep titles/bodies short; deep-link into the app where the full, gated detail lives.
const REGISTRY: Record<string, Spec> = {
  'leave-request.approved': {
    kind: 'leave.approved',
    category: 'leave',
    render: () => ({ severity: 'info', title: 'Leave approved', body: 'Your leave request was approved.', linkPath: '/me' }),
  },
  'leave-request.rejected': {
    kind: 'leave.rejected',
    category: 'leave',
    render: () => ({ severity: 'warning', title: 'Leave not approved', body: 'Your leave request was rejected.', linkPath: '/me' }),
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
      const spec = REGISTRY[ev.eventType];
      if (!spec || !ev.subjectEmploymentId) continue;
      const r = spec.render((ev.payload as Record<string, unknown> | null) ?? null);
      await tx.insert(notification).values({
        tenantId: ctx.tenantId,
        recipientEmploymentId: ev.subjectEmploymentId,
        kind: spec.kind,
        title: r.title,
        body: r.body,
        linkPath: r.linkPath,
        severity: r.severity,
        sourceEventId: ev.id,
      });
      created += 1;
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
