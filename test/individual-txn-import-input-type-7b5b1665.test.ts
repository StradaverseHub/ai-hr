/**
 * 7b5b1665 — ONE TOTAL FOR THE MONTH KEEPS EACH ROW'S INPUT TYPE ON A FORMULA PAY ITEM.
 *
 * Reported case: an Amount of 105.40 imported for NORMAL OT (a Pay Item linked to a Formula Builder formula) was
 * stored without its input method, so payroll ran the overtime formula on 105.40. Now an Amount row is written with
 * calculation_method 'amount' and pays exactly the typed figure; a Qty/Hours/Days/Units row is written with 'formula'
 * and priced by the same owner as Add new transaction; a type the item refuses or both cells filled is refused by row
 * and Pay Item; duplicates compare type and value; an earlier method-less import of the same value refuses the new
 * row; Day by Day stays quantity-only (owner, 24 Nov 2026) and points amounts to One Total for the Month.
 *
 * Fictional data only. EXPECTED FIGURES ARE HAND-COMPUTED LITERALS: the saved formula is `{#Input} * 25`, so Qty 2 pays
 * 50.00 and a legacy 105.40 fed in as input pays 2,635.00. The inline item is basic / 100 × hours with basic 5,000, so
 * 2 hours pay 100.00.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { seedPayComponentCatalog, upsertPayComponent, type PayComponentInput } from '../core/pay-components';
import type { PayRule } from '../core/pay-rule';
import { savePayFormula, payFormulaOptions, getPayFormula } from '../core/pay-formula';
import { previewIndividualTxnInput } from '../packs/payroll/individual-calculation';
import { createBatch, generatePayslips } from '../core/payroll';
import { validateIndividualImport, confirmIndividualImport, revertIndividualImport } from '../core/individual-txn-import';
import { INDIVIDUAL_IMPORT_HEADERS, type IndividualImportMethod } from '../lib/payroll-txn-import-schema';
import { toCsv } from '../lib/csv';
import { reportFormulaBuilderAmountImports } from '../scripts/report-formula-builder-amount-imports-7b5b1665';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const PERIOD = '2026-05', DATE = '2026-05-10';
const t = createTranslator({ locale: 'en', messages: en, namespace: 'payroll.txnImport.reason' });
const item = (code: string, rule: PayRule): PayComponentInput => ({
  code, name: `Fictional ${code}`, label: `Fictional ${code}`, kind: 'allowance', includedInEpf: false, includedInSocsoEis: false, includedInPcb: false,
  includedInHrdfBase: false, isNonPayable: false, prorates: false, roundingMethod: 'none', rule,
});

let base: Base, ctx: SessionContext, employee: string, code: string, onorId: string, inlineId: string, cycleId: string;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); base = await seedBase();
  await setModule(base.tenantId, 'typed_pay_components', 'active'); await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
  ctx = await entitledCtx(base);
  const hired = await hireEmployee(ctx, { person: { fullName: 'Fictional import employee', primaryEmail: `import-type-${randomUUID()}@example.invalid` }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
  employee = hired.employmentId;
  await setCompensation(ctx, { employmentId: employee, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(ctx, { personId: hired.personId, icNumber: '900101011234' });
  await seedPayComponentCatalog(ctx);
  const [emp] = await owner.db.select({ code: schema.employment.employeeCode }).from(schema.employment).where(eq(schema.employment.id, employee)); code = emp.code!;
  const [cycle] = await owner.db.insert(schema.payrollCycle).values({ tenantId: base.tenantId, companyId: base.companyId, name: 'Fictional monthly', code: 'MONTHLY', runType: 'regular' }).returning(); cycleId = cycle.id;
  await savePayFormula(ctx, { formulaId: 'ONOR_TEST', description: '25 per input', method: 'write', source: 'Return {#Input} * 25' });
  onorId = (await upsertPayComponent(ctx, item('ONOR', { kind: 'formula_builder', formulaId: 'ONOR_TEST', dependencies: [] }))).id;
  inlineId = (await upsertPayComponent(ctx, item('OTIN', { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'number', value: 100 } }, { op: '*', operand: { ref: 'hours' } }] }))).id;
});

const monthly = (payItem: string, type: string, quantity: string, amount: string) => [code, 'Fictional import employee', PERIOD, 'MONTHLY', payItem, DATE, type, quantity, amount, 'remark'];
const daily = (payItem: string, type: string, value: string) => [code, 'Fictional import employee', PERIOD, 'MONTHLY', payItem, DATE, type, value, 'daily'];
const validate = (method: IndividualImportMethod, rows: string[][]) => validateIndividualImport(ctx, {
  operationId: randomUUID(), sourceName: `${method}.xlsx`, csv: toCsv([[...INDIVIDUAL_IMPORT_HEADERS[method]], ...rows]), method, scopeIds: [base.companyId],
});
const confirm = (id: string) => confirmIndividualImport(ctx, { id, scopeIds: [base.companyId] });
const ledger = () => owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.employmentId, employee));

describe('One Total for the Month on a Formula Builder Pay Item', () => {
  it('stores an Amount row as method amount, and the processed payslip pays exactly 105.40', async () => {
    const input = await validate('monthly', [monthly('ONOR', 'amount', '', '105.40')]);
    expect(input.preview.rows[0]).toMatchObject({ ok: true, amount: '105.40', inputType: 'amount', inputValue: 105.4, calculationMethod: 'amount' });
    const [attempt] = await owner.db.select().from(schema.payrollTxnImportAttempt).where(eq(schema.payrollTxnImportAttempt.id, input.id));
    expect(attempt.bindings['2']).toMatchObject({ componentId: onorId, quantity: null, unit: 'amount', calculationMethod: 'amount' });
    expect((await confirm(input.id)).written).toBe(1);
    const [row] = await ledger();
    expect(row).toMatchObject({ amount: '105.40', quantity: null, unit: 'amount', calculationMethod: 'amount', pricingSource: null, source: 'import' });
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: PERIOD, payrollCycleId: cycleId });
    await generatePayslips(ctx, { batchId });
    const [slip] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(Number(slip.allowance)).toBe(105.4);
    expect(await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId, batchId))).toHaveLength(0);
  });

  it('stores a Qty/Hours row as method formula with the same figure as Add new transaction', async () => {
    const manual = await previewIndividualTxnInput(ctx, { componentId: onorId, employmentId: employee, companyId: base.companyId, payPeriod: PERIOD, txnDate: DATE, amount: 0, quantity: 2, unit: 'hours', method: 'formula', cycleId });
    expect(manual.amount).toBe(50);
    const input = await validate('monthly', [monthly('ONOR', 'hours', '2', '')]);
    expect(input.preview.rows[0]).toMatchObject({ ok: true, amount: '50.00', inputType: 'hours', inputValue: 2, calculationMethod: 'formula' });
    expect((await confirm(input.id)).written).toBe(1);
    expect((await ledger())[0]).toMatchObject({ amount: '50.00', quantity: '2.00', unit: 'hours', calculationMethod: 'formula', pricingSource: 'saved_formula' });
  });

  it('refuses at confirmation when the formula changed after preview, writing nothing', async () => {
    const input = await validate('monthly', [monthly('ONOR', 'qty', '2', '')]);
    expect(input.preview.rows[0].amount).toBe('50.00');
    const option = (await payFormulaOptions(ctx)).activeFormulas.find((f) => f.formulaId === 'ONOR_TEST')!;
    const view = await getPayFormula(ctx, option.id);
    await savePayFormula(ctx, { id: option.id, expectedRevisionId: view!.latest.id, formulaId: 'ONOR_TEST', description: '30 per input', method: 'write', source: 'Return {#Input} * 30' });
    const saved = await confirm(input.id);
    expect(saved.written).toBe(0);
    expect(saved.outcomes[0]).toMatchObject({ state: 'failed', row: { reason: 'previewChanged' } });
    expect(await ledger()).toHaveLength(0);
  });

  it('refuses an Input Type the item does not take, both cells filled, a blank type and a missing quantity, by row and Pay Item', async () => {
    const input = await validate('monthly', [
      monthly('ONOR', 'amount', '4', '80.00'),
      monthly('ONOR', '', '', '105.40'),
      monthly('ONOR', 'hours', '', ''),
      monthly('OTIN', 'days', '2', ''),
      monthly('ONOR', 'minutes', '2', ''),
    ]);
    expect(input.preview.rows.map((r) => [r.rowNum, r.ok, r.reason, r.detail])).toEqual([
      [2, false, 'amountAndQuantity', { row: 2, code: 'ONOR' }],
      [3, false, 'formulaInputTypeRequired', { row: 3, code: 'ONOR' }],
      [4, false, 'formulaQuantityRequired', { row: 4, code: 'ONOR' }],
      [5, false, 'inputTypeNotAccepted', { row: 5, code: 'OTIN', value: 'days' }],
      [6, false, 'inputTypeInvalid', undefined],
    ]);
    expect(t('amountAndQuantity', input.preview.rows[0].detail as never)).toBe('Row 2: fill in either Amount or Quantity for ONOR, not both');
    expect(t('inputTypeNotAccepted', input.preview.rows[3].detail as never)).toBe('Row 5: OTIN does not take days as its Input Type');
    expect((await confirm(input.id)).written).toBe(0);
    expect(await ledger()).toHaveLength(0);
  });

  it('compares Input Type and value for duplicates, and names both with what the saved line pays', async () => {
    const first = await validate('monthly', [monthly('ONOR', 'amount', '', '105.40')]);
    expect((await confirm(first.id)).written).toBe(1);
    const second = await validate('monthly', [
      monthly('ONOR', 'amount', '', '105.40'),
      monthly('ONOR', 'qty', '105.40', ''),
      monthly('ONOR', 'hours', '2', ''),
      monthly('ONOR', 'hours', '2', ''),
    ]);
    expect(second.preview.rows.map((r) => [r.ok, r.reason, r.amount])).toEqual([
      [false, 'duplicateInRunTyped', '105.40'], [true, '', '2635.00'], [true, '', '50.00'], [false, 'duplicateInFileTyped', '50.00'],
    ]);
    expect(second.preview.rows[0].detail).toEqual({ code: 'ONOR', type: 'amount', value: '105.40', pays: '105.40' });
    expect(t('duplicateInRunTyped', second.preview.rows[0].detail as never)).toBe('The pay run already has ONOR as Amount 105.40 for this employee (pays MYR 105.40) — it is already there');
    expect(t('duplicateInFileTyped', second.preview.rows[3].detail as never)).toBe('Row 4 of this file already has ONOR as Hours 2.00 for this employee');
  });

  it('refuses a new row of the same value as an earlier method-less import, so the employee is not paid twice', async () => {
    const [legacy] = await owner.db.insert(schema.payrollIndividualTxn).values({ tenantId: base.tenantId, companyId: base.companyId, payPeriod: PERIOD, employmentId: employee, kind: 'earning',
      componentId: onorId, txnDate: DATE, amount: '105.40', unit: 'amount', source: 'import', intendedCycleId: cycleId }).returning();
    const input = await validate('monthly', [monthly('ONOR', 'amount', '', '105.40'), monthly('ONOR', 'qty', '105.40', ''), monthly('ONOR', 'amount', '', '99.00')]);
    expect(input.preview.rows.map((r) => [r.ok, r.reason, r.detail])).toEqual([
      [false, 'legacyFormulaImport', { code: 'ONOR', value: '105.40', pays: '2635.00' }],
      [false, 'legacyFormulaImport', { code: 'ONOR', value: '105.40', pays: '2635.00' }],
      [true, '', undefined],
    ]);
    expect(t('legacyFormulaImport', input.preview.rows[0].detail as never))
      .toBe('An earlier import saved ONOR 105.40 as Qty (pays MYR 2635.00). Correct that transaction first, so the employee is not paid twice.');

    // The read-only report lists that earlier line with what it pays now and as an Amount, and writes nothing.
    const before = await ledger();
    const report = await reportFormulaBuilderAmountImports(owner, { tenantId: base.tenantId, actorUserId: base.adminUserId });
    expect(report.rows).toEqual([expect.objectContaining({ transactionId: legacy.id, employeeCode: code, payItemCode: 'ONOR', savedAmount: '105.40', paysNow: '2635.00', asAmount: '105.40', difference: '-2529.60', reason: null })]);
    expect(report.groups).toEqual([{ companyId: base.companyId, payPeriod: PERIOD, rows: 1, refused: 0, paysNowTotal: '2635.00', asAmountTotal: '105.40' }]);
    expect(await ledger()).toEqual(before);
  });

  it('reverses a method-amount import, and refuses reversal once its Input Type was edited', async () => {
    const input = await validate('monthly', [monthly('ONOR', 'amount', '', '105.40')]);
    const saved = await confirm(input.id);
    expect(saved.outcomes[0].snapshot).toMatchObject({ calculationMethod: 'amount', amount: '105.40' });
    expect((await revertIndividualImport(ctx, { id: input.id, scopeIds: [base.companyId], confirmProcessed: false })).state).toBe('reverted');
    expect(await ledger()).toHaveLength(0);

    const again = await validate('monthly', [monthly('ONOR', 'amount', '', '105.40')]);
    const id = (await confirm(again.id)).outcomes[0].transactionId!;
    await owner.db.update(schema.payrollIndividualTxn).set({ calculationMethod: 'formula' }).where(eq(schema.payrollIndividualTxn.id, id));
    await expect(revertIndividualImport(ctx, { id: again.id, scopeIds: [base.companyId], confirmProcessed: false })).rejects.toThrow('importRowsChanged');
    expect(await ledger()).toHaveLength(1);
  });
});

describe('inline "Calculated by Formula" item and Day by Day', () => {
  it('accepts a typed Amount on an inline formula item in One Total for the Month, while Hours keep the item formula', async () => {
    const input = await validate('monthly', [monthly('OTIN', 'amount', '', '88.50'), monthly('OTIN', 'hours', '2', '')]);
    expect(input.preview.rows.map((r) => [r.ok, r.amount, r.calculationMethod])).toEqual([[true, '88.50', 'amount'], [true, '100.00', undefined]]);
    expect((await confirm(input.id)).written).toBe(2);
    const rows = await owner.db.select().from(schema.payrollIndividualTxn).where(and(eq(schema.payrollIndividualTxn.employmentId, employee), eq(schema.payrollIndividualTxn.componentId, inlineId)));
    expect(rows.map((r) => [r.amount, r.quantity, r.unit, r.calculationMethod]).sort()).toEqual([['100.00', '2.00', 'hours', null], ['88.50', null, 'amount', 'amount']]);
  });

  it('keeps Day by Day quantity-only and points an Amount to One Total for the Month', async () => {
    const input = await validate('daily', [daily('OTIN', 'amount', '88.50'), daily('ONOR', 'amount', '105.40'), daily('OTIN', 'hours', '2')]);
    expect(input.preview.rows.map((r) => [r.ok, r.reason, r.detail])).toEqual([
      [false, 'dailyAmountUseMonthly', { value: 'hours' }],
      [false, 'dailyItemAmountUseMonthly', undefined],
      [true, '', undefined],
    ]);
    expect(t('dailyAmountUseMonthly', { value: 'hours' })).toBe('Day by Day takes hours for this pay item. To import an amount, use One Total for the Month.');
    expect(t('dailyItemAmountUseMonthly')).toContain('use One Total for the Month');
  });
});
