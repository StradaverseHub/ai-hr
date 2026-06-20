/**
 * Shift rosters (ADR-0032 Phase C, slice C1). Shift templates per company + per-employee roster
 * assignments — the "expected" schedule the time engine will consume (C2). Each mutation runs inside
 * withTenant and appends a DomainEvent. RLS gates writes (shift → company admin; roster → can_admin_employment).
 */
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { rosterAssignment, shift, type ShiftDifferential } from '../db/schema';

const DIFF_KINDS = ['percent', 'flat_hourly', 'flat_per_shift'] as const;

function validateDifferential(d: ShiftDifferential | null | undefined): ShiftDifferential | null {
  if (d == null) return null;
  if (!DIFF_KINDS.includes(d.kind)) throw new Error(`Invalid shift differential kind: ${d.kind}`);
  if (typeof d.value !== 'number' || !Number.isFinite(d.value) || d.value < 0) {
    throw new Error('Shift differential value must be a non-negative number');
  }
  return { kind: d.kind, value: d.value };
}

/** end ≤ start means the shift runs past midnight (e.g. 22:00:00 → 06:00:00). Times are 'HH:MM:SS', whose
 *  lexicographic order is chronological. */
export const shiftCrossesMidnight = (startTime: string, endTime: string) => endTime <= startTime;

export type ShiftInput = {
  companyId: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes?: number;
  differential?: ShiftDifferential | null;
};

export async function createShift(ctx: SessionContext, p: ShiftInput) {
  const name = p.name.trim();
  if (!name) throw new Error('Shift name is required');
  const differential = validateDifferential(p.differential);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(shift)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        name,
        startTime: p.startTime,
        endTime: p.endTime,
        breakMinutes: p.breakMinutes ?? 0,
        crossesMidnight: shiftCrossesMidnight(p.startTime, p.endTime),
        differential,
      })
      .returning({ id: shift.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: row.id,
      eventType: 'shift.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, name, startTime: p.startTime, endTime: p.endTime, hasDifferential: !!differential },
    });
    return { id: row.id };
  });
}

export async function updateShift(
  ctx: SessionContext,
  p: { shiftId: string; name: string; startTime: string; endTime: string; breakMinutes?: number; differential?: ShiftDifferential | null },
) {
  const name = p.name.trim();
  if (!name) throw new Error('Shift name is required');
  const differential = validateDifferential(p.differential);
  return withTenant(ctx, async (tx) => {
    await tx
      .update(shift)
      .set({
        name,
        startTime: p.startTime,
        endTime: p.endTime,
        breakMinutes: p.breakMinutes ?? 0,
        crossesMidnight: shiftCrossesMidnight(p.startTime, p.endTime),
        differential,
        updatedAt: new Date(),
      })
      .where(eq(shift.id, p.shiftId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: p.shiftId,
      eventType: 'shift.updated',
      actor: actorOf(ctx),
      payload: { name, startTime: p.startTime, endTime: p.endTime, hasDifferential: !!differential },
    });
    return { id: p.shiftId };
  });
}

export async function archiveShift(ctx: SessionContext, p: { shiftId: string }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(shift).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(shift.id, p.shiftId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'shift',
      aggregateId: p.shiftId,
      eventType: 'shift.archived',
      actor: actorOf(ctx),
      payload: { shiftId: p.shiftId },
    });
    return { id: p.shiftId };
  });
}

export function listShifts(ctx: SessionContext, companyId: string, opts?: { includeArchived?: boolean }) {
  return withTenant(ctx, (tx) => {
    const conds = [eq(shift.companyId, companyId)];
    if (!opts?.includeArchived) conds.push(isNull(shift.archivedAt));
    return tx.select().from(shift).where(and(...conds)).orderBy(asc(shift.startTime), asc(shift.name));
  });
}

// ── Roster assignments ──────────────────────────────────────────────

