/**
 * R17 3e8350db — Shift Settings enhancement. Covers the three genuinely-new behaviours:
 *   1. Per-shift late grace + early-leave grace override the company-policy defaults in scheduleFor (proved
 *      through checkIn/checkOut status, so it's the REAL engine path, not a display figure). NULL columns
 *      keep the legacy behaviour.
 *   2. Centralized authoring — createShiftMulti creates one row + one shift.created event PER company;
 *      duplicateShift with targetCompanyIds copies a shift into another company (full-field, incl. grace).
 *   3. The employee "Shift Type" invariant — assignEmployeeShift: Fixed requires a default shift, Roster
 *      forces default_shift_id to null and stamps shift_type.
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
  createShiftMulti,
  deleteShift,
  duplicateShift,
  FixedShiftRequiresShiftError,
  listShifts,
  rosterForRange,
  ShiftInUseError,
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

async function secondCompany() {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: `Beta ${randomUUID()}` })
    .returning({ id: schema.company.id });
  return c.id;
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

describe('R17 centralized authoring — multi-company create + copy-to-company', () => {
  it('createShiftMulti inserts one row + one shift.created event per company', async () => {
    const a = adminCtx(b);
    const c2 = await secondCompany();
    const res = await createShiftMulti(a, {
      companyIds: [b.companyId, c2],
      name: 'Office Hours',
      code: 'OFF',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    });
    expect(res.ids).toHaveLength(2);
    expect(await listShifts(a, b.companyId)).toHaveLength(1);
    expect(await listShifts(a, c2)).toHaveLength(1);
    for (const id of res.ids) expect(await eventTypesFor(b.tenantId, id)).toContain('shift.created');
  });

  it('duplicateShift with targetCompanyIds copies a shift (incl. grace) into another company', async () => {
    const a = adminCtx(b);
    const c2 = await secondCompany();
    const src = await createShift(a, {
      companyId: b.companyId,
      name: 'Night',
      code: 'NIGHT',
      startTime: '22:00:00',
      endTime: '06:00:00',
      breakMinutes: 45,
      lateGraceMinutes: 10,
      earlyLeaveGraceMinutes: 20,
      otRule: { eligible: true, dailyCapMinutes: 30 },
    });
    const dup = await duplicateShift(a, { shiftId: src.id, targetCompanyIds: [c2] });
    expect(dup.ids).toHaveLength(1);
    const target = await listShifts(a, c2);
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({ code: 'NIGHT', lateGraceMinutes: 10, earlyLeaveGraceMinutes: 20 });
    // Duplicate must preserve the per-shift OT rule (not persist NULL).
    expect(target[0].otRule).toEqual({ eligible: true, dailyCapMinutes: 30 });
    // Source company still has just its own row (the copy landed in c2).
    expect(await listShifts(a, b.companyId)).toHaveLength(1);
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
  it('Fixed requires a default shift; Roster clears it; both stamp shift_type', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'Day',
      code: 'DAY',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    });
    await expect(
      assignEmployeeShift(a, { employmentId: empId, shiftType: 'fixed', shiftId: null }),
    ).rejects.toBeInstanceOf(FixedShiftRequiresShiftError);

    await assignEmployeeShift(a, { employmentId: empId, shiftType: 'fixed', shiftId: s.id });
    expect(await storedEmployment(empId)).toEqual({ ds: s.id, st: 'fixed' });

    // Roster forces default_shift_id null even if a shiftId is passed.
    await assignEmployeeShift(a, { employmentId: empId, shiftType: 'roster', shiftId: s.id });
    expect(await storedEmployment(empId)).toEqual({ ds: null, st: 'roster' });
  });
});
