/**
 * 3244584c — REPROCESS AFTER AN EMPLOYEE'S RECORD SAYS THEY NO LONGER BELONG TO THE MONTH.
 *
 * The reporter's case: October 2026 was processed while the employee was active, then a resignation dated
 * August was entered. Reprocess used to stop the WHOLE job with the generic "Processing stopped…" line and
 * leave the October payslip paying. What these tests pin:
 *   a. the employee becomes an 'excluded' outcome with the reason and the date, their payslip leaves the
 *      run through the removal owner (history snapshot, one-off release, totals/headcount by delta) and the
 *      other selected employee still completes;
 *   b. a mid-period leaver is IN the month and is recalculated (prorated), never excluded;
 *   c. removal switched off ⇒ 'not_eligible', the old result kept untouched;
 *   d. HR saves of payroll facts mark the processed run with a change CATEGORY (termination, salary) only
 *      when the effective date reaches the run's month; a salary dated next month and a non-payroll edit
 *      mark nothing;
 *   e. a transfer out of the company before the month is NOT_WITH_COMPANY_IN_PERIOD.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setEmploymentInfo, terminateEmployment } from '../core/org';
import { setCompensation, supersedeCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  createBatch,
  generatePayslips,
  listRecalcChangeCategories,
  reprocessSelectedEmployees,
  type ReprocessJobResult,
} from '../core/payroll';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

describe('3244584c reprocess eligibility after employee changes', () => {
  let base: Base;
  let ctx: SessionContext;
  let ic = 610000;
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    ctx = await entitledCtx(base);
    ic = 610000;
  });
  afterAll(closeAll);

  async function hire(name: string, basic = 3000) {
    const e = await hireEmployee(ctx, {
      person: { fullName: name, primaryEmail: `${randomUUID()}@fb3244584c.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01',
    });
    await setStatutoryProfileMY(ctx, { personId: e.personId, icNumber: `900101${++ic}` });
    await setCompensation(ctx, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    return e;
  }
  const slip = async (batchId: string, employmentId: string) =>
    (await owner.db.select().from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId))))[0];
  const batchRow = async (batchId: string) =>
    (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)))[0];
  async function processed(period = '2026-10') {
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(ctx, { batchId });
    return batchId;
  }
  async function reprocess(batchId: string, employmentIds: string[]) {
    const key = randomUUID();
    await reprocessSelectedEmployees(ctx, { batchId, employmentIds, idempotencyKey: key });
    const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, key));
    return { job, result: job.result as ReprocessJobResult };
  }

  it('the reporter case: October processed, resignation dated August entered, reprocess excludes and removes', async () => {
    const leaver = await hire('Late Resignation');
    const stays = await hire('Still Here');
    const batchId = await processed();
    const before = await batchRow(batchId);
    const oldSlip = await slip(batchId, leaver.employmentId);
    expect(oldSlip).toBeDefined();
    const [txn] = await owner.db.insert(schema.payrollIndividualTxn).values({
      tenantId: base.tenantId, batchId, companyId: base.companyId, payPeriod: '2026-10', employmentId: leaver.employmentId,
      kind: 'deduction', txnDate: '2026-10-12', amount: '20.00', consumedBatchId: batchId, consumedAt: new Date(),
    }).returning();

    await terminateEmployment(ctx, { employmentId: leaver.employmentId, terminationDate: '2026-08-15', terminationType: 'voluntary' });

    // d. the save itself marks the October run, with the category and no value.
    const marked = await batchRow(batchId);
    expect(marked.needsRecalcAt).not.toBeNull();
    expect(marked.recalcEmploymentIds).toEqual([leaver.employmentId]);
    expect(await listRecalcChangeCategories(ctx, { batchId })).toEqual({ [leaver.employmentId]: ['termination'] });

    const { job, result } = await reprocess(batchId, [leaver.employmentId, stays.employmentId]);
    expect(job.status).toBe('completed');
    expect(job.error).toBeNull();
    expect(result.excluded).toBe(1);
    expect(result.reprocessed).toBe(1);
    const outcome = result.outcomes.find((r) => r.employmentId === leaver.employmentId)!;
    expect(outcome).toMatchObject({
      status: 'excluded', reasonCode: 'RESIGNED_BEFORE_PERIOD', name: 'Late Resignation',
      validationDetails: [{ gap: 'RESIGNED_BEFORE_PERIOD', date: '2026-08-15' }],
      resultRetained: false, payslipId: null, versionBefore: oldSlip.version, versionAfter: null,
    });
    expect(outcome.historyId).toBeTruthy();
    expect(result.outcomes.find((r) => r.employmentId === stays.employmentId)?.status).toBe('reprocessed');

    // No payable amount stays on the run; headcount and totals drop by exactly the removed payslip.
    expect(await slip(batchId, leaver.employmentId)).toBeUndefined();
    const after = await batchRow(batchId);
    expect(after.status).toBe('processed');
    expect(after.employeeCount).toBe(1);
    expect(Number((after.totals as Record<string, number>).gross))
      .toBeCloseTo(Number((before.totals as Record<string, number>).gross) - Number(oldSlip.grossPay), 2);
    // The mark is cleared for the excluded employee: nothing left for the run to owe.
    expect(after.needsRecalcAt).toBeNull();

    // History keeps the whole payslip; the one-off line it consumed is released for a correct re-run.
    const [history] = await owner.db.select().from(schema.payrollEmployeeResultHistory)
      .where(eq(schema.payrollEmployeeResultHistory.id, outcome.historyId!));
    expect(history).toMatchObject({ action: 'remove', employmentId: leaver.employmentId, versionAfter: null });
    expect((history.before as { payslip: { id: string } }).payslip.id).toBe(oldSlip.id);
    expect(history.reason).toContain('Excluded on reprocess');
    const [released] = await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id, txn.id));
    expect(released.consumedBatchId).toBeNull();

    const events = await owner.db.select().from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, batchId), eq(schema.domainEvent.eventType, 'payroll-batch.employee-reprocess-outcome')));
    expect(events.find((e) => (e.payload as { employmentId?: string }).employmentId === leaver.employmentId)?.payload)
      .toMatchObject({ status: 'excluded', reasonCode: 'RESIGNED_BEFORE_PERIOD', exclusionDate: '2026-08-15', resultRetained: false });
  });

  it('a mid-period termination stays in the month and is recalculated with proration', async () => {
    const a = await hire('Mid Month Leaver');
    await hire('Colleague');
    const batchId = await processed();
    const old = await slip(batchId, a.employmentId);
    await terminateEmployment(ctx, { employmentId: a.employmentId, terminationDate: '2026-10-15', terminationType: 'voluntary' });
    expect((await batchRow(batchId)).recalcEmploymentIds).toEqual([a.employmentId]);
    const { result } = await reprocess(batchId, [a.employmentId]);
    expect(result.outcomes[0].status).toBe('reprocessed');
    const now = await slip(batchId, a.employmentId);
    expect(Number(now.grossPay)).toBeLessThan(Number(old.grossPay));
    expect(Number(now.grossPay)).toBeGreaterThan(0);
  });

  it('removal switched off: not_eligible, old result kept, nothing removed', async () => {
    const a = await hire('Gate Closed');
    await hire('Other');
    const batchId = await processed();
    const old = await slip(batchId, a.employmentId);
    const before = await batchRow(batchId);
    await terminateEmployment(ctx, { employmentId: a.employmentId, terminationDate: '2026-08-31', terminationType: 'voluntary' });
    await setSetting(base.tenantId, 'payroll.reset_enabled', false);
    ctx = await entitledCtx(base);
    const { job, result } = await reprocess(batchId, [a.employmentId]);
    expect(job.status).toBe('completed');
    expect(result.outcomes[0]).toMatchObject({
      status: 'not_eligible', reasonCode: 'RESIGNED_BEFORE_PERIOD', resultRetained: true,
      payslipId: old.id, historyId: null, versionBefore: old.version, versionAfter: old.version,
    });
    expect(await slip(batchId, a.employmentId)).toEqual(old);
    expect((await batchRow(batchId)).employeeCount).toBe(before.employeeCount);
    expect(result.notEligible).toBe(1);
  });

  it('the last payslip on a run is never emptied by an exclusion', async () => {
    const a = await hire('Only One');
    const batchId = await processed();
    await terminateEmployment(ctx, { employmentId: a.employmentId, terminationDate: '2026-09-30', terminationType: 'voluntary' });
    const { result } = await reprocess(batchId, [a.employmentId]);
    expect(result.outcomes[0]).toMatchObject({ status: 'not_eligible', validationCode: 'last_on_run', resultRetained: true });
    expect(await slip(batchId, a.employmentId)).toBeDefined();
  });

  it('a transfer out of the company before the month is NOT_WITH_COMPANY_IN_PERIOD', async () => {
    const a = await hire('Moved Away');
    await hire('Remains');
    const batchId = await processed();
    const [other] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Other Sdn Bhd' }).returning();
    const [dept] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: other.id, name: 'Ops' }).returning();
    const [current] = await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, a.employmentId));
    await owner.db.update(schema.assignment).set({ validTo: '2026-08-01' }).where(eq(schema.assignment.id, current.id));
    await owner.db.insert(schema.assignment).values({
      tenantId: base.tenantId, employmentId: a.employmentId, companyId: other.id, departmentId: dept.id,
      employmentType: current.employmentType, validFrom: '2026-08-01', validTo: null,
    });
    await owner.db.update(schema.employment).set({ companyId: other.id }).where(eq(schema.employment.id, a.employmentId));
    const { job, result } = await reprocess(batchId, [a.employmentId]);
    expect(job.status).toBe('completed');
    expect(result.outcomes[0]).toMatchObject({
      status: 'excluded', reasonCode: 'NOT_WITH_COMPANY_IN_PERIOD',
      validationDetails: [{ gap: 'NOT_WITH_COMPANY_IN_PERIOD', date: '2026-08-01' }],
    });
    expect(await slip(batchId, a.employmentId)).toBeUndefined();
  });

  it('salary marks only from its effective month; a non-payroll edit marks nothing', async () => {
    const a = await hire('Salary Change');
    await hire('Bystander');
    const batchId = await processed();
    const nov = await setCompensation(ctx, { employmentId: a.employmentId, basicSalary: 3500, effectiveFrom: '2026-11-01' });
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
    // Withdrawing that November record hands November back to the old salary: still nothing in October.
    await supersedeCompensation(ctx, { compensationId: nov.compensationId, employmentId: a.employmentId });
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
    await setEmploymentInfo(ctx, { employmentId: a.employmentId, probationMonths: 3 });
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
    await setCompensation(ctx, { employmentId: a.employmentId, basicSalary: 3200, effectiveFrom: '2026-10-01' });
    const row = await batchRow(batchId);
    expect(row.recalcEmploymentIds).toEqual([a.employmentId]);
    expect(await listRecalcChangeCategories(ctx, { batchId })).toEqual({ [a.employmentId]: ['compensation'] });
    const events = await owner.db.select().from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, batchId), eq(schema.domainEvent.eventType, 'payroll-batch.recalc-required')));
    // A category, never a value (ADR-0030 Layer 0).
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain('3200');
  });
});
