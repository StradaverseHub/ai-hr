/**
 * Leave services. Balance is the signed sum of the append-only leave_ledger
 * (accrual +, debit −, adjustment ±). Approval checks projected balance and writes
 * the debit + status flip + event atomically in one transaction.
 */
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { employment, holiday, leaveLedger, leaveRequest, leaveType, reportingLine } from '../db/schema';

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

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Working days in [start, end]: excludes Sat/Sun and the given holiday dates. */
function workingDays(start: string, end: string, holidays: Set<string>): number {
  let n = 0;
  for (const d of eachDate(start, end)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6 || holidays.has(d)) continue;
    n++;
  }
  return n;
}

export async function requestLeave(
  ctx: SessionContext,
  p: { employmentId: string; leaveTypeId: string; startDate: string; endDate: string; reason?: string },
) {
  return withTenant(ctx, async (tx) => {
    // Day count depends on the leave type: working-days (excl weekends + holidays) vs calendar.
    const [lt] = await tx
      .select({ counting: leaveType.counting })
      .from(leaveType)
      .where(eq(leaveType.id, p.leaveTypeId))
      .limit(1);
    let days: number;
    if (lt?.counting === 'working_days') {
      const hols = await tx
        .select({ d: holiday.holidayDate })
        .from(holiday)
        .where(and(gte(holiday.holidayDate, p.startDate), lte(holiday.holidayDate, p.endDate)));
      days = workingDays(p.startDate, p.endDate, new Set(hols.map((h) => h.d)));
    } else {
      days = dayCount(p.startDate, p.endDate);
    }
    if (days <= 0) throw new Error('No leave days in range (end before start, or all non-working)');
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

    // Authorization beyond RLS visibility (RLS makes self rows writable, so the service
    // must gate): no self-approval, and only an admin or the requester's administrative
    // manager may decide. super_admin keeps a sole-admin escape hatch for their own
    // requests (small-firm reality); every decision is evented with the real actor.
    const [emp] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, req.employmentId))
      .limit(1);
    const roles = ctx.roles ?? [];
    const isSuperAdmin = roles.includes('super_admin');
    const isAdminRole = isSuperAdmin || roles.includes('hr_admin');
    const isSelf = ctx.personId != null && emp?.personId === ctx.personId;
    if (isSelf && !isSuperAdmin) throw new Error('You cannot decide your own leave request');
    if (!isAdminRole) {
      const mgr = ctx.personId
        ? await tx
            .select({ id: reportingLine.id })
            .from(reportingLine)
            .innerJoin(employment, eq(employment.id, reportingLine.managerEmploymentId))
            .where(
              and(
                eq(reportingLine.subordinateEmploymentId, req.employmentId),
                eq(reportingLine.lineType, 'administrative'),
                isNull(reportingLine.validTo),
                isNull(reportingLine.supersededAt),
                eq(employment.personId, ctx.personId),
              ),
            )
            .limit(1)
        : [];
      if (mgr.length === 0) {
        throw new Error('Only an admin or the administrative manager can decide leave');
      }
    }

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
