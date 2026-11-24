/**
 * Board 016276b7 — payroll processing HOLDS an employee whose historical income tax inputs need review instead of failing
 * the whole company: real PostgreSQL, real RLS, real worker ticks, fictional people.
 *
 * Fixture: three employees of one company. Employee 0007 has imported January–March wages whose travel allowance was
 * later made taxable, so the historical tax reader refuses to use that imported month until it is reviewed in
 * Recalculate Income Tax Value. 0008 and 0009 have nothing to review. 0007 also has a loan instalment reserved on the run.
 */
import {and, asc, eq} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {BatchHasPendingEmployeesError, closeBatch, createBatch, reprocessSelectedEmployees} from '../core/payroll';
import {createLoan, prefillLoansForBatch} from '../core/loans';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {previewPayrollHistoryUpload, confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {previewTaxBasisRecalculation, confirmTaxBasisRecalculation} from '../core/payroll-tax-basis';
import {payrollProcessJobHandler, requestPayrollProcessing} from '../core/payroll-processing-job';
import {listTaxHeldEmployees} from '../core/payroll-view';
import {summarize} from '../core/payroll-run-group-result';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll, entitledCtx, owner, resetDb, seedBase, setModule, setSetting, type Base} from './harness';

vi.hoisted(() => {
  vi.stubEnv('AIHR_DB_PROCESS_ROLE', 'worker');
  vi.stubEnv('AIHR_DB_POOL_MAX', '2');
});

let b: Base, ctx: SessionContext, travel: string;
const hired = new Map<string, string>();
const historyRows = (employeeNo: string) => ['01', '02', '03'].flatMap(month => [
  [employeeNo, `2026-${month}`, 'ME', 'BASIC', 'TAXCO', '5000'], [employeeNo, `2026-${month}`, 'ME', 'TRV', 'TAXCO', '500'],
  [employeeNo, `2026-${month}`, 'ME', 'EEEPF', 'TAXCO', '0'], [employeeNo, `2026-${month}`, 'ME', 'EESOCSO', 'TAXCO', '0'],
  [employeeNo, `2026-${month}`, 'ME', 'EEEIS', 'TAXCO', '0'], [employeeNo, `2026-${month}`, 'ME', 'PCB', 'TAXCO', '0'],
]);
const tick = () => runBulkJobTick(owner.client, {handlers: [payrollProcessJobHandler]});
async function runJob(id: string, max = 400) {
  for (let i = 0; i < max; i++) {
    const [row] = await owner.client<{state: string; notified: boolean; error: string | null; result: unknown}[]>`select state,notified_at is not null as notified,error,result from bulk_job where id=${id}::uuid`;
    if (['completed', 'failed', 'cancelled'].includes(row.state) && row.notified) return row;
    if (!await tick()) await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('payroll processing job did not finish');
}
const slipsOf = (batchId: string) => owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId)).orderBy(asc(schema.payslip.employmentId));

beforeEach(async () => {
  process.env.PAYROLL_PROCESS_STEP_EMPLOYEES = '1'; process.env.PAYROLL_PROCESS_CHUNK_BUDGET_MS = '1';
  await resetDb(); b = await seedBase(); hired.clear();
  await setModule(b.tenantId, 'payroll', 'active');
  await setModule(b.tenantId, 'multi_cycle_payroll', 'disabled');
  await setSetting(b.tenantId, 'payroll.reset_enabled', true);
  ctx = await entitledCtx(b);
  await owner.db.update(schema.company).set({companyLabel: 'TAXCO'}).where(eq(schema.company.id, b.companyId));
  await seedPayrollCycleCatalog(ctx, b.companyId);
  const [component] = await owner.db.insert(schema.payComponent).values({tenantId: b.tenantId, code: 'TRV', name: 'Travel allowance', kind: 'allowance',
    displayCategory: 'allowance', includedInPcb: false, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE'}).returning({id: schema.payComponent.id});
  travel = component.id;
  for (const [code, name, ic] of [['0007', 'Fictional Aina', '850202025555'], ['0008', 'Fictional Badrul', '850303035555'], ['0009', 'Fictional Chandra', '850404045555']] as const) {
    const employmentId = (await hireEmployee(ctx, {person: {fullName: name, primaryEmail: `tax-hold-${code}@example.test`}, companyId: b.companyId,
      departmentId: b.deptA, employmentType: 'full_time', employeeCode: code, hiredOn: '2025-01-01'})).employmentId;
    hired.set(code, employmentId);
    const [subject] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
    await setCompensation(ctx, {employmentId, basicSalary: 5000, effectiveFrom: '2025-01-01'});
    await setStatutoryProfileMY(ctx, {personId: subject.personId, icNumber: ic, taxCategory: 1, numChildren: 0});
  }
  const draft = await previewPayrollHistoryUpload(ctx, {name: 'source.csv', operationKey: randomUUID(),
    content: Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS), ...historyRows('0007')]))});
  expect(draft.plan.counts.invalid).toBe(0);
  await confirmPayrollHistoryUpload(ctx, {attemptId: draft.attemptId, previewHash: draft.plan.previewHash, confirmReplacement: true});
  // The allowance becomes taxable after the import: its imported months now need review before PCB can use them.
  await owner.db.update(schema.payComponent).set({includedInPcb: true}).where(eq(schema.payComponent.id, travel));
});
afterEach(() => { delete process.env.PAYROLL_PROCESS_STEP_EMPLOYEES; delete process.env.PAYROLL_PROCESS_CHUNK_BUDGET_MS; });
afterAll(closeAll);

