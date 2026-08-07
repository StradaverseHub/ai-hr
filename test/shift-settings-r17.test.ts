/**
 * R17 3e8350db — Shift Settings enhancement. Covers the three genuinely-new behaviours:
 *   1. Per-shift late grace + early-leave grace override the company-policy defaults in scheduleFor (proved
 *      through checkIn/checkOut status, so it's the REAL engine path, not a display figure). NULL columns
 *      keep the legacy behaviour.
 *   2. R33 f21d6eee — shared tenant-wide shift library: createShift authors a tenant-global template
 *      (company_id NULL, listed by listShiftsForTenant), and name/code are unique tenant-wide. (The R17
 *      multi-company createShiftMulti / duplicateShift-to-company features were retired.)
 *   3. The employee "Shift Type" invariant — assignEmployeeShift. b8aa3466 CHANGED it: BOTH arrangements
 *      now require a backup shift (Roster used to force default_shift_id to null, which was the decline
 *      path that left 30 of 31 employments with no shift); shift_type is still stamped either way.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { checkIn, checkOut } from '../core/attendance';
import {
  assignDefaultShift,
  assignEmployeeShift,
  assignShift,
  copyRoster,
  createShift,
  deleteShift,
  BackupShiftRequiredError,
  ShiftHasNoWorkingPatternError,
  listShifts,
  listShiftsForTenant,
  rosterForRange,
  ShiftInUseError,
  updateShift,
} from '../core/roster';

const WED = '2026-07-01'; // ISO weekday 3

let b: Base;
let empId: string;

async function makeEmp() {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'R17', primaryEmail: `r17_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

const storedEmployment = async (id: string) => {
  const [row] = await owner.db
    .select({ ds: schema.employment.defaultShiftId, st: schema.employment.shiftType })
    .from(schema.employment)
    .where(eq(schema.employment.id, id));
  return row;
};

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  empId = await makeEmp();
});

describe('R17 per-shift grace windows drive scheduleFor lateness / early-leave', () => {
  it('late grace: within grace is present, past grace is late; a zero-grace shift is late at start+1', async () => {
    const a = adminCtx(b);
    const graced = await createShift(a, {
      companyId: b.companyId,
      name: 'Graced',
      code: 'GRACE30',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      lateGraceMinutes: 30,
    });
    await assignDefaultShift(a, { employmentId: empId, shiftId: graced.id });
    const r = await checkIn(a, { employmentId: empId, date: WED, time: '09:15:00' });
    expect(r.status).toBe('present'); // 09:15 < 09:00 + 30 grace

    // A second employee on a zero-grace shift is late at the same 09:15 clock-in.
    const emp2 = await makeEmp();
    const strict = await createShift(a, {
      companyId: b.companyId,
      name: 'Strict',
      code: 'GRACE0',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      lateGraceMinutes: 0,
    });
    await assignDefaultShift(a, { employmentId: emp2, shiftId: strict.id });
    const r2 = await checkIn(a, { employmentId: emp2, date: WED, time: '09:15:00' });
    expect(r2.status).toBe('late'); // 09:15 > 09:00 + 0 grace
  });

  /**
   * 7c834696 rev 2 point 4 removed the two grace INPUTS from the Shift Settings form while deliberately
   * keeping the columns and the precedence chain in core/attendance.ts, so a future per-shift override
   * still has somewhere to live. That is only true if saving the shift cannot erase one.
   *
   * The form is a full-row overwrite: before this release `updateShift` wrote `lateGraceMinutes` on every
   * save, and normalizeShiftInput collapsed an absent value to null — so the moment the inputs stopped
   * posting, any stored override would have been silently cleared by the next edit of an unrelated field.
   * Measured 0 of 9 production shifts carry one today, which is precisely why this needs a test rather
   * than a bug report: nothing would have noticed. `undefined` now preserves; explicit `null` still clears.
   */
  it('saving a shift WITHOUT the grace fields preserves a stored override; an explicit null still clears it', async () => {
    const a = adminCtx(b);
    const created = await createShift(a, {
      name: 'GracePreserve',
      code: `GP${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      lateGraceMinutes: 20,
      earlyLeaveGraceMinutes: 25,
    });
    const stored = async () => {
      const [row] = await owner.db
        .select({ late: schema.shift.lateGraceMinutes, early: schema.shift.earlyLeaveGraceMinutes })
        .from(schema.shift)
        .where(eq(schema.shift.id, created.id));
      return row;
    };
    expect(await stored()).toEqual({ late: 20, early: 25 });

    // Exactly what app/admin/attendance/shift-actions.ts now posts: the two keys are simply absent.
    await updateShift(a, {
      shiftId: created.id,
      name: 'GracePreserve renamed',
      code: `GP${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    });
    expect(await stored()).toEqual({ late: 20, early: 25 });

    // An explicit null is still a real instruction to clear — preserving that is what keeps the column usable.
    await updateShift(a, {
      shiftId: created.id,
      name: 'GracePreserve cleared',
      code: `GP${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      lateGraceMinutes: null,
      earlyLeaveGraceMinutes: null,
    });
    expect(await stored()).toEqual({ late: null, early: null });
  });

  it('early-leave grace: a checkout after end−grace is present, before it is a half-day', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'EarlyGrace',
      code: 'EGRACE',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      earlyLeaveGraceMinutes: 30, // half-day threshold = 17:30 (not the 13:30 midpoint default)
    });
    await assignDefaultShift(a, { employmentId: empId, shiftId: s.id });
    await checkIn(a, { employmentId: empId, date: WED, time: '09:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: WED, time: '17:15:00' });
    expect(out.status).toBe('half_day'); // 17:15 < 17:30 threshold
  });
});

describe('R33 f21d6eee — shared tenant-wide shift library', () => {
  it('createShift authors a tenant-global template (company_id NULL) visible via listShiftsForTenant', async () => {
    const a = adminCtx(b);
    const res = await createShift(a, {
      name: 'Office Hours',
      code: 'OFF',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    });
    expect(await eventTypesFor(b.tenantId, res.id)).toContain('shift.created');
    const lib = await listShiftsForTenant(a);
    expect(lib).toHaveLength(1);
    expect(lib[0]).toMatchObject({ id: res.id, companyId: null, code: 'OFF' });
    // Company-scoped listShifts does NOT return a tenant-global template (it has no company_id).
    expect(await listShifts(a, b.companyId)).toHaveLength(0);
  });

  it('name and code are unique tenant-wide (not per company)', async () => {
    const a = adminCtx(b);
    await createShift(a, { name: 'Day', code: 'DAY', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60 });
    // Same name / code again anywhere in the tenant is rejected (tenant-wide partial unique).
    await expect(
      createShift(a, { name: 'Day', code: 'DAY2', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60 }),
    ).rejects.toThrow(/already exists/i);
    await expect(
      createShift(a, { name: 'Day2', code: 'DAY', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60 }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe('R17 gap-fix — per-shift OT Rules shape workday overtime', () => {
  // Default shift 09:00–18:00 (break 60 ⇒ 480 normal minutes). Clocking 09:00→20:00 works 600 min ⇒ raw OT
  // 120 min. The per-shift OT rule then reshapes THAT figure.
  async function otMinutesFor(otRule: Parameters<typeof createShift>[1]['otRule']) {
    const a = adminCtx(b);
    const emp = await makeEmp();
    const sh = await createShift(a, {
      companyId: b.companyId,
      name: `OT ${randomUUID()}`,
      code: `OT${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      otRule,
    });
    await assignDefaultShift(a, { employmentId: emp, shiftId: sh.id });
    await checkIn(a, { employmentId: emp, date: WED, time: '09:00:00' });
    const out = await checkOut(a, { employmentId: emp, date: WED, time: '20:00:00' });
    return out.otMinutes;
  }

  it('no rule ⇒ full raw OT; cap clamps; minimum-block zeroes below threshold; ineligible zeroes', async () => {
    expect(await otMinutesFor(null)).toBe(120);
    expect(await otMinutesFor({ eligible: true, dailyCapMinutes: 30 })).toBe(30);
    expect(await otMinutesFor({ eligible: true, minMinutes: 200 })).toBe(0);
    expect(await otMinutesFor({ eligible: false })).toBe(0);
  });
});

describe('R17 gap-fix — hard delete shift (distinct from archive)', () => {
  it('deletes an unreferenced shift; refuses one referenced by roster or an employee default', async () => {
    const a = adminCtx(b);
    // Unreferenced ⇒ hard delete succeeds and the row is gone.
    const gone = await createShift(a, { companyId: b.companyId, name: 'Temp', code: 'TMP', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60 });
    await deleteShift(a, { shiftId: gone.id });
    expect(await listShifts(a, b.companyId)).toHaveLength(0);

    // Referenced by a roster row ⇒ blocked.
    const rostered = await createShift(a, { companyId: b.companyId, name: 'Rostered', code: 'RST', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60 });
    await assignShift(a, { employmentId: empId, shiftDate: WED, shiftId: rostered.id });
    await expect(deleteShift(a, { shiftId: rostered.id })).rejects.toBeInstanceOf(ShiftInUseError);

    // Referenced as an employee default ⇒ blocked.
    const def = await createShift(a, { companyId: b.companyId, name: 'Default', code: 'DEF', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });
    await assignDefaultShift(a, { employmentId: empId, shiftId: def.id });
    await expect(deleteShift(a, { shiftId: def.id })).rejects.toBeInstanceOf(ShiftInUseError);
  });
});

describe('R17 gap-fix — copy roster from a previous period', () => {
  it('copies shift + rest rows forward by the source→target day offset', async () => {
    const a = adminCtx(b);
    const sh = await createShift(a, { companyId: b.companyId, name: 'Morning', code: 'AM', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60 });
    // Source week: a shift on 2026-06-24 (Wed) for empId.
    await assignShift(a, { employmentId: empId, shiftDate: '2026-06-24', shiftId: sh.id });
    // Copy the source week 2026-06-22..28 forward to start 2026-06-29 (offset +7d ⇒ lands on 2026-07-01).
    const res = await copyRoster(a, {
      employmentIds: [empId],
      sourceFrom: '2026-06-22',
      sourceTo: '2026-06-28',
      targetFrom: '2026-06-29',
    });
    expect(res.copied).toBe(1);
    const target = await rosterForRange(a, { employmentIds: [empId], from: '2026-06-29', to: '2026-07-05' });
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({ shiftDate: '2026-07-01', shiftId: sh.id, isRestDay: false });
  });
});

describe('R17 employee Shift Type invariant', () => {
  // b8aa3466 REWROTE THIS TEST, and the old expectation is worth naming because it was the defect.
  // It read "Fixed requires a default shift; Roster CLEARS it" — and that clearing is how 30 of the
  // reporter's 31 employments ended up with no shift at all: picking Roster was a way to decline the
  // field, after which every unrostered day fell through to the flat company work schedule. Both
  // arrangements now REQUIRE a backup shift; shift_type says how the person is normally scheduled, not
  // whether they get a shift.
  it('BOTH arrangements require a backup shift — Roster no longer clears it', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'Day',
      code: 'DAY',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      // b8aa3466 — a mandatory backup shift must declare working days; this test is about the arrangement
      // invariant, so the shift needs a workable pattern to get past that separate guard.
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    await expect(
      assignEmployeeShift(a, { employmentId: empId, shiftType: 'fixed', shiftId: null }),
    ).rejects.toBeInstanceOf(BackupShiftRequiredError);
    // The decline path R17 left open: Roster used to be accepted with no shift and null the column.
    await expect(
      assignEmployeeShift(a, { employmentId: empId, shiftType: 'roster', shiftId: null }),
    ).rejects.toBeInstanceOf(BackupShiftRequiredError);
    expect(await storedEmployment(empId)).toEqual({ ds: null, st: 'roster' }); // a refused write changes nothing

    await assignEmployeeShift(a, { employmentId: empId, shiftType: 'fixed', shiftId: s.id });
    expect(await storedEmployment(empId)).toEqual({ ds: s.id, st: 'fixed' });

    // Roster KEEPS the backup shift now — it is what covers any day with no roster row.
    await assignEmployeeShift(a, { employmentId: empId, shiftType: 'roster', shiftId: s.id });
    expect(await storedEmployment(empId)).toEqual({ ds: s.id, st: 'roster' });
  });
});

