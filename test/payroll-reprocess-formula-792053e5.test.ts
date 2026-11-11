/**
 * 792053e5 — PAYROLL REPROCESSING REFLECTS UPDATED PAY ITEM FORMULA CHANGES.
 *
 * ROOT CAUSE pinned by the first test: a one-off transaction on a Pay Item that works out its own amount was priced
 * ONCE, when it was keyed or imported, and every later generation paid that stored figure. Correcting the formula
 * marked the run, yet reprocessing returned the old amount. Processing or reprocessing an OPEN run now re-prices the
 * marked rows from their saved Hours, Days or Quantity with the latest saved formula; closed runs never move.
 *
 * Fictional data only. EXPECTED FIGURES ARE HAND-COMPUTED LITERALS, never produced by the evaluator under test:
 *   basic RM 2,600; formula v1 basic / 30 / 8 × 1.5 × hours = 16.25 an hour → 2h, 3h, 1h = 32.50 + 48.75 + 16.25 = 97.50;
 *   corrected v2 basic / 26 / 8 × 1.5 × hours = 18.75 an hour → 37.50 + 56.25 + 18.75 = 112.50 (exactly +15.00).
 *   One Total for the Month, 10.00 hours: 162.50 → 187.50. Pay Formula Builder Input × 25, qty 2 = 50.00 → Input × 30 = 60.00.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { seedPayComponentCatalog, upsertPayComponent, type PayComponentInput } from '../core/pay-components';
import type { PayRule } from '../core/pay-rule';
import { savePayFormula, payFormulaOptions, getPayFormula } from '../core/pay-formula';
import { createIndividualTxnsBulk } from '../core/payroll-individual-txn';
import { individualTxnPricingMarkerTx } from '../packs/payroll/individual-calculation';
import {
  BatchNeedsRecalculationError, BatchNotResettableError, closeBatch, createBatch, generatePayslips, reprocessSelectedEmployees,
  type ReprocessJobResult,
} from '../core/payroll';
import { runPricingMarkerBackfill } from '../scripts/mark-individual-txn-pricing-792053e5';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const PERIOD = '2026-10';
const formulaRule = (divisor: number): PayRule => ({
  kind: 'formula', start: { ref: 'basic' },
  terms: [
    { op: '/', operand: { ref: 'number', value: divisor } },
    { op: '/', operand: { ref: 'number', value: 8 } },
    { op: '*', operand: { ref: 'number', value: 1.5 } },
    { op: '*', operand: { ref: 'hours' } },
  ],
});
const otItem = (rule: PayRule): PayComponentInput => ({
  code: 'OT15', name: 'Overtime 1.5x', label: 'Overtime 1.5x', kind: 'allowance', includedInEpf: true, includedInSocsoEis: true,
  includedInPcb: false, includedInHrdfBase: false, isNonPayable: false, prorates: false, roundingMethod: 'none', rule,
});

describe('792053e5 reprocess picks up the updated Pay Item formula', () => {
  let base: Base, ctx: SessionContext, employee: string, componentId: string;
  beforeAll(migrateTestDb);
  afterAll(closeAll);
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    ctx = await entitledCtx(base);
    const hired = await hireEmployee(ctx, {
      person: { fullName: 'Fictional Overtime Worker', primaryEmail: `${randomUUID()}@fb792053e5.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01',
    });
    employee = hired.employmentId;
    await setCompensation(ctx, { employmentId: employee, basicSalary: 2600, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(ctx, { personId: hired.personId, icNumber: '900101017921' });
    await seedPayComponentCatalog(ctx);
    componentId = (await upsertPayComponent(ctx, otItem(formulaRule(30)))).id;
  });

  /** Day by Day: three dated lines with the amounts the v1 formula produced when they were entered. */
  const dayByDay = (period = PERIOD) => createIndividualTxnsBulk(ctx, {
    companyId: base.companyId, payPeriod: period, employmentIds: [employee],
    rows: [[2, 32.5, '05'], [3, 48.75, '12'], [1, 16.25, '19']].map(([hours, amount, day]) => ({
      kind: 'earning', componentId, txnDate: `${period}-${day}`, amount: amount as number, quantity: hours as number, unit: 'hours', source: 'import', sourceRef: randomUUID(),
    })),
  });
  const ledger = async () => (await owner.db.select().from(schema.payrollIndividualTxn)
    .where(eq(schema.payrollIndividualTxn.employmentId, employee)).orderBy(schema.payrollIndividualTxn.txnDate));
  const slip = async (batchId: string) => (await owner.db.select().from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employee))))[0];
  const batchRow = async (batchId: string) => (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)))[0];
  const repricedEvents = async () => owner.db.select().from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.eventType, 'payroll.individual-txn.repriced')));
  async function processed(period = PERIOD) {
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(ctx, { batchId });
    return batchId;
  }
  async function reprocess(batchId: string) {
    const key = randomUUID();
    await reprocessSelectedEmployees(ctx, { batchId, employmentIds: [employee], idempotencyKey: key });
    const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, key));
    return (job.result as ReprocessJobResult).outcomes[0];
  }

  it('Day by Day hours on Calculated by Formula: reprocess re-prices with the corrected formula and pays exactly 15.00 more', async () => {
    await dayByDay();
    const entered = await ledger();
    // Every row priced by the Pay Item rule is marked with the rule that priced it.
    expect(entered.map(r => [r.amount, r.pricingSource])).toEqual([['32.50', 'pay_item_rule'], ['48.75', 'pay_item_rule'], ['16.25', 'pay_item_rule']]);
    expect(entered.every(r => r.pricingRef?.startsWith('rule:') && r.pricedAt)).toBe(true);
    const batchId = await processed();
    const v1 = await slip(batchId), runV1 = await batchRow(batchId);
    expect(Number(v1.gross)).toBe(2697.5);

    // Unchanged formula: a reprocess writes no ledger row and no repriced event.
    const unchanged = await reprocess(batchId);
    expect(unchanged.status).toBe('reprocessed');
    expect(unchanged.repricedItems).toBeUndefined();
    expect((await ledger()).map(r => r.amount)).toEqual(['32.50', '48.75', '16.25']);
    expect(await repricedEvents()).toHaveLength(0);

    // The reporter's step 4: amend the formula under Payroll > Settings > Pay Items. Step 5: reprocess.
    await upsertPayComponent(ctx, otItem(formulaRule(26)));
    const outcome = await reprocess(batchId);
    expect(outcome).toMatchObject({ status: 'reprocessed', reasonCode: null, resultRetained: false });
    expect(outcome.repricedItems).toEqual([{ componentId, code: 'OT15', name: 'Overtime 1.5x', count: 3, quantity: 6, unit: 'hours', before: 97.5, after: 112.5 }]);

    // The imported transactions stayed in place (same ids, same hours), only their amounts moved.
    const after = await ledger();
    expect(after.map(r => r.id)).toEqual(entered.map(r => r.id));
    expect(after.map(r => [r.quantity, r.amount])).toEqual([['2.00', '37.50'], ['3.00', '56.25'], ['1.00', '18.75']]);
    expect(after.every(r => r.pricingRef !== entered[0].pricingRef && r.pricingRef?.startsWith('rule:'))).toBe(true);

    const v2 = await slip(batchId), runV2 = await batchRow(batchId);
    expect(Number(v2.gross)).toBe(2712.5);
    expect(Math.round((Number(v2.gross) - Number(v1.gross)) * 100) / 100).toBe(15);
    const gross = (t: unknown) => Number((t as Record<string, number>).gross);
    expect(Math.round((gross(runV2.totals) - gross(runV1.totals)) * 100) / 100).toBe(15);

    // One reference-only event per re-priced row: no amount in the payload (ADR-0030 Layer 0).
    const events = await repricedEvents();
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.payload).toMatchObject({ batchId, componentId, pricingSource: 'pay_item_rule', reason: 'formula-updated' });
      expect(JSON.stringify(e.payload)).not.toMatch(/37\.5|56\.25|18\.75/);
    }
  });

  it('One Total for the Month: a full processing after the edit uses the latest formula (162.50 → 187.50)', async () => {
    await createIndividualTxnsBulk(ctx, { companyId: base.companyId, payPeriod: PERIOD, employmentIds: [employee],
      rows: [{ kind: 'earning', componentId, txnDate: `${PERIOD}-31`, amount: 162.5, quantity: 10, unit: 'hours', source: 'import' }] });
    await upsertPayComponent(ctx, otItem(formulaRule(26)));
    const batchId = await processed();
    expect((await ledger()).map(r => r.amount)).toEqual(['187.50']);
    expect(Number((await slip(batchId)).gross)).toBe(2787.5);
  });

  it('a typed amount on a calculating Pay Item is never mistaken for a calculated one and is never re-priced', async () => {
    await createIndividualTxnsBulk(ctx, { companyId: base.companyId, payPeriod: PERIOD, employmentIds: [employee],
      rows: [{ kind: 'earning', componentId, txnDate: `${PERIOD}-07`, amount: 99.99, quantity: 1, unit: 'hours' }] });
    expect((await ledger())[0]).toMatchObject({ amount: '99.99', pricingSource: null, pricingRef: null, pricedAt: null });
    const batchId = await processed();
    await upsertPayComponent(ctx, otItem(formulaRule(26)));
    const outcome = await reprocess(batchId);
    expect(outcome.status).toBe('reprocessed');
    expect((await ledger())[0].amount).toBe('99.99');
    expect(await repricedEvents()).toHaveLength(0);
  });

  it('a closed month keeps its payslip, ledger rows and events after the edit and a later open-month reprocess', async () => {
    await dayByDay('2026-09');
    const closedId = await processed('2026-09');
    await closeBatch(ctx, { batchId: closedId });
    const closedSlip = await slip(closedId);
    const closedRows = await ledger();
    const closedEvents = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, base.tenantId));

    await upsertPayComponent(ctx, otItem(formulaRule(26)));
    const openId = await processed();
    await reprocess(openId);
    // A closed run cannot be reprocessed at all.
    await expect(reprocessSelectedEmployees(ctx, { batchId: closedId, employmentIds: [employee], idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(BatchNotResettableError);

    expect(await slip(closedId)).toEqual(closedSlip);
    expect(await ledger()).toEqual(closedRows);
    const eventsNow = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, base.tenantId));
    const touching = eventsNow.filter(e => !closedEvents.some(c => c.id === e.id) && closedRows.some(r => r.id === e.aggregateId));
    expect(touching).toEqual([]);
  });

  it('the one-off marking script marks open-month rows priced by the current rule, lists uncertain ones, and leaves closed months alone', async () => {
    const insert = (period: string, day: string, amount: string, hours: string, batchId: string | null = null) => owner.db.insert(schema.payrollIndividualTxn).values({
      tenantId: base.tenantId, batchId, companyId: base.companyId, payPeriod: period, employmentId: employee, kind: 'earning', componentId,
      txnDate: `${period}-${day}`, amount, quantity: hours, unit: 'hours',
    }).returning().then(r => r[0]);
    const closedId = await processed('2026-08');
    await closeBatch(ctx, { batchId: closedId });
    const closedRow = await insert('2026-08', '20', '32.50', '2.00', closedId);
    const certain = await insert(PERIOD, '05', '32.50', '2.00');
    const noHours = await owner.db.insert(schema.payrollIndividualTxn).values({ tenantId: base.tenantId, companyId: base.companyId, payPeriod: PERIOD,
      employmentId: employee, kind: 'earning', componentId, txnDate: `${PERIOD}-06`, amount: '40.00', unit: 'amount' }).returning().then(r => r[0]);
    const URL = process.env.TEST_MIGRATION_DATABASE_URL!;

    const dry = await runPricingMarkerBackfill(URL);
    expect(dry.written).toBe(0);
    expect(dry.marked).toEqual([{ companyId: base.companyId, source: 'pay_item_rule', rows: 1 }]);
    expect(dry.review.map(r => [r.id, r.reason])).toEqual([[noHours.id, 'no hours input on the row']]);
    expect((await ledger()).every(r => r.pricingSource === null)).toBe(true);

    const applied = await runPricingMarkerBackfill(URL, { apply: true });
    expect(applied.written).toBe(1);
    const rows = await ledger();
    expect(rows.find(r => r.id === certain.id)).toMatchObject({ pricingSource: 'pay_item_rule', amount: '32.50' });
    expect(rows.find(r => r.id === closedRow.id)).toMatchObject({ pricingSource: null, amount: '32.50' });
    expect(rows.find(r => r.id === noHours.id)).toMatchObject({ pricingSource: null });
    expect((await runPricingMarkerBackfill(URL, { apply: true })).written).toBe(0);

    // After the rule changes, a row written before the change is no longer certain and is only listed.
    const later = await insert(PERIOD, '09', '16.25', '1.00');
    await upsertPayComponent(ctx, otItem(formulaRule(26)));
    const afterEdit = await runPricingMarkerBackfill(URL);
    expect(afterEdit.review.find(r => r.id === later.id)?.reason).toBe('Pay Item rule changed since the row was written');
  });

  it('marks only rows of the caller’s company: another company’s employee yields no marker', async () => {
    const [other] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Company', registrationNo: 'FB792-OTHER' }).returning();
    const marker = await withTenant(ctx, tx => individualTxnPricingMarkerTx(tx, ctx, { componentId, employmentId: employee, companyId: other.id, payPeriod: PERIOD,
      txnDate: `${PERIOD}-05`, quantity: 2, unit: 'hours', amount: 32.5, calculationMethod: null }));
    expect(marker).toEqual({ pricingSource: null, pricingRef: null, pricedAt: null });
  });
});

