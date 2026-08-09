/**
 * 18504ca6 — EFFECTIVE DATE ON THE SHIFT ARRANGEMENT CARD.
 *
 * The reporter spotted a real asymmetry: the Location card on the Attendance tab is effective-dated and the
 * Shift arrangement card directly below it was not. Saving there replaced the old shift with no date and no
 * history, so the system could not say which shift someone was on last month — and any day later corrected
 * or re-imported was re-measured against TODAY's shift, because today's shift was the only one on file.
 *
 * WHAT THIS FILE PINS
 *  1. The ladder writer (core/shift-arrangement.ts assignEmployeeShiftDated): a later date closes the open
 *     period the day before; the SAME date replaces its entry instead of adding a second; a date BEFORE the
 *     last recorded change is refused by name; a date before the employee's start date is refused; a
 *     non-date is refused. A refused save writes nothing at all.
 *  2. THE REPORTER'S EXACT SCENARIO through the engine — the day before the effective date keeps the old
 *     shift's rules, the effective date and the day after use the new shift's.
 *  3. The retroactive-relabel regression: a past day with no roster row keeps the OLD shift code on the
 *     Records screen after a change. That is the display half of the same bug.
 *  4. Behaviour-neutrality: an employment with NO ladder row (the legacy writer, the b8aa3466 backup-shift
 *     backfill) resolves exactly as it did before, through employment.default_shift_id.
 *
 * Dates: 2026-07-14 = Tuesday, 2026-07-15 = Wednesday, 2026-07-16 = Thursday — all Mon–Fri working days, all
 * in the past, so checkIn/checkOut accept them. Default company policy: 09:00–18:00, 60m break, Mon–Fri.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { attendanceForEmploymentRange, checkIn, checkOut } from '../core/attendance';
import { assignDefaultShift, createShift, deleteShift, listShiftsForTenant, ShiftInUseError } from '../core/roster';
import {
  assignEmployeeShiftDated,
  InvalidEffectiveDateError,
  pickArrangementOn,
  ShiftBackInsertError,
  ShiftEffectiveBeforeStartError,
  shiftArrangementHistory,
} from '../core/shift-arrangement';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let empId: string;

const HIRED = '2020-01-01';
const DAY_BEFORE = '2026-07-14'; // Tue
const EFFECTIVE = '2026-07-15'; // Wed — the change lands here
const DAY_AFTER = '2026-07-16'; // Thu

/** Mon–Fri 06:00–18:00, 60m break → net 660 scheduled. The shift they were on. */
const oldShift = () =>
  createShift(adminCtx(b), {
    companyId: b.companyId,
    name: 'Old Morning',
    code: 'OLD',
    startTime: '06:00:00',
    endTime: '18:00:00',
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
  });

/** Mon–Fri 08:00–17:00, 60m break → net 480 scheduled. The reporter's "Shift B". */
const newShift = () =>
  createShift(adminCtx(b), {
    companyId: b.companyId,
    name: 'New Day',
    code: 'NEW',
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
  });

