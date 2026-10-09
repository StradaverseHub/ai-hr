/**
 * f6819e19 (r429) — MIGRATION 0519, READ OFF DISK AND EXECUTED, THE SAME DISCIPLINE
 * test/schedule-group-split-migration.test.ts USES FOR 0483.
 *
 * This item retires the whole-shift Flexible break switch from the Shift page. A shift still using it
 * (flexible_break_enabled = true) must deduct IDENTICAL minutes after this ships, so migration 0519 moves
 * its allowance onto its break rows wherever that is EXACT, and leaves anything it cannot convert exactly
 * alone. The load-bearing half of this file is therefore not "the migration ran" — it is "the engine
 * produced the identical worked/OT minutes before and after", read back from real punches, for:
 *   · a full day            (the allowance comes off a span long enough to use all of it)
 *   · a short day (<6h)     (shorter than the 6-hour cliff the shift's SCALAR break would otherwise use)
 *   · a day not covering the break window (the allowance is unconditional; a fixed window would not be)
 *   · a shift with a PAID row alongside the converted one (paid rows contribute 0 either side)
 *
 * The file is READ FROM DISK and its one DO block executed against seeded rows, so this test runs the
 * SQL that ships, not a paraphrase of it.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import { assignDefaultShift, createShift } from '../core/roster';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const MIGRATION = readFileSync(root + 'db/migrations/0519_shift_flexible_break_to_rows.sql', 'utf8');

/** The migration's one DATA block — everything after the last (only) drizzle breakpoint. */
const runMigrationData = async () => {
  const blocks = MIGRATION.split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.includes('DO $$'));
  // Non-vacuity of the harness itself: if the file ever stops containing exactly one DO block, this test
  // would silently assert nothing at all.
  expect(blocks).toHaveLength(1);
  await owner.db.execute(sql.raw(blocks[0]));
};

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

const shiftRow = async (id: string) => (await owner.db.select().from(schema.shift).where(eq(schema.shift.id, id)))[0];

let icSeq = 0;
const randomIc = () => `9301010${String(10000 + (icSeq += 1)).slice(-5)}`;

/** A whole employee on the given shift as their default (backup) shift — the branch every scenario below
 *  punches against. */
async function employeeOn(shiftId: string) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Flex Migration', primaryEmail: `fm_${randomUUID()}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await assignDefaultShift(a, { employmentId: e.employmentId, shiftId });
  return { a, employmentId: e.employmentId };
}

const TUE = '2026-05-05'; // a Tuesday (ISO 2)

async function punch(shiftId: string, inAt: string, outAt: string) {
  const { a, employmentId } = await employeeOn(shiftId);
  await checkIn(a, { employmentId, date: TUE, time: inAt });
  const out = await checkOut(a, { employmentId, date: TUE, time: outAt });
  return out;
}

/** MB28's exact production shape: 08:00-17:00, allowance 60, ONE unpaid break row 12:00-13:00 (length 60
 *  — N == sum(len(U)), the boundary case: every one of the row's 60 minutes is given to it). Convertible. */
const mb28Shape = (over: Partial<Parameters<typeof createShift>[1]> = {}) =>
  createShift(adminCtx(b), {
    name: `MB28_${randomUUID().slice(0, 6)}`,
    code: `MB28_${randomUUID().slice(0, 6)}`,
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 60,
    breakPeriods: [{ start: '12:00:00', end: '13:00:00' }],
    flexibleBreakEnabled: true,
    flexibleBreakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
    ...over,
  });

