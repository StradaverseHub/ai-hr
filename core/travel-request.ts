/**
 * ADR-0069 Attendance Request Management — Travel Request.
 *
 * An employee submits a date-range record marking that they were working off-site for that window. It flows
 * through the SAME request→decide workflow as an attendance correction (same approvals inbox, same
 * assertCanDecide self-approval ban, same domain-event audit). On approval it becomes an AUDIT MARKER only —
 * surfaced as a badge via activeTravelRequestFor — and is deliberately NOT wired into DayContext /
 * attendanceForDate, so it can never silently change month-summary absence counting (ADR-0069 §3: a
 * travelling employee who does not clock in still counts as absent for month-end summaries — travel is not
 * leave). This is scoped to a marker because this codebase's geofencing (ADR-0070) is a separate enforcement
 * path; real location enforcement is out of scope here.
 */
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { assertCanDecide } from './approvals';
import { employment, person, travelRequest } from '../db/schema';

/** Raise a travel request for an off-site work window. RLS confines who an employment is visible to (self /
 *  manager / admin), so a peer cannot file for someone else. Validates travelTo >= travelFrom and non-empty
 *  remarks in application code (the DB also enforces the range and remarks NOT NULL). */
export async function requestTravel(
  ctx: SessionContext,
  p: { employmentId: string; travelFrom: string; travelTo: string; remarks?: string },
) {
  if (p.travelTo < p.travelFrom) {
    throw new Error('Travel end date must be on or after the start date.');
  }
  const remarks = (p.remarks ?? '').trim();
  if (remarks.length === 0) {
    throw new Error('A reason is required.');
  }
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(travelRequest)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        travelFrom: p.travelFrom,
        travelTo: p.travelTo,
        remarks,
      })
      .returning({ id: travelRequest.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'travel-request',
      aggregateId: row.id,
      eventType: 'travel-request.requested',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, travelFrom: p.travelFrom, travelTo: p.travelTo, remarks },
    });
    return { travelRequestId: row.id };
  });
}

/** Decide a travel request. No self-approval (assertCanDecide). Approval simply flips the status — the marker
 *  is the row itself; there is no downstream attendance mutation (an audit marker, not an enforcement toggle). */
export async function decideTravelRequest(
  ctx: SessionContext,
  p: { travelRequestId: string; decision: 'approved' | 'rejected'; deciderEmploymentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(travelRequest)
      .where(eq(travelRequest.id, p.travelRequestId))
      .limit(1);
    if (!row) throw new Error('travel request not found (or not visible)');
    if (row.status !== 'pending') throw new Error(`travel request is already ${row.status}`);

    await assertCanDecide(tx, ctx, row.employmentId, 'travel request');

    await tx
      .update(travelRequest)
      .set({ status: p.decision, decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: sql`now()` })
      .where(eq(travelRequest.id, row.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'travel-request',
      aggregateId: row.id,
      eventType: `travel-request.${p.decision}`,
      actor: actorOf(ctx),
      subjectEmploymentId: row.employmentId,
      payload: { decision: p.decision, deciderEmploymentId: p.deciderEmploymentId ?? null },
    });
    return { status: p.decision };
  });
}

/** ADR-0069: the approved travel record covering a given date (if any), for a detail-view badge ONLY. Bounded
 *  to [travelFrom, travelTo]. Returns the single most-recent matching approved row (windows should not overlap
 *  in practice, but a deterministic pick keeps the badge stable). NOT used in absence/month-summary math. */
export async function activeTravelRequestFor(
  tx: Tx,
  employmentId: string,
  date: string,
): Promise<{ id: string; travelFrom: string; travelTo: string; remarks: string } | null> {
  const [row] = await tx
    .select({
      id: travelRequest.id,
      travelFrom: travelRequest.travelFrom,
      travelTo: travelRequest.travelTo,
      remarks: travelRequest.remarks,
    })
    .from(travelRequest)
    .where(
      and(
        eq(travelRequest.employmentId, employmentId),
        eq(travelRequest.status, 'approved'),
        lte(travelRequest.travelFrom, date),
        gte(travelRequest.travelTo, date),
      ),
    )
    .orderBy(desc(travelRequest.travelFrom))
    .limit(1);
  return row ?? null;
}

/** Travel-request inbox — RLS trims to what the viewer may see (admin all in scope, manager their reports,
 *  employee their own). Recent first. Mirrors listAttendanceCorrections. */
export function listTravelRequests(
  ctx: SessionContext,
  opts: { companyIds?: string[]; status?: 'pending' | 'approved' | 'rejected' } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: travelRequest.id,
        employmentId: travelRequest.employmentId,
        personId: employment.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode, // Employee ID left-of-name (feedback 38668d9b)
        travelFrom: travelRequest.travelFrom,
        travelTo: travelRequest.travelTo,
        remarks: travelRequest.remarks,
        status: travelRequest.status,
        createdAt: travelRequest.createdAt,
      })
      .from(travelRequest)
      .innerJoin(employment, eq(employment.id, travelRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          opts.status ? eq(travelRequest.status, opts.status) : undefined,
          opts.companyIds && opts.companyIds.length
            ? inArray(employment.companyId, opts.companyIds)
            : undefined,
        ),
      )
      .orderBy(desc(travelRequest.createdAt))
      .limit(100),
  );
}

/** An employee's own recent travel requests (the /me history). */
export function myTravelRequests(ctx: SessionContext, employmentId: string, limit = 5) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: travelRequest.id,
        travelFrom: travelRequest.travelFrom,
        travelTo: travelRequest.travelTo,
        remarks: travelRequest.remarks,
        status: travelRequest.status,
        createdAt: travelRequest.createdAt,
      })
      .from(travelRequest)
      .where(eq(travelRequest.employmentId, employmentId))
      .orderBy(desc(travelRequest.createdAt))
      .limit(limit),
  );
}