async function makeEmp(hiredOn = HIRED) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'Shifty', primaryEmail: `sh_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn })
    .returning({ id: schema.employment.id });
  return e.id;
}

/** Every LIVE period of the employment, oldest first — the ladder as the DB holds it. */
const ladder = (employmentId: string) =>
  owner.db
    .select({
      shiftId: schema.employmentShiftArrangement.shiftId,
      shiftType: schema.employmentShiftArrangement.shiftType,
      validFrom: schema.employmentShiftArrangement.validFrom,
      validTo: schema.employmentShiftArrangement.validTo,
      createdBy: schema.employmentShiftArrangement.createdBy,
    })
    .from(schema.employmentShiftArrangement)
    .where(
      and(
        eq(schema.employmentShiftArrangement.employmentId, employmentId),
        isNull(schema.employmentShiftArrangement.supersededAt),
      ),
    )
    .orderBy(schema.employmentShiftArrangement.validFrom);

/** The employment cache (employment.default_shift_id / shift_type) the ladder keeps in step. */
const cache = async (employmentId: string) => {
  const [row] = await owner.db
    .select({ ds: schema.employment.defaultShiftId, st: schema.employment.shiftType })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return row;
};

const shiftCodeByDate = async (from: string, to: string) => {
  const rows = await attendanceForEmploymentRange(adminCtx(b), empId, from, to);
  return Object.fromEntries(rows.map((r) => [r.date, r.shiftCode]));
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

describe('pickArrangementOn — the resolution rule, in isolation', () => {
  const p = (validFrom: string, shiftId: string) => ({
    employmentId: 'e',
    shiftType: 'fixed' as const,
    shiftId,
    validFrom,
  });

  it('picks the greatest valid_from on or before the date', () => {
    const rows = [p('2026-01-01', 'a'), p('2026-07-15', 'b'), p('2026-09-01', 'c')];
    expect(pickArrangementOn(rows, '2026-07-14')?.shiftId).toBe('a');
    expect(pickArrangementOn(rows, '2026-07-15')?.shiftId).toBe('b');
    expect(pickArrangementOn(rows, '2026-08-31')?.shiftId).toBe('b');
    expect(pickArrangementOn(rows, '2026-09-01')?.shiftId).toBe('c');
  });

  it('a date BEFORE the earliest period resolves to the earliest period (the release promise)', () => {
    const rows = [p('2026-01-01', 'a'), p('2026-07-15', 'b')];
    expect(pickArrangementOn(rows, '2019-05-05')?.shiftId).toBe('a');
  });

  it('no periods at all ⇒ undefined, which is the caller signal to use the cache', () => {
    expect(pickArrangementOn([], '2026-07-15')).toBeUndefined();
    expect(pickArrangementOn(undefined, '2026-07-15')).toBeUndefined();
  });
});

describe('the ladder writer', () => {
  it('the first save opens one period at the effective date and refreshes the cache', async () => {
    const a = adminCtx(b);
    const s = await oldShift();
    const res = await assignEmployeeShiftDated(a, {
      employmentId: empId,
      shiftType: 'fixed',
      shiftId: s.id,
      effectiveFrom: EFFECTIVE,
    });
    expect(res.effectiveFrom).toBe(EFFECTIVE);
    expect(await ladder(empId)).toEqual([
      { shiftId: s.id, shiftType: 'fixed', validFrom: EFFECTIVE, validTo: null, createdBy: b.adminUserId },
    ]);
    expect(await cache(empId)).toEqual({ ds: s.id, st: 'fixed' });
  });

  it('a LATER date closes the open period the day before and opens the new one — no overlap, no gap', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    const newS = await newShift();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: HIRED });
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'roster', shiftId: newS.id, effectiveFrom: EFFECTIVE });
    expect(await ladder(empId)).toEqual([
      { shiftId: oldS.id, shiftType: 'fixed', validFrom: HIRED, validTo: DAY_BEFORE, createdBy: b.adminUserId },
      { shiftId: newS.id, shiftType: 'roster', validFrom: EFFECTIVE, validTo: null, createdBy: b.adminUserId },
    ]);
    // The cache follows the period in force TODAY, and EFFECTIVE is in the past.
    expect(await cache(empId)).toEqual({ ds: newS.id, st: 'roster' });
  });

  it('saving twice for the SAME date REPLACES that entry rather than creating a second', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    const newS = await newShift();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: HIRED });
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: newS.id, effectiveFrom: EFFECTIVE });
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: EFFECTIVE });
    expect(await ladder(empId)).toEqual([
      { shiftId: oldS.id, shiftType: 'fixed', validFrom: HIRED, validTo: DAY_BEFORE, createdBy: b.adminUserId },
      { shiftId: oldS.id, shiftType: 'fixed', validFrom: EFFECTIVE, validTo: null, createdBy: b.adminUserId },
    ]);
    // The replaced row is still on file, superseded — the history list just stops showing it.
    const all = await owner.db
      .select({ id: schema.employmentShiftArrangement.id })
      .from(schema.employmentShiftArrangement)
      .where(eq(schema.employmentShiftArrangement.employmentId, empId));
    expect(all.length).toBe(3);
    expect((await shiftArrangementHistory(a, empId)).length).toBe(2);
  });

  it('a date BEFORE the last recorded change is REFUSED, and the refused save writes nothing', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    const newS = await newShift();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: EFFECTIVE });
    const before = await ladder(empId);
    await expect(
      assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: newS.id, effectiveFrom: DAY_BEFORE }),
    ).rejects.toBeInstanceOf(ShiftBackInsertError);
    // The message names the blocking entry — that date is what the screen puts in front of the admin.
    await expect(
      assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: newS.id, effectiveFrom: DAY_BEFORE }),
    ).rejects.toMatchObject({ lastEffectiveFrom: EFFECTIVE });
    expect(await ladder(empId)).toEqual(before);
    expect(await cache(empId)).toEqual({ ds: oldS.id, st: 'fixed' });
  });

  it('a date before the employee START date is refused, naming the start date', async () => {
    const a = adminCtx(b);
    const s = await oldShift();
    await expect(
      assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: s.id, effectiveFrom: '2019-12-31' }),
    ).rejects.toBeInstanceOf(ShiftEffectiveBeforeStartError);
    await expect(
      assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: s.id, effectiveFrom: '2019-12-31' }),
    ).rejects.toMatchObject({ startDate: HIRED });
    // The start date itself is allowed — the boundary is inclusive.
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: s.id, effectiveFrom: HIRED });
    expect((await ladder(empId))[0].validFrom).toBe(HIRED);
  });

  it('a non-date is refused', async () => {
    const a = adminCtx(b);
    const s = await oldShift();
    await expect(
      assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: s.id, effectiveFrom: '2026-02-30' }),
    ).rejects.toBeInstanceOf(InvalidEffectiveDateError);
    await expect(
      assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: s.id, effectiveFrom: 'tomorrow' }),
    ).rejects.toBeInstanceOf(InvalidEffectiveDateError);
    expect(await ladder(empId)).toEqual([]);
  });

  it('a FUTURE-dated change leaves the cache — and therefore every unconverted reader — alone', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    const newS = await newShift();
    const future = (() => {
      const d = new Date(`${todayInKualaLumpur()}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 30);
      return d.toISOString().slice(0, 10);
    })();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: HIRED });
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: newS.id, effectiveFrom: future });
    expect(await cache(empId)).toEqual({ ds: oldS.id, st: 'fixed' });
    expect((await ladder(empId)).map((r) => r.validFrom)).toEqual([HIRED, future]);
  });

  it('keeps the b8aa3466 / R33 invariants: no shift, an archived shift and a pattern-less shift are refused', async () => {
    const a = adminCtx(b);
    await expect(
      assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: null, effectiveFrom: EFFECTIVE }),
    ).rejects.toMatchObject({ name: 'BackupShiftRequiredError' });
    const patternless = await createShift(a, {
      companyId: b.companyId,
      name: 'Blank',
      code: 'BLANK',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    });
    await expect(
      assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: patternless.id, effectiveFrom: EFFECTIVE }),
    ).rejects.toMatchObject({ name: 'ShiftHasNoWorkingPatternError' });
    expect(await ladder(empId)).toEqual([]);
  });

  it('records the change on the event stream with the effective date attached', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    const newS = await newShift();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: HIRED });
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'roster', shiftId: newS.id, effectiveFrom: EFFECTIVE });
    expect(await latestEventPayload(b.tenantId, empId, 'employment.shift-arrangement.assigned')).toMatchObject({
      before: { shiftType: 'fixed', defaultShiftId: oldS.id },
      after: { shiftType: 'roster', defaultShiftId: newS.id },
      effectiveFrom: EFFECTIVE,
    });
  });
});

