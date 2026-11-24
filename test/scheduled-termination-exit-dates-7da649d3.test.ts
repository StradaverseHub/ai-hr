/**
 * 7da649d3 — a future-dated Termination writes its EXIT DATES when it is saved.
 *
 * The reporter's case: a Termination keyed for 20 November only scheduled itself, so the employee stayed Active,
 * the Last Working Date read Not set, and a November payroll processed on 15 November paid the full month without
 * listing the leaver. What these tests pin, against the database and the real HR date owner:
 *   1. Serving Notice before any sweep, last working day (and tender date) written, placement/manager and
 *      terminated_on untouched; the Resignation Information shows the dates as "scheduled"; the sweep still
 *      closes the assignment and reporting line on the effective date, and does not rewrite the dates.
 *   2. The leaving month's run prorates basic to the last working day, leaverAdvisory lists the pending leaver,
 *      an amended date re-prorates with ONE live history row, and deleting the pending event clears the dates
 *      and restores the full month. Processed runs are marked for reprocessing each time.
 *   3. A closed run is never changed and is flagged.
 *   4. A tenant's own Termination type behaves the same.
 *
 * Fictional data only. Expected money is hand-computed: RM 3,000 basic, calendar-day proration (no policy),
 * so 5 days of the month pay 3000 × 5 / days-in-month.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  createMovementEvent,
  editMovementEvent,
  movementCurrentState,
  movementHistory,
  resignationInformation,
  reverseMovementEvent,
} from '../core/movement';
import { sweepDueMovements } from '../core/movement-apply';
import { saveMovementEventType } from '../core/movement-type';
import { createBatch, generatePayslips, leaverAdvisory, reprocessSelectedEmployees } from '../core/payroll';
import { deriveEmploymentStatus } from '../core/employment-status';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const TODAY = todayInKualaLumpur();
function plusDays(iso: string, n: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}
/** The calendar month after today's: every date in it is in the future, whatever day the suite runs. */
const PERIOD = (() => {
  const y = Number(TODAY.slice(0, 4)), m = Number(TODAY.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
})();
const DAYS_IN_PERIOD = new Date(Date.UTC(Number(PERIOD.slice(0, 4)), Number(PERIOD.slice(5, 7)), 0)).getUTCDate();
const LAST_DAY = `${PERIOD}-05`;
const AMENDED_LAST_DAY = `${PERIOD}-10`;
const BASIC = 3000;
const proratedBasic = (days: number) => Math.round((BASIC * days * 100) / DAYS_IN_PERIOD) / 100;

let b: Base;
let payroll: SessionContext;
let ic = 720000;
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
  await setSetting(b.tenantId, 'payroll.reset_enabled', true);
  payroll = await entitledCtx(b);
});
afterAll(closeAll);

