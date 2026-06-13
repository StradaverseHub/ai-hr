/**
 * Attendance — generic, jurisdiction-neutral time engine (ADR-0011).
 *
 * One row per employee per day. Check-in classifies the day (workday / rest day /
 * holiday, frozen on the row); check-out derives worked + overtime minutes from the
 * company work schedule. Absence is implicit (no row) and contextualized at read time
 * (approved leave / holiday / rest day are not "absent"). Each mutation appends a
 * domain event (ADR-0006).
 */
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { assertCanDecide } from './approvals';
import {
  attendance,
  attendanceCorrection,
  attendancePolicy,
  company,
  employment,
  holiday,
  leaveRequest,
  person,
} from '../db/schema';

export class AlreadyCheckedInError extends Error {
  constructor() {
    super('Already checked in today');
    this.name = 'AlreadyCheckedInError';
  }
}

export type DayType = 'workday' | 'rest_day' | 'holiday';

const DEFAULTS = {
  lateAfter: '09:15:00',
  halfDayBefore: '13:00:00',
  workStart: '09:00:00',
  workEnd: '18:00:00',
  breakMinutes: 60,
  workingDays: [1, 2, 3, 4, 5], // ISO: Mon–Fri
};

const toMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** ISO weekday (1=Mon … 7=Sun) of a YYYY-MM-DD date. */
export const isoWeekday = (iso: string): number => {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
};

type Policy = typeof DEFAULTS & { country: string };

async function policyFor(tx: Tx, employmentId: string): Promise<Policy> {
  const [row] = await tx
    .select({
      lateAfter: attendancePolicy.lateAfter,
      halfDayBefore: attendancePolicy.halfDayBefore,
      workStart: attendancePolicy.workStart,
      workEnd: attendancePolicy.workEnd,
      breakMinutes: attendancePolicy.breakMinutes,
      workingDays: attendancePolicy.workingDays,
      country: company.country,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(attendancePolicy, eq(attendancePolicy.companyId, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  return {
    lateAfter: row?.lateAfter ?? DEFAULTS.lateAfter,
    halfDayBefore: row?.halfDayBefore ?? DEFAULTS.halfDayBefore,
    workStart: row?.workStart ?? DEFAULTS.workStart,
    workEnd: row?.workEnd ?? DEFAULTS.workEnd,
    breakMinutes: row?.breakMinutes ?? DEFAULTS.breakMinutes,
    workingDays: row?.workingDays ?? DEFAULTS.workingDays,
    country: row?.country ?? 'MY',
  };
}

async function dayTypeFor(tx: Tx, pol: Policy, date: string): Promise<DayType> {
  const [hol] = await tx
    .select({ id: holiday.id })
    .from(holiday)
    .where(and(eq(holiday.holidayDate, date), eq(holiday.country, pol.country)))
    .limit(1);
  if (hol) return 'holiday';
  return pol.workingDays.includes(isoWeekday(date)) ? 'workday' : 'rest_day';
}

/** Net scheduled minutes of a normal working day (span minus break). */
const scheduledMinutes = (pol: Policy) =>
  Math.max(0, toMinutes(pol.workEnd) - toMinutes(pol.workStart) - pol.breakMinutes);

/**
 * Worked minutes for a raw in→out span: the full break is deducted once the span
 * reaches 6h (a deliberate, conservative simplification — ADR-0011).
 */
const workedFromSpan = (spanMinutes: number, breakMinutes: number) =>
  Math.max(0, spanMinutes - (spanMinutes >= 360 ? breakMinutes : 0));

/** Derive status + worked/OT minutes for a full or partial day — the shared rule that
 *  check-in/out apply incrementally and a correction applies in one shot. */
function deriveAttendance(
  pol: Policy,
  dayType: DayType,
  checkInAt: string,
  checkOutAt: string | null,
): { status: 'present' | 'late' | 'half_day'; workedMinutes: number | null; otMinutes: number | null } {
  let status: 'present' | 'late' | 'half_day' =
    dayType === 'workday' && toMinutes(checkInAt) > toMinutes(pol.lateAfter) ? 'late' : 'present';
  if (!checkOutAt) return { status, workedMinutes: null, otMinutes: null };
  if (dayType === 'workday' && status !== 'late' && toMinutes(checkOutAt) < toMinutes(pol.halfDayBefore)) {
    status = 'half_day';
  }
  const workedMinutes = workedFromSpan(toMinutes(checkOutAt) - toMinutes(checkInAt), pol.breakMinutes);
  const otMinutes =
    dayType === 'workday' ? Math.max(0, workedMinutes - scheduledMinutes(pol)) : workedMinutes;
  return { status, workedMinutes, otMinutes };
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

    const pol = await policyFor(tx, p.employmentId);
    const dayType = await dayTypeFor(tx, pol, p.date);
    // "Late" only means something against a schedule — rest-day/holiday work is just present.
    const status =
      dayType === 'workday' && toMinutes(p.time) > toMinutes(pol.lateAfter) ? 'late' : 'present';
    const [row] = await tx
      .insert(attendance)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        attendanceDate: p.date,
        checkInAt: p.time,
        status,
        dayType,
      })
      .returning({ id: attendance.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance',
      aggregateId: row.id,
      eventType: 'attendance.checked-in',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, date: p.date, time: p.time, status, dayType },
    });
    return { attendanceId: row.id, status, dayType };
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

    const pol = await policyFor(tx, p.employmentId);
    // Tolerate legacy rows that pre-date day-type stamping.
    const dayType: DayType = rec.dayType ?? (await dayTypeFor(tx, pol, p.date));
    let status = rec.status;
    if (dayType === 'workday' && status !== 'late' && toMinutes(p.time) < toMinutes(pol.halfDayBefore)) {
      status = 'half_day';
    }

    const span = toMinutes(p.time) - toMinutes(rec.checkInAt ?? p.time);
    const workedMinutes = workedFromSpan(span, pol.breakMinutes);
    // Workday OT = beyond the scheduled net day; rest-day/holiday work is OT-class in full
    // (EA 1955 pays it at premium rates — classification here, monetization in payroll).
    const otMinutes =
      dayType === 'workday' ? Math.max(0, workedMinutes - scheduledMinutes(pol)) : workedMinutes;

    await tx
      .update(attendance)
      .set({ checkOutAt: p.time, status, dayType, workedMinutes, otMinutes })
      .where(eq(attendance.id, rec.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance',
      aggregateId: rec.id,
      eventType: 'attendance.checked-out',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        employmentId: p.employmentId,
        date: p.date,
        time: p.time,
        status,
        dayType,
        workedMinutes,
        otMinutes,
      },
    });
    return { status, dayType, workedMinutes, otMinutes };
  });
}