describe('f6819e19 — migration 0519 converts the whole-shift allowance onto the one row that can hold it', () => {
  it('rewrites the row: flexible_break_enabled off, the allowance moved onto the break row, break_minutes unchanged', async () => {
    const sh = await mb28Shape();
    const before = await shiftRow(sh.id);
    expect(before.flexibleBreakEnabled).toBe(true);
    expect(before.breakMinutes).toBe(60);

    await runMigrationData();

    const after = await shiftRow(sh.id);
    expect(after.flexibleBreakEnabled).toBe(false);
    expect(after.flexibleBreakMinutes).toBeNull();
    expect(after.breakMinutes, 'break_minutes is NOT touched — it already equalled N').toBe(60);
    expect(after.breakPeriods).toEqual([{ start: '12:00:00', end: '13:00:00', flexible: true, flexibleMinutes: 60 }]);
  });

  it('IDENTITY — a full day produces the identical worked and overtime minutes before and after', async () => {
    const before = await mb28Shape();
    const beforeOut = await punch(before.id, '08:00:00', '18:00:00'); // 600 span, allowance 60 ⇒ 540 worked, 60 OT

    const after = await mb28Shape();
    await runMigrationData();
    const afterOut = await punch(after.id, '08:00:00', '18:00:00');

    expect(afterOut.workedMinutes).toBe(beforeOut.workedMinutes);
    expect(afterOut.otMinutes).toBe(beforeOut.otMinutes);
    expect(beforeOut.workedMinutes).toBe(540);
    expect(beforeOut.otMinutes).toBe(60);
  });

  it('IDENTITY — a short day (<6h) loses the same allowance before and after (no 6-hour-cliff divergence)', async () => {
    const before = await mb28Shape();
    const beforeOut = await punch(before.id, '08:00:00', '11:30:00'); // 210 span, well under 6h

    const after = await mb28Shape();
    await runMigrationData();
    const afterOut = await punch(after.id, '08:00:00', '11:30:00');

    expect(afterOut.workedMinutes).toBe(beforeOut.workedMinutes);
    expect(afterOut.otMinutes).toBe(beforeOut.otMinutes);
  });

  it('IDENTITY — a day that never reaches the break window still loses the allowance, before and after', async () => {
    const before = await mb28Shape();
    const beforeOut = await punch(before.id, '08:00:00', '11:00:00'); // clocks out before 12:00

    const after = await mb28Shape();
    await runMigrationData();
    const afterOut = await punch(after.id, '08:00:00', '11:00:00');

    expect(afterOut.workedMinutes).toBe(beforeOut.workedMinutes);
    expect(afterOut.otMinutes).toBe(beforeOut.otMinutes);
    expect(beforeOut.workedMinutes).toBe(120); // 180 span − 60 allowance
  });

  it('IDENTITY — a PAID row alongside the converted one contributes zero, before and after', async () => {
    const shape = (code: string) =>
      createShift(adminCtx(b), {
        name: `MB28P_${code}`,
        code: `MB28P_${code}`,
        startTime: '08:00:00',
        endTime: '18:00:00',
        breakMinutes: 60,
        breakPeriods: [
          { start: '12:00:00', end: '13:00:00' },
          { start: '15:00:00', end: '15:15:00', paid: true },
        ],
        flexibleBreakEnabled: true,
        flexibleBreakMinutes: 60,
        weeklyPattern: [1, 2, 3, 4, 5],
      });
    const before = await shape(randomUUID().slice(0, 6));
    const beforeOut = await punch(before.id, '08:00:00', '19:00:00');

    const after = await shape(randomUUID().slice(0, 6));
    await runMigrationData();
    const afterOut = await punch(after.id, '08:00:00', '19:00:00');

    expect(afterOut.workedMinutes).toBe(beforeOut.workedMinutes);
    expect(afterOut.otMinutes).toBe(beforeOut.otMinutes);
  });
});