describe('792053e5 Pay Formula Builder rows keyed by quantity', () => {
  let base: Base, ctx: SessionContext, employee: string, componentId: string, cycleId: string;
  const period = '2026-05', date = '2026-05-10';
  beforeAll(migrateTestDb);
  afterAll(closeAll);
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    ctx = await entitledCtx(base);
    const hired = await hireEmployee(ctx, { person: { fullName: 'Fictional Night Shift Worker', primaryEmail: `${randomUUID()}@fb792053e5.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
    employee = hired.employmentId;
    await setCompensation(ctx, { employmentId: employee, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(ctx, { personId: hired.personId, icNumber: '900101017922' });
    await seedPayComponentCatalog(ctx);
    const [cycle] = await owner.db.insert(schema.payrollCycle).values({ tenantId: base.tenantId, companyId: base.companyId, name: 'Fictional monthly cycle', code: 'FB792', runType: 'regular' }).returning();
    cycleId = cycle.id;
    await savePayFormula(ctx, { formulaId: 'NSA_RATE', description: '25 per input', method: 'write', source: 'Return {#Input} * 25' });
    componentId = (await upsertPayComponent(ctx, { code: 'NSA', name: 'Night Shift Allowance', label: 'Night Shift Allowance', kind: 'allowance', includedInEpf: false,
      includedInSocsoEis: false, includedInPcb: false, includedInHrdfBase: false, isNonPayable: false, prorates: false, roundingMethod: 'none',
      rule: { kind: 'formula_builder', formulaId: 'NSA_RATE', dependencies: [] } })).id;
  });
  async function resave(source: string) {
    const option = (await payFormulaOptions(ctx)).activeFormulas.find(f => f.formulaId === 'NSA_RATE')!;
    const view = await getPayFormula(ctx, option.id);
    await savePayFormula(ctx, { id: option.id, expectedRevisionId: view!.latest.id, formulaId: 'NSA_RATE', description: 'Updated', method: 'write', source });
  }
  const create = (row: { amount: number; quantity: number | null; unit: string; calculationMethod?: 'amount' | 'formula' }) =>
    createIndividualTxnsBulk(ctx, { companyId: base.companyId, payPeriod: period, employmentIds: [employee], intendedCycleId: cycleId,
      rows: [{ kind: 'earning', componentId, txnDate: date, ...row }] });
  const amountOf = async (id: string) => (await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id, id)))[0];
  async function processedRun() {
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period, payrollCycleId: cycleId });
    await generatePayslips(ctx, { batchId });
    return batchId;
  }
  async function reprocess(batchId: string) {
    const key = randomUUID();
    await reprocessSelectedEmployees(ctx, { batchId, employmentIds: [employee], idempotencyKey: key });
    const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, key));
    return (job.result as ReprocessJobResult).outcomes[0];
  }

  it('re-prices a quantity row with the re-saved formula (50.00 → 60.00); a manual Amount and the One Total raw input keep their own rules', async () => {
    const keyed = (await create({ amount: 999, quantity: 2, unit: 'qty', calculationMethod: 'formula' })).ids[0];
    const manual = (await create({ amount: 125.25, quantity: null, unit: 'amount', calculationMethod: 'amount' })).ids[0];
    const raw = (await create({ amount: 2, quantity: null, unit: 'amount' })).ids[0];
    const firstRevision = (await amountOf(keyed)).pricingRef;
    expect(await amountOf(keyed)).toMatchObject({ amount: '50.00', pricingSource: 'saved_formula' });
    expect(firstRevision).toMatch(/^[0-9a-f-]{36}$/);
    expect(await amountOf(manual)).toMatchObject({ pricingSource: null });
    expect(await amountOf(raw)).toMatchObject({ pricingSource: null });
    const batchId = await processedRun();
    const before = (await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId)))[0];
    expect(Number(before.allowance)).toBe(225.25); // 50.00 + 125.25 + raw 2 × 25

    await resave('Return {#Input} * 30');
    const outcome = await reprocess(batchId);
    expect(outcome.status).toBe('reprocessed');
    expect(outcome.repricedItems).toEqual([{ componentId, code: 'NSA', name: 'Night Shift Allowance', count: 1, quantity: 2, unit: 'qty', before: 50, after: 60 }]);
    expect(await amountOf(keyed)).toMatchObject({ amount: '60.00', pricingSource: 'saved_formula' });
    expect((await amountOf(keyed)).pricingRef).not.toBe(firstRevision);
    expect((await amountOf(manual)).amount).toBe('125.25');
    const after = (await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId)))[0];
    expect(Number(after.allowance)).toBe(245.25); // 60.00 + 125.25 + raw 2 × 30
  });

  it('a formula that cannot price the row: Configuration incomplete naming the item, previous result kept, run still marked and close refused', async () => {
    const keyed = (await create({ amount: 999, quantity: 2, unit: 'qty', calculationMethod: 'formula' })).ids[0];
    const batchId = await processedRun();
    const before = (await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId)))[0];

    await resave('Return {#Input} - 2'); // qty 2 → 0: not a positive transaction amount
    const outcome = await reprocess(batchId);
    expect(outcome).toMatchObject({ status: 'validation_failed', reasonCode: 'PAY_ITEM_FORMULA_FAILED', validationCode: 'pay_item_formula_failed', resultRetained: true });
    expect(outcome.formulaFailure).toMatchObject({ componentId, code: 'NSA', name: 'Night Shift Allowance', dates: [date], reason: 'formula_failed' });
    expect(outcome.repricedItems).toBeUndefined();

    expect((await amountOf(keyed)).amount).toBe('50.00');
    const after = (await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId)))[0];
    expect(after).toEqual(before);
    const run = (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)))[0];
    expect(run.needsRecalcAt).not.toBeNull();
    expect(run.recalcEmploymentIds).toContain(employee);
    await expect(closeBatch(ctx, { batchId })).rejects.toBeInstanceOf(BatchNeedsRecalculationError);

    // Fixed formula, reprocess: the run can close.
    await resave('Return {#Input} * 30');
    expect((await reprocess(batchId)).status).toBe('reprocessed');
    expect((await amountOf(keyed)).amount).toBe('60.00');
    await closeBatch(ctx, { batchId });
  });

  it('a whole-run processing names the failing Pay Item instead of paying the previous figure', async () => {
    await create({ amount: 999, quantity: 2, unit: 'qty', calculationMethod: 'formula' });
    await resave('Return {#Input} - 2');
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period, payrollCycleId: cycleId });
    await expect(generatePayslips(ctx, { batchId })).rejects.toThrow(/Night Shift Allowance \(NSA\): the updated formula could not calculate 1 transaction/);
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(0);
  });
});
