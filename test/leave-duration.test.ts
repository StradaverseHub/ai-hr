/**
 * ADR-0048 — Half-day & hourly leave. A leave_type.durations allow-list opts a type into non-full-day
 * durations; requestLeave computes a fractional `days` (full=1, half=0.5, hourly=round(hours/8,2)) that
 * flows through the balance gate, ledger debit, and payroll proration unchanged. Covers the working-day
 * guard, single-day enforcement, hourly bounds, AM/PM same-date conflict, lossy rounding, and the
 * attendance + payroll integrations.
 */
import { and, eq, gte, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { decideLeave, LeaveDurationNotAllowedError, requestLeave, type LeaveDurationType } from '../core/leave';
import { createHoliday } from '../core/admin';
import { attendanceMonthSummary } from '../core/attendance';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let employmentId: string;

const ALL: LeaveDurationType[] = ['half_day_am', 'half_day_pm', 'hourly'];

async function hire() {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Dur', primaryEmail: `dur_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
}

/** A leave type with a duration allow-list + counting mode. paid=false when unpaid. */
async function leaveType(opts: {
  code?: string;
  durations: LeaveDurationType[] | null;
  counting?: 'calendar_days' | 'working_days';
  paid?: boolean;
}) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: opts.code ?? `DUR_${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Dur',
      paid: opts.paid ?? true,
      counting: opts.counting ?? 'calendar_days',
      durations: opts.durations,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Give the employee plenty of balance so approvals never hit the balance gate. */
async function grant(leaveTypeId: string, days = '30.00') {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

const daysOf = async (leaveRequestId: string) => {
  const [r] = await owner.db
    .select({ days: schema.leaveRequest.days, durationType: schema.leaveRequest.durationType, hours: schema.leaveRequest.hours })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.id, leaveRequestId));
  return r;
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  employmentId = await hire();
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0048 — half-day & hourly leave', () => {
  it('half_day_am / half_day_pm record 0.50 and debit 0.50 on approval', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    const before = await ledgerBalance(employmentId, lt);

    const am = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-06', // Monday
      endDate: '2026-07-06',
      durationType: 'half_day_am',
    });
    expect(am.days).toBe(0.5);
    const amRow = await daysOf(am.leaveRequestId);
    expect(amRow.days).toBe('0.50');
    expect(amRow.durationType).toBe('half_day_am');

    await decideLeave(adminCtx(b), { leaveRequestId: am.leaveRequestId, decision: 'approved' });
    expect(await ledgerBalance(employmentId, lt)).toBeCloseTo(before - 0.5, 2);
  });

  it('hourly deducts round(hours/8, 2): 2h → 0.25, 4h → 0.50', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);

    const h2 = await requestLeave(adminCtx(b), {
      employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'hourly', hours: 2,
    });
    expect(h2.days).toBe(0.25);
    expect((await daysOf(h2.leaveRequestId)).days).toBe('0.25');

    const h4 = await requestLeave(adminCtx(b), {
      employmentId, leaveTypeId: lt, startDate: '2026-07-07', endDate: '2026-07-07', durationType: 'hourly', hours: 4,
    });
    expect(h4.days).toBe(0.5);
    expect((await daysOf(h4.leaveRequestId)).days).toBe('0.50');
  });

  it('hourly rounding is lossy and the stored hours are the display source of truth: 1h → 0.13, hours 1.00', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    const h1 = await requestLeave(adminCtx(b), {
      employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'hourly', hours: 1,
    });
    // 1/8 = 0.125 → 0.13 (not 0.12, not a clean eighth). days and the displayed "1h" deliberately disagree.
    expect(h1.days).toBe(0.13);
    const row = await daysOf(h1.leaveRequestId);
    expect(row.days).toBe('0.13');
    expect(row.hours).toBe('1.00');
  });

  it('hourly 8h → 1.00 day, still recorded as durationType hourly', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    const h8 = await requestLeave(adminCtx(b), {
      employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'hourly', hours: 8,
    });
    expect(h8.days).toBe(1);
    const row = await daysOf(h8.leaveRequestId);
    expect(row.days).toBe('1.00');
    expect(row.durationType).toBe('hourly');
    expect(row.hours).toBe('8.00');
  });

  it('rejects a duration not in the type allow-list', async () => {
    const onlyAm = await leaveType({ durations: ['half_day_am'] });
    await grant(onlyAm);
    await expect(
      requestLeave(adminCtx(b), {
        employmentId, leaveTypeId: onlyAm, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'hourly', hours: 2,
      }),
    ).rejects.toBeInstanceOf(LeaveDurationNotAllowedError);
    // full_day is always allowed even when not listed.
    await expect(
      requestLeave(adminCtx(b), { employmentId, leaveTypeId: onlyAm, startDate: '2026-07-06', endDate: '2026-07-06' }),
    ).resolves.toMatchObject({ days: 1 });
  });

  it('enforces single-day for half/hourly (start !== end throws)', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    await expect(
      requestLeave(adminCtx(b), {
        employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-07', durationType: 'half_day_am',
      }),
    ).rejects.toThrow(/single day/i);
  });

  it('enforces hourly bounds: hours <= 0 or > 8 throws', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    const base = { employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'hourly' as const };
    await expect(requestLeave(adminCtx(b), { ...base, hours: 0 })).rejects.toThrow(/hours/i);
    await expect(requestLeave(adminCtx(b), { ...base, hours: 9 })).rejects.toThrow(/hours/i);
  });

  it('working-day guard: half_day_am on a weekend / gazetted holiday is rejected, not deducted at 0.5', async () => {
    const lt = await leaveType({ durations: ALL, counting: 'working_days' });
    await grant(lt);
    // 2026-07-05 is a Sunday.
    await expect(
      requestLeave(adminCtx(b), {
        employmentId, leaveTypeId: lt, startDate: '2026-07-05', endDate: '2026-07-05', durationType: 'half_day_am',
      }),
    ).rejects.toThrow(/No leave days in range/i);

    // A gazetted national holiday on a working day is also rejected.
    await createHoliday(adminCtx(b), { country: 'MY', holidayDate: '2026-07-06', name: 'Test Holiday' });
    await expect(
      requestLeave(adminCtx(b), {
        employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'half_day_am',
      }),
    ).rejects.toThrow(/No leave days in range/i);

    // A real working day (Tuesday) is fine.
    await expect(
      requestLeave(adminCtx(b), {
        employmentId, leaveTypeId: lt, startDate: '2026-07-07', endDate: '2026-07-07', durationType: 'half_day_am',
      }),
    ).resolves.toMatchObject({ days: 0.5 });
  });

  it('AM/PM same-date: two AM conflict; AM + PM both succeed', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    await requestLeave(adminCtx(b), {
      employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'half_day_am',
    });
    // Second AM on the same date conflicts.
    await expect(
      requestLeave(adminCtx(b), {
        employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'half_day_am',
      }),
    ).rejects.toThrow(/conflicting/i);
    // The complementary PM on the same date is allowed.
    await expect(
      requestLeave(adminCtx(b), {
        employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'half_day_pm',
      }),
    ).resolves.toMatchObject({ days: 0.5 });
  });

  it('full_day with durations null behaves exactly as before (regression guard)', async () => {
    const lt = await leaveType({ durations: null });
    await grant(lt);
    const r = await requestLeave(adminCtx(b), {
      employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-08',
    });
    expect(r.days).toBe(3); // calendar_days inclusive
    const row = await daysOf(r.leaveRequestId);
    expect(row.days).toBe('3.00');
    expect(row.durationType).toBe('full_day');
    expect(row.hours).toBeNull();
    // A non-full-day duration is rejected when the allow-list is null.
    await expect(
      requestLeave(adminCtx(b), {
        employmentId, leaveTypeId: lt, startDate: '2026-07-09', endDate: '2026-07-09', durationType: 'half_day_am',
      }),
    ).rejects.toBeInstanceOf(LeaveDurationNotAllowedError);
  });

  it('backfill default: a request created the legacy way reads back durationType = full_day', async () => {
    const lt = await leaveType({ durations: null });
    await grant(lt);
    // Insert with NO durationType (mirrors a pre-migration row) — the column default applies.
    const [row] = await owner.db
      .insert(schema.leaveRequest)
      .values({
        tenantId: b.tenantId,
        employmentId,
        leaveTypeId: lt,
        startDate: '2026-07-06',
        endDate: '2026-07-06',
        days: '1.00',
        status: 'pending',
      })
      .returning({ durationType: schema.leaveRequest.durationType, hours: schema.leaveRequest.hours });
    expect(row.durationType).toBe('full_day');
    expect(row.hours).toBeNull();
  });

  it('attendance: an approved half-day-AM leave does not flag the employee fully on-leave or add a full leaveDay', async () => {
    const lt = await leaveType({ durations: ALL, counting: 'working_days' });
    await grant(lt);
    // Monday 2026-07-06.
    const r = await requestLeave(adminCtx(b), {
      employmentId, leaveTypeId: lt, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'half_day_am',
    });
    await decideLeave(adminCtx(b), { leaveRequestId: r.leaveRequestId, decision: 'approved' });

    // today after the day so it is counted; no attendance recorded for the worked half.
    const [summary] = await attendanceMonthSummary(adminCtx(b), {
      month: '2026-07',
      companyIds: [b.companyId],
      today: '2026-07-07',
    });
    // The half-day must NOT count as a full leave day; the day is treated as a worked/absent day instead.
    expect(summary.leaveDays).toBe(0);

    // A full_day leave on the same employee on another workday DOES count.
    const full = await requestLeave(adminCtx(b), {
      employmentId, leaveTypeId: lt, startDate: '2026-07-07', endDate: '2026-07-07',
    });
    await decideLeave(adminCtx(b), { leaveRequestId: full.leaveRequestId, decision: 'approved' });
    const [summary2] = await attendanceMonthSummary(adminCtx(b), {
      month: '2026-07',
      companyIds: [b.companyId],
      today: '2026-07-08',
    });
    expect(summary2.leaveDays).toBe(1);
  });

  it('payroll: an approved unpaid half-day contributes 0.5 to the unpaid-days sum (proration flows through)', async () => {
    const unpaid = await leaveType({ durations: ALL, paid: false });
    await grant(unpaid);
    const r = await requestLeave(adminCtx(b), {
      employmentId, leaveTypeId: unpaid, startDate: '2026-07-06', endDate: '2026-07-06', durationType: 'half_day_am',
    });
    await decideLeave(adminCtx(b), { leaveRequestId: r.leaveRequestId, decision: 'approved' });

    // Mirror core/payroll.ts unpaidDaysByEmployment exactly (it is a private fn): sum approved unpaid
    // leave_request.days whose startDate is in the period, grouped by employment.
    const periodStart = '2026-07-01';
    const periodEnd = '2026-07-31';
    const rows = await owner.db
      .select({ days: schema.leaveRequest.days })
      .from(schema.leaveRequest)
      .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveRequest.leaveTypeId))
      .where(
        and(
          eq(schema.leaveRequest.status, 'approved'),
          eq(schema.leaveType.paid, false),
          eq(schema.leaveRequest.employmentId, employmentId),
          gte(schema.leaveRequest.startDate, periodStart),
          lte(schema.leaveRequest.startDate, periodEnd),
        ),
      );
    const total = rows.reduce((s, x) => s + Number(x.days), 0);
    expect(total).toBeCloseTo(0.5, 2); // fractional unpaid leave prorates through payroll unchanged
    expect(rows).toHaveLength(1);
  });
});