describe('f6819e19 — a shift the migration CANNOT convert exactly is left untouched', () => {
  it('no break rows at all (AM4’s production shape): the switch, the allowance and break_minutes all survive', async () => {
    const sh = await createShift(adminCtx(b), {
      name: `AM4_${randomUUID().slice(0, 6)}`,
      code: `AM4_${randomUUID().slice(0, 6)}`,
      startTime: '09:15:00',
      endTime: '18:15:00',
      breakMinutes: 60,
      flexibleBreakEnabled: true,
      flexibleBreakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const before = await shiftRow(sh.id);
    await runMigrationData();
    const after = await shiftRow(sh.id);

    expect(after.flexibleBreakEnabled).toBe(true);
    expect(after.flexibleBreakMinutes).toBe(60);
    expect(after.breakMinutes).toBe(60);
    expect(after.breakPeriods).toEqual(before.breakPeriods);

    // And the day it produces is UNCHANGED too — the switch is still what the engine reads.
    const out = await punch(sh.id, '09:15:00', '18:15:00');
    expect(out.workedMinutes).toBe(480); // 540 span − 60 allowance
  });

  it('the allowance exceeds the sum of the unpaid rows’ own lengths: left unchanged', async () => {
    const sh = await createShift(adminCtx(b), {
      name: `Over_${randomUUID().slice(0, 6)}`,
      code: `OVR_${randomUUID().slice(0, 6)}`,
      startTime: '08:00:00',
      endTime: '17:00:00',
      breakMinutes: 90,
      breakPeriods: [{ start: '12:00:00', end: '12:30:00' }], // only 30 minutes long
      flexibleBreakEnabled: true,
      flexibleBreakMinutes: 90, // > the row's own 30-minute length
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const before = await shiftRow(sh.id);
    await runMigrationData();
    const after = await shiftRow(sh.id);
    expect(after.flexibleBreakEnabled).toBe(true);
    expect(after.breakPeriods).toEqual(before.breakPeriods);
  });

  it('the allowance is smaller than the number of unpaid rows (each needs at least 1 minute): left unchanged', async () => {
    const sh = await createShift(adminCtx(b), {
      name: `TooFew_${randomUUID().slice(0, 6)}`,
      code: `TF_${randomUUID().slice(0, 6)}`,
      startTime: '08:00:00',
      endTime: '17:00:00',
      breakMinutes: 1,
      breakPeriods: [
        { start: '10:00:00', end: '10:15:00' },
        { start: '15:00:00', end: '15:15:00' },
      ],
      flexibleBreakEnabled: true,
      flexibleBreakMinutes: 1, // < count(U) = 2
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const before = await shiftRow(sh.id);
    await runMigrationData();
    const after = await shiftRow(sh.id);
    expect(after.flexibleBreakEnabled).toBe(true);
    expect(after.breakPeriods).toEqual(before.breakPeriods);
  });

  it('a shift with the switch OFF is never touched, converted or otherwise', async () => {
    const sh = await createShift(adminCtx(b), {
      name: `Off_${randomUUID().slice(0, 6)}`,
      code: `OFF_${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      breakPeriods: [{ start: '13:00:00', end: '14:00:00' }],
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const before = await shiftRow(sh.id);
    await runMigrationData();
    const after = await shiftRow(sh.id);
    expect(after).toEqual(before);
  });
});

describe('f6819e19 — the greedy distribution, asserted on a multi-row shift', () => {
  it('two unpaid rows share the remainder in ARRAY ORDER, each capped at its own length minus one', async () => {
    // Row 1 is 15 long, row 2 is 60 long. N = 50: base 1+1=2, remainder 48. Row 1 fills to its cap first
    // (14, using 14 of the 48), leaving 34 for row 2 (1+34=35) — both within bounds, summing to 50.
    const sh = await createShift(adminCtx(b), {
      name: `Greedy_${randomUUID().slice(0, 6)}`,
      code: `GR_${randomUUID().slice(0, 6)}`,
      startTime: '08:00:00',
      endTime: '18:00:00',
      breakMinutes: 50,
      breakPeriods: [
        { start: '10:00:00', end: '10:15:00' }, // 15 min
        { start: '13:00:00', end: '14:00:00' }, // 60 min
      ],
      flexibleBreakEnabled: true,
      flexibleBreakMinutes: 50,
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    await runMigrationData();
    const after = await shiftRow(sh.id);
    expect(after.flexibleBreakEnabled).toBe(false);
    expect(after.breakPeriods).toEqual([
      { start: '10:00:00', end: '10:15:00', flexible: true, flexibleMinutes: 15 },
      { start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 35 },
    ]);
    const total = (after.breakPeriods as { flexibleMinutes: number }[]).reduce((acc, bp) => acc + bp.flexibleMinutes, 0);
    expect(total).toBe(50);
  });
});
