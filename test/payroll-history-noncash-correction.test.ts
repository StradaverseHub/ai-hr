/**
 * Board 289634a6 — an Income Tax Correction saved for an imported month is NEVER silently kept after the imported
 * taxable Non-Payable amount for that month changes. Real PostgreSQL, real RLS, real payroll processing job,
 * fictional people and amounts.
 *
 * Story: January is imported with a taxable benefit-in-kind car (BKCAR 2,083.33, Non-Payable, Subject to PCB). A
 * travel allowance in the same file later becomes taxable, so January needs review and an Income Tax Correction is
 * saved for it. January is then re-imported with "Update Listed Pay Item Totals" and BKCAR 3,000.00. A later month is
 * processed:
 *   1. when the new import's tax inputs are confirmed, the new 3,000.00 reaches the year-to-date benefit total and
 *      the old correction is not used (it stays in the correction history);
 *   2. when the new import's tax inputs cannot be confirmed (the benefit's PCB setting changed after the import), the
 *      employee is held with the named reason — the old correction is still not used.
 * Also: an identical repeat upload is "unchanged" and records no new revision.
 */
import {and, eq, sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {withTenant, type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch} from '../core/payroll';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {previewPayrollHistoryUpload, confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {previewTaxBasisRecalculation, confirmTaxBasisRecalculation} from '../core/payroll-tax-basis';
import {readEffectiveTaxBasesTx, readTaxBasisFailureDetailsTx, type EffectiveTaxBasis} from '../core/payroll-tax-basis-read';
import {payrollProcessJobHandler, requestPayrollProcessing} from '../core/payroll-processing-job';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll, entitledCtx, owner, resetDb, seedBase, setModule, type Base} from './harness';

vi.hoisted(() => {
  vi.stubEnv('AIHR_DB_PROCESS_ROLE', 'worker');
  vi.stubEnv('AIHR_DB_POOL_MAX', '2');
});

let b: Base, ctx: SessionContext, aina: string, badrul: string, travel: string, benefit: string;
const month = (lines: readonly [string, string][]) =>
  Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS), ...lines.map(([code, amount]) => ['0007', '2026-01', 'ME', code, 'TAXCO', amount])]));
const upload = (lines: readonly [string, string][], mode: 'replace' | 'update_listed') =>
  previewPayrollHistoryUpload(ctx, {name: 'fictional-history.csv', operationKey: randomUUID(), content: month(lines),
    maintenance: {version: 1, mode, reason: 'Fictional payroll history upload'}});
const commit = (review: Awaited<ReturnType<typeof upload>>) =>
  confirmPayrollHistoryUpload(ctx, {attemptId: review.attemptId, previewHash: review.plan.previewHash, confirmReplacement: true});
