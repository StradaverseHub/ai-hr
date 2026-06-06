/**
 * Attendance — generic, jurisdiction-neutral. One row per employee per day; status is
 * derived from per-company thresholds (late / half-day). Absence is implicit (no row).
 * Each mutation appends a domain event (ADR-0006).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { attendance, attendancePolicy, employment, person } from '../db/schema';

export class AlreadyCheckedInError extends Error {
  constructor() {
    super('Already checked in today');
    this.name = 'AlreadyCheckedInError';
  }
}

const DEFAULT_LATE_AFTER = '09:15:00';
const DEFAULT_HALF_DAY_BEFORE = '13:00:00';

const toMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

async function policyFor(tx: Tx, employmentId: string) {
  const [pol] = await tx
    .select({ lateAfter: attendancePolicy.lateAfter, halfDayBefore: attendancePolicy.halfDayBefore })
    .from(attendancePolicy)
    .innerJoin(employment, eq(employment.companyId, attendancePolicy.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  return {
    lateAfter: pol?.lateAfter ?? DEFAULT_LATE_AFTER,
    halfDayBefore: pol?.halfDayBefore ?? DEFAULT_HALF_DAY_BEFORE,
  };
}

export async function checkIn(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string },
) {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: attendance.id })
      .from(attendance)
      .where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date)))
      .limit(1);
    if (existing) throw new AlreadyCheckedInError();

    const { lateAfter } = await policyFor(tx, p.employmentId);
    const status = toMinutes(p.time) > toMinutes(lateAfter) ? 'late' : 'present';
    const [row] = await tx
      .insert(attendance)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        attendanceDate: p.date,
        checkInAt: p.time,
        status,
      })
      .returning({ id: attendance.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance',
      aggregateId: row.id,
      eventType: 'attendance.checked-in',
      actor: actorOf(ctx),
      payload: { employmentId: p.employmentId, date: p.date, time: p.time, status },
    });
    return { attendanceId: row.id, status };
  });
}

export async function checkOut(
  ctx: SessionContext,
  p: { employmentId: string; date: string; time: string },
) {
  return withTenant(ctx, async (tx) => {
    const [rec] = await tx
      .select()
      .from(attendance)
      .where(and(eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date)))
      .limit(1);
    if (!rec) throw new Error('No check-in recorded for this day');
    if (rec.checkOutAt) throw new Error('Already checked out');
    if (rec.checkInAt && toMinutes(p.time) <= toMinutes(rec.checkInAt)) {
      throw new Error('Check-out must be after check-in');
    }

    const { halfDayBefore } = await policyFor(tx, p.employmentId);
    let status = rec.status;
    if (status !== 'late' && toMinutes(p.time) < toMinutes(halfDayBefore)) status = 'half_day';

    await tx.update(attendance).set({ checkOutAt: p.time, status }).where(eq(attendance.id, rec.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance',
      aggregateId: rec.id,
      eventType: 'attendance.checked-out',
      actor: actorOf(ctx),
      payload: { employmentId: p.employmentId, date: p.date, time: p.time, status },
    });
    return { status };
  });
}

/** Every active employee with their attendance row for `date` (null = not yet checked in). */
export function attendanceForDate(ctx: SessionContext, date: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        attendanceId: attendance.id,
        checkInAt: attendance.checkInAt,
        checkOutAt: attendance.checkOutAt,
        status: attendance.status,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(
        attendance,
        and(eq(attendance.employmentId, employment.id), eq(attendance.attendanceDate, date)),
      )
      .where(isNull(employment.terminatedOn))
      .orderBy(person.fullName),
  );
}
