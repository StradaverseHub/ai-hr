/**
 * ADR-0032 C7 — attendance policy (the no-roster default schedule). setAttendancePolicy upserts one row per
 * company (RLS-gated to admins), validates the schedule is coherent, and appends attendance-policy.updated.
 * The decisive test: a saved policy actually drives the time engine — adding Saturday as a working day with
 * an 08:00–16:00/30 schedule makes a Saturday a workday and computes OT against the policy's scheduled hours.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { checkIn, checkOut, listAttendancePolicies, setAttendancePolicy } from '../core/attendance';

let b: Base;
const uniqEmail = () => `pol_${Math.random().toString(36).slice(2)}@t.local`;
const BASE = (companyId: string) => ({
  companyId,
  workStart: '09:00',
  workEnd: '18:00',
  breakMinutes: 60,
  lateAfter: '09:15',
  halfDayBefore: '13:00',
  workingDays: [1, 2, 3, 4, 5],
});

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('attendance policy (ADR-0032 C7)', () => {
  it('lists engine defaults for a company with no saved policy', async () => {
    const [pol] = await listAttendancePolicies(adminCtx(b), [b.companyId]);
    expect(pol.isDefault).toBe(true);
    expect(pol.workStart).toBe('09:00:00');
    expect(pol.breakMinutes).toBe(60);
    expect(pol.workingDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('upserts (insert then update keep one row) and appends attendance-policy.updated', async () => {
    const a = adminCtx(b);
    await setAttendancePolicy(a, { ...BASE(b.companyId), workStart: '08:00', workEnd: '16:00', breakMinutes: 30, lateAfter: '08:15', halfDayBefore: '12:00', workingDays: [1, 2, 3, 4, 5, 6] });
    let [pol] = await listAttendancePolicies(a, [b.companyId]);
    expect(pol.isDefault).toBe(false);
    expect(pol.workStart).toBe('08:00:00');
    expect(pol.workingDays).toEqual([1, 2, 3, 4, 5, 6]);

    await setAttendancePolicy(a, BASE(b.companyId)); // update back to Mon–Fri 09–18
    [pol] = await listAttendancePolicies(a, [b.companyId]);
    expect(pol.workStart).toBe('09:00:00');
    expect(pol.workingDays).toEqual([1, 2, 3, 4, 5]);

    const rows = await owner.db.select().from(schema.attendancePolicy).where(eq(schema.attendancePolicy.companyId, b.companyId));
    expect(rows).toHaveLength(1); // one row per company, upserted
    expect(await eventTypesFor(b.tenantId, rows[0].id)).toContain('attendance-policy.updated');
  });

  it('rejects an incoherent schedule', async () => {
    const a = adminCtx(b);
    await expect(setAttendancePolicy(a, { ...BASE(b.companyId), workEnd: '08:00' })).rejects.toThrow(/after work start/);
    await expect(setAttendancePolicy(a, { ...BASE(b.companyId), workingDays: [] })).rejects.toThrow(/working day/);
    await expect(setAttendancePolicy(a, { ...BASE(b.companyId), breakMinutes: 600 })).rejects.toThrow(/between 0 and 480/);
    await expect(setAttendancePolicy(a, { ...BASE(b.companyId), workStart: '9am' })).rejects.toThrow(/HH:MM/);
    // span 09:00→10:00 = 60m, break 60m ⇒ the working span doesn't exceed the break
    await expect(setAttendancePolicy(a, { ...BASE(b.companyId), workEnd: '10:00', breakMinutes: 60 })).rejects.toThrow(/exceed the break/);
  });

  it('the saved policy drives the time engine: a Saturday becomes a workday with policy OT', async () => {
    const a = adminCtx(b);
    // 2026-07-04 is a Saturday: default Mon–Fri policy ⇒ rest day. Saturday + 08:00–16:00/30 ⇒ 450 scheduled.
    await setAttendancePolicy(a, { ...BASE(b.companyId), workStart: '08:00', workEnd: '16:00', breakMinutes: 30, lateAfter: '08:15', halfDayBefore: '12:00', workingDays: [1, 2, 3, 4, 5, 6] });
    const e = await hireEmployee(a, {
      person: { fullName: 'Pol', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await checkIn(a, { employmentId: e.employmentId, date: '2026-07-04', time: '08:00:00' });
    await checkOut(a, { employmentId: e.employmentId, date: '2026-07-04', time: '17:00:00' }); // 540 span − 30 = 510 worked

    const [row] = await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, e.employmentId));
    expect(row.dayType).toBe('workday'); // Saturday is now a working day per the policy
    expect(row.workedMinutes).toBe(510);
    expect(row.otMinutes).toBe(60); // 510 − (08:00→16:00 − 30 = 450 scheduled)
  });
});
