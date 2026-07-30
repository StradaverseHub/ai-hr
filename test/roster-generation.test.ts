/**
 * R7 Multi-Shift — PHASE 2 (weekly pattern + roster generation). Covers: a shift's Mon–Sun weekly_pattern
 * splitting a date window into working rows AND explicit rest rows for EVERY date (the two-sources
 * reconciliation rule: a generated roster row always wins in scheduleFor, so an uncovered date never
 * silently falls back to the company attendance policy); idempotent re-runs; department scope resolved via
 * listEmployeesPage's current-assignment filter; workday OT measured against the template normal including
 * the Phase-1 normal_minutes_override; REST-DAY-WORKED OT (all worked minutes = OT through the rest
 * branch); a generated working day that is a calendar holiday keeping dayType='holiday'; and the event
 * substrate (existing roster.bulk.assigned + ONE thin roster.bulk.rest-day.set summary — no new
 * roster.generated type).
 *
 * Dates: 2026-07-06 = Monday … 2026-07-12 = Sunday (one clean ISO week; default policy = Mon–Fri).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { checkIn, checkOut } from '../core/attendance';
import { createShift, generateRosterFromTemplate } from '../core/roster';

let b: Base;
let empId: string;

async function makeEmp() {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: `W ${randomUUID().slice(0, 8)}`, primaryEmail: `w_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

async function assignDept(employmentId: string, departmentId: string) {
  await owner.db.insert(schema.assignment).values({
    tenantId: b.tenantId,
    employmentId,
    departmentId,
    employmentType: 'full_time',
    validFrom: '2020-01-01',
  });
}

function rowsFor(employmentId: string) {
  return owner.db
    .select({ shiftDate: schema.rosterAssignment.shiftDate, shiftId: schema.rosterAssignment.shiftId, isRestDay: schema.rosterAssignment.isRestDay })
    .from(schema.rosterAssignment)
    .where(and(eq(schema.rosterAssignment.tenantId, b.tenantId), eq(schema.rosterAssignment.employmentId, employmentId)))
    .orderBy(asc(schema.rosterAssignment.shiftDate));
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
  empId = await makeEmp();
});

const mkShift = (over: Partial<Parameters<typeof createShift>[1]> = {}) =>
  createShift(adminCtx(b), {
    companyId: b.companyId,
    name: 'Day',
    code: 'DAY',
    startTime: '09:00:00',
    endTime: '18:00:00',
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
    ...over,
  });

describe('roster generation from a weekly pattern (R7 Multi-Shift Phase 2)', () => {
  it('writes a row for EVERY date in the window: working rows on pattern days, explicit rest rows on the rest', async () => {
    const s = await mkShift();
    const r = await generateRosterFromTemplate(adminCtx(b), {
      shiftId: s.id,
      employmentIds: [empId],
      from: '2026-07-06',
      to: '2026-07-12',
    });
    expect(r).toMatchObject({ employments: 1, workingDates: 5, restDates: 2, workingRows: 5, restRows: 2 });

    const rows = await rowsFor(empId);
    expect(rows).toHaveLength(7); // no uncovered date — the reconciliation rule
    for (const d of ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10']) {
      expect(rows.find((x) => x.shiftDate === d)).toMatchObject({ shiftId: s.id, isRestDay: false });
    }
    for (const d of ['2026-07-11', '2026-07-12']) {
      expect(rows.find((x) => x.shiftDate === d)).toMatchObject({ shiftId: null, isRestDay: true });
    }

    // Substrate: the EXISTING bulk event + ONE thin rest-day summary, both anchored on the shift.
    // Deliberately NO new roster.generated type.
    const types = await eventTypesFor(b.tenantId, s.id);
    expect(types).toContain('roster.bulk.assigned');
    expect(types).toContain('roster.bulk.rest-day.set');
    expect(types.filter((x) => x === 'roster.bulk.rest-day.set')).toHaveLength(1);
  });

  it('is idempotent: re-running the generator leaves the same 7 rows (upsert on (employee, date))', async () => {
    const s = await mkShift();
    const p = { shiftId: s.id, employmentIds: [empId], from: '2026-07-06', to: '2026-07-12' };
    await generateRosterFromTemplate(adminCtx(b), p);
    await generateRosterFromTemplate(adminCtx(b), p);
    const rows = await rowsFor(empId);
    expect(rows).toHaveLength(7);
    expect(rows.filter((x) => x.shiftId === s.id)).toHaveLength(5);
    expect(rows.filter((x) => x.isRestDay)).toHaveLength(2);
  });

  it('department scope: resolves employments via listEmployeesPage current-assignment dept filter', async () => {
    const inA1 = empId;
    const inA2 = await makeEmp();
    const inB = await makeEmp();
    await assignDept(inA1, b.deptA);
    await assignDept(inA2, b.deptA);
    await assignDept(inB, b.deptB);

    const s = await mkShift();
    const r = await generateRosterFromTemplate(adminCtx(b), {
      shiftId: s.id,
      departmentId: b.deptA,
      from: '2026-07-06',
      to: '2026-07-08',
    });
    expect(r.employments).toBe(2);
    expect(await rowsFor(inA1)).toHaveLength(3);
    expect(await rowsFor(inA2)).toHaveLength(3);
    expect(await rowsFor(inB)).toHaveLength(0);
  });

  it('workday OT on a generated day = worked − template normal, honouring the Phase-1 override', async () => {
    const ctx = adminCtx(b);
    // With override: 09:00–17:00, no break, normal = 420m override. Worked 480 ⇒ OT 60 vs the OVERRIDE.
    const withOverride = await mkShift({ name: 'Ovr', code: 'OVR', endTime: '17:00:00', breakMinutes: 0, normalMinutesOverride: 420 });
    await generateRosterFromTemplate(ctx, { shiftId: withOverride.id, employmentIds: [empId], from: '2026-07-06', to: '2026-07-12' });
    await checkIn(ctx, { employmentId: empId, date: '2026-07-07', time: '09:00:00' });
    const out1 = await checkOut(ctx, { employmentId: empId, date: '2026-07-07', time: '17:00:00' });
    expect(out1).toMatchObject({ dayType: 'workday', workedMinutes: 480, otMinutes: 60 });

    // Without override: 09:00–18:00 break 60 ⇒ normal 480. Worked 11h−1h = 600 ⇒ OT 120 vs span − break.
    const emp2 = await makeEmp();
    const plain = await mkShift({ name: 'Plain', code: 'PLN' });
    await generateRosterFromTemplate(ctx, { shiftId: plain.id, employmentIds: [emp2], from: '2026-07-06', to: '2026-07-12' });
    await checkIn(ctx, { employmentId: emp2, date: '2026-07-07', time: '09:00:00' });
    const out2 = await checkOut(ctx, { employmentId: emp2, date: '2026-07-07', time: '20:00:00' });
    expect(out2).toMatchObject({ dayType: 'workday', workedMinutes: 600, otMinutes: 120 });
  });

  it('REST-DAY-WORKED OT: ALL worked minutes on a generated rest day are OT (rest branch, shiftId null)', async () => {
    const ctx = adminCtx(b);
    const s = await mkShift(); // Sat 2026-07-11 is a pattern rest day → explicit isRestDay row
    await generateRosterFromTemplate(ctx, { shiftId: s.id, employmentIds: [empId], from: '2026-07-06', to: '2026-07-12' });
    await checkIn(ctx, { employmentId: empId, date: '2026-07-11', time: '09:00:00' });
    const out = await checkOut(ctx, { employmentId: empId, date: '2026-07-11', time: '13:00:00' });
    // span 240 < 6h ⇒ no break deduction; rest day ⇒ otMinutes = full worked
    expect(out).toMatchObject({ dayType: 'rest_day', workedMinutes: 240, otMinutes: 240 });
  });

  it("a generated working day that is a calendar holiday keeps dayType='holiday' (premium classification)", async () => {
    const ctx = adminCtx(b);
    await owner.db
      .insert(schema.holiday)
      .values({ tenantId: b.tenantId, country: 'MY', state: null, holidayDate: '2026-07-07', name: 'Test Holiday' });
    const s = await mkShift({ name: 'Hol', code: 'HOL', endTime: '17:00:00', breakMinutes: 0, normalMinutesOverride: 420 });
    await generateRosterFromTemplate(ctx, { shiftId: s.id, employmentIds: [empId], from: '2026-07-06', to: '2026-07-12' });
    // The roster row is a WORKING row (Tue is in the pattern) …
    expect((await rowsFor(empId)).find((x) => x.shiftDate === '2026-07-07')).toMatchObject({ shiftId: s.id, isRestDay: false });
    // … but the day TYPE stays holiday, so ALL worked minutes are (holiday-premium) OT — not worked − normal.
    await checkIn(ctx, { employmentId: empId, date: '2026-07-07', time: '09:00:00' });
    const out = await checkOut(ctx, { employmentId: empId, date: '2026-07-07', time: '17:00:00' });
    expect(out).toMatchObject({ dayType: 'holiday', workedMinutes: 480, otMinutes: 480 });
  });

  it('TWO-SOURCES RECONCILIATION: the generated row beats the company policy in BOTH directions', async () => {
    const ctx = adminCtx(b);
    // Pattern Tue–Sat working, Sun+Mon rest — deliberately disagreeing with the default Mon–Fri policy.
    const s = await mkShift({ name: 'TueSat', code: 'TS', weeklyPattern: [2, 3, 4, 5, 6] });
    await generateRosterFromTemplate(ctx, { shiftId: s.id, employmentIds: [empId], from: '2026-07-06', to: '2026-07-12' });

    const rows = await rowsFor(empId);
    // Saturday 07-11: policy says rest, pattern says WORKING ⇒ a working row that classifies as a workday.
    expect(rows.find((x) => x.shiftDate === '2026-07-11')).toMatchObject({ shiftId: s.id, isRestDay: false });
    await checkIn(ctx, { employmentId: empId, date: '2026-07-11', time: '09:00:00' });
    const sat = await checkOut(ctx, { employmentId: empId, date: '2026-07-11', time: '18:00:00' });
    // worked 540−60=480 = scheduled ⇒ OT 0 (measured vs the shift's normal, NOT all-worked rest-day OT)
    expect(sat).toMatchObject({ dayType: 'workday', workedMinutes: 480, otMinutes: 0 });

    // Monday 07-06: policy says working, pattern says REST ⇒ an explicit rest row (NOT a silent policy
    // fallback) that sends scheduleFor down the rest branch: all worked = OT.
    expect(rows.find((x) => x.shiftDate === '2026-07-06')).toMatchObject({ shiftId: null, isRestDay: true });
    await checkIn(ctx, { employmentId: empId, date: '2026-07-06', time: '09:00:00' });
    const mon = await checkOut(ctx, { employmentId: empId, date: '2026-07-06', time: '13:00:00' });
    expect(mon).toMatchObject({ dayType: 'rest_day', workedMinutes: 240, otMinutes: 240 });
  });

  it('guards: no weekly pattern, empty scope, and inverted date ranges are clear errors', async () => {
    const ctx = adminCtx(b);
    const noPattern = await mkShift({ name: 'NoPat', code: 'NP', weeklyPattern: null });
    await expect(
      generateRosterFromTemplate(ctx, { shiftId: noPattern.id, employmentIds: [empId], from: '2026-07-06', to: '2026-07-12' }),
    ).rejects.toThrow(/no weekly working-day pattern/i);

    const s = await mkShift();
    await expect(
      generateRosterFromTemplate(ctx, { shiftId: s.id, employmentIds: [], from: '2026-07-06', to: '2026-07-12' }),
    ).rejects.toThrow(/no employees in scope/i);
    await expect(
      generateRosterFromTemplate(ctx, { shiftId: s.id, employmentIds: [empId], from: '2026-07-12', to: '2026-07-06' }),
    ).rejects.toThrow(/end date/i);
  });
});
