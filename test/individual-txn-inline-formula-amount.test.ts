/**
 * aac17dd0 — A TYPED AMOUNT ON A "CALCULATED BY FORMULA" PAY ITEM.
 *
 * The same Pay Item code takes either Hours (the formula works the amount out, exactly as before) or a typed
 * Amount on one individual transaction. A typed Amount is stamped calculation_method 'amount', so processing,
 * reprocessing after a formula edit, and relinking the item to a Pay Formula Builder Formula ID all pay it as
 * typed and never run a formula over it. Hours entries keep method NULL plus the pay_item_rule marker.
 *
 * Writes go through the screen's own server actions (only the session/scope boundary is mocked), so the
 * action's amountForWrite and the service's priceIndividualTxnInputTx are both exercised.
 *
 * Fictional data only. EXPECTED FIGURES ARE HAND-COMPUTED LITERALS: basic RM 2,600; formula
 * basic / 26 / 8 × hours = 12.50 an hour → 2 h = 25.00, 40 h = 500.00, 3 h = 37.50. Edited formula
 * basic / 20 / 8 × hours = 16.25 an hour.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { seedPayComponentCatalog, upsertPayComponent, type PayComponentInput } from '../core/pay-components';
import type { PayRule } from '../core/pay-rule';
import { savePayFormula } from '../core/pay-formula';
import { previewIndividualTxnInput } from '../packs/payroll/individual-calculation';
import { createBatch, generatePayslips, reprocessSelectedEmployees, type ReprocessJobResult } from '../core/payroll';
import {
  createIndividualTxnAction,
  createIndividualTxnDayGridAction,
  updateIndividualTxnAction,
} from '../app/payroll/transactions/individual/actions';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const PERIOD = '2026-10';
const DATE = '2026-10-15';
const hoursRule = (divisor: number): PayRule => ({
  kind: 'formula', start: { ref: 'basic' },
  terms: [
    { op: '/', operand: { ref: 'number', value: divisor } },
    { op: '/', operand: { ref: 'number', value: 8 } },
    { op: '*', operand: { ref: 'hours' } },
  ],
});
const item = (code: string, rule: PayRule | null, statutory: boolean): PayComponentInput => ({
  code, name: `Fictional ${code}`, label: `Fictional ${code}`, kind: 'allowance', includedInEpf: statutory, includedInSocsoEis: statutory,
  includedInPcb: statutory, includedInHrdfBase: false, isNonPayable: false, prorates: false, roundingMethod: 'none', rule,
});

let base: Base, ctx: SessionContext, cycleId: string, otId: string;

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
  ctx = await entitledCtx(base);
  scope.s = ctx;
  scope.scopeIds = [base.companyId];
  await seedPayComponentCatalog(ctx);
  const [cycle] = await owner.db.insert(schema.payrollCycle).values({ tenantId: base.tenantId, companyId: base.companyId, name: 'Fictional monthly', code: 'FXAAC', runType: 'regular' }).returning();
  cycleId = cycle.id;
  otId = (await upsertPayComponent(ctx, item('OTFX', hoursRule(26), true))).id;
});

let icSeq = 0;
async function hire(companyId = base.companyId, departmentId = base.deptA) {
  const e = await hireEmployee(ctx, {
    person: { fullName: `Fictional Worker ${randomUUID().slice(0, 6)}`, primaryEmail: `${randomUUID()}@fbaac17dd0.test` },
    companyId, departmentId, employmentType: 'full_time', hiredOn: '2024-01-01',
  });
  await setCompensation(ctx, { employmentId: e.employmentId, basicSalary: 2600, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setStatutoryProfileMY(ctx, { personId: e.personId, icNumber: `90010101${String(7000 + ++icSeq)}` });
  return e.employmentId;
}
const add = (employmentId: string, componentId: string, row: { amount: number; quantity: number | null; unit: string; calculationMethod?: 'amount' | 'formula' }, companyId = base.companyId) =>
  createIndividualTxnAction({ employmentId, companyId, payPeriod: PERIOD, batchId: '', intendedCycleId: cycleId, kind: 'earning', componentId, txnDate: DATE, notes: null, ...row });
const ledger = async (employmentId?: string) => owner.db.select().from(schema.payrollIndividualTxn)
  .where(employmentId ? eq(schema.payrollIndividualTxn.employmentId, employmentId) : undefined);
const rowById = async (id: string) => (await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id, id)))[0];
const slipOf = async (batchId: string, employmentId: string) => (await owner.db.select().from(schema.payslip)
  .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId))))[0];
const events = (type: string) => owner.db.select().from(schema.domainEvent)
  .where(and(eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.eventType, type)));
async function processed() {
  const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: PERIOD, payrollCycleId: cycleId });
  await generatePayslips(ctx, { batchId });
  return batchId;
}
async function reprocess(batchId: string, employmentId: string) {
  const key = randomUUID();
  await reprocessSelectedEmployees(ctx, { batchId, employmentIds: [employmentId], idempotencyKey: key });
  const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, key));
  return (job.result as ReprocessJobResult).outcomes[0];
}

describe('aac17dd0 · entry on a Calculated by Formula Pay Item', () => {
  it('Hours entry is unchanged: the formula prices it, method NULL, pay_item_rule marker', async () => {
    const e = await hire();
    const res = await add(e, otId, { amount: 999, quantity: 2, unit: 'hours' });
    expect(res).toMatchObject({ ok: true });
    expect(await rowById(res.ok ? res.id! : '')).toMatchObject({ amount: '25.00', quantity: '2.00', unit: 'hours', calculationMethod: null, pricingSource: 'pay_item_rule' });
  });

  it('Amount 500 with no quantity is stored as typed: method amount, no pricing marker, audited with actor and method', async () => {
    const e = await hire();
    const res = await add(e, otId, { amount: 500, quantity: null, unit: 'amount', calculationMethod: 'amount' });
    expect(res).toMatchObject({ ok: true });
    const id = res.ok ? res.id! : '';
    expect(await rowById(id)).toMatchObject({ amount: '500.00', quantity: null, unit: 'amount', calculationMethod: 'amount', pricingSource: null, pricingRef: null, pricedAt: null });
    const [created] = (await events('payroll.individual-txn.created')).filter(ev => ev.aggregateId === id);
    expect(created).toMatchObject({ actorType: 'user', actorId: base.adminUserId });
    // ADR-0030 Layer 0: the exact event carries references and no amount. Random
    // identifiers can legitimately contain the digits of the entered amount.
    expect(created.payload).toEqual({
      kind: 'earning', batchId: null, txnDate: DATE, companyId: base.companyId, payPeriod: PERIOD,
      componentId: otId, employmentId: e, intendedCycleId: cycleId, calculationMethod: 'amount',
    });
  });

  it('payroll pays the typed 500 with the Pay Item’s own statutory flags, exactly like a calculated 500', async () => {
    const typed = await hire(), calculated = await hire(), none = await hire(), typedNoFlags = await hire();
    const otNoFlags = (await upsertPayComponent(ctx, item('OTNF', hoursRule(26), false))).id;
    expect(await add(typed, otId, { amount: 500, quantity: null, unit: 'amount', calculationMethod: 'amount' })).toMatchObject({ ok: true });
    expect(await add(calculated, otId, { amount: 1, quantity: 40, unit: 'hours' })).toMatchObject({ ok: true });
    expect(await add(typedNoFlags, otNoFlags, { amount: 500, quantity: null, unit: 'amount', calculationMethod: 'amount' })).toMatchObject({ ok: true });
    expect((await ledger(calculated))[0].amount).toBe('500.00');

    const batchId = await processed();
    const [a, b, c, d] = await Promise.all([typed, calculated, none, typedNoFlags].map(e => slipOf(batchId, e)));
    expect(Number(c.grossPay)).toBe(2600);
    expect(Number(a.grossPay)).toBe(3100);
    expect(Number(d.grossPay)).toBe(3100);
    // Flags on: the typed amount and the calculated amount are treated identically, and both raise statutory.
    expect([a.totalDeductions, a.employerCost, a.netPay]).toEqual([b.totalDeductions, b.employerCost, b.netPay]);
    expect(Number(a.totalDeductions)).toBeGreaterThan(Number(c.totalDeductions));
    // Flags off: the typed amount adds pay but no EPF, SOCSO/EIS or PCB.
    expect(d.totalDeductions).toBe(c.totalDeductions);
    expect(Math.round((Number(d.employerCost) - Number(c.employerCost)) * 100) / 100).toBe(500);
  });

  it('editing the formula and reprocessing still pays 500 and re-prices nothing', async () => {
    const e = await hire();
    const res = await add(e, otId, { amount: 500, quantity: null, unit: 'amount', calculationMethod: 'amount' });
    const id = res.ok ? res.id! : '';
    const batchId = await processed();
    expect(Number((await slipOf(batchId, e)).grossPay)).toBe(3100);

    await upsertPayComponent(ctx, item('OTFX', hoursRule(20), true));
    const outcome = await reprocess(batchId, e);
    expect(outcome.status).toBe('reprocessed');
    expect(outcome.repricedItems).toBeUndefined();
    expect((await rowById(id)).amount).toBe('500.00');
    expect(Number((await slipOf(batchId, e)).grossPay)).toBe(3100);
    expect(await events('payroll.individual-txn.repriced')).toHaveLength(0);
  });

  it('relinking the Pay Item to a Formula ID never runs that formula over the typed amount', async () => {
    const e = await hire();
    expect(await add(e, otId, { amount: 500, quantity: null, unit: 'amount', calculationMethod: 'amount' })).toMatchObject({ ok: true });
    await savePayFormula(ctx, { formulaId: 'OTFX_LINK', description: '25 per input', method: 'write', source: 'Return {#Input} * 25' });
    await upsertPayComponent(ctx, item('OTFX', { kind: 'formula_builder', formulaId: 'OTFX_LINK', dependencies: [] }, true));

    const batchId = await processed();
    expect(Number((await slipOf(batchId, e)).grossPay)).toBe(3100);
    expect((await ledger(e))[0]).toMatchObject({ amount: '500.00', calculationMethod: 'amount', pricingSource: null });
    expect(await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId, batchId))).toHaveLength(0);
  });

  it('round trip Amount → Hours restores method NULL, the marker and the formula amount', async () => {
    const e = await hire();
    const res = await add(e, otId, { amount: 500, quantity: null, unit: 'amount', calculationMethod: 'amount' });
    const id = res.ok ? res.id! : '';

    expect(await updateIndividualTxnAction({ id, companyId: base.companyId, kind: 'earning', componentId: otId, txnDate: DATE, amount: 0, quantity: 3, unit: 'hours', calculationMethod: null, notes: null }))
      .toMatchObject({ ok: true });
    expect(await rowById(id)).toMatchObject({ amount: '37.50', quantity: '3.00', unit: 'hours', calculationMethod: null, pricingSource: 'pay_item_rule' });
    const [cleared] = (await events('payroll.individual-txn.updated')).filter(ev => ev.aggregateId === id);
    expect(cleared).toMatchObject({ actorType: 'user', actorId: base.adminUserId });
    expect(cleared.payload).toMatchObject({ calculationMethod: null, previousCalculationMethod: 'amount' });

    // …and back to Amount on the same row.
    expect(await updateIndividualTxnAction({ id, companyId: base.companyId, kind: 'earning', componentId: otId, txnDate: DATE, amount: 480.5, quantity: null, unit: 'amount', calculationMethod: 'amount', notes: null }))
      .toMatchObject({ ok: true });
    expect(await rowById(id)).toMatchObject({ amount: '480.50', quantity: null, unit: 'amount', calculationMethod: 'amount', pricingSource: null });
  });

  it('refuses Amount with a quantity, Amount on a per-hour item, another company’s employee and the Day by Day grid', async () => {
    const e = await hire();
    // Amount with a quantity (both shapes the browser could send).
    expect(await add(e, otId, { amount: 500, quantity: 2, unit: 'amount', calculationMethod: 'amount' })).toMatchObject({ ok: false });
    expect(await add(e, otId, { amount: 500, quantity: 2, unit: 'hours', calculationMethod: 'amount' })).toMatchObject({ ok: false });
    // A legacy per-hour item keeps its own Hours entry: Amount is not offered there and is refused.
    const perHour = (await upsertPayComponent(ctx, item('PHFX', { kind: 'per_hour', rate: 10 }, true))).id;
    expect(await add(e, perHour, { amount: 500, quantity: null, unit: 'amount', calculationMethod: 'amount' })).toMatchObject({ ok: false });
    // Another company: refused at the screen's scope fence and by the service's own authorization.
    const [other] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Works', registrationNo: 'FXAAC-OTHER' }).returning();
    expect(await add(e, otId, { amount: 500, quantity: null, unit: 'amount', calculationMethod: 'amount' }, other.id)).toEqual({ ok: false, error: 'outOfScope' });
    await expect(previewIndividualTxnInput(ctx, { componentId: otId, employmentId: e, companyId: other.id, payPeriod: PERIOD, txnDate: DATE, amount: 500, quantity: null, unit: 'amount', method: 'amount' }))
      .rejects.toThrow(/unavailable/);
    // Day by Day stays quantity-only.
    expect(await createIndividualTxnDayGridAction({ employmentId: e, companyId: base.companyId, payPeriod: PERIOD, batchId: '', kind: 'earning', componentId: otId,
      unit: 'amount', calculationMethod: 'amount', intendedCycleId: cycleId, lines: [{ txnDate: DATE, amount: 500, quantity: null, notes: null }] }))
      .toEqual({ ok: false, error: 'rowIncomplete' });
    expect(await ledger()).toHaveLength(0);
  });
});