export type DayContext = 'on_leave' | 'holiday' | 'rest_day' | null;

/**
 * Every active employee with their attendance row for `date` (null = no row), plus the
 * context that explains a missing row: approved leave > public holiday > rest day.
 */
export function attendanceForDate(ctx: SessionContext, date: string, companyIds?: string[]) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        companyCountry: company.country,
        companyId: employment.companyId,
        attendanceId: attendance.id,
        checkInAt: attendance.checkInAt,
        checkOutAt: attendance.checkOutAt,
        status: attendance.status,
        dayType: attendance.dayType,
        workedMinutes: attendance.workedMinutes,
        otMinutes: attendance.otMinutes,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(
        attendance,
        and(eq(attendance.employmentId, employment.id), eq(attendance.attendanceDate, date)),
      )
      .where(
        and(
          isNull(employment.terminatedOn),
          companyIds && companyIds.length ? inArray(employment.companyId, companyIds) : undefined,
        ),
      )
      .orderBy(person.fullName);

    const empIds = rows.map((r) => r.employmentId);
    const [onLeave, holidays, policies] = await Promise.all([
      empIds.length
        ? tx
            .select({ employmentId: leaveRequest.employmentId })
            .from(leaveRequest)
            .where(
              and(
                eq(leaveRequest.status, 'approved'),
                lte(leaveRequest.startDate, date),
                gte(leaveRequest.endDate, date),
                inArray(leaveRequest.employmentId, empIds),
              ),
            )
        : Promise.resolve([]),
      tx.select({ country: holiday.country }).from(holiday).where(eq(holiday.holidayDate, date)),
      tx
        .select({ companyId: attendancePolicy.companyId, workingDays: attendancePolicy.workingDays })
        .from(attendancePolicy),
    ]);
    const leaveSet = new Set(onLeave.map((l) => l.employmentId));
    const holidayCountries = new Set(holidays.map((h) => h.country));
    const daysByCompany = new Map(policies.map((p) => [p.companyId, p.workingDays]));
    const dow = isoWeekday(date);

    return rows.map(({ companyCountry, companyId, ...r }) => {
      let context: DayContext = null;
      if (!r.attendanceId) {
        if (leaveSet.has(r.employmentId)) context = 'on_leave';
        else if (holidayCountries.has(companyCountry)) context = 'holiday';
        else if (!(daysByCompany.get(companyId) ?? DEFAULTS.workingDays).includes(dow))
          context = 'rest_day';
      }
      return { ...r, context };
    });
  });
}

