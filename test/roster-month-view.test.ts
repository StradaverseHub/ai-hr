/**
 * rosterMonthView (item 23390097) — the ONE read behind both the monthly grid and its export.
 *
 * It exists so the file and the screen cannot disagree: the export route re-reads this, with the same
 * company / Business Group / Department / Employee narrowing carried in the query string, instead of
 * rebuilding the month from its own copy of the rules. These tests pin the three things a second
 * implementation would have got subtly wrong:
 *
 *   · the filters narrow the GRID but not the DROPDOWNS — `allEmployees` stays whole, so choosing a
 *     department cannot make the department list collapse to one entry;
 *   · a terminated employee is not on the roster at all;
 *   · the usual (default) shift comes back WITH its weekly pattern, because the pattern is what decides
 *     whether an un-rostered date reads as a grey ghost or as OFF, and a view that returned the shift
 *     without it would silently make every OFF day look scheduled.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { assignDefaultShift, assignShift, createShift, rosterMonthView, setRestDay } from '../core/roster';

let b: Base;
let ctx: ReturnType<typeof adminCtx>;
let finance = '';
let ops = '';
let leaver = '';
let morning = '';

async function hire(code: string, name: string, departmentId: string) {
  const r = await hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${code.toLowerCase()}@t.local` },
    companyId: b.companyId,
    departmentId,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
    employeeCode: code,
  });
  return r.employmentId;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ctx = adminCtx(b);
  finance = await hire('A0003', 'Lim Chee Keong', b.deptA);
  ops = await hire('A0005', 'Muthusamy Ramasamy', b.deptB);
  leaver = await hire('A0009', 'Former Staff', b.deptB);
  await owner.db.update(schema.employment).set({ terminatedOn: '2026-01-31' }).where(eq(schema.employment.id, leaver));
  morning = (await createShift(ctx, {
    companyId: b.companyId,
    name: 'Morning full',
    code: 'MB28',
    startTime: '08:00:00',
    endTime: '17:00:00',
    weeklyPattern: [1, 2, 3, 4, 5],
  })).id;
});

describe('rosterMonthView (23390097)', () => {
  it('returns every date of the month and leaves a terminated employee out', async () => {
    const view = await rosterMonthView(ctx, { companyId: b.companyId, month: '2026-08' });
    expect(view.dates).toHaveLength(31);
    expect(view.from).toBe('2026-08-01');
    expect(view.to).toBe('2026-08-31');
    expect(view.employees.map((e) => e.code).sort()).toEqual(['A0003', 'A0005']);
    expect(view.employees.some((e) => e.employmentId === leaver)).toBe(false);
  });

  it('filters the grid by department while leaving the dropdown source whole', async () => {
    const view = await rosterMonthView(ctx, { companyId: b.companyId, month: '2026-08', departmentId: b.deptA });
    expect(view.employees.map((e) => e.code)).toEqual(['A0003']);
    // The filters are built from allEmployees precisely so choosing one cannot empty the others.
    expect(view.allEmployees.map((e) => e.code).sort()).toEqual(['A0003', 'A0005']);
  });

  it('finds an employee by name OR by employee number, case-insensitively', async () => {
    const byName = await rosterMonthView(ctx, { companyId: b.companyId, month: '2026-08', q: 'muthusamy' });
    expect(byName.employees.map((e) => e.code)).toEqual(['A0005']);
    const byNumber = await rosterMonthView(ctx, { companyId: b.companyId, month: '2026-08', q: 'a0003' });
    expect(byNumber.employees.map((e) => e.code)).toEqual(['A0003']);
    const nobody = await rosterMonthView(ctx, { companyId: b.companyId, month: '2026-08', q: 'nobody' });
    expect(nobody.employees).toEqual([]);
  });

  it('carries the stored cells for the month and nothing from the months either side', async () => {
    await assignShift(ctx, { employmentId: finance, shiftDate: '2026-08-03', shiftId: morning });
    await setRestDay(ctx, { employmentId: finance, shiftDate: '2026-08-04' });
    await assignShift(ctx, { employmentId: finance, shiftDate: '2026-09-01', shiftId: morning });

    const view = await rosterMonthView(ctx, { companyId: b.companyId, month: '2026-08' });
    expect(view.cells[`${finance}|2026-08-03`]).toEqual({ kind: 'shift', shiftId: morning });
    expect(view.cells[`${finance}|2026-08-04`]).toEqual({ kind: 'rest' });
    expect(view.cells[`${finance}|2026-09-01`]).toBeUndefined();
    expect(view.cells[`${finance}|2026-08-05`]).toBeUndefined(); // nothing rostered ⇒ the grid ghosts it
  });

  it('returns the usual shift WITH its weekly pattern, and omits anyone who has none', async () => {
    await assignDefaultShift(ctx, { employmentId: finance, shiftId: morning });
    const view = await rosterMonthView(ctx, { companyId: b.companyId, month: '2026-08' });
    expect(view.usual[finance]).toEqual({ shiftId: morning, pattern: [1, 2, 3, 4, 5] });
    expect(view.usual[ops]).toBeUndefined();
    expect(view.usualNames[morning]).toEqual({ code: 'MB28', name: 'Morning full' });
  });

  it('a filtered month reads only the filtered employees’ rows', async () => {
    await assignShift(ctx, { employmentId: ops, shiftDate: '2026-08-03', shiftId: morning });
    const view = await rosterMonthView(ctx, { companyId: b.companyId, month: '2026-08', departmentId: b.deptA });
    expect(view.cells[`${ops}|2026-08-03`]).toBeUndefined();
  });
});
