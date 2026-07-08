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
  createShift,
  createShiftMulti,
  duplicateShift,
  FixedShiftRequiresShiftError,
  listShifts,
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
    });
    const dup = await duplicateShift(a, { shiftId: src.id, targetCompanyIds: [c2] });
    expect(dup.ids).toHaveLength(1);
    const target = await listShifts(a, c2);
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({ code: 'NIGHT', lateGraceMinutes: 10, earlyLeaveGraceMinutes: 20 });
    // Source company still has just its own row (the copy landed in c2).
    expect(await listShifts(a, b.companyId)).toHaveLength(1);
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