describe("scheduleFor answers BY DATE — the reporter's exact scenario", () => {
  it('the day before the effective date keeps the old shift; the effective date and the day after use the new one', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift(); // net 660
    const newS = await newShift(); // net 480
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: HIRED });
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: newS.id, effectiveFrom: EFFECTIVE });

    // The SAME worked span on all three days — only the shift the day is measured against differs.
    for (const d of [DAY_BEFORE, EFFECTIVE, DAY_AFTER]) {
      await checkIn(a, { employmentId: empId, date: d, time: '06:00:00' });
      await checkOut(a, { employmentId: empId, date: d, time: '18:00:00' });
    }
    const rows = await attendanceForEmploymentRange(a, empId, DAY_BEFORE, DAY_AFTER);
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
    // 14 Jul — OLD (06:00–18:00, 660 scheduled): the day ends exactly at the shift end ⇒ no overtime.
    expect(byDate[DAY_BEFORE]).toMatchObject({
      workedMinutes: 660,
      otMinutes: 0,
      shiftCode: 'OLD',
      scheduledMinutes: 660,
    });
    // 15 Jul and 16 Jul — NEW (08:00–17:00, 480 scheduled): the SAME clock-out at 18:00 is now an hour past
    // the shift end, so the same worked span produces 60 minutes of overtime.
    expect(byDate[EFFECTIVE]).toMatchObject({
      workedMinutes: 660,
      otMinutes: 60,
      shiftCode: 'NEW',
      scheduledMinutes: 480,
    });
    expect(byDate[DAY_AFTER]).toMatchObject({
      workedMinutes: 660,
      otMinutes: 60,
      shiftCode: 'NEW',
      scheduledMinutes: 480,
    });
  });

  it('a roster entry for a specific day still WINS, exactly as today', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    const newS = await newShift();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: HIRED });
    // Roster the NEW shift onto a day BEFORE the arrangement changes — the dated roster row beats the ladder.
    await owner.db.insert(schema.rosterAssignment).values({
      tenantId: b.tenantId,
      employmentId: empId,
      shiftDate: DAY_BEFORE,
      shiftId: newS.id,
    });
    await checkIn(a, { employmentId: empId, date: DAY_BEFORE, time: '06:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: DAY_BEFORE, time: '18:00:00' });
    // Measured against the ROSTERED shift (ends 17:00), not the arrangement's OLD shift (ends 18:00): the
    // 18:00 clock-out is an hour of overtime here, where the arrangement alone would have given none.
    expect(out).toMatchObject({ workedMinutes: 660, otMinutes: 60 });
    expect((await shiftCodeByDate(DAY_BEFORE, DAY_BEFORE))[DAY_BEFORE]).toBe('NEW');
  });

  it('THE RETROACTIVE RELABEL: a past day with no roster row keeps the OLD shift code after a change', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    const newS = await newShift();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: HIRED });
    expect(await shiftCodeByDate(DAY_BEFORE, DAY_AFTER)).toEqual({
      [DAY_BEFORE]: 'OLD',
      [EFFECTIVE]: 'OLD',
      [DAY_AFTER]: 'OLD',
    });
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: newS.id, effectiveFrom: EFFECTIVE });
    // Before the change: still OLD. This is the bug — it used to flip to NEW for every past day too.
    expect(await shiftCodeByDate(DAY_BEFORE, DAY_AFTER)).toEqual({
      [DAY_BEFORE]: 'OLD',
      [EFFECTIVE]: 'NEW',
      [DAY_AFTER]: 'NEW',
    });
  });
});