export type MonthSummaryRow = {
  employmentId: string;
  name: string;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  leaveDays: number;
  workedMinutes: number;
  otWorkday: number;
  otRestDay: number;
  otHoliday: number;
  /** EA 1955 limitation-of-overtime regs: > 104 OT hours in the month. */
  otCapExceeded: boolean;
  /** Indicative: some Mon–Sun week in the month exceeded 45 worked hours. */
  over45hWeek: boolean;
};

const OT_CAP_MINUTES = 104 * 60;
const WEEK_LIMIT_MINUTES = 45 * 60;

/** Per-employee month roll-up: status counts, hours, OT split by day type, compliance flags. */
export function attendanceMonthSummary(
  ctx: SessionContext,
  p: { month: string; companyIds?: string[]; today?: string },
): Promise<MonthSummaryRow[]> {
  return withTenant(ctx, async (tx) => {
    const monthStart = `${p.month}-01`;
    const [y, m] = p.month.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const today = p.today ?? new Date().toISOString().slice(0, 10);
    const lastCounted = today < monthEnd ? today : monthEnd; // absence only up to today

    const emps = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        companyId: employment.companyId,
        country: company.country,
        hiredOn: employment.hiredOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          isNull(employment.terminatedOn),
          p.companyIds && p.companyIds.length
            ? inArray(employment.companyId, p.companyIds)
            : undefined,
        ),
      )
      .orderBy(person.fullName);
    if (emps.length === 0) return [];
    const empIds = emps.map((e) => e.employmentId);

    const [rows, hols, leaves, policies] = await Promise.all([
      tx
        .select({
          employmentId: attendance.employmentId,
          date: attendance.attendanceDate,
          status: attendance.status,
          dayType: attendance.dayType,
          workedMinutes: attendance.workedMinutes,
          otMinutes: attendance.otMinutes,
        })
        .from(attendance)
        .where(
          and(
            inArray(attendance.employmentId, empIds),
            gte(attendance.attendanceDate, monthStart),
            lte(attendance.attendanceDate, monthEnd),
          ),
        ),
      tx
        .select({ country: holiday.country, date: holiday.holidayDate })
        .from(holiday)
        .where(and(gte(holiday.holidayDate, monthStart), lte(holiday.holidayDate, monthEnd))),
      tx
        .select({
          employmentId: leaveRequest.employmentId,
          startDate: leaveRequest.startDate,
          endDate: leaveRequest.endDate,
        })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.status, 'approved'),
            lte(leaveRequest.startDate, monthEnd),
            gte(leaveRequest.endDate, monthStart),
            inArray(leaveRequest.employmentId, empIds),
          ),
        ),
      tx
        .select({ companyId: attendancePolicy.companyId, workingDays: attendancePolicy.workingDays })
        .from(attendancePolicy),
    ]);

    const holidaySet = new Set(hols.map((h) => `${h.country}|${h.date}`));
    const daysByCompany = new Map(policies.map((pp) => [pp.companyId, pp.workingDays]));
    const rowsByEmp = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = rowsByEmp.get(r.employmentId);
      if (arr) arr.push(r);
      else rowsByEmp.set(r.employmentId, [r]);
    }
    const leaveByEmp = new Map<string, { startDate: string; endDate: string }[]>();
    for (const l of leaves) {
      const arr = leaveByEmp.get(l.employmentId);
      if (arr) arr.push(l);
      else leaveByEmp.set(l.employmentId, [l]);
    }

    const MS_DAY = 86_400_000;
    const mondayOf = (iso: string) => {
      const d = new Date(`${iso}T00:00:00Z`);
      const off = (d.getUTCDay() + 6) % 7;
      return new Date(d.getTime() - off * MS_DAY).toISOString().slice(0, 10);
    };

    return emps.map((e) => {
      const myRows = rowsByEmp.get(e.employmentId) ?? [];
      const recorded = new Set(myRows.map((r) => r.date));
      const myLeaves = leaveByEmp.get(e.employmentId) ?? [];
      const onLeave = (d: string) => myLeaves.some((l) => l.startDate <= d && d <= l.endDate);
      const workingDays = daysByCompany.get(e.companyId) ?? DEFAULTS.workingDays;

      let present = 0;
      let late = 0;
      let halfDay = 0;
      let workedMinutes = 0;
      let otWorkday = 0;
      let otRestDay = 0;
      let otHoliday = 0;
      const weekMinutes = new Map<string, number>();
      for (const r of myRows) {
        if (r.status === 'late') late += 1;
        else if (r.status === 'half_day') halfDay += 1;
        else present += 1;
        workedMinutes += r.workedMinutes ?? 0;
        const ot = r.otMinutes ?? 0;
        if (r.dayType === 'rest_day') otRestDay += ot;
        else if (r.dayType === 'holiday') otHoliday += ot;
        else otWorkday += ot;
        const wk = mondayOf(r.date);
        weekMinutes.set(wk, (weekMinutes.get(wk) ?? 0) + (r.workedMinutes ?? 0));
      }

      let absent = 0;
      let leaveDays = 0;
      for (let ms = Date.parse(`${monthStart}T00:00:00Z`); ; ms += MS_DAY) {
        const d = new Date(ms).toISOString().slice(0, 10);
        if (d > lastCounted) break;
        if (d < e.hiredOn) continue;
        if (!workingDays.includes(isoWeekday(d))) continue;
        if (holidaySet.has(`${e.country}|${d}`)) continue;
        if (recorded.has(d)) continue;
        if (onLeave(d)) leaveDays += 1;
        else absent += 1;
      }

      const totalOt = otWorkday + otRestDay + otHoliday;
      return {
        employmentId: e.employmentId,
        name: e.name,
        present,
        late,
        halfDay,
        absent,
        leaveDays,
        workedMinutes,
        otWorkday,
        otRestDay,
        otHoliday,
        otCapExceeded: totalOt > OT_CAP_MINUTES,
        over45hWeek: [...weekMinutes.values()].some((v) => v > WEEK_LIMIT_MINUTES),
      };
    });
  });
}

