/**
 * ad6ed930 — A FORMULA-PRICED TRANSACTION FOR SOMEONE WHO HAS LEFT.
 *
 * The case (production, 13 Nov 2026, identity kept out): an employee left on 29 Oct; ONOR (NORMAL OT, a Formula
 * Builder item priced from keyed hours) was keyed dated 31 Oct. The formula runtime refused with "employer segment for
 * the selected payroll month" and HR was told to check the Pay Item's set-up. And a genuine late claim (work done
 * before the last day, keyed into a later month) could not be priced at all, although typed amounts already flow into
 * the later regular run through outstandingPaymentPredicate.
 *
 * What is proven here, against the database:
 *   1. A date after the last day is refused with the named PayFormulaAfterLeavingDateError (leftOn), in the leaving
 *      month and in a later month, by the formula runtime itself: never priced.
 *   2. The Individual Transaction save refuses an Effective Date after the last day (TxnAfterLeavingDateError) when
 *      asked to (the window's flag); the last day itself is accepted; callers that do not ask (imports, back pay)
 *      keep their existing behaviour.
 *   3. ONOR hours dated on/before the last day and keyed into the NEXT month price against the departure month and
 *      the compensation at departure (not a raise effective after it), and the later regular run pays them, as a
 *      post-employment payment, and reprocesses them to the same figure.
 *   4. A stored row dated after the last day makes reprocess name the leaving date (reason after_leaving_date).
 *   5. An employee who has not left prices exactly as before.
 *
 * Fictional data only. EXPECTED FIGURES ARE HAND-COMPUTED LITERALS:
 *   NORMAL_OT = basic / 26 / 8 × 1.5 × hours. Basic RM 2,600 → 18.75 an hour → 9 h = 168.75.
 *   A later salary of RM 5,200 would give 37.50 an hour → 9 h = 337.50 (must NOT be used for the leaver).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { seedPayComponentCatalog, upsertPayComponent, type PayComponentInput } from '../core/pay-components';
import type { PayRule } from '../core/pay-rule';
import { savePayFormula } from '../core/pay-formula';
import { createIndividualTxnsBulk, updateIndividualTxn, TxnAfterLeavingDateError } from '../core/payroll-individual-txn';
import { previewIndividualTxnInput } from '../packs/payroll/individual-calculation';
import { PayFormulaAfterLeavingDateError } from '../lib/pay-formula-model';
import { createBatch, generatePayslips, reprocessSelectedEmployees, type ReprocessJobResult } from '../core/payroll';
import { seedPayrollCycleCatalog, listPayrollCycles } from '../core/payroll-cycle';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const LEFT_ON = '2026-10-29';
const LINKED: PayRule = { kind: 'formula_builder', formulaId: 'NORMAL_OT', dependencies: [] };
const ONOR: PayComponentInput = {
  code: 'ONOR', name: 'NORMAL OT', label: 'NORMAL OT', kind: 'allowance', includedInEpf: true, includedInSocsoEis: true,
  includedInPcb: false, includedInHrdfBase: false, isNonPayable: false, prorates: false, roundingMethod: 'none', rule: LINKED,
};

beforeAll(migrateTestDb);
afterAll(closeAll);

describe('ad6ed930 — formula pricing and the employee’s last day', () => {
  let base: Base, ctx: SessionContext, leaver: string, stayer: string, componentId: string, monthly: string;

  async function hire(name: string, code: string) {
    const hired = await hireEmployee(ctx, {
      person: { fullName: name, primaryEmail: `${randomUUID()}@leaver-ot.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', employeeCode: code, hiredOn: '2024-01-01',
    });
    await setCompensation(ctx, { employmentId: hired.employmentId, basicSalary: 2600, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(ctx, { personId: hired.personId, icNumber: code === 'ZX0001' ? '900101017931' : '900202027942' });
    return hired.employmentId;
  }

  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'payroll', 'active');
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    ctx = await entitledCtx(base);
    await seedPayrollCycleCatalog(ctx, base.companyId);
    monthly = (await listPayrollCycles(ctx, base.companyId)).find((c) => c.runType === 'regular')!.id;
    leaver = await hire('Fictional Departed Keyer', 'ZX0001');
    stayer = await hire('Fictional Staying Keyer', 'ZX0002');
    // A raise effective AFTER the last day: a later salary must never price the leaver's work.
    await setCompensation(ctx, { employmentId: leaver, basicSalary: 5200, monthlyAllowance: 0, effectiveFrom: '2026-11-01' });
    await seedPayComponentCatalog(ctx);
    await savePayFormula(ctx, { formulaId: 'NORMAL_OT', description: 'Normal overtime 1.5x', method: 'write', source: 'Return (((({#Basic} / 26) / 8) * 1.5) * {#Input})' });
    componentId = (await upsertPayComponent(ctx, ONOR)).id;
  });

  const leave = () => owner.db.update(schema.employment)
    .set({ terminatedOn: LEFT_ON, resignationDate: LEFT_ON, lastWorkingDate: LEFT_ON }).where(eq(schema.employment.id, leaver));
  const price = (employmentId: string, payPeriod: string, txnDate: string, batchId?: string) => previewIndividualTxnInput(ctx, {
    componentId, employmentId, companyId: base.companyId, payPeriod, txnDate, amount: 0, quantity: 9, unit: 'hours', method: 'formula',
    cycleId: monthly, ...(batchId ? { batchId } : {}),
  });
  const keyOnor = (employmentId: string, payPeriod: string, txnDate: string, refuseAfterLeavingDate = true) => createIndividualTxnsBulk(ctx, {
    companyId: base.companyId, payPeriod, employmentIds: [employmentId], intendedCycleId: monthly, refuseAfterLeavingDate,
    rows: [{ kind: 'earning', componentId, txnDate, amount: 0, quantity: 9, unit: 'hours', calculationMethod: 'formula' }],
  }).then((r) => r.ids[0]);
  const txn = async (id: string) => (await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id, id)))[0];
  const txnsOf = (employmentId: string) => owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
  const slip = async (batchId: string, employmentId: string) => (await owner.db.select().from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId))))[0];
  async function reprocess(batchId: string, employmentId: string) {
    const k = randomUUID();
    await reprocessSelectedEmployees(ctx, { batchId, employmentIds: [employmentId], idempotencyKey: k });
    const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, k));
    return (job.result as ReprocessJobResult).outcomes[0];
  }

  it('refuses a date after the last day with the named error, in the leaving month and in a later month', async () => {
    await leave();
    const inMonth = await price(leaver, '2026-10', '2026-10-31').catch((e: unknown) => e);
    expect(inMonth).toBeInstanceOf(PayFormulaAfterLeavingDateError);
    expect(inMonth).toMatchObject({ code: 'AFTER_LEAVING_DATE', leftOn: LEFT_ON });
    expect(String((inMonth as Error).message)).not.toMatch(/employer segment|Payroll Items/);
    const later = await price(leaver, '2026-11', '2026-11-05').catch((e: unknown) => e);
    expect(later).toMatchObject({ code: 'AFTER_LEAVING_DATE', leftOn: LEFT_ON });
    // Keyed into a later month but dated after the last day: still never priced.
    const lateAfter = await price(leaver, '2026-11', '2026-10-30').catch((e: unknown) => e);
    expect(lateAfter).toBeInstanceOf(PayFormulaAfterLeavingDateError);
    // The same refusal reaches a save that did not ask for the window's date guard (the runtime is the floor).
    await expect(keyOnor(leaver, '2026-11', '2026-10-30', false)).rejects.toBeInstanceOf(PayFormulaAfterLeavingDateError);
    expect(await txnsOf(leaver)).toHaveLength(0);
  });

  it('the save refuses an Effective Date after the last day, accepts the last day, and is opt-in for other writers', async () => {
    await leave();
    const typed = (txnDate: string, refuseAfterLeavingDate?: boolean) => createIndividualTxnsBulk(ctx, {
      companyId: base.companyId, payPeriod: '2026-10', employmentIds: [leaver], intendedCycleId: monthly,
      ...(refuseAfterLeavingDate === undefined ? {} : { refuseAfterLeavingDate }),
      rows: [{ kind: 'overtime', txnDate, amount: 50 }],
    });
    const refused = await typed('2026-10-30', true).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TxnAfterLeavingDateError);
    expect(refused).toMatchObject({ employmentId: leaver, txnDate: '2026-10-30', leftOn: LEFT_ON });
    expect(await txnsOf(leaver)).toHaveLength(0);
    const onLastDay = await typed(LEFT_ON, true);
    expect(onLastDay.ids).toHaveLength(1);
    // Moving that row past the last day through the window's edit path is refused; the stored row is unchanged.
    await expect(updateIndividualTxn(ctx, { id: onLastDay.ids[0], txnDate: '2026-10-31', refuseAfterLeavingDate: true }))
      .rejects.toBeInstanceOf(TxnAfterLeavingDateError);
    expect((await txn(onLastDay.ids[0])).txnDate).toBe(LEFT_ON);
    // Existing behaviour for callers that do not opt in (imports, back pay): a typed amount still saves.
    expect((await typed('2026-10-31')).ids).toHaveLength(1);
  });

  it('prices ONOR hours worked before leaving and keyed into the next month at departure pay; the later run pays them', async () => {
    await leave();
    // Previewed and saved through the same owner, keyed for November, worked on 20 October.
    expect((await price(leaver, '2026-11', '2026-10-20')).amount).toBe(168.75);
    const id = await keyOnor(leaver, '2026-11', '2026-10-20');
    expect(await txn(id)).toMatchObject({ amount: '168.75', quantity: '9.00', unit: 'hours', calculationMethod: 'formula', pricingSource: 'saved_formula', payPeriod: '2026-11' });
    // The last day itself is still a payable work date.
    expect((await price(leaver, '2026-11', LEFT_ON)).amount).toBe(168.75);

    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-11', payrollCycleId: monthly });
    await generatePayslips(ctx, { batchId });
    const paid = await slip(batchId, leaver);
    expect(Number(paid.basicSalary)).toBe(0);
    expect(Number(paid.grossPay)).toBe(168.75);
    expect(Number(paid.grossPay)).not.toBe(337.5);
    expect(paid.statutory).toMatchObject({ postEmploymentPayment: { endedOn: LEFT_ON, sourceTxnIds: [id] } });
    expect(await txn(id)).toMatchObject({ amount: '168.75', consumedBatchId: batchId });

    // Reprocessing re-prices the row through the same owner, to the same figure.
    const outcome = await reprocess(batchId, leaver);
    expect(outcome).toMatchObject({ status: 'reprocessed', reasonCode: null });
    expect(outcome.repricedItems).toBeUndefined();
    expect(Number((await slip(batchId, leaver)).grossPay)).toBe(168.75);
  });

  it('a stored row dated after the last day makes reprocess name the leaving date, not the formula', async () => {
    // Keyed while still employed (as on 13 Nov), then the leaving date is recorded.
    const id = await keyOnor(leaver, '2026-10', '2026-10-31');
    expect((await txn(id)).amount).toBe('168.75');
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-10', payrollCycleId: monthly });
    await generatePayslips(ctx, { batchId });
    const before = await slip(batchId, leaver);
    await leave();
    const outcome = await reprocess(batchId, leaver);
    expect(outcome).toMatchObject({ status: 'validation_failed', reasonCode: 'PAY_ITEM_FORMULA_FAILED', resultRetained: true });
    expect(outcome.formulaFailure).toMatchObject({ componentId, code: 'ONOR', dates: ['2026-10-31'], reason: 'after_leaving_date', leftOn: LEFT_ON, detail: null });
    expect(await slip(batchId, leaver)).toEqual(before);
    expect((await txn(id)).amount).toBe('168.75');
  });

  it('an employee who has not left prices exactly as before (in-month and out-of-month work dates)', async () => {
    await leave();
    expect((await price(stayer, '2026-10', '2026-10-31')).amount).toBe(168.75);
    expect((await price(stayer, '2026-10', '2026-09-30')).amount).toBe(168.75);
    expect((await price(stayer, '2026-11', '2026-11-30')).amount).toBe(168.75);
    const id = await keyOnor(stayer, '2026-11', '2026-11-30');
    expect(await txn(id)).toMatchObject({ amount: '168.75', calculationMethod: 'formula' });
    // A date in the future of a stayer is not "after leaving".
    expect((await price(stayer, '2026-12', '2026-12-31')).amount).toBe(168.75);
  });
});