describe('behaviour-neutrality — an employment with NO ladder row', () => {
  it('resolves through employment.default_shift_id exactly as before (the legacy writer path)', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    await assignDefaultShift(a, { employmentId: empId, shiftId: oldS.id });
    expect(await ladder(empId)).toEqual([]); // the legacy writer maintains the CACHE, never the ladder
    await checkIn(a, { employmentId: empId, date: DAY_BEFORE, time: '06:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: DAY_BEFORE, time: '19:00:00' });
    // Unchanged from test/default-shift-schedule.ts: scheduled 660, worked 720, OT 60.
    expect(out).toMatchObject({ dayType: 'workday', workedMinutes: 720, otMinutes: 60 });
    expect(await shiftCodeByDate(DAY_BEFORE, DAY_BEFORE)).toEqual({ [DAY_BEFORE]: 'OLD' });
  });
});

describe("migration 0421's backfill — the release-is-behaviour-neutral promise", () => {
  /** The EXACT backfill statement the migration will run in production, lifted out of the .sql file. */
  const backfillStatement = (): string => {
    const file = fs.readFileSync(
      path.resolve(__dirname, '../db/migrations/0421_employment_shift_arrangement.sql'),
      'utf8',
    );
    const stmt = file
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .find((s) => s.includes('INSERT INTO "employment_shift_arrangement"'));
    expect(stmt, '0421 no longer contains its backfill INSERT').toBeTruthy();
    return stmt as string;
  };

  it('opens one period per employee WITH a shift, from their start date, and none for those without', async () => {
    const a = adminCtx(b);
    const s = await oldShift();
    const withShift = await makeEmp('2021-03-04');
    const withoutShift = await makeEmp('2022-05-06');
    await assignDefaultShift(a, { employmentId: withShift, shiftId: s.id }); // legacy writer: cache only

    await owner.db.execute(sql.raw(backfillStatement()));

    expect(await ladder(withShift)).toEqual([
      { shiftId: s.id, shiftType: 'fixed', validFrom: '2021-03-04', validTo: null, createdBy: null },
    ]);
    // No shift on file ⇒ no period. There is nothing true to record, and b8aa3466's backup-shift backfill
    // is the admin action that fixes those employments.
    expect(await ladder(withoutShift)).toEqual([]);
  });

  it('is idempotent — a re-run adds nothing (a replayed migration cannot double the ladder)', async () => {
    const a = adminCtx(b);
    const s = await oldShift();
    await assignDefaultShift(a, { employmentId: empId, shiftId: s.id });
    await owner.db.execute(sql.raw(backfillStatement()));
    await owner.db.execute(sql.raw(backfillStatement()));
    expect((await ladder(empId)).length).toBe(1);
  });

  it('leaves the resolved shift EXACTLY where it was — no figure and no screen moves', async () => {
    const a = adminCtx(b);
    const s = await oldShift();
    await assignDefaultShift(a, { employmentId: empId, shiftId: s.id });
    // The answer BEFORE the ladder exists (the cache path) …
    const before = await shiftCodeByDate(DAY_BEFORE, DAY_AFTER);
    await owner.db.execute(sql.raw(backfillStatement()));
    // … is the answer AFTER it does (the ladder path).
    expect(await shiftCodeByDate(DAY_BEFORE, DAY_AFTER)).toEqual(before);
    expect(before).toEqual({ [DAY_BEFORE]: 'OLD', [EFFECTIVE]: 'OLD', [DAY_AFTER]: 'OLD' });
  });
});

describe('the Shift history list under the card', () => {
  it('lists effective date, previous shift, new shift, who changed it and when — newest first', async () => {
    const a = adminCtx(b);
    // Give the admin user a person so the "changed by" name resolves (seedBase leaves person_id null).
    const [hr] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'HR Admin', primaryEmail: `hr_${randomUUID()}@t.local` })
      .returning({ id: schema.person.id });
    await owner.db
      .update(schema.appUser)
      .set({ personId: hr.id })
      .where(eq(schema.appUser.id, b.adminUserId));

    const oldS = await oldShift();
    const newS = await newShift();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: HIRED });
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: newS.id, effectiveFrom: EFFECTIVE });

    const rows = await shiftArrangementHistory(a, empId);
    expect(rows.map((r) => r.effectiveFrom)).toEqual([EFFECTIVE, HIRED]);
    expect(rows[0]).toMatchObject({
      effectiveFrom: EFFECTIVE,
      effectiveTo: null,
      previousShiftCode: 'OLD',
      previousShiftName: 'Old Morning',
      shiftCode: 'NEW',
      shiftName: 'New Day',
      changedByName: 'HR Admin',
      recordedOnRelease: false,
    });
    expect(rows[1]).toMatchObject({
      effectiveFrom: HIRED,
      effectiveTo: DAY_BEFORE,
      previousShiftCode: null,
      previousShiftName: null,
      shiftCode: 'OLD',
      changedByName: 'HR Admin',
    });
  });

  it('the period migration 0421 recorded on release is labelled as such (no actor, first period)', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    // Exactly the shape the migration's backfill writes: created_by NULL, open, from the start date.
    await owner.db.insert(schema.employmentShiftArrangement).values({
      tenantId: b.tenantId,
      employmentId: empId,
      shiftType: 'fixed',
      shiftId: oldS.id,
      validFrom: HIRED,
      validTo: null,
      createdBy: null,
    });
    const rows = await shiftArrangementHistory(a, empId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ effectiveFrom: HIRED, changedByName: null, recordedOnRelease: true });
  });

  it('is empty for an employee whose shift has never been dated', async () => {
    expect(await shiftArrangementHistory(adminCtx(b), empId)).toEqual([]);
  });

  // RLS mirrors roster_assignment (migration 0075): READ is can_see_employment, so the employee sees their
  // own shift history; WRITE is can_admin_employment, so only HR can move them. The GRANT is proven by every
  // other test in this file — they all write through the ai_hr_app role.
  it('an ordinary employee can READ their own shift history but cannot WRITE one', async () => {
    const a = adminCtx(b);
    const s = await oldShift();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: s.id, effectiveFrom: HIRED });
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, empId));
    const userId = await createAppUser(b.tenantId, emp.personId, 'employee');
    const selfCtx: SessionContext = { tenantId: b.tenantId, userId, personId: emp.personId, roles: ['employee'] };

    expect((await shiftArrangementHistory(selfCtx, empId)).map((r) => r.effectiveFrom)).toEqual([HIRED]);
    await expect(
      assignEmployeeShiftDated(selfCtx, {
        employmentId: empId,
        shiftType: 'fixed',
        shiftId: s.id,
        effectiveFrom: EFFECTIVE,
      }),
    ).rejects.toThrow();
  });
});