/** Assign (or re-assign) a shift to an employee on a date. Upsert: one assignment per (employee, date). */
export async function assignShift(ctx: SessionContext, p: { employmentId: string; shiftDate: string; shiftId: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(rosterAssignment)
      .values({ tenantId: ctx.tenantId, employmentId: p.employmentId, shiftDate: p.shiftDate, shiftId: p.shiftId, isRestDay: false })
      .onConflictDoUpdate({
        target: [rosterAssignment.tenantId, rosterAssignment.employmentId, rosterAssignment.shiftDate],
        set: { shiftId: p.shiftId, isRestDay: false, updatedAt: new Date() },
      })
      .returning({ id: rosterAssignment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: row.id,
      eventType: 'roster.shift.assigned',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, shiftDate: p.shiftDate, shiftId: p.shiftId },
    });
    return { id: row.id };
  });
}

/** Mark a date as an explicit rest day for an employee (vs no row = company-policy fallback). */
export async function setRestDay(ctx: SessionContext, p: { employmentId: string; shiftDate: string; note?: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(rosterAssignment)
      .values({ tenantId: ctx.tenantId, employmentId: p.employmentId, shiftDate: p.shiftDate, shiftId: null, isRestDay: true, note: p.note ?? null })
      .onConflictDoUpdate({
        target: [rosterAssignment.tenantId, rosterAssignment.employmentId, rosterAssignment.shiftDate],
        set: { shiftId: null, isRestDay: true, note: p.note ?? null, updatedAt: new Date() },
      })
      .returning({ id: rosterAssignment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: row.id,
      eventType: 'roster.rest-day.set',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, shiftDate: p.shiftDate },
    });
    return { id: row.id };
  });
}

/** Remove an assignment → the date falls back to the company policy. */
export async function clearRoster(ctx: SessionContext, p: { employmentId: string; shiftDate: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .delete(rosterAssignment)
      .where(and(eq(rosterAssignment.employmentId, p.employmentId), eq(rosterAssignment.shiftDate, p.shiftDate)))
      .returning({ id: rosterAssignment.id });
    if (!row) return { id: null };
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: row.id,
      eventType: 'roster.cleared',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, shiftDate: p.shiftDate },
    });
    return { id: row.id };
  });
}

/** Bulk-assign one shift to many employees across many dates (the roster-grid workhorse). One summary
 *  event (per-row events would spam the log at 4,500-staff scale — documented skip). */
export async function assignShiftBulk(
  ctx: SessionContext,
  p: { employmentIds: string[]; shiftDates: string[]; shiftId: string },
) {
  if (p.employmentIds.length === 0 || p.shiftDates.length === 0) return { assigned: 0 };
  const values = p.employmentIds.flatMap((employmentId) =>
    p.shiftDates.map((shiftDate) => ({ tenantId: ctx.tenantId, employmentId, shiftDate, shiftId: p.shiftId, isRestDay: false })),
  );
  return withTenant(ctx, async (tx) => {
    await tx
      .insert(rosterAssignment)
      .values(values)
      .onConflictDoUpdate({
        target: [rosterAssignment.tenantId, rosterAssignment.employmentId, rosterAssignment.shiftDate],
        set: { shiftId: sql`excluded.shift_id`, isRestDay: false, updatedAt: new Date() },
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'roster-assignment',
      aggregateId: p.shiftId,
      eventType: 'roster.bulk.assigned',
      actor: actorOf(ctx),
      payload: { shiftId: p.shiftId, employmentCount: p.employmentIds.length, dateCount: p.shiftDates.length, rows: values.length },
    });
    return { assigned: values.length };
  });
}

/** The roster grid for a date window (admin/manager view; RLS scopes which employees are visible). */
export function rosterForRange(ctx: SessionContext, p: { employmentIds?: string[]; from: string; to: string }) {
  return withTenant(ctx, (tx) => {
    const conds = [gte(rosterAssignment.shiftDate, p.from), lte(rosterAssignment.shiftDate, p.to)];
    if (p.employmentIds && p.employmentIds.length > 0) conds.push(inArray(rosterAssignment.employmentId, p.employmentIds));
    return tx
      .select({
        id: rosterAssignment.id,
        employmentId: rosterAssignment.employmentId,
        shiftDate: rosterAssignment.shiftDate,
        shiftId: rosterAssignment.shiftId,
        isRestDay: rosterAssignment.isRestDay,
        note: rosterAssignment.note,
      })
      .from(rosterAssignment)
      .where(and(...conds))
      .orderBy(asc(rosterAssignment.shiftDate));
  });
}
