/**
 * NORMAL OT (production) — A PAY ITEM SWITCHED FROM AN INLINE FORMULA TO A LINKED FORMULA BUILDER FORMULA.
 *
 * The case: ONOR "NORMAL OT" had an inline Calculated-by-Formula rule; one October row was keyed as 9.00 hours and
 * priced by that rule (method NULL, pricing marker `pay_item_rule`). The Pay Item was then linked to the saved
 * formula NORMAL_OT, `… / 26 / 8 × 1.5 × {#Input}`, where {#Input} is the hours keyed.
 *   Bug 1: payroll built {#Input} from the stored amount, so it paid amount × factor, while entry used the hours.
 *   Bug 2: reprocess refused the row ("The Pay Item no longer calculates its amount from a formula").
 *
 * Fictional data only. EXPECTED FIGURES ARE HAND-COMPUTED LITERALS, never produced by the evaluator under test:
 *   basic RM 2,600. Old inline rule basic / 30 / 8 × 1.5 × hours = 16.25 an hour → 9 h = 146.25 (the saved amount).
 *   NORMAL_OT basic / 26 / 8 × 1.5 × {#Input} = 18.75 an hour → 9 h = 168.75. The bug paid 146.25 × 18.75 = 2,742.19.
 *   Gross = basic 2,600.00 + one-offs.
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
import { savePayFormula, testPayFormula } from '../core/pay-formula';
import { createIndividualTxnsBulk } from '../core/payroll-individual-txn';
import { previewIndividualTxnInput } from '../packs/payroll/individual-calculation';
import { createBatch, generatePayslips, reprocessSelectedEmployees, type ReprocessJobResult } from '../core/payroll';
import { reportFormulaKeyedInputImpact } from '../scripts/report-formula-keyed-input-impact';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const PERIOD = '2026-10', DATE = '2026-10-14';
const inlineRule = (hours: boolean): PayRule => ({
  kind: 'formula', start: { ref: 'basic' },
  terms: hours
    ? [{ op: '/', operand: { ref: 'number', value: 30 } }, { op: '/', operand: { ref: 'number', value: 8 } },
       { op: '*', operand: { ref: 'number', value: 1.5 } }, { op: '*', operand: { ref: 'hours' } }]
    : [{ op: '/', operand: { ref: 'number', value: 26 } }],
});
const LINKED: PayRule = { kind: 'formula_builder', formulaId: 'NORMAL_OT', dependencies: [] };
const onor = (rule: PayRule): PayComponentInput => ({
  code: 'ONOR', name: 'NORMAL OT', label: 'NORMAL OT', kind: 'allowance', includedInEpf: true, includedInSocsoEis: true,
  includedInPcb: false, includedInHrdfBase: false, isNonPayable: false, prorates: false, roundingMethod: 'none', rule,
});

beforeAll(migrateTestDb);
afterAll(closeAll);

describe('NORMAL OT: keyed hours are the {#Input} after a Pay Item is linked to the Formula Builder', () => {
  let base: Base, ctx: SessionContext, employee: string, componentId: string, cycleId: string;
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    ctx = await entitledCtx(base);
    const hired = await hireEmployee(ctx, {
      person: { fullName: 'Fictional Overtime Keyer', primaryEmail: `${randomUUID()}@keyed-input.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01',
    });
    employee = hired.employmentId;
    await setCompensation(ctx, { employmentId: employee, basicSalary: 2600, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(ctx, { personId: hired.personId, icNumber: '900101017931' });
    await seedPayComponentCatalog(ctx);
    const [cycle] = await owner.db.insert(schema.payrollCycle).values({ tenantId: base.tenantId, companyId: base.companyId, name: 'Fictional OT cycle', code: 'KEYED', runType: 'regular' }).returning();
    cycleId = cycle.id;
    componentId = (await upsertPayComponent(ctx, onor(inlineRule(true)))).id;
  });

  const key = (row: { amount: number; quantity: number | null; unit: string | null; calculationMethod?: 'amount' | 'formula' }) =>
    createIndividualTxnsBulk(ctx, { companyId: base.companyId, payPeriod: PERIOD, employmentIds: [employee], intendedCycleId: cycleId,
      rows: [{ kind: 'earning', componentId, txnDate: DATE, ...row }] }).then((r) => r.ids[0]);
  const txn = async (id: string) => (await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id, id)))[0];
  const slip = async (batchId: string) => (await owner.db.select().from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employee))))[0];
  async function processed() {
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: PERIOD, payrollCycleId: cycleId });
    await generatePayslips(ctx, { batchId });
    return batchId;
  }
  async function reprocess(batchId: string) {
    const k = randomUUID();
    await reprocessSelectedEmployees(ctx, { batchId, employmentIds: [employee], idempotencyKey: k });
    const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, k));
    return (job.result as ReprocessJobResult).outcomes[0];
  }
  async function link(source = 'Return (((({#Basic} / 26) / 8) * 1.5) * {#Input})') {
    const saved = await savePayFormula(ctx, { formulaId: 'NORMAL_OT', description: 'Normal overtime 1.5x', method: 'write', source });
    await upsertPayComponent(ctx, onor(LINKED));
    return { id: saved.id, revisionId: saved.revisionId };
  }

  it('the ONOR case end to end: entry, reprocess, processing and the formula tester all pay 9 hours = 168.75, never 146.25 × 18.75', async () => {
    const id = await key({ amount: 146.25, quantity: 9, unit: 'hours' });
    expect(await txn(id)).toMatchObject({ amount: '146.25', quantity: '9.00', unit: 'hours', calculationMethod: null, pricingSource: 'pay_item_rule' });
    const batchId = await processed();
    expect(Number((await slip(batchId)).grossPay)).toBe(2746.25);

    const revision = await link();

    // Reprocess (Bug 2): re-priced from the keyed 9.00 hours through the linked formula, with entry's marker.
    const outcome = await reprocess(batchId);
    expect(outcome).toMatchObject({ status: 'reprocessed', reasonCode: null });
    expect(outcome.repricedItems).toEqual([{ componentId, code: 'ONOR', name: 'NORMAL OT', count: 1, quantity: 9, unit: 'hours', before: 146.25, after: 168.75 }]);
    const row = await txn(id);
    expect(row).toMatchObject({ amount: '168.75', quantity: '9.00', unit: 'hours', calculationMethod: 'formula', pricingSource: 'saved_formula', pricingRef: revision.revisionId });
    expect(Number((await slip(batchId)).grossPay)).toBe(2768.75);
    expect(Number((await slip(batchId)).grossPay)).not.toBe(Math.round((2600 + 146.25 * 18.75) * 100) / 100);

    const events = await owner.db.select().from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, id), eq(schema.domainEvent.eventType, 'payroll.individual-txn.repriced')));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ batchId, componentId, pricingSource: 'saved_formula', previousPricingSource: 'pay_item_rule', calculationMethod: 'formula',
      pricingRef: revision.revisionId, reason: 'formula-builder-linked' });
    expect(JSON.stringify(events[0].payload)).not.toMatch(/168\.75|146\.25/);

    // Entry: the same keyed hours price to the same figure.
    const entry = await previewIndividualTxnInput(ctx, { componentId, employmentId: employee, companyId: base.companyId, payPeriod: PERIOD, txnDate: DATE,
      amount: 0, quantity: 9, unit: 'hours', method: 'formula', cycleId, batchId });
    expect(entry.amount).toBe(168.75);
    // The formula tester with Input 9 for the same employee and run.
    const tested = await testPayFormula(ctx, { ...revision, context: { companyId: base.companyId, employmentId: employee, period: PERIOD, cycleId, asOf: DATE, currentCode: 'ONOR', input: '9' } });
    expect(tested.passed).toBe(true);
    expect(Number(tested.amount)).toBe(168.75);
    // A second reprocess is stable: nothing re-priced, nothing written.
    expect((await reprocess(batchId)).repricedItems).toBeUndefined();
    expect((await txn(id)).amount).toBe('168.75');
  });

  it('processing (whole run) after the switch pays the keyed hours through the linked formula (Bug 1)', async () => {
    const id = await key({ amount: 146.25, quantity: 9, unit: 'hours' });
    await link();
    const batchId = await processed();
    expect(await txn(id)).toMatchObject({ amount: '168.75', calculationMethod: 'formula', pricingSource: 'saved_formula' });
    expect(Number((await slip(batchId)).grossPay)).toBe(2768.75);
  });

  it('Amount-entered rows and an unmarked historical raw input keep the amount as their input', async () => {
    await link();
    const keyed = await key({ amount: 999, quantity: 9, unit: 'hours', calculationMethod: 'formula' });
    const manual = await key({ amount: 125.25, quantity: null, unit: 'amount', calculationMethod: 'amount' });
    // A method-NULL row on a Formula Builder item carries no marker: its amount is the raw input (4 × 18.75 = 75.00),
    // and the descriptive 9.00 hours beside it are not inferred.
    const raw = await key({ amount: 4, quantity: 9, unit: 'hours' });
    expect(await txn(keyed)).toMatchObject({ amount: '168.75', pricingSource: 'saved_formula' });
    expect(await txn(manual)).toMatchObject({ amount: '125.25', calculationMethod: 'amount', pricingSource: null });
    expect(await txn(raw)).toMatchObject({ amount: '4.00', calculationMethod: null, pricingSource: null });
    const batchId = await processed();
    expect(Number((await slip(batchId)).grossPay)).toBe(2969); // 2,600 + 168.75 + 125.25 + 75.00
    const evaluations = await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId, batchId));
    expect(evaluations.map((e) => Number(e.amount))).toEqual([75]);
    expect((await txn(raw)).amount).toBe('4.00');
    expect((await txn(manual)).amount).toBe('125.25');
  });

  it('a genuine formula failure still refuses with its reason and keeps the previous result', async () => {
    const id = await key({ amount: 146.25, quantity: 9, unit: 'hours' });
    const batchId = await processed();
    const before = await slip(batchId);
    await link('Return {#Input} - 9'); // 9 hours → 0: not a positive transaction amount
    const outcome = await reprocess(batchId);
    expect(outcome).toMatchObject({ status: 'validation_failed', reasonCode: 'PAY_ITEM_FORMULA_FAILED', resultRetained: true });
    expect(outcome.formulaFailure).toMatchObject({ componentId, code: 'ONOR', name: 'NORMAL OT', dates: [DATE], reason: 'formula_failed' });
    expect(await txn(id)).toMatchObject({ amount: '146.25', calculationMethod: null, pricingSource: 'pay_item_rule' });
    expect(await slip(batchId)).toEqual(before);
  });

  it('a whole-run processing with a failing linked formula names the Pay Item instead of paying the previous figure', async () => {
    const id = await key({ amount: 146.25, quantity: 9, unit: 'hours' });
    await link('Return {#Input} - 9');
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: PERIOD, payrollCycleId: cycleId });
    await expect(generatePayslips(ctx, { batchId })).rejects.toThrow(/NORMAL OT \(ONOR\): the updated formula could not calculate 1 transaction/);
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(0);
    expect(await txn(id)).toMatchObject({ amount: '146.25', calculationMethod: null, pricingSource: 'pay_item_rule' });
  });

  it('a priced row with no keyed quantity refuses as input missing once its Pay Item is linked', async () => {
    componentId = (await upsertPayComponent(ctx, onor(inlineRule(false)))).id; // basic / 26 = 100.00, needs no input
    const id = await key({ amount: 100, quantity: null, unit: null });
    expect(await txn(id)).toMatchObject({ amount: '100.00', pricingSource: 'pay_item_rule' });
    const batchId = await processed();
    await link();
    const outcome = await reprocess(batchId);
    expect(outcome).toMatchObject({ status: 'validation_failed', reasonCode: 'PAY_ITEM_FORMULA_FAILED' });
    expect(outcome.formulaFailure).toMatchObject({ code: 'ONOR', reason: 'input_missing' });
    expect((await txn(id)).amount).toBe('100.00');
  });

  it('the read-only impact report lists the repricing and the unchanged raw input per company and month, and writes nothing', async () => {
    const priced = await key({ amount: 146.25, quantity: 9, unit: 'hours' });
    await link();
    const raw = await key({ amount: 4, quantity: 9, unit: 'hours' });
    const ledgerBefore = await owner.db.select().from(schema.payrollIndividualTxn).orderBy(schema.payrollIndividualTxn.id);
    const eventsBefore = (await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, base.tenantId))).length;
    const [emp] = await owner.db.select({ code: schema.employment.employeeCode }).from(schema.employment).where(eq(schema.employment.id, employee));

    const report = await reportFormulaKeyedInputImpact(owner, { tenantId: base.tenantId, actorUserId: base.adminUserId });
    expect(report.groups).toEqual([{ companyId: base.companyId, payPeriod: PERIOD, reprice: 1, refuse: 0, unchanged: 1, savedTotal: '146.25', newTotal: '168.75' }]);
    expect(report.rows.find((r) => r.transactionId === priced)).toMatchObject({ outcome: 'reprice', marker: 'pay_item_rule', employeeCode: emp.code, payItemCode: 'ONOR',
      quantity: '9.00', unit: 'hours', savedAmount: '146.25', newAmount: '168.75', difference: '22.50', reason: null });
    expect(report.rows.find((r) => r.transactionId === raw)).toMatchObject({ outcome: 'unchanged', marker: null, savedAmount: '4.00', newAmount: '4.00', quantityPriced: '168.75' });
    expect(JSON.stringify(report)).not.toMatch(/Fictional Overtime Keyer|keyed-input\.test/);

    expect(await owner.db.select().from(schema.payrollIndividualTxn).orderBy(schema.payrollIndividualTxn.id)).toEqual(ledgerBefore);
    expect((await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, base.tenantId))).length).toBe(eventsBefore);
    // Another tenant's administrator cannot be named as the actor.
    await expect(reportFormulaKeyedInputImpact(owner, { tenantId: base.tenantId, actorUserId: randomUUID() })).rejects.toThrow(/not a user of this tenant/);
  });
});
