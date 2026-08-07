/**
 * Item b8aa3466 — the BACKUP SHIFT (the profile's `default_shift_id`) and its coverage gate.
 *
 * THE DEFECT THIS FILE PINS. The shift field on the employee profile has been marked `required` since R17
 * 3e8350db, and 30 of the reporter's 31 active employments still had no shift. `required` was satisfiable:
 * the arrangement select offered "Roster", and `assignEmployeeShift` responded by FORCING
 * `default_shift_id` to null. So the field asked, and then let you decline — and a declined backup shift
 * means every unrostered day falls through `scheduleFor`'s third branch to the flat company work schedule,
 * which is the calculation gap the reporter reported. (An earlier incarnation of the same defect was a
 * literal "None — company default schedule" OPTION; the trap survived the option's removal because a
 * decline can hide in a second field.)
 *
 * What is asserted here, refusals first:
 *   1. assignEmployeeShift REFUSES a null shift on BOTH arrangements, and a refused write changes nothing.
 *   2. The coverage read finds exactly the active employments with no backup shift, and ignores terminated
 *      ones (they are not scheduled, so they cannot be uncovered).
 *   3. The backfill is a no-op unless applied, reports BEFORE and AFTER, and drives coverage to zero — the
 *      gate the Attendance Policy screen reads.
 *   4. The backfill REFUSES an ambiguous shift code rather than picking one (production carries two shifts
 *      both coded AM1), and refuses a code that matches nothing.
 *   5. THE ENGINE CONTRACT the plan states: a rostered day still overrides the backup shift, and attendance
 *      ALREADY RECORDED does not move when the backup shift changes underneath it.
 *
 * Dates: 2026-07-01 = Wednesday, 2026-07-02 = Thursday. Base company policy 09:00–18:00, 60m break, Mon–Fri.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import {
  BackupShiftRequiredError,
  assignEmployeeShift,
  assignShift,
  backfillBackupShift,
  createShift,
  employmentsWithoutBackupShift,
} from '../core/roster';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const WED = '2026-07-01';
const THU = '2026-07-02';

let b: Base;

async function makeEmp(name: string, code: string | null = null): Promise<string> {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `bs_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({
      tenantId: b.tenantId,
      personId: p.id,
      companyId: b.companyId,
      hiredOn: '2020-01-01',
      employeeCode: code,
    })
    .returning({ id: schema.employment.id });
  return e.id;
}

const stored = async (employmentId: string) => {
  const [row] = await owner.db
    .select({ ds: schema.employment.defaultShiftId, st: schema.employment.shiftType })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return row;
};

/** The shift the reporter named: 09:00–18:00, 60-minute break, Mon–Fri. */
const am03 = () =>
  createShift(adminCtx(b), {
    name: 'Morning 03',
    code: 'AM03',
    startTime: '09:00:00',
    endTime: '18:00:00',
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
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

describe('b8aa3466 — the backup shift can no longer be declined', () => {
  it('REFUSES a null shift on the Roster arrangement — the decline path R17 left open', async () => {
    const a = adminCtx(b);
    const emp = await makeEmp('Roster Rita');
    // The precise failure this asserts on: BackupShiftRequiredError, not "Employment not found" or a
    // schema error. The check runs BEFORE any lookup, so a made-up employment id would produce the same
    // rejection — hence a real employment, so the refusal is the one meant.
    await expect(
      assignEmployeeShift(a, { employmentId: emp, shiftType: 'roster', shiftId: null }),
    ).rejects.toBeInstanceOf(BackupShiftRequiredError);
    await expect(
      assignEmployeeShift(a, { employmentId: emp, shiftType: 'fixed', shiftId: '' }),
    ).rejects.toBeInstanceOf(BackupShiftRequiredError);
    expect(await stored(emp)).toEqual({ ds: null, st: 'roster' });
  });

  it('a Roster employee KEEPS their backup shift — it is what covers an unrostered day', async () => {
    const a = adminCtx(b);
    const emp = await makeEmp('Roster Rita');
    const s = await am03();
    await assignEmployeeShift(a, { employmentId: emp, shiftType: 'roster', shiftId: s.id });
    expect(await stored(emp)).toEqual({ ds: s.id, st: 'roster' });
  });
});

describe('b8aa3466 — coverage read', () => {
  it('lists exactly the ACTIVE employments with no backup shift', async () => {
    const a = adminCtx(b);
    const s = await am03();
    const covered = await makeEmp('Covered Carl', 'EMP-002');
    const uncovered = await makeEmp('Uncovered Uma', 'EMP-001');
    const terminated = await makeEmp('Gone Gary', 'EMP-003');
    await assignEmployeeShift(a, { employmentId: covered, shiftType: 'fixed', shiftId: s.id });
    // A terminated employment with no backup shift is NOT a coverage gap: nothing schedules it. Without
    // this the gate could never reach zero on a tenant with any history, and the removal it guards would
    // be unreachable for the wrong reason.
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2025-12-31' })
      .where(eq(schema.employment.id, terminated));

    const gaps = await employmentsWithoutBackupShift(a);
    expect(gaps.map((g) => g.employmentId)).toEqual([uncovered]);
    expect(gaps[0]).toMatchObject({ employeeCode: 'EMP-001', name: 'Uncovered Uma', companyId: b.companyId });
  });
});

describe('b8aa3466 — the AM03 backfill', () => {
  it('writes NOTHING without --apply, and reports the same BEFORE and AFTER list', async () => {
    const a = adminCtx(b);
    await am03();
    const emp = await makeEmp('Uncovered Uma', 'EMP-001');

    const dry = await backfillBackupShift(a, { shiftCode: 'AM03', apply: false });
    expect(dry.applied).toBe(false);
    expect(dry.assignedShiftId).toBeNull();
    expect(dry.before.map((r) => r.employmentId)).toEqual([emp]);
    expect(dry.after).toEqual(dry.before);
    expect(await stored(emp)).toEqual({ ds: null, st: 'roster' }); // a dry run must not touch the row
  });

  it('--apply points every uncovered ACTIVE employment at AM03 and drives coverage to zero', async () => {
    const a = adminCtx(b);
    const s = await am03();
    const e1 = await makeEmp('Uma', 'EMP-001');
    const e2 = await makeEmp('Vic', 'EMP-002');

    const res = await backfillBackupShift(a, { shiftCode: 'am03', apply: true }); // code match is case-insensitive
    expect(res.applied).toBe(true);
    expect(res.assignedShiftId).toBe(s.id);
    expect(res.before).toHaveLength(2);
    expect(res.after).toEqual([]);
    expect(await stored(e1)).toEqual({ ds: s.id, st: 'fixed' });
    expect(await stored(e2)).toEqual({ ds: s.id, st: 'fixed' });
    // THE GATE: this is the condition the Attendance Policy screen renders, and the reporter's
    // "the list of employees without a shift is zero".
    expect(await employmentsWithoutBackupShift(a)).toEqual([]);
  });

  it('REFUSES an ambiguous shift code instead of picking one', async () => {
    const a = adminCtx(b);
    await makeEmp('Uma', 'EMP-001');
    // Production carries two shifts both coded AM1 (09:00–18:00 and 06:00–16:00), plus AM1-copy / Test /
    // Test-2 — so "resolve a shift by its code" is not a lookup, it is a guess. Picking the first row
    // would point every uncovered employee at whichever one the planner happened to return.
    //
    // THE SECOND ROW IS INSERTED DIRECTLY, and that is the honest fixture rather than a shortcut. R33's
    // partial index (shift_tenant_code_uq: UNIQUE (tenant_id, lower(code)) WHERE archived_at IS NULL)
    // means createShift can no longer author a same-code pair — but the index compares `lower(code)`
    // while backfillBackupShift compares `code.trim().toLowerCase()`, so a legacy row whose code carries
    // whitespace is DISTINCT to the database and IDENTICAL to the backfill. That gap is exactly where a
    // silent coin-flip would live, and it is reachable only from data the current service cannot write.
    const keep = await createShift(a, {
      name: 'Morning A',
      code: 'AM1',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    });
    await owner.db.insert(schema.shift).values({
      tenantId: b.tenantId,
      name: 'Morning B (legacy)',
      code: 'AM1 ', // trailing space — lower('AM1 ') ≠ lower('AM1'), so the unique index permits it
      startTime: '06:00:00',
      endTime: '16:00:00',
      breakMinutes: 60,
    });
    await expect(backfillBackupShift(a, { shiftCode: 'AM1', apply: true })).rejects.toThrow(/matches 2 shifts/);
    expect(await employmentsWithoutBackupShift(a)).toHaveLength(1); // and nothing was written

    // The guard refuses the AMBIGUITY, not the feature: an unambiguous code in the same tenant still runs.
    const unique = await am03();
    const ok = await backfillBackupShift(a, { shiftCode: 'AM03', apply: true });
    expect(ok.assignedShiftId).toBe(unique.id);
    expect(ok.after).toEqual([]);
    expect(keep.id).not.toBe(unique.id);
  });

  it('REFUSES a code that matches no active shift', async () => {
    const a = adminCtx(b);
    await makeEmp('Uma', 'EMP-001');
    await expect(backfillBackupShift(a, { shiftCode: 'NOPE', apply: true })).rejects.toThrow(/No active shift/);
  });
});

describe('b8aa3466 — the engine contract the plan promises', () => {
  it('a rostered day still overrides the backup shift', async () => {
    const a = adminCtx(b);
    const backup = await am03(); // 09:00–18:00, 60m ⇒ 480 scheduled
    const night = await createShift(a, {
      name: 'Long day',
      code: 'LONG',
      startTime: '06:00:00',
      endTime: '18:00:00',
      breakMinutes: 60, // ⇒ 660 scheduled
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const emp = await makeEmp('Uma', 'EMP-001');
    await assignEmployeeShift(a, { employmentId: emp, shiftType: 'roster', shiftId: backup.id });
    await assignShift(a, { employmentId: emp, shiftDate: WED, shiftId: night.id });

    // WED is rostered onto the 660-minute shift: 06:00→19:00 = 720 worked, OT 60 (the backup shift would
    // have given 720−480 = 240).
    await checkIn(a, { employmentId: emp, date: WED, time: '06:00:00' });
    const rostered = await checkOut(a, { employmentId: emp, date: WED, time: '19:00:00' });
    expect(rostered).toMatchObject({ dayType: 'workday', workedMinutes: 720, otMinutes: 60 });

    // THU has no roster row, so the backup shift applies: 09:00→19:00 = 540 worked, OT 60 over its 480.
    await checkIn(a, { employmentId: emp, date: THU, time: '09:00:00' });
    const fallback = await checkOut(a, { employmentId: emp, date: THU, time: '19:00:00' });
    expect(fallback).toMatchObject({ dayType: 'workday', workedMinutes: 540, otMinutes: 60 });
  });

  it('ATTENDANCE ALREADY RECORDED does not move when the backup shift is changed underneath it', async () => {
    // The plan's headline reassurance, and the one claim a backfill could silently falsify. The engine
    // stamps worked/OT minutes onto the attendance row at write time and never re-derives history — so
    // the AM03 backfill changes how days calculate FORWARD and touches nothing behind it.
    const a = adminCtx(b);
    const emp = await makeEmp('Uma', 'EMP-001');
    await checkIn(a, { employmentId: emp, date: WED, time: '09:00:00' });
    const asRecorded = await checkOut(a, { employmentId: emp, date: WED, time: '19:00:00' });
    expect(asRecorded).toMatchObject({ workedMinutes: 540, otMinutes: 60 }); // company policy: 480 scheduled

    await am03();
    const long = await createShift(a, {
      name: 'Long day',
      code: 'LONG',
      startTime: '06:00:00',
      endTime: '18:00:00',
      breakMinutes: 60, // 660 scheduled — a day derived against THIS would have OT 0, not 60
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    await assignEmployeeShift(a, { employmentId: emp, shiftType: 'fixed', shiftId: long.id });

    const [row] = await owner.db
      .select({ worked: schema.attendance.workedMinutes, ot: schema.attendance.otMinutes })
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, emp));
    expect(row).toEqual({ worked: 540, ot: 60 });
  });
});
