/**
 * Audit H#3 — Leave working-day counting must honour the company's configured rest-day roster, not a
 * hardcoded Sat/Sun. `core/leave.ts` workingDays() and the Emergency-Leave cascade split must resolve the
 * employee's working days from the SAME attendance_policy.workingDays (ISO weekday array) the attendance
 * engine uses (core/attendance.ts), defaulting to Mon–Fri when no policy is configured.
 *
 * Statutory: EA 1955 s.59 (the rest day is employer-designated, not fixed to Sunday), s.60E.
 *
 * Cases:
 *  - A 6-day-week employee (rest day Sunday only) taking a Mon–Sat working_days leave is debited 6, not 5.
 *  - A Friday-rest employee's leave spanning a Friday is NOT debited for the Friday.
 *  - Unconfigured (no attendance_policy row) keeps the Mon–Fri default (Mon–Fri week debits 5).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let annualId: string;

async function hire() {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Rest', primaryEmail: `rest_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
}

/** Configure the company attendance policy's working-day roster (ISO weekdays 1=Mon … 7=Sun). */
async function setWorkingDays(workingDays: number[]) {
  await owner.db.insert(schema.attendancePolicy).values({ tenantId: b.tenantId, companyId: b.companyId, workingDays });
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  annualId = b.annualLeaveTypeId;
  // ANNUAL counts in working_days (the EA leave-balance axis).
  await owner.db.update(schema.leaveType).set({ counting: 'working_days' }).where(eq(schema.leaveType.id, annualId));
});
afterAll(async () => {
  await closeAll();
});

describe('H#3 — leave working-day count honours the configured rest-day roster', () => {
  it('6-day week (rest day Sunday only): a Mon–Sat working_days leave is debited 6, not 5', async () => {
    // Roster: Mon–Sat working (ISO 1..6), Sunday (7) the only rest day.
    await setWorkingDays([1, 2, 3, 4, 5, 6]);
    const employmentId = await hire();
    // 2026-06-01 is a Monday; 2026-06-06 is the Saturday of that week (no public holidays seeded).
    const r = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: annualId,
      startDate: '2026-06-01',
      endDate: '2026-06-06',
    });
    expect(r.days).toBe(6);
  });

  it('Friday-rest roster (Sun–Thu working): a leave spanning a Friday is NOT debited for the Friday', async () => {
    // Kelantan/Terengganu/Kedah/Johor weekend = Fri–Sat. Working days Sun(7),Mon(1),Tue(2),Wed(3),Thu(4).
    await setWorkingDays([7, 1, 2, 3, 4]);
    const employmentId = await hire();
    const r = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: annualId,
      startDate: '2026-06-03', // Wednesday
      endDate: '2026-06-05', // Friday (rest day on this roster)
    });
    // Wed(work) + Thu(work) + Fri(rest) ⇒ 2 working days. The hardcoded Sat/Sun version would count Wed+Thu+Fri = 3.
    expect(r.days).toBe(2);
  });

  it('unconfigured (no attendance_policy) keeps the Mon–Fri default: a Mon–Fri leave debits 5', async () => {
    // No setWorkingDays — the company has no attendance_policy row, so the default Mon–Fri roster applies.
    const employmentId = await hire();
    const r = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: annualId,
      startDate: '2026-06-01', // Monday
      endDate: '2026-06-05', // Friday
    });
    expect(r.days).toBe(5);
  });
});
