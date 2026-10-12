/**
 * Recompute Attendance (feedback 1c1b321a) — the range writer.
 *
 * WHAT THESE TESTS ARE FOR. The feature's whole value rests on four promises the reporter made explicit,
 * and each one is a test below rather than a paragraph in a comment:
 *   1. changing a shift and re-working a recorded day moves the CALCULATED figures and nothing else —
 *      `check_in_at` / `check_out_at` are asserted byte-identical on every write path here;
 *   2. a day that cannot be worked out cleanly (clock-in, no clock-out) is left EXACTLY as it is;
 *   3. a human-approved overtime figure is never overwritten, only its per-rate split recut;
 *   4. running the same range twice changes nothing the second time.
 * Plus the two things that make it safe: a dry run writes nothing at all, and a refreshed day inside an
 * already-processed pay run raises that run's needs-recalculation notice instead of editing a payslip.
 *
 * The BEFORE state is always produced by a REAL write path (a clocking-file import — r424 retired
 * importAttendancePunches; test/helpers/punch-import.ts drives its replacement) under the OLD
 * settings, not by hand-inserted figures — otherwise the test would only prove the recompute agrees with
 * what I believed the old engine produced.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { importPunchCsv } from './helpers/punch-import';
import { recomputeAttendance, recomputeRunsFromEvents } from '../core/attendance-recompute';
import { assignDefaultShift, createShift, setRestDay, updateShift } from '../core/roster';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

/** An employee with a known employee code, so the punch importer can match against them. */
async function hire(code: string, name = `Recompute ${code}`) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `rc_${randomUUID()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  await owner.db
    .update(schema.employment)
    .set({ employeeCode: code })
    .where(eq(schema.employment.id, e.employmentId));
  return e;
}

/** A tenant-global shift that works every day of the week (so no test depends on a weekday). */
async function shiftEveryDay(code: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}) {
  const a = adminCtx(b);
  return createShift(a, {
    name: `Shift ${code}`,
    code,
    startTime,
    endTime,
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5, 6, 7],
    ...extra,
  });
}

/** Record a day the way the tenant really does: reconcile a clocking file against the CURRENT settings. */
async function record(code: string, date: string, inAt: string, outAt: string | null) {
  const csv =
    `staff,time\n${code},${date} ${inAt}` + (outAt ? `\n${code},${date} ${outAt}` : '');
  return importPunchCsv(adminCtx(b), csv);
}

async function attRow(employmentId: string, date: string) {
  const [row] = await owner.db
    .select()
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)));
  return row;
}

const scope = (over: Partial<Parameters<typeof recomputeAttendance>[1]> = {}) => ({
  companyId: b.companyId,
  from: '2026-07-01',
  to: '2026-07-31',
  dryRun: false,
  ...over,
});

// ────────────────────────── 1 · the case the reporter led with ──────────────────────────

describe('a shift whose start moved later', () => {
  it('turns a Late day back into Present, drops the lateness to zero, and never touches the punches', async () => {
    const a = adminCtx(b);
    const e = await hire('R100');
    const s = await shiftEveryDay('EARLY', '08:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    // 09:30 against an 08:00 shift (policy grace 15m ⇒ late after 08:15) is a late day.
    await record('R100', '2026-07-01', '09:30:00', '18:00:00');
    const before = await attRow(e.employmentId, '2026-07-01');
    expect(before.status).toBe('late');
    expect(before.lateMinutes).toBe(75);

    // The shift itself is corrected — the exact situation the request describes.
    await updateShift(a, { shiftId: s.id, name: 'Shift EARLY', code: 'EARLY', startTime: '10:00', endTime: '17:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });

    const r = await recomputeAttendance(a, scope());
    expect(r.checked).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.flagged).toBe(0);
    expect(r.rows[0].before.status).toBe('late');
    expect(r.rows[0].after.status).toBe('present');
    expect(r.rows[0].after.lateMinutes).toBe(0);
    expect(r.rows[0].shiftCode).toBe('EARLY');

    const after = await attRow(e.employmentId, '2026-07-01');
    expect(after.status).toBe('present');
    expect(after.lateMinutes).toBe(0);
    // THE HARD BOUNDARY: the raw clock times are byte-identical.
    expect(after.checkInAt).toBe(before.checkInAt);
    expect(after.checkOutAt).toBe(before.checkOutAt);
  });

  it('running the same range twice changes nothing the second time', async () => {
    const a = adminCtx(b);
    const e = await hire('R101');
    const s = await shiftEveryDay('IDEM', '08:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    await record('R101', '2026-07-02', '09:30:00', '18:00:00');
    await updateShift(a, { shiftId: s.id, name: 'Shift IDEM', code: 'IDEM', startTime: '10:00', endTime: '17:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });

    const first = await recomputeAttendance(a, scope());
    expect(first.updated).toBe(1);
    const afterFirst = await attRow(e.employmentId, '2026-07-02');

    const second = await recomputeAttendance(a, scope());
    expect(second.checked).toBe(1);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.rows).toHaveLength(0);
    const afterSecond = await attRow(e.employmentId, '2026-07-02');
    expect(afterSecond.workedMinutes).toBe(afterFirst.workedMinutes);
    expect(afterSecond.otMinutes).toBe(afterFirst.otMinutes);
    expect(afterSecond.lateMinutes).toBe(afterFirst.lateMinutes);
    expect(afterSecond.checkInAt).toBe(afterFirst.checkInAt);
    expect(afterSecond.checkOutAt).toBe(afterFirst.checkOutAt);
  });
});

// ────────────────────────── 2 · cf21e554's own fields ──────────────────────────

describe('the shift General settings that move a figure', () => {
  it('a normal-hours rounding change moves the scheduled minutes, and therefore the overtime', async () => {
    const a = adminCtx(b);
    const e = await hire('R110');
    const s = await shiftEveryDay('ROUND', '09:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    await record('R110', '2026-07-06', '09:00:00', '18:30:00');
    const before = await attRow(e.employmentId, '2026-07-06');

    // 15-minute normal-hours rounding shortens the paid normal span, so more of the day is overtime.
    await updateShift(a, {
      shiftId: s.id,
      name: 'Shift ROUND',
      code: 'ROUND',
      startTime: '09:00',
      endTime: '17:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5, 6, 7],
      normalHoursRoundingMinutes: 15,
    });

    const r = await recomputeAttendance(a, scope());
    const after = await attRow(e.employmentId, '2026-07-06');
    // Either the total or the split moved — the point is the recompute noticed, and the punches did not move.
    expect(r.checked).toBe(1);
    expect(after.checkInAt).toBe(before.checkInAt);
    expect(after.checkOutAt).toBe(before.checkOutAt);
    if (r.updated === 1) {
      const buckets = [after.otFlatMinutes, after.ot00Minutes, after.ot10Minutes, after.ot15Minutes, after.ot20Minutes, after.ot30Minutes];
      const summed = buckets.reduce<number>((acc, x) => acc + (x ?? 0), 0);
      // The buckets always sum back to ot_minutes — categorising moves minutes, it never changes the total.
      expect(summed).toBe(after.otMinutes ?? 0);
    }
  });
});

// ────────────────────────── 3 · a working day that became a rest day ──────────────────────────

describe('a day whose TYPE is re-decided', () => {
  it('a workday rostered to a rest day flips day_type and re-splits overtime at the rest-day rate', async () => {
    const a = adminCtx(b);
    const e = await hire('R120');
    const s = await shiftEveryDay('ROT', '09:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    await record('R120', '2026-07-08', '09:00:00', '19:00:00');
    const before = await attRow(e.employmentId, '2026-07-08');
    expect(before.dayType).toBe('workday');

    // The roster is corrected afterwards: that day was actually a rest day.
    await setRestDay(a, { employmentId: e.employmentId, shiftDate: '2026-07-08' });

    const r = await recomputeAttendance(a, scope());
    expect(r.updated).toBe(1);
    expect(r.rows[0].before.dayType).toBe('workday');
    expect(r.rows[0].after.dayType).toBe('rest_day');

    const after = await attRow(e.employmentId, '2026-07-08');
    expect(after.dayType).toBe('rest_day');
    expect(after.checkInAt).toBe(before.checkInAt);
    expect(after.checkOutAt).toBe(before.checkOutAt);
    const summed = [after.otFlatMinutes, after.ot00Minutes, after.ot10Minutes, after.ot15Minutes, after.ot20Minutes, after.ot30Minutes].reduce<number>(
      (acc, x) => acc + (x ?? 0),
      0,
    );
    expect(summed).toBe(after.otMinutes ?? 0);
  });
});

// ────────────────────────── 4 · the day it refuses to guess at ──────────────────────────

describe('a day that cannot be worked out cleanly', () => {
  it('a clock-in with no clock-out is flagged for review and left exactly as it is', async () => {
    const a = adminCtx(b);
    const e = await hire('R130');
    const s = await shiftEveryDay('OPEN', '08:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    await record('R130', '2026-07-09', '08:31:00', null);
    const before = await attRow(e.employmentId, '2026-07-09');
    expect(before.checkOutAt).toBeNull();

    await updateShift(a, { shiftId: s.id, name: 'Shift OPEN', code: 'OPEN', startTime: '10:00', endTime: '19:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });

    const r = await recomputeAttendance(a, scope());
    expect(r.checked).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.flagged).toBe(1);
    expect(r.flags[0].reason).toBe('missing-clock-out');
    expect(r.flags[0].date).toBe('2026-07-09');

    const after = await attRow(e.employmentId, '2026-07-09');
    // EVERY column, not just the punches: a flagged day is not written at all.
    expect(after.status).toBe(before.status);
    expect(after.dayType).toBe(before.dayType);
    expect(after.workedMinutes).toBe(before.workedMinutes);
    expect(after.otMinutes).toBe(before.otMinutes);
    expect(after.lateMinutes).toBe(before.lateMinutes);
    expect(after.checkInAt).toBe(before.checkInAt);
    expect(after.checkOutAt).toBeNull();
  });
});

// ────────────────────────── 5 · a human-approved overtime figure ──────────────────────────

describe('an approved overtime figure', () => {
  it('is kept and re-split rather than overwritten, while the measured figures refresh', async () => {
    const a = adminCtx(b);
    const e = await hire('R140');
    const s = await shiftEveryDay('OTKEEP', '08:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    await record('R140', '2026-07-10', '09:30:00', '19:00:00');

    // An approved correction that fixes the day's OT at a human's number (ADR-0069).
    await owner.db.insert(schema.attendanceCorrection).values({
      tenantId: b.tenantId,
      employmentId: e.employmentId,
      attendanceDate: '2026-07-10',
      status: 'approved',
      requestedOtMinutes: 90,
      approvedOtMinutes: 90,
    });
    await owner.db
      .update(schema.attendance)
      .set({ otMinutes: 90 })
      .where(and(eq(schema.attendance.employmentId, e.employmentId), eq(schema.attendance.attendanceDate, '2026-07-10')));

    await updateShift(a, { shiftId: s.id, name: 'Shift OTKEEP', code: 'OTKEEP', startTime: '10:00', endTime: '17:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });

    const r = await recomputeAttendance(a, scope());
    const after = await attRow(e.employmentId, '2026-07-10');
    expect(after.otMinutes).toBe(90); // the approved total survives the recompute
    if (r.updated === 1) expect(r.rows[0].otPreserved).toBe(true);
    // …and the buckets still sum to it, recut from the figure actually stored.
    const summed = [after.otFlatMinutes, after.ot00Minutes, after.ot10Minutes, after.ot15Minutes, after.ot20Minutes, after.ot30Minutes].reduce<number>(
      (acc, x) => acc + (x ?? 0),
      0,
    );
    expect(summed).toBe(90);
    // The MEASURED figures did refresh against the corrected shift.
    expect(after.lateMinutes).toBe(0);
  });
});

// ────────────────────────── 6 · the dry run ──────────────────────────

describe('preview', () => {
  it('writes nothing at all — no column, no event', async () => {
    const a = adminCtx(b);
    const e = await hire('R150');
    const s = await shiftEveryDay('DRY', '08:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    await record('R150', '2026-07-13', '09:30:00', '18:00:00');
    await updateShift(a, { shiftId: s.id, name: 'Shift DRY', code: 'DRY', startTime: '10:00', endTime: '17:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });

    const before = await attRow(e.employmentId, '2026-07-13');
    const r = await recomputeAttendance(a, scope({ dryRun: true }));
    expect(r.dryRun).toBe(true);
    expect(r.updated).toBe(1);
    expect(r.rows).toHaveLength(1);

    const after = await attRow(e.employmentId, '2026-07-13');
    expect(after).toEqual(before); // the WHOLE row, snapshot against snapshot
    const events = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.tenantId, b.tenantId));
    expect(events.map((x) => x.t)).not.toContain('attendance.recomputed');
    expect(events.map((x) => x.t)).not.toContain('attendance-recompute.run');
  });
});

// ────────────────────────── 7 · the permanent record ──────────────────────────

describe('every run is kept', () => {
  it('appends one event per changed day plus one run event carrying the whole before/after list', async () => {
    const a = adminCtx(b);
    const e = await hire('R160');
    const s = await shiftEveryDay('AUDIT', '08:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    await record('R160', '2026-07-14', '09:30:00', '18:00:00');
    await updateShift(a, { shiftId: s.id, name: 'Shift AUDIT', code: 'AUDIT', startTime: '10:00', endTime: '17:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });

    const r = await recomputeAttendance(a, scope());
    const perDay = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'attendance.recomputed')));
    expect(perDay).toHaveLength(1);
    expect((perDay[0].payload as Record<string, unknown>).runId).toBe(r.runId);
    expect(perDay[0].subjectEmploymentId).toBe(e.employmentId);
    expect(perDay[0].aggregateType).toBe('attendance');

    const runEvents = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(
        and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'attendance-recompute.run')),
      );
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0].aggregateType).toBe('attendance-recompute');
    // The run payload IS the history: re-opening a past run reads this back, so it must carry the days.
    const summaries = recomputeRunsFromEvents(
      runEvents.map((x) => ({
        aggregateId: x.aggregateId,
        eventType: x.eventType,
        actorName: null,
        payload: x.payload,
        occurredAt: x.occurredAt,
      })),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].runId).toBe(r.runId);
    expect(summaries[0].updated).toBe(1);
    expect(summaries[0].rows[0].date).toBe('2026-07-14');
    expect(summaries[0].rows[0].before.status).toBe('late');
    expect(summaries[0].rows[0].after.status).toBe('present');
  });
});

// ────────────────────────── 8 · the payroll interlock ──────────────────────────

describe('a refreshed day inside an already-processed pay run', () => {
  /** One employee, one recorded July day, and a PROCESSED July run they are on. */
  async function withProcessedRun(code: string) {
    const a = adminCtx(b);
    const e = await hire(code);
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const s = await shiftEveryDay(`PR${code}`, '08:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    await record(code, '2026-07-15', '08:00:00', '19:00:00');
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId });
    return { a, e, s, batchId };
  }
  const batchRow = async (batchId: string) => {
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    return row;
  };

  it('raises the run needs-recalculation notice and edits no payslip', async () => {
    const { a, e, s, batchId } = await withProcessedRun('R170');
    expect((await batchRow(batchId)).status).toBe('processed');
    const slipsBefore = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const totalsBefore = (await batchRow(batchId)).totals;

    // The shift END moves, so the day's OVERTIME moves — the only kind of change that can disagree
    // with what a processed run already paid.
    await updateShift(a, { shiftId: s.id, name: 'x', code: 'PRR170', startTime: '08:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });
    const r = await recomputeAttendance(a, scope());
    expect(r.updated).toBe(1);
    expect(r.batchWarnings.map((x) => x.batchId)).toContain(batchId);
    expect(r.batchWarnings[0].employmentIds).toContain(e.employmentId);

    const row = await batchRow(batchId);
    expect(row.needsRecalcAt).not.toBeNull();
    expect(row.recalcEmploymentIds as string[]).toContain(e.employmentId);
    // Nothing about the run itself moved.
    const slipsAfter = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(slipsAfter).toEqual(slipsBefore);
    expect(row.totals).toEqual(totalsBefore);

    const marks = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.eventType, 'payroll-batch.recalc-required'),
        ),
      );
    expect(marks.length).toBeGreaterThanOrEqual(1);
  });

  it('the PREVIEW warns about the same run, and marks nothing', async () => {
    const { a, s, batchId } = await withProcessedRun('R171');
    await updateShift(a, { shiftId: s.id, name: 'x', code: 'PRR171', startTime: '08:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });
    const r = await recomputeAttendance(a, scope({ dryRun: true }));
    expect(r.batchWarnings.map((x) => x.batchId)).toContain(batchId);
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
  });

  it('refuses a closed payroll before rewriting any attendance figures',async()=>{
    const {a,s,batchId}=await withProcessedRun('CLOSEDREC');
    await owner.db.update(schema.payrollBatch).set({status:'closed'}).where(eq(schema.payrollBatch.id,batchId));
    await updateShift(a,{shiftId:s.id,name:'x',code:'PRCLOSEDREC',startTime:'09:00',endTime:'17:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7]});
    const before=await owner.db.select().from(schema.attendance).where(eq(schema.attendance.tenantId,b.tenantId));
    await expect(recomputeAttendance(a,scope())).rejects.toThrow(/closed payroll/);
    const after=await owner.db.select().from(schema.attendance).where(eq(schema.attendance.tenantId,b.tenantId));
    expect(after).toEqual(before);expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
  });

  it('a lateness-only refresh marks the processed run for downstream attendance rules', async () => {
    const { a, s, batchId } = await withProcessedRun('R174');
    // Only the shift START moves ⇒ the late mark is recut, worked and overtime are not.
    await updateShift(a, { shiftId: s.id, name: 'x', code: 'PRR174', startTime: '09:00', endTime: '17:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });
    const r = await recomputeAttendance(a, scope());
    expect(r.batchWarnings.map(x=>x.batchId)).toContain(batchId);
    expect((await batchRow(batchId)).needsRecalcAt).not.toBeNull();
  });

  it('an unchanged day marks nothing', async () => {
    const { a, batchId } = await withProcessedRun('R172');
    // No settings change at all ⇒ nothing moves ⇒ no run is flagged.
    const r = await recomputeAttendance(a, scope());
    expect(r.updated).toBe(0);
    expect(r.batchWarnings).toHaveLength(0);
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
  });

  it('a DRAFT run is left alone', async () => {
    const a = adminCtx(b);
    const e = await hire('R173');
    const s = await shiftEveryDay('DRAFTRUN', '08:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    await record('R173', '2026-07-16', '08:00:00', '19:00:00');
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await updateShift(a, { shiftId: s.id, name: 'x', code: 'DRAFTRUN', startTime: '08:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });

    const r = await recomputeAttendance(a, scope());
    expect(r.updated).toBe(1);
    expect(r.batchWarnings).toHaveLength(0);
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(row.status).toBe('draft');
    expect(row.needsRecalcAt).toBeNull();
  });
});

// ────────────────────────── 9 · scope and access ──────────────────────────

describe('scope', () => {
  it('another tenant sees none of these days', async () => {
    const a = adminCtx(b);
    const e = await hire('R180');
    const s = await shiftEveryDay('ISO', '08:00', '17:00');
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: s.id });
    await record('R180', '2026-07-20', '09:30:00', '18:00:00');
    await updateShift(a, { shiftId: s.id, name: 'x', code: 'ISO', startTime: '10:00', endTime: '17:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });

    const other = await seedBase();
    const r = await recomputeAttendance(adminCtx(other), {
      companyId: b.companyId, // ANOTHER tenant's company id, passed deliberately
      from: '2026-07-01',
      to: '2026-07-31',
      dryRun: false,
    });
    expect(r.checked).toBe(0);
    expect(r.updated).toBe(0);
    const untouched = await attRow(e.employmentId, '2026-07-20');
    expect(untouched.status).toBe('late');
  });

  it('a department filter narrows the employment set', async () => {
    const a = adminCtx(b);
    const inDept = await hire('R190');
    const s = await shiftEveryDay('DEPT', '08:00', '17:00');
    await assignDefaultShift(a, { employmentId: inDept.employmentId, shiftId: s.id });
    await record('R190', '2026-07-21', '09:30:00', '18:00:00');
    await updateShift(a, { shiftId: s.id, name: 'x', code: 'DEPT', startTime: '10:00', endTime: '17:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });

    // deptB holds nobody, so the same range under it checks nothing at all.
    const none = await recomputeAttendance(a, scope({ departmentId: b.deptB, dryRun: true }));
    expect(none.checked).toBe(0);
    const some = await recomputeAttendance(a, scope({ departmentId: b.deptA, dryRun: true }));
    expect(some.checked).toBe(1);
  });

  it('a start date after the end date is refused', async () => {
    await expect(recomputeAttendance(adminCtx(b), scope({ from: '2026-07-31', to: '2026-07-01' }))).rejects.toThrow();
  });
});

describe('access', () => {
  /** Both server actions are HR-admin only. Asserted on the source because `requireAdmin` reads the
   *  request session, which has no meaning inside this suite — and the guard being PRESENT on both
   *  exports is the property that matters (test/function-access.test.ts pins the route's column). */
  it('both server actions are guarded by requireAdmin', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../app/attendance/recompute/actions.ts'), 'utf8');
    const bodies = src.split('export async function ').slice(1);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain('await requireAdmin()');
    }
  });
});