// ───────────────────── Corrections (ADR-0011 Phase B) ─────────────────────

/** Raise a correction request for a day's punches. RLS confines who an employment is
 *  visible to (self / manager / admin), so a peer cannot file for someone else. */
export async function requestAttendanceCorrection(
  ctx: SessionContext,
  p: { employmentId: string; date: string; checkIn: string; checkOut?: string | null; reason?: string },
) {
  return withTenant(ctx, async (tx) => {
    if (p.checkOut && toMinutes(p.checkOut) <= toMinutes(p.checkIn)) {
      throw new Error('Check-out must be after check-in');
    }
    const [row] = await tx
      .insert(attendanceCorrection)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        attendanceDate: p.date,
        proposedCheckIn: p.checkIn,
        proposedCheckOut: p.checkOut ?? null,
        reason: p.reason ?? null,
      })
      .returning({ id: attendanceCorrection.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-correction',
      aggregateId: row.id,
      eventType: 'attendance-correction.requested',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        employmentId: p.employmentId,
        date: p.date,
        checkIn: p.checkIn,
        checkOut: p.checkOut ?? null,
        reason: p.reason ?? null,
      },
    });
    return { correctionId: row.id };
  });
}

/** Decide a correction. Approval upserts the attendance row with the proposed punches,
 *  re-derived through the time engine (so corrected OT flows to payroll). No self-approval. */