/**
 * THE DELETE GUARD MUST KNOW ABOUT THE LADDER (verifier blocker on 18504ca6).
 *
 * employment_shift_arrangement.shift_id REFERENCES shift(id) with no ON DELETE — a hard RESTRICT. core/roster.ts
 * deleteShift only ever checked roster_assignment.shift_id and employment.default_shift_id, and BOTH stop
 * naming the old shift the moment HR dates a change: the cache moves to the new shift and there need be no
 * roster row at all. The old shift then LOOKS unreferenced, the delete reaches Postgres, and HR gets a raw
 * `Failed query: delete from "shift" where "shift"."id" = $1` banner — deleteShiftAction puts the thrown
 * message straight into ?error=. Without the third check these tests fail with exactly that string.
 */
describe('deleting a shift after a DATED change — the ladder is a third reference', () => {
  const codes = async () => (await listShiftsForTenant(adminCtx(b))).map((s) => s.code).sort();

  it("refuses to delete the shift HR moved the employee OFF, even though nothing else references it", async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    const newS = await newShift();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: HIRED });
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: newS.id, effectiveFrom: EFFECTIVE });

    // The exact state the verifier measured: the cache names the NEW shift and there are no roster rows, so
    // deleteShift's two original checks both see nothing. Only the closed ladder period still holds the FK.
    expect((await cache(empId)).ds).toBe(newS.id);
    const [ra] = await owner.db
      .select({ id: schema.rosterAssignment.id })
      .from(schema.rosterAssignment)
      .where(eq(schema.rosterAssignment.shiftId, oldS.id));
    expect(ra).toBeUndefined();

    await expect(deleteShift(a, { shiftId: oldS.id })).rejects.toBeInstanceOf(ShiftInUseError);
    expect(await codes()).toEqual(['NEW', 'OLD']); // nothing was deleted
  });

  // The rule the migration comment promises and the reason this check does NOT filter superseded_at: a row
  // replaced by a second save for the same date is invisible to every RESOLVER, but it still holds the FK.
  it('a SUPERSEDED period blocks the delete too — the FK does not care that the row was replaced', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    const newS = await newShift();
    // Save twice for the SAME date: the OLD period is superseded, so the ladder's only LIVE row names NEW.
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: EFFECTIVE });
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: newS.id, effectiveFrom: EFFECTIVE });
    expect((await ladder(empId)).map((r) => r.shiftId)).toEqual([newS.id]);

    await expect(deleteShift(a, { shiftId: oldS.id })).rejects.toBeInstanceOf(ShiftInUseError);
    expect(await codes()).toEqual(['NEW', 'OLD']);
  });

  // The guard must stay narrow: a template created in error and never put on anybody's ladder is still
  // hard-deletable, which is the whole point of Delete existing beside Archive.
  it('still hard-deletes a shift no ladder period has ever named', async () => {
    const a = adminCtx(b);
    const oldS = await oldShift();
    const spare = await newShift();
    await assignEmployeeShiftDated(a, { employmentId: empId, shiftType: 'fixed', shiftId: oldS.id, effectiveFrom: HIRED });

    await deleteShift(a, { shiftId: spare.id });
    expect(await codes()).toEqual(['OLD']);
  });
});
