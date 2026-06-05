/**
 * Leave services. Balance is the signed sum of the append-only leave_ledger
 * (accrual +, debit −, adjustment ±). Approval checks projected balance and writes
 * the debit + status flip + event atomically in one transaction.
 */
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { leaveLedger, leaveRequest } from '../db/schema';

export class InsufficientLeaveBalanceError extends Error {
  constructor() {
    super('Leave rejected: insufficient balance');
    this.name = 'InsufficientLeaveBalanceError';
  }
}

export async function leaveBalance(tx: Tx, employmentId: string, leaveTypeId: string): Promise<number> {
  const [row] = await tx
    .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
    .from(leaveLedger)
    .where(and(eq(leaveLedger.employmentId, employmentId), eq(leaveLedger.leaveTypeId, leaveTypeId)));
  return Number(row?.bal ?? 0);
}

/** Inclusive whole-day count between two ISO dates (Slice 0 — no public-holiday logic yet). */
function dayCount(start: string, end: string): number {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  return Math.floor((e - s) / 86_400_000) + 1;
}

export async function requestLeave(
  ctx: SessionContext,
  p: { employmentId: string; leaveTypeId: string; startDate: string; endDate: string; reason?: string },
) {
  return withTenant(ctx, async (tx) => {
    const days = dayCount(p.startDate, p.endDate);
    if (days <= 0) throw new Error('endDate is before startDate');
    const [row] = await tx
      .insert(leaveRequest)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        leaveTypeId: p.leaveTypeId,
        startDate: p.startDate,
        endDate: p.endDate,
        days: days.toFixed(2),
        status: 'pending',
        reason: p.reason ?? null,
      })
      .returning({ id: leaveRequest.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: row.id,
      eventType: 'leave-request.submitted',
      actor: actorOf(ctx),
      payload: { employmentId: p.employmentId, leaveTypeId: p.leaveTypeId, startDate: p.startDate, endDate: p.endDate, days },
    });
    return { leaveRequestId: row.id, days };
  });
}

export async function decideLeave(
  ctx: SessionContext,
  p: { leaveRequestId: string; decision: 'approved' | 'rejected'; deciderEmploymentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx
      .select()
      .from(leaveRequest)
      .where(eq(leaveRequest.id, p.leaveRequestId))
      .limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`leave request is already ${req.status}`);

    if (p.decision === 'approved') {
      const balance = await leaveBalance(tx, req.employmentId, req.leaveTypeId);
      const need = Number(req.days);
      if (balance - need < 0) throw new InsufficientLeaveBalanceError();
      await tx.insert(leaveLedger).values({
        tenantId: ctx.tenantId,
        employmentId: req.employmentId,
        leaveTypeId: req.leaveTypeId,
        entryType: 'debit',
        days: (-need).toFixed(2),
        sourceRequestId: req.id,
        effectiveOn: req.startDate,
      });
    }

    await tx
      .update(leaveRequest)
      .set({ status: p.decision, decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: sql`now()` })
      .where(eq(leaveRequest.id, req.id));

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: req.id,
      eventType: `leave-request.${p.decision}`,
      actor: actorOf(ctx),
      payload: { decision: p.decision, deciderEmploymentId: p.deciderEmploymentId ?? null },
    });
    return { status: p.decision };
  });
}