describe('b8aa3466 — a MANDATORY backup shift must be one an employee can actually work', () => {
  /**
   * FOUND IN VERIFICATION, and it is the trap this item's own change opens.
   *
   * Making the backup shift mandatory promotes it from "one option among several" to THE fallback for every
   * employee on every date no roster covers. core/attendance.ts resolves that branch as
   * `ds.pattern?.includes(isoWeekday(date))`, so a shift with no weekly pattern matches NOTHING, falls
   * through to policyBranch('rest_day'), and the employee silently books every ordinary working day as a
   * REST DAY — which pays rest-day overtime multipliers on normal work and shows nobody an error.
   *
   * Nothing refused it before, because before this item nobody was forced to pick that shift.
   */
  it('REFUSES a backup shift whose weekly pattern is empty', async () => {
    const a = adminCtx(b);
    const emp = await makeEmp();
    const patternless = await createShift(a, {
      companyId: b.companyId,
      name: 'No working days',
      code: `NOPAT-${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [],
    });
    await expect(
      assignEmployeeShift(a, { employmentId: emp, shiftType: 'fixed', shiftId: patternless.id }),
    ).rejects.toBeInstanceOf(ShiftHasNoWorkingPatternError);
  });

  it('ALLOWS one that declares working days — the guard must not refuse everything', async () => {
    // The other half. A refusal test alone passes just as well against a function that always throws.
    const a = adminCtx(b);
    const emp = await makeEmp();
    const workable = await createShift(a, {
      companyId: b.companyId,
      name: 'Mon-Fri',
      code: `PAT-${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const res = await assignEmployeeShift(a, { employmentId: emp, shiftType: 'fixed', shiftId: workable.id });
    expect(res.id).toBe(emp);
  });
});