/** The current (effective) January source for Aina, as every reader sees it under RLS. */
const january = async () => {
  const rows = await withTenant(ctx, tx => tx.execute<{id: string}>(sql`select p.id from payslip p join payroll_batch b on b.id=p.batch_id where p.employment_id=${aina}::uuid and b.pay_period='2026-01'`));
  expect(rows).toHaveLength(1);
  return rows[0].id;
};
const effective = (id: string) => withTenant(ctx, tx => readEffectiveTaxBasesTx(tx, ctx, [id], {includeImported: true}));
const ownedBik = (value: EffectiveTaxBasis | undefined) => (value?.basis.pcbNonCash as {owned: {bik: number}}).owned.bik;
const revisionCount = async () => (await owner.db.select().from(schema.payrollHistoryImportRevision)).length;
const tick = () => runBulkJobTick(owner.client, {handlers: [payrollProcessJobHandler]});
async function runJob(id: string, max = 400) {
  for (let i = 0; i < max; i++) {
    const [row] = await owner.client<{state: string; notified: boolean; error: string | null; result: unknown}[]>`select state,notified_at is not null as notified,error,result from bulk_job where id=${id}::uuid`;
    if (['completed', 'failed', 'cancelled'].includes(row.state) && row.notified) return row;
    if (!await tick()) await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('payroll processing job did not finish');
}

/** Import January with BKCAR 2,083.33, save an Income Tax Correction for it, then re-import BKCAR 3,000.00. */
async function correctThenReimport() {
  const first = await upload([['BASIC', '5000.00'], ['TRV', '500.00'], ['BKCAR', '2083.33'], ['EEEPF', '0'], ['EESOCSO', '0'], ['EEEIS', '0'], ['PCB', '0']], 'replace');
  expect(first.plan.issues).toEqual([]);
  expect(first.plan.counts).toMatchObject({created: 1, invalid: 0});
  await commit(first);
  const v1 = await january();
  // The accepted import owns the benefit as a ready tax input: 2,083.33 of BIK, PCB wages 5,000 (travel not yet taxable).
  const imported = (await effective(v1)).get(v1);
  expect(imported?.correction).toBeNull();
  expect(ownedBik(imported)).toBe(2083.33);

  // Travel becomes taxable, so January needs review; the reviewed Income Tax Correction is saved for it.
  await owner.db.update(schema.payComponent).set({includedInPcb: true}).where(eq(schema.payComponent.id, travel));
  await expect(effective(v1)).rejects.toThrow(/Imported wage inputs require review for 2026-01/);
  const preview = await previewTaxBasisRecalculation(ctx, {companyId: b.companyId, year: 2026, upToMonth: 1, employmentIds: [aina]});
  expect(preview.eligibleCount).toBe(1);
  await confirmTaxBasisRecalculation(ctx, {previewId: preview.previewId, previewHash: preview.previewHash});
  const corrections = await owner.db.select().from(schema.payrollTaxBasisRevision);
  expect(corrections).toHaveLength(1);
  const correctionId = corrections[0].id;
  const corrected = (await effective(v1)).get(v1);
  expect(corrected?.correction?.id).toBe(correctionId);
  expect(corrected?.basis.pcb).toBe(5500);

  // Re-import January with a changed benefit, listed alone, exactly as the reporter's "Update Listed Pay Item Totals".
  const update = await upload([['BKCAR', '3000.00']], 'update_listed');
  expect(update.plan.issues).toEqual([]);
  expect(update.plan.counts).toMatchObject({created: 0, replaced: 1, unchanged: 0, invalid: 0});
  expect(update.plan.rows[0].operation).toBe('replace');
  expect(update.plan.rows[0].itemChanges?.find(item => item.code === 'BKCAR')).toMatchObject({before: '2083.33', after: '3000.00', operation: 'change'});
  await commit(update);
  const v2 = await january();
  expect(v2).not.toBe(v1);
  return {v1, v2, correctionId};
}

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'payroll', 'active');
  await setModule(b.tenantId, 'multi_cycle_payroll', 'disabled');
  ctx = await entitledCtx(b);
  await owner.db.update(schema.company).set({companyLabel: 'TAXCO'}).where(eq(schema.company.id, b.companyId));
  await seedPayrollCycleCatalog(ctx, b.companyId);
  const [trv] = await owner.db.insert(schema.payComponent).values({tenantId: b.tenantId, code: 'TRV', name: 'Travel allowance', kind: 'allowance',
    displayCategory: 'allowance', includedInPcb: false, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE'}).returning({id: schema.payComponent.id});
  travel = trv.id;
  const [bik] = await owner.db.insert(schema.payComponent).values({tenantId: b.tenantId, code: 'BKCAR', name: 'Fictional benefit-in-kind car', kind: 'allowance',
    displayCategory: 'bik', eaFormLine: 'EA_B3', isNonPayable: true, includedInPcb: true, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE'}).returning({id: schema.payComponent.id});
  benefit = bik.id;
  const people: [string, string, string][] = [['0007', 'Fictional Aina', '850202025555'], ['0008', 'Fictional Badrul', '850303035555']];
  const ids: string[] = [];
  for (const [code, name, ic] of people) {
    const employmentId = (await hireEmployee(ctx, {person: {fullName: name, primaryEmail: `noncash-${code}@example.test`}, companyId: b.companyId,
      departmentId: b.deptA, employmentType: 'full_time', employeeCode: code, hiredOn: '2025-01-01'})).employmentId;
    const [subject] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
    await setCompensation(ctx, {employmentId, basicSalary: 5000, effectiveFrom: '2025-01-01'});
    await setStatutoryProfileMY(ctx, {personId: subject.personId, icNumber: ic, taxCategory: 1, numChildren: 0});
    ids.push(employmentId);
  }
  [aina, badrul] = ids;
});
afterAll(closeAll);

describe('imported Non-Payable amounts and a saved Income Tax Correction (289634a6)', () => {
  it('uses the newly imported benefit for year-to-date tax and never the superseded correction', async () => {
    const {v1, v2, correctionId} = await correctThenReimport();

    // The new import's own confirmed tax inputs are effective: the new 3,000.00, no correction attached.
    const now = (await effective(v2)).get(v2);
    expect(now?.correction).toBeNull();
    expect(ownedBik(now)).toBe(3000);
    expect(now?.basis.pcb).toBe(5500);
    // The correction is not deleted: it stays in the correction history, bound to the January source it reviewed.
    const kept = await owner.db.select().from(schema.payrollTaxBasisRevision);
    expect(kept.map(row => [row.id, row.payslipId])).toEqual([[correctionId, v1]]);

    // An identical repeat upload is recognised as already saved: no change, and no new revision.
    const before = await revisionCount();
    const repeat = await upload([['BKCAR', '3000.00']], 'update_listed');
    expect(repeat.plan.counts).toMatchObject({created: 0, replaced: 0, unchanged: 1, invalid: 0});
    expect(repeat.plan.rows[0].operation).toBe('unchanged');
    expect(repeat.plan.rows[0].itemChanges?.find(item => item.code === 'BKCAR')).toMatchObject({before: '3000.00', after: '3000.00', operation: 'keep'});
    await commit(repeat).catch(() => null);
    expect(await revisionCount()).toBe(before);
    expect(await january()).toBe(v2);

    // A later month is processed by the real payroll job: the benefit's year-to-date total is the new 3,000.00
    // (not the old 2,083.33, and not both), the opening prefix is the new January source only, and the old
    // correction is not among the corrections the run used.
    const {batchId} = await createBatch(ctx, {companyId: b.companyId, payPeriod: '2026-02'});
    const {jobId} = await requestPayrollProcessing(ctx, {batchId});
    const job = await runJob(jobId);
    expect(job.state).toBe('completed');
    expect(job.result).toMatchObject({payslips: 2});
    const [slip] = await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, aina)));
    const st = slip.statutory as {pcbNonCash: {accumulated: {bik: number}}; taxBasisCorrections?: {id: string}[]; taxBasisImportedSources: {payslipId: string}[]};
    expect(st.pcbNonCash.accumulated.bik).toBe(3000);
    expect((st.taxBasisCorrections ?? []).map(ref => ref.id)).not.toContain(correctionId);
    expect(st.taxBasisImportedSources.map(source => source.payslipId)).toEqual([v2]);
  }, 180000);

  it('holds the employee with the named reason when the new import cannot be confirmed, instead of using the old correction', async () => {
    const {v2, correctionId} = await correctThenReimport();
    // The benefit's PCB setting changes after the re-import: its stamped tax input can no longer be confirmed.
    await owner.db.update(schema.payComponent).set({includedInPcb: false}).where(eq(schema.payComponent.id, benefit));

    // The reader refuses January rather than falling back to the earlier correction.
    await expect(effective(v2)).rejects.toThrow(/Imported wage inputs require review for 2026-01/);
    const failures = await withTenant(ctx, tx => readTaxBasisFailureDetailsTx(tx, ctx, [v2], {includeImported: true}));
    expect(failures.get(aina)).toMatchObject({period: '2026-01', reason: expect.stringMatching(/^Imported wage inputs require review for 2026-01/)});

    // The real payroll job holds Aina with that reason and pays Badrul.
    const {batchId} = await createBatch(ctx, {companyId: b.companyId, payPeriod: '2026-02'});
    const {jobId} = await requestPayrollProcessing(ctx, {batchId});
    const job = await runJob(jobId);
    expect(job.state).toBe('completed');
    expect(job.result).toMatchObject({payslips: 1, taxHeld: 1});
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(slips.map(s => s.employmentId)).toEqual([badrul]);
    const [processed] = await owner.db.select({payload: schema.domainEvent.payload}).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, batchId), eq(schema.domainEvent.eventType, 'payroll-batch.processed')));
    expect(processed.payload).toMatchObject({taxHeldCount: 1, taxHeld: [{employmentId: aina, period: '2026-01'}]});
    expect(String((processed.payload as {taxHeld: {reason: string}[]}).taxHeld[0].reason)).toMatch(/^Imported wage inputs require review for 2026-01/);
    // Nothing about the saved correction changed.
    expect((await owner.db.select().from(schema.payrollTaxBasisRevision)).map(row => row.id)).toEqual([correctionId]);
  }, 180000);
});