describe('employees held for income tax review during payroll processing (016276b7)', () => {
  it('processes everyone else, holds only the employee with unreviewed tax history and adds them after correction', async () => {
    const aina = hired.get('0007')!, badrul = hired.get('0008')!, chandra = hired.get('0009')!;
    const loan = await createLoan(ctx, {employmentId: aina, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01'});
    const {batchId} = await createBatch(ctx, {companyId: b.companyId, payPeriod: '2026-04'});
    await prefillLoansForBatch(ctx, {batchId});

    const {jobId} = await requestPayrollProcessing(ctx, {batchId});
    const job = await runJob(jobId);
    expect(job.state).toBe('completed');
    expect(job.result).toMatchObject({payslips: 2, taxHeld: 1});

    // Two payslips, none for the held employee; the run is processed and counts only who it paid.
    const slips = await slipsOf(batchId);
    expect(slips.map(s => s.employmentId).sort()).toEqual([badrul, chandra].sort());
    const [run] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(run.status).toBe('processed');
    expect(run.employeeCount).toBe(2);

    // The durable record names the held employee, the month and the tax reader's reason.
    const [processed] = await owner.db.select({payload: schema.domainEvent.payload}).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, batchId), eq(schema.domainEvent.eventType, 'payroll-batch.processed')));
    expect(processed.payload).toMatchObject({count: 2, taxHeldCount: 1, taxHeld: [{employmentId: aina, period: '2026-01'}]});
    expect(String((processed.payload as {taxHeld: {reason: string}[]}).taxHeld[0].reason)).toMatch(/^Imported wage inputs require review for 2026-01/);

    // The held employee's loan instalment stays reserved on the run for the add (not applied at zero, not rescheduled).
    const reservations = await owner.db.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.loanId, loan.id));
    expect(reservations.filter(r => r.reservedBatchId === batchId).map(r => r.status)).toEqual(['reserved']);

    // The screens' read: named, outstanding, with the reason for an income-tax reviewer.
    const held = await listTaxHeldEmployees(ctx, [batchId]);
    expect(held).toMatchObject([{employmentId: aina, employeeCode: '0007', period: '2026-01', outstanding: true, canReviewTax: true}]);
    expect(held[0].reason).toMatch(/require review/);

    // Close stays shut while the held employee is not on the run, and the refusal says they are held.
    const closing = await closeBatch(ctx, {batchId}).catch(error => error);
    expect(closing).toBeInstanceOf(BatchHasPendingEmployeesError);
    expect((closing as BatchHasPendingEmployeesError).employees).toMatchObject([{employmentId: aina, heldForTax: true}]);

    // Without multiple runs a month, only a held employee may be added through a selective reprocess.
    await expect(reprocessSelectedEmployees(ctx, {batchId, employmentIds: [badrul], idempotencyKey: randomUUID()})).rejects.toThrow(/not enabled/);

    // Correct the history, then add the held employee to the same run.
    const preview = await previewTaxBasisRecalculation(ctx, {companyId: b.companyId, year: 2026, upToMonth: 3, employmentIds: [aina]});
    await confirmTaxBasisRecalculation(ctx, {previewId: preview.previewId, previewHash: preview.previewHash});
    const added = await reprocessSelectedEmployees(ctx, {batchId, employmentIds: [aina], idempotencyKey: randomUUID()});
    expect(added).toMatchObject({status: 'completed', added: 1});

    const after = await slipsOf(batchId);
    expect(after.map(s => s.employmentId).sort()).toEqual([aina, badrul, chandra].sort());
    // The employees processed first are untouched: same rows, same versions, same figures.
    for (const original of slips) expect(after.find(s => s.id === original.id)).toEqual(original);
    // The reservation is now applied by the payslip that paid it, and the held list is cleared.
    const applied = await owner.db.select().from(schema.loanRepayment)
      .where(and(eq(schema.loanRepayment.reservedBatchId, batchId), eq(schema.loanRepayment.employmentId, aina)));
    expect(applied.map(r => r.status)).toEqual(['applied']);
    expect((await listTaxHeldEmployees(ctx, [batchId])).map(r => r.outstanding)).toEqual([false]);

    // Once added they are no longer held, so (without multiple runs a month) nothing more can be added, and nothing duplicates.
    await expect(reprocessSelectedEmployees(ctx, {batchId, employmentIds: [aina], idempotencyKey: randomUUID()})).rejects.toThrow(/not enabled/);
    expect(await slipsOf(batchId)).toHaveLength(3);
  }, 180000);
});

describe('run outcome with held employees (pure)', () => {
  it('reads as partly done, and counts held apart from failed and skipped', () => {
    const result = summarize('2026-04', '2026-04-30T00:00:00Z', '2026-04-30T00:01:00Z', [
      {companyId: 'a', companyName: 'A', status: 'succeeded', employeesSelected: 159, employeesSucceeded: 157, employeesHeldForTax: 2},
    ]);
    expect(result).toMatchObject({overallStatus: 'partial', totalEmployeesHeldForTax: 2, totalEmployeesFailed: 0, totalEmployeesSucceeded: 157});
    const clean = summarize('2026-04', '2026-04-30T00:00:00Z', '2026-04-30T00:01:00Z', [
      {companyId: 'a', companyName: 'A', status: 'succeeded', employeesSelected: 3, employeesSucceeded: 3},
    ]);
    expect(clean.overallStatus).toBe('succeeded');
    expect(clean).not.toHaveProperty('totalEmployeesHeldForTax');
  });
});
