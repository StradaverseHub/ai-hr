/**
 * Board 124a979e — every payroll change flags Reprocess Required.
 *
 * After a run is processed, a change that can move an employee's pay must put that employee on the run's
 * Reprocess Required list (payroll_batch.recalc_employment_ids, with the change's category on the
 * `payroll-batch.recalc-required` event). These tests pin, per source this lane owns:
 *   - fixed allowances/deductions (add, end, remove; the import job marks once per chunk, not per row);
 *   - the Zakat election, the tax profile, an approved TP1, the payroll policy assignment;
 *   - a one-off transaction keyed for a month whose run is already processed (attached to that run and marked,
 *     or refused when the run is closed, never left waiting for nothing);
 *   - a processed run is marked, a closed run never is, and a change starting after the run's month marks nothing;
 *   - reprocessing produces the new figure (fixed allowance, Zakat).
 * CP38 belongs to the CP38 lane (038c304b / bc6b5490).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import {
  BatchNotDraftError,
  closeBatch,
  createBatch,
  generatePayslips,
  listRecalcChangeCategories,
  markRunsAffectedByEmploymentChangeTx,
  markRunsAffectedByEmploymentWindowsTx,
  reprocessSelectedEmployees,
} from '../core/payroll';
import {
  addFixedTransaction,
  archiveEmploymentPayComponent,
  endEmploymentPayComponent,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
} from '../core/pay-components';
import { assignPolicy, createPolicy } from '../core/payroll-policy';
import { approveTp1ForPerson, submitTp1ForPerson } from '../core/tax-relief';
import { createIndividualTxn } from '../core/payroll-individual-txn';
import { fixedTransactionImportJobHandler } from '../core/fixed-transaction-import-job';
import type { BulkJobRow } from '../core/bulk-job';
import { observeStatements } from './helpers/statement-observer';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

describe('124a979e — payroll changes after processing flag Reprocess Required', () => {
  let base: Base;
  let ctx: SessionContext;
  let ic = 520000;
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    ctx = await entitledCtx(base);
    ic = 520000;
    await seedPayComponentCatalog(ctx);
  });
  afterAll(closeAll);

  const codeId = async (code: string) => (await listPayComponents(ctx, { includeArchived: true })).find((c) => c.code === code)!.id;
  async function hire(name: string, basic = 6000) {
    const e = await hireEmployee(ctx, {
      person: { fullName: name, primaryEmail: `${randomUUID()}@cd124a979e.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01',
    });
    await setStatutoryProfileMY(ctx, { personId: e.personId, icNumber: `900101${++ic}` });
    await setCompensation(ctx, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(ctx, { employmentId: e.employmentId, componentId: await codeId('BASIC'), amount: basic, effectiveFrom: '2026-01-01' });
    return e;
  }
  async function processed(period: string) {
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(ctx, { batchId });
    return batchId;
  }
  const batchRow = async (batchId: string) =>
    (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)))[0];
  const slip = async (batchId: string, employmentId: string) =>
    (await owner.db.select().from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId))))[0];
  const recalcEvents = async (batchId: string) =>
    owner.db.select({ payload: schema.domainEvent.payload }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, batchId), eq(schema.domainEvent.eventType, 'payroll-batch.recalc-required')));
  async function reprocess(batchId: string, employmentIds: string[]) {
    const key = randomUUID();
    await reprocessSelectedEmployees(ctx, { batchId, employmentIds, idempotencyKey: key });
    const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, key));
    expect(job.status).toBe('completed');
  }

  it('fixed allowance added after processing marks the run once, and reprocessing pays it', async () => {
    const e = await hire('Fixed Late');
    const other = await hire('Untouched');
    const batchId = await processed('2026-10');
    const before = await slip(batchId, e.employmentId);
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();

    await addFixedTransaction(ctx, { employmentId: e.employmentId, componentId: await codeId('ALLOWANCE'), amount: 300, effectiveFrom: '2026-10-01' });
    const marked = await batchRow(batchId);
    expect(marked.needsRecalcAt).not.toBeNull();
    expect(marked.recalcEmploymentIds).toEqual([e.employmentId]);
    expect(await listRecalcChangeCategories(ctx, { batchId })).toEqual({ [e.employmentId]: ['fixed_item'] });

    await reprocess(batchId, [e.employmentId]);
    const after = await slip(batchId, e.employmentId);
    expect(Number(after.grossPay)).toBeCloseTo(Number(before.grossPay) + 300, 2);
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
    expect(Number((await slip(batchId, other.employmentId)).grossPay)).toBeCloseTo(6000, 2);
  });

  it('a fixed item starting after the run month marks nothing; ending or removing one that paid the month marks it', async () => {
    const e = await hire('Fixed Window');
    const { id } = await setEmploymentPayComponent(ctx, { employmentId: e.employmentId, componentId: await codeId('ALLOWANCE'), amount: 200, effectiveFrom: '2026-01-01', prorateOverride: false });
    const batchId = await processed('2026-10');

    await addFixedTransaction(ctx, { employmentId: e.employmentId, componentId: await codeId('HOUSING'), amount: 50, effectiveFrom: '2026-12-01' });
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();

    // Ending it from December (after October) does not move October.
    await endEmploymentPayComponent(ctx, { id, employmentId: e.employmentId, effectiveTo: '2026-12-31' });
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();

    // Ending it in September moves October.
    await endEmploymentPayComponent(ctx, { id, employmentId: e.employmentId, effectiveTo: '2026-09-30' });
    expect((await batchRow(batchId)).recalcEmploymentIds).toEqual([e.employmentId]);

    await owner.db.update(schema.payrollBatch).set({ needsRecalcAt: null, recalcEmploymentIds: null }).where(eq(schema.payrollBatch.id, batchId));
    await archiveEmploymentPayComponent(ctx, { id, employmentId: e.employmentId });
    expect((await batchRow(batchId)).recalcEmploymentIds).toEqual([e.employmentId]);
  });

  it('a closed run is never marked', async () => {
    const e = await hire('Closed Month');
    const batchId = await processed('2026-10');
    await closeBatch(ctx, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');
    // Allowed or refused by the writer's own closed-month rule; either way the closed run is not marked.
    await addFixedTransaction(ctx, { employmentId: e.employmentId, componentId: await codeId('HOUSING'), amount: 100, effectiveFrom: '2026-10-01' }).catch(() => undefined);
    await setStatutoryProfileMY(ctx, { personId: e.personId, icNumber: `900101${ic}`, zakatActive: true, zakatMethod: 'fixed', zakatFixed: 80 });
    const row = await batchRow(batchId);
    expect(row.needsRecalcAt).toBeNull();
    expect(row.recalcEmploymentIds ?? []).toEqual([]);
  });

  it('a Zakat election change marks every unclosed processed run of the person, and reprocessing applies it', async () => {
    const e = await hire('Zakat Later');
    const sept = await processed('2026-09');
    const oct = await processed('2026-10');
    expect(Number(((await slip(oct, e.employmentId)).statutory as Record<string, number>).zakat ?? 0)).toBe(0);

    await setStatutoryProfileMY(ctx, { personId: e.personId, icNumber: `900101${ic}`, zakatActive: true, zakatMethod: 'fixed', zakatFixed: 80, zakatEffectiveFrom: '2026-10-01' });
    // The election's effective dates are display-only in the calculation, so September is stale too.
    for (const batchId of [sept, oct]) {
      expect((await batchRow(batchId)).recalcEmploymentIds).toEqual([e.employmentId]);
      expect(await listRecalcChangeCategories(ctx, { batchId })).toEqual({ [e.employmentId]: ['zakat'] });
    }
    await reprocess(oct, [e.employmentId]);
    expect(Number(((await slip(oct, e.employmentId)).statutory as Record<string, number>).zakat)).toBe(80);

    // Re-saving the same election marks nothing new.
    const events = (await recalcEvents(sept)).length;
    await setStatutoryProfileMY(ctx, { personId: e.personId, icNumber: `900101${ic}`, zakatActive: true, zakatMethod: 'fixed', zakatFixed: 80, zakatEffectiveFrom: '2026-10-01' });
    expect((await recalcEvents(sept)).length).toBe(events);
  });

  it('a tax profile change marks the person (Tax settings); the tax reference number alone does not', async () => {
    const e = await hire('Tax Later');
    const batchId = await processed('2026-10');
    // Settle the card once (the hire left some columns at their defaults), then start from an unmarked run.
    await setTaxProfileMY(ctx, { personId: e.personId, taxNumber: 'SG 1234567890', childReliefMode: 'manual', numChildren: 0 });
    await owner.db.update(schema.payrollBatch).set({ needsRecalcAt: null, recalcEmploymentIds: null }).where(eq(schema.payrollBatch.id, batchId));
    await setTaxProfileMY(ctx, { personId: e.personId, taxNumber: 'SG 9999999999', childReliefMode: 'manual', numChildren: 0 });
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();
    await setTaxProfileMY(ctx, { personId: e.personId, taxNumber: 'SG 9999999999', childReliefMode: 'manual', numChildren: 3 });
    expect((await batchRow(batchId)).recalcEmploymentIds).toEqual([e.employmentId]);
    expect((await listRecalcChangeCategories(ctx, { batchId }))[e.employmentId]).toContain('tax_profile');
  });

  it('an approved TP1 marks its effective month onward, not the months before it', async () => {
    const e = await hire('TP1 Later');
    const sept = await processed('2026-09');
    const oct = await processed('2026-10');
    const { id } = await submitTp1ForPerson(ctx, { personId: e.personId, assessmentYear: 2026, tp1Amount: 1200, deductionMonth: 10 });
    expect((await batchRow(oct)).needsRecalcAt).toBeNull(); // submitted only: not yet feeding payroll
    await approveTp1ForPerson(ctx, { personId: e.personId, id, approvedMonth: 10, approvedYear: 2026 });
    expect((await batchRow(oct)).recalcEmploymentIds).toEqual([e.employmentId]);
    expect(await listRecalcChangeCategories(ctx, { batchId: oct })).toEqual({ [e.employmentId]: ['tax_profile'] });
    expect((await batchRow(sept)).needsRecalcAt).toBeNull();
  });

  it('a payroll policy assignment marks the person (Payroll policy); re-assigning the same policy marks nothing more', async () => {
    const e = await hire('Policy Later');
    const batchId = await processed('2026-10');
    const { id } = await createPolicy(ctx, { companyId: base.companyId, name: `Policy ${randomUUID().slice(0, 8)}`, policyType: 'monthly' });
    await assignPolicy(ctx, { employmentId: e.employmentId, policyId: id });
    expect((await batchRow(batchId)).recalcEmploymentIds).toEqual([e.employmentId]);
    expect(await listRecalcChangeCategories(ctx, { batchId })).toEqual({ [e.employmentId]: ['payroll_policy'] });
    const events = (await recalcEvents(batchId)).length;
    await assignPolicy(ctx, { employmentId: e.employmentId, policyId: id });
    expect((await recalcEvents(batchId)).length).toBe(events);
  });

  it('a one-off keyed for a month whose run is processed lands on that run and marks it; a closed run refuses it', async () => {
    const e = await hire('One-off Late');
    const oct = await processed('2026-10');
    const { id } = await createIndividualTxn(ctx, { companyId: base.companyId, payPeriod: '2026-10', employmentId: e.employmentId, kind: 'earning', txnDate: '2026-10-10', amount: 50 });
    const [row] = await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id, id));
    expect(row.batchId).toBe(oct);
    expect((await batchRow(oct)).recalcEmploymentIds).toEqual([e.employmentId]);

    // A month with no run yet stays period-keyed, exactly as before.
    const { id: later } = await createIndividualTxn(ctx, { companyId: base.companyId, payPeriod: '2026-12', employmentId: e.employmentId, kind: 'earning', txnDate: '2026-12-10', amount: 50 });
    expect((await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id, later)))[0].batchId).toBeNull();

    const nov = await processed('2026-11');
    await closeBatch(ctx, { batchId: nov });
    await expect(createIndividualTxn(ctx, { companyId: base.companyId, payPeriod: '2026-11', employmentId: e.employmentId, kind: 'earning', txnDate: '2026-11-10', amount: 50 }))
      .rejects.toBeInstanceOf(BatchNotDraftError);
  });

  it('the batched window mark costs the same statements for 2 or 8 employments and marks what the single calls mark', async () => {
    const people: Awaited<ReturnType<typeof hire>>[] = [];
    for (let i = 0; i < 8; i++) people.push(await hire(`Window ${i}`));
    const sept = await processed('2026-09');
    const oct = await processed('2026-10');
    const windows = people.map((p, i) => ({ employmentId: p.employmentId, from: i % 2 ? '2026-10-01' : '2026-09-01', until: i % 2 ? null : '2026-10-01' }));
    const cost = async (n: number) => {
      await owner.db.update(schema.payrollBatch).set({ needsRecalcAt: null, recalcEmploymentIds: null });
      return (await observeStatements(() => withTenant(ctx, (tx) => markRunsAffectedByEmploymentWindowsTx(tx, ctx, { category: 'fixed_item', windows: windows.slice(0, n) })))).statements.length;
    };
    const two = await cost(2);
    const eight = await cost(8);
    expect(eight).toBe(two);
    const batched = { sept: (await batchRow(sept)).recalcEmploymentIds, oct: (await batchRow(oct)).recalcEmploymentIds };

    await owner.db.update(schema.payrollBatch).set({ needsRecalcAt: null, recalcEmploymentIds: null });
    await withTenant(ctx, async (tx) => {
      for (const w of windows) await markRunsAffectedByEmploymentChangeTx(tx, ctx, { employmentIds: [w.employmentId], category: 'fixed_item', from: w.from, until: w.until });
    });
    const single = { sept: (await batchRow(sept)).recalcEmploymentIds, oct: (await batchRow(oct)).recalcEmploymentIds };
    expect([...(batched.sept as string[])].sort()).toEqual([...(single.sept as string[])].sort());
    expect([...(batched.oct as string[])].sort()).toEqual([...(single.oct as string[])].sort());
    // September: only the windows that reach it (even indexes); October: the odd ones (the even ones end in September).
    expect([...(single.sept as string[])].sort()).toEqual(people.filter((_, i) => i % 2 === 0).map((p) => p.employmentId).sort());
    expect([...(single.oct as string[])].sort()).toEqual(people.filter((_, i) => i % 2 === 1).map((p) => p.employmentId).sort());
  });

  it('the Fixed Transaction import job marks once per chunk, not once per row', async () => {
    const people = [await hire('Import A'), await hire('Import B'), await hire('Import C')];
    const batchId = await processed('2026-10');
    const allowance = await codeId('ALLOWANCE');
    const job = { id: randomUUID(), company_ids: [base.companyId] } as unknown as BulkJobRow;
    const handler = fixedTransactionImportJobHandler;
    await withTenant(ctx, async (tx) => {
      await handler.beginChunkTx!(tx, ctx, job);
      for (const p of people) {
        const step = { seq: 1, kind: 'row', row_num: 2, payload: { employeeId: p.employmentId, resolved: {
          employmentId: p.employmentId, companyId: base.companyId, componentId: allowance, amount: 100, effectiveFrom: '2026-10-01',
          effectiveTo: null, runType: null, payrollCycleId: null, remarks: null,
        } } } as unknown as Parameters<typeof handler.applyStepTx>[3];
        await tx.transaction((stepTx) => handler.applyStepTx(stepTx, ctx, job, step, new Map()));
      }
      // No row marked on its own.
      expect((await recalcEvents(batchId)).length).toBe(0);
      await handler.endChunkTx!(tx, ctx, job);
    });
    const row = await batchRow(batchId);
    expect([...(row.recalcEmploymentIds as string[])].sort()).toEqual(people.map((p) => p.employmentId).sort());
    const events = await recalcEvents(batchId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ changeCategory: 'fixed_item' });
  });
});