export async function decideAttendanceCorrection(
  ctx: SessionContext,
  p: { correctionId: string; decision: 'approved' | 'rejected'; deciderEmploymentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [cor] = await tx
      .select()
      .from(attendanceCorrection)
      .where(eq(attendanceCorrection.id, p.correctionId))
      .limit(1);
    if (!cor) throw new Error('correction request not found (or not visible)');
    if (cor.status !== 'pending') throw new Error(`correction request is already ${cor.status}`);

    await assertCanDecide(tx, ctx, cor.employmentId, 'attendance correction');

    if (p.decision === 'approved') {
      const pol = await policyFor(tx, cor.employmentId);
      const dayType = await dayTypeFor(tx, pol, cor.attendanceDate);
      const d = deriveAttendance(pol, dayType, cor.proposedCheckIn, cor.proposedCheckOut);
      const [amended] = await tx
        .insert(attendance)
        .values({
          tenantId: ctx.tenantId,
          employmentId: cor.employmentId,
          attendanceDate: cor.attendanceDate,
          checkInAt: cor.proposedCheckIn,
          checkOutAt: cor.proposedCheckOut,
          status: d.status,
          dayType,
          workedMinutes: d.workedMinutes,
          otMinutes: d.otMinutes,
          remarks: 'Corrected',
        })
        .onConflictDoUpdate({
          target: [attendance.employmentId, attendance.attendanceDate],
          set: {
            checkInAt: cor.proposedCheckIn,
            checkOutAt: cor.proposedCheckOut,
            status: d.status,
            dayType,
            workedMinutes: d.workedMinutes,
            otMinutes: d.otMinutes,
            remarks: 'Corrected',
          },
        })
        .returning({ id: attendance.id });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'attendance',
        aggregateId: amended.id,
        eventType: 'attendance.amended',
        actor: actorOf(ctx),
        subjectEmploymentId: cor.employmentId,
        payload: {
          correctionId: cor.id,
          date: cor.attendanceDate,
          checkIn: cor.proposedCheckIn,
          checkOut: cor.proposedCheckOut,
          status: d.status,
          dayType,
          workedMinutes: d.workedMinutes,
          otMinutes: d.otMinutes,
        },
      });
    }

    await tx
      .update(attendanceCorrection)
      .set({
        status: p.decision,
        decidedByEmploymentId: p.deciderEmploymentId ?? null,
        decidedAt: sql`now()`,
      })
      .where(eq(attendanceCorrection.id, cor.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'attendance-correction',
      aggregateId: cor.id,
      eventType: `attendance-correction.${p.decision}`,
      actor: actorOf(ctx),
      subjectEmploymentId: cor.employmentId,
      payload: { decision: p.decision, deciderEmploymentId: p.deciderEmploymentId ?? null },
    });
    return { status: p.decision };
  });
}

/** Correction inbox — RLS trims to what the viewer may see (admin all in scope, manager
 *  their reports, employee their own). Recent first. */
export function listAttendanceCorrections(
  ctx: SessionContext,
  opts: { companyIds?: string[]; status?: 'pending' | 'approved' | 'rejected' } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: attendanceCorrection.id,
        employmentId: attendanceCorrection.employmentId,
        personId: employment.personId,
        employee: person.fullName,
        attendanceDate: attendanceCorrection.attendanceDate,
        proposedCheckIn: attendanceCorrection.proposedCheckIn,
        proposedCheckOut: attendanceCorrection.proposedCheckOut,
        reason: attendanceCorrection.reason,
        status: attendanceCorrection.status,
        createdAt: attendanceCorrection.createdAt,
      })
      .from(attendanceCorrection)
      .innerJoin(employment, eq(employment.id, attendanceCorrection.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          opts.status ? eq(attendanceCorrection.status, opts.status) : undefined,
          opts.companyIds && opts.companyIds.length
            ? inArray(employment.companyId, opts.companyIds)
            : undefined,
        ),
      )
      .orderBy(desc(attendanceCorrection.createdAt))
      .limit(100),
  );
}

/** An employee's own recent corrections (the /me history). */
export function myAttendanceCorrections(ctx: SessionContext, employmentId: string, limit = 5) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: attendanceCorrection.id,
        attendanceDate: attendanceCorrection.attendanceDate,
        proposedCheckIn: attendanceCorrection.proposedCheckIn,
        proposedCheckOut: attendanceCorrection.proposedCheckOut,
        status: attendanceCorrection.status,
        createdAt: attendanceCorrection.createdAt,
      })
      .from(attendanceCorrection)
      .where(eq(attendanceCorrection.employmentId, employmentId))
      .orderBy(desc(attendanceCorrection.createdAt))
      .limit(limit),
  );
}
