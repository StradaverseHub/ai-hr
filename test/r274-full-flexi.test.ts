/**
 * r274 (439565ff) — FULL FLEXI: the day is judged on hours worked, not on the clock.
 *
 * The value has existed since migration 0188 and the service has always accepted it; only the form option
 * was disabled and the ENGINE had no branch. So un-greying it alone would have recorded three of the four
 * rows in the reporter's own worked example wrong — an 08:31 arrival that completed nine hours would read
 * as thirty-one minutes late, and a 07:30–16:30 day would read as ninety minutes early out.
 *
 * ⚠️ LATENESS AND EARLY-OUT ARE MONEY. They feed `late_deduct_minutes` and `early_out_deduct_minutes`, and
 * the overtime basis decides ringgit on a payslip. So the load-bearing assertions here run the WHOLE path —
 * punch in, punch out, read what the engine derived — exactly as `shift-four-way-and-cutoff` does for the
 * same reason. A source-grep would prove the branch is written, not that it is reached.
 *
 * The control case matters as much as the flexi ones: a `normal` shift must be byte-identical, because this
 * round ships with zero shifts converted and nothing may move on release day.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import { assignDefaultShift, createShift } from '../core/roster';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/** 2026-05-05 is a TUESDAY (ISO 2). */
const TUE = '2026-05-05';
const BASIC = 2080;
/** Nine hours, the reporter's own figure. */
const NINE_HOURS = 540;

let b: Base;

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

let icSeq = 0;
const randomIc = () => `9201010${String(10000 + (icSeq += 1)).slice(-5)}`;

async function employeeOn(shiftId: string, email: string) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Flexi Case', primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: BASIC,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: randomIc() });
  await assignDefaultShift(a, { employmentId: e.employmentId, shiftId });
  return { a, employmentId: e.employmentId };
}

/** A Full Flexi shift. 08:00–18:00 are the earliest and latest clocking accepted, NOT a requirement. */
const fullFlexiShift = (normalMinutes: number | null) =>
  createShift(adminCtx(b), {
    name: `FullFlex_${randomUUID().slice(0, 6)}`,
    code: `FF_${randomUUID().slice(0, 6)}`,
    type: 'full_flexi',
    startTime: '08:00:00',
    endTime: '18:00:00',
    breakMinutes: 0,
    normalMinutesOverride: normalMinutes,
    weeklyPattern: [1, 2, 3, 4, 5],
  });

/** The same shape as a plain fixed shift, for the control case. */
const normalShift = () =>
  createShift(adminCtx(b), {
    name: `Normal_${randomUUID().slice(0, 6)}`,
    code: `NM_${randomUUID().slice(0, 6)}`,
    type: 'normal',
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 0,
    weeklyPattern: [1, 2, 3, 4, 5],
  });

const attendanceOf = async (employmentId: string, date: string) => {
  const [row] = await owner.db
    .select()
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)));
  return row;
};

async function punchDay(shiftId: string, inAt: string, outAt: string) {
  const { a, employmentId } = await employeeOn(shiftId, `ff_${randomUUID()}@t.local`);
  await checkIn(a, { employmentId, date: TUE, time: inAt });
  const out = await checkOut(a, { employmentId, date: TUE, time: outAt });
  return { employmentId, out, row: await attendanceOf(employmentId, TUE) };
}

describe('§A · the reporter’s worked example, end to end', () => {
  it('clock in 08:04, out 17:04 — nine hours, complete, not late', async () => {
    const shift = await fullFlexiShift(NINE_HOURS);
    const { out, row } = await punchDay(shift.id, '08:04:00', '17:04:00');
    expect(out.workedMinutes).toBe(NINE_HOURS);
    expect(row.status, 'a full flexi day is never late').toBe('present');
    expect(row.lateMinutes, 'null, not zero — there is no start to be on time against').toBeNull();
    expect(out.otMinutes, 'exactly the required hours is not overtime').toBe(0);
  });

  it('clock in 09:00, out 18:00 — the SAME nine hours, and still not late', async () => {
    // On a fixed 08:00 shift this is sixty minutes late. That is the whole defect being fixed.
    const shift = await fullFlexiShift(NINE_HOURS);
    const { out, row } = await punchDay(shift.id, '09:00:00', '18:00:00');
    expect(out.workedMinutes).toBe(NINE_HOURS);
    expect(row.status).toBe('present');
    expect(row.lateMinutes).toBeNull();
  });

  it('finishing before the shift’s end time is NOT an early out when the hours are done', async () => {
    const shift = await fullFlexiShift(NINE_HOURS);
    // 08:00 → 17:00 is a full nine hours and ends an hour before the 18:00 window closes.
    const { out, row } = await punchDay(shift.id, '08:00:00', '17:00:00');
    expect(out.workedMinutes).toBe(NINE_HOURS);
    expect(row.earlyOutMinutes ?? null, 'null, not zero — there is no end to leave early from').toBeNull();
  });

  it('overtime starts when the required hours are done, wherever that falls', async () => {
    const shift = await fullFlexiShift(NINE_HOURS);
    const { out } = await punchDay(shift.id, '08:00:00', '18:00:00');
    expect(out.workedMinutes).toBe(600);
    expect(out.otMinutes, 'ten hours worked against nine required').toBe(60);
  });

  it('short of the required hours is still SHORT — the one thing flexi does not excuse', async () => {
    const shift = await fullFlexiShift(NINE_HOURS);
    const { out, row } = await punchDay(shift.id, '09:00:00', '16:00:00');
    expect(out.workedMinutes).toBe(420);
    expect(row.underMinutes ?? 0, 'two hours short of nine').toBe(120);
    expect(out.otMinutes).toBe(0);
  });
});

describe('§B · a NORMAL shift is untouched — nothing moves on release day', () => {
  it('08:31 on a fixed 08:00 shift is still late, with the minutes still counted', async () => {
    const shift = await normalShift();
    const { row } = await punchDay(shift.id, '08:31:00', '17:31:00');
    expect(row.status, 'the control case: fixed shifts still judge the clock').toBe('late');
    expect(Number(row.lateMinutes ?? 0), 'still measured, not suppressed').toBeGreaterThan(0);
  });

  it('and leaving before its end is still an early out', async () => {
    const shift = await normalShift();
    const { row } = await punchDay(shift.id, '08:00:00', '16:00:00');
    expect(Number(row.earlyOutMinutes ?? 0)).toBeGreaterThan(0);
  });
});

describe('§C · the service refuses the trap production is already in', () => {
  it('a Full Flexi shift with NO required hours is refused', async () => {
    // SemiFlex01 on production is 07:00–20:00 with no override, which reads as a twelve-hour normal day
    // and accrues no overtime until the twelfth hour. The same trap must not be reachable on this type.
    await expect(fullFlexiShift(null)).rejects.toThrow(/total normal working hours/i);
  });

  it('and with zero hours, which is the same trap wearing a number', async () => {
    await expect(fullFlexiShift(0)).rejects.toThrow(/total normal working hours/i);
  });

  it('a NORMAL shift still saves without one, exactly as before', async () => {
    const shift = await normalShift();
    expect(shift.id).toBeTruthy();
  });
});