async function hire(name: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${randomUUID()}@scheduled-exit.test` },
    companyId: b.companyId, departmentId: b.deptA, positionId: b.positionId, employmentType: 'full_time', hiredOn: '2024-01-01',
  });
  await setStatutoryProfileMY(payroll, { personId: e.personId, icNumber: `900101${++ic}` });
  await setCompensation(payroll, { employmentId: e.employmentId, basicSalary: BASIC, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  return e.employmentId;
}
const employmentRow = async (id: string) => (await owner.db.select().from(schema.employment).where(eq(schema.employment.id, id)))[0];
const terminate = (employmentId: string, lastDay: string, over: Record<string, unknown> = {}) =>
  createMovementEvent(adminCtx(b), { employmentId, kind: 'termination', effectiveDate: lastDay, endDate: lastDay, terminationReasonCode: 'redundancy', ...over });
const liveExit = async (employmentId: string) => {
  const rows = (await movementHistory(adminCtx(b), employmentId)).filter((r) => r.kind !== 'hired' && !r.reversed);
  expect(rows).toHaveLength(1);
  return rows[0];
};
const slip = async (batchId: string, employmentId: string) =>
  (await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId))))[0];
const batchRow = async (batchId: string) => (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)))[0];
async function reprocess(batchId: string, employmentId: string) {
  const key = randomUUID();
  await reprocessSelectedEmployees(payroll, { batchId, employmentIds: [employmentId], idempotencyKey: key });
  const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, key));
  expect(job.status).toBe('completed');
}

describe('7da649d3 — a scheduled termination writes its exit dates now and defers only the closure', () => {
  it('is Serving Notice before any sweep, keeps placement and manager, and the sweep still closes them on the date', async () => {
    const manager = await hire('Fictional Exit Manager');
    const id = await hire('Fictional Scheduled Leaver');
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: id, managerEmploymentId: manager, lineType: 'administrative', validFrom: '2024-01-01' });
    const before = await movementCurrentState(adminCtx(b), id);

    await terminate(id, LAST_DAY, { terminationReasonCode: 'resignation', resignationDate: TODAY });

    const row = await employmentRow(id);
    expect(row).toMatchObject({ lastWorkingDate: LAST_DAY, tenderResignationDate: TODAY, resignationDate: null, terminatedOn: null, terminationReasonCode: null });
    expect(deriveEmploymentStatus(row, TODAY)).toBe('active_serving_notice');
    const after = await movementCurrentState(adminCtx(b), id);
    expect([after.departmentId, after.positionId, after.managerEmploymentId]).toEqual([before.departmentId, before.positionId, manager]);
    const open = await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, id));
    expect(open.map((a) => a.validTo)).toEqual([null]);

    const pending = await liveExit(id);
    expect(pending).toMatchObject({ kind: 'termination', status: 'pending', effectiveDate: LAST_DAY, endDate: LAST_DAY });
    const info = await resignationInformation(adminCtx(b), id);
    expect(info.lastWorkingDate).toEqual({ value: LAST_DAY, source: { kind: 'scheduled', movementId: pending.id, effectiveDate: LAST_DAY } });
    expect(info.tenderResignationDate.source).toMatchObject({ kind: 'scheduled', movementId: pending.id });
    expect(info.resignationDate.source.kind).toBe('empty');

    // The day before: nothing more happens. On the day: terminated, assignment and reporting line closed.
    await sweepDueMovements(adminCtx(b), { today: plusDays(LAST_DAY, -1) });
    expect((await employmentRow(id)).terminatedOn).toBeNull();
    await sweepDueMovements(adminCtx(b), { today: LAST_DAY });
    const ended = await employmentRow(id);
    expect(ended).toMatchObject({ terminatedOn: LAST_DAY, lastWorkingDate: LAST_DAY, tenderResignationDate: TODAY, terminationReasonCode: 'resignation' });
    expect((await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, id))).map((a) => a.validTo)).toEqual([LAST_DAY]);
    const lines = await owner.db.select().from(schema.reportingLine).where(eq(schema.reportingLine.subordinateEmploymentId, id));
    expect(lines.map((l) => l.validTo)).toEqual([LAST_DAY]);

    // One history row, now applied; the sweep's leg 2 had nothing to change (no second dates event, and the
    // permanent change record no longer claims a last working day moved from empty).
    expect(await liveExit(id)).toMatchObject({ id: pending.id, status: 'applied' });
    const events = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.subjectEmploymentId, id));
    const exitDateLegs = events.filter((e) => e.eventType === 'employment.info.updated' && ((e.payload as { fields?: string[] }).fields ?? []).includes('lastWorkingDate'));
    expect(exitDateLegs).toHaveLength(1);
    const applied = events.find((e) => e.eventType === 'employment.movement.applied')!;
    expect((applied.payload as { changes: { field: string }[] }).changes.map((c) => c.field)).toEqual(['terminatedOn', 'terminationReasonCode']);
    expect((await resignationInformation(adminCtx(b), id)).lastWorkingDate.source).toMatchObject({ kind: 'movement', movementId: pending.id });
  });

  it('prorates the leaving month to the last working day, follows an amended date, and a delete restores the full month', async () => {
    const leaver = await hire('Fictional Prorated Leaver');
    const stayer = await hire('Fictional Full Month Colleague');
    await terminate(leaver, LAST_DAY);

    // The leaving month is processed BEFORE the termination's effective date (no sweep has run).
    const { batchId } = await createBatch(payroll, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(payroll, { batchId });
    expect(Number((await slip(batchId, leaver)).basicSalary)).toBeCloseTo(proratedBasic(5), 2);
    expect(Number((await slip(batchId, stayer)).basicSalary)).toBeCloseTo(BASIC, 2);
    const advisory = await leaverAdvisory(payroll, batchId);
    expect(advisory.map((r) => [r.employmentId, r.terminatedOn])).toEqual([[leaver, LAST_DAY]]);

    // Amend the date: the Employment tab and payroll follow it; one live row with its correction history.
    const original = await liveExit(leaver);
    await editMovementEvent(adminCtx(b), {
      employmentId: leaver, movementId: original.id, kind: 'termination', effectiveDate: AMENDED_LAST_DAY, endDate: AMENDED_LAST_DAY,
      terminationReasonCode: 'redundancy', reason: 'Fictional later agreed last day',
    });
    expect((await employmentRow(leaver)).lastWorkingDate).toBe(AMENDED_LAST_DAY);
    const amended = await liveExit(leaver);
    expect(amended).toMatchObject({ status: 'pending', effectiveDate: AMENDED_LAST_DAY });
    expect((await movementHistory(adminCtx(b), leaver)).find((r) => r.id === original.id)?.reversed?.corrected).toBe(true);
    expect((await batchRow(batchId)).needsRecalcAt).not.toBeNull();
    expect((await batchRow(batchId)).recalcEmploymentIds).toContain(leaver);
    await reprocess(batchId, leaver);
    expect(Number((await slip(batchId, leaver)).basicSalary)).toBeCloseTo(proratedBasic(10), 2);
    expect((await leaverAdvisory(payroll, batchId)).map((r) => r.terminatedOn)).toEqual([AMENDED_LAST_DAY]);

    // Delete the pending event: the dates clear and the month is full again.
    await reverseMovementEvent(adminCtx(b), { employmentId: leaver, movementId: amended.id, reason: 'Fictional resignation withdrawn' });
    const restored = await employmentRow(leaver);
    expect(restored).toMatchObject({ lastWorkingDate: null, tenderResignationDate: null, terminatedOn: null });
    expect(deriveEmploymentStatus(restored, TODAY)).not.toBe('active_serving_notice');
    expect((await batchRow(batchId)).recalcEmploymentIds).toContain(leaver);
    await reprocess(batchId, leaver);
    expect(Number((await slip(batchId, leaver)).basicSalary)).toBeCloseTo(BASIC, 2);
    expect(await leaverAdvisory(payroll, batchId)).toEqual([]);

    // The sweep never resurrects the deleted intent.
    await sweepDueMovements(adminCtx(b), { today: AMENDED_LAST_DAY });
    expect(await employmentRow(leaver)).toMatchObject({ lastWorkingDate: null, terminatedOn: null });
  });

  it('never changes a closed run, and flags the closed month', async () => {
    const id = await hire('Fictional Closed Month Leaver');
    const [period] = await owner.db.insert(schema.payPeriod).values({ tenantId: b.tenantId, companyId: b.companyId, period: PERIOD, status: 'closed' }).returning();
    const [batch] = await owner.db.insert(schema.payrollBatch).values({ tenantId: b.tenantId, companyId: b.companyId, payPeriodId: period.id, payPeriod: PERIOD, batchDate: `${PERIOD}-25`, status: 'closed' }).returning();
    await owner.db.insert(schema.payslip).values({ tenantId: b.tenantId, batchId: batch.id, employmentId: id, basicSalary: '3000.00', grossPay: '3000.00', statutory: { fixture: 'issued' }, totalDeductions: '0.00', netPay: '3000.00', employerCost: '3000.00' });
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, id));
    const batches = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batch.id));

    const result = await terminate(id, LAST_DAY);
    expect((result as { payrollFlaggedPeriods?: string[] }).payrollFlaggedPeriods).toEqual([PERIOD]);
    expect((await employmentRow(id)).lastWorkingDate).toBe(LAST_DAY);
    expect((await liveExit(id))).toMatchObject({ status: 'pending', payrollLocked: true, payrollClosedPeriods: [PERIOD] });
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, id))).toEqual(slips);
    expect(await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batch.id))).toEqual(batches);
  });

  it("applies the same way to the organisation's own Termination type", async () => {
    const { code } = await saveMovementEventType(adminCtx(b), { label: 'Fictional Mutual Separation', behaviourKind: 'termination' });
    const id = await hire('Fictional Custom Exit');
    await terminate(id, LAST_DAY, { kind: code });

    const row = await employmentRow(id);
    expect(row).toMatchObject({ lastWorkingDate: LAST_DAY, terminatedOn: null });
    expect(deriveEmploymentStatus(row, TODAY)).toBe('active_serving_notice');
    const pending = await liveExit(id);
    expect(pending).toMatchObject({ kind: code, status: 'pending' });
    expect((await resignationInformation(adminCtx(b), id)).lastWorkingDate.source).toMatchObject({ kind: 'scheduled', movementId: pending.id });

    await sweepDueMovements(adminCtx(b), { today: LAST_DAY });
    expect(await employmentRow(id)).toMatchObject({ terminatedOn: LAST_DAY, lastWorkingDate: LAST_DAY });
    expect((await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, id))).map((a) => a.validTo)).toEqual([LAST_DAY]);
    expect(await liveExit(id)).toMatchObject({ id: pending.id, kind: code, status: 'applied' });
  });
});
