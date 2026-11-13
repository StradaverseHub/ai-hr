/**
 * NORMAL_OT (production, read-only report of 12 Nov 2026) — A PAY ITEM THE EMPLOYEE DOES NOT HAVE IN THIS RUN.
 *
 * Pay Item ONOR links the Formula Builder formula NORMAL_OT, which adds {#PayItemInput}("A0128") and other allowances
 * to Basic. 145 October rows refused at re-price with "Payroll source PayItemInput is unavailable or not permitted"
 * because those employees have no A0128 in the run. Owner decision (13 Nov 2026): "A Pay Item the employee simply
 * doesn't have in this run counts as 0." Unknown/archived codes, a present item whose value cannot be determined and
 * a denied source still refuse.
 *
 * Fictional data only. EXPECTED FIGURES ARE HAND-COMPUTED LITERALS, never produced by the evaluator under test:
 *   basic 2,600; A0100 312; S0002 208; A0128 not assigned.
 *   (2,600 + 0 + 312 + 208) = 3,120 / 26 = 120 / 8 = 15 × 1.5 = 22.5 × 9 h = 202.50.
 *   With A0128 = 104: 3,224 / 26 = 124 / 8 = 15.5 × 1.5 = 23.25 × 9 h = 209.25.
 *   Old inline rule before the link: 2,600 / 30 / 8 × 1.5 × 9 h = 146.25.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { seedPayComponentCatalog, setEmploymentPayComponent, upsertPayComponent, type PayComponentInput } from '../core/pay-components';
import type { PayRule, ResolvablePayComponent } from '../core/pay-rule';
import { getFormulaEvaluation, getPayFormula, loadSavedFormulaProgramTx, saveFormulaAccumulationGroup, savePayFormula, testPayFormula } from '../core/pay-formula';
import { preparePayFormulaRuntimeTx, simulatePayFormulaTx } from '../core/pay-formula-runtime';
import { createIndividualTxnsBulk } from '../core/payroll-individual-txn';
import { previewIndividualTxnInput } from '../packs/payroll/individual-calculation';
import { createBatch, generatePayslips, reprocessSelectedEmployees, type ReprocessJobResult } from '../core/payroll';
import { parsePayFormula, PAY_FORMULA_EVALUATOR_VERSION } from '../lib/pay-formula-language';
import { PAY_FORMULA_REGISTRY_VERSION } from '../lib/pay-formula-registry';
import type { ActiveFormula, PayFormulaContext } from '../lib/pay-formula-model';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const PERIOD = '2026-10', DATE = '2026-10-14';
const NORMAL_OT = 'If ((({#EmployeeProfile}("companyCode") = "ARIU") Or ({#EmployeeProfile}("companyCode") = "ARIT")) Or ({#EmployeeProfile}("companyCode") = "ARI")) Then\n'
  + '    Return ((((((({#Basic} + {#PayItemInput}("A0128")) + {#PayItemInput}("A0100")) + {#PayItemInput}("S0002")) / 26) / 8) * 1.5) * {#Input})\n'
  + 'Else\n    Return ((({#Basic} / 26) / 8) * 1.5) * {#Input}\nEnd If';
const LINKED: PayRule = { kind: 'formula_builder', formulaId: 'NORMAL_OT', dependencies: [] };
const INLINE: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'number', value: 30 } }, { op: '/', operand: { ref: 'number', value: 8 } },
  { op: '*', operand: { ref: 'number', value: 1.5 } }, { op: '*', operand: { ref: 'hours' } }] };
const item = (code: string, name: string, rule: PayRule | null): PayComponentInput => ({
  code, name, label: name, kind: 'allowance', includedInEpf: false, includedInSocsoEis: false, includedInPcb: false, includedInHrdfBase: false,
  isNonPayable: false, prorates: false, roundingMethod: 'none', rule,
});
const probe = (source: string, dependencies: string[] = []): ActiveFormula => ({ id: randomUUID(), formulaId: 'PROBE', revisionId: randomUUID(), ordinal: 1,
  program: parsePayFormula(source), contentHash: '0'.repeat(64), dependencies, evaluatorVersion: PAY_FORMULA_EVALUATOR_VERSION,
  registryVersion: PAY_FORMULA_REGISTRY_VERSION, dependencyFingerprint: '0'.repeat(64) });

beforeAll(migrateTestDb);
afterAll(closeAll);

describe('a Pay Item the employee does not have in this run counts as 0 (owner rule, 13 Nov 2026)', () => {
  let base: Base, ctx: SessionContext, employee: string, cycleId: string, onorId: string, ids: Record<string, string>, context: PayFormulaContext;
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    ctx = await entitledCtx(base);
    await owner.db.update(schema.company).set({ companyLabel: 'ARIT' }).where(eq(schema.company.id, base.companyId));
    const hired = await hireEmployee(ctx, {
      person: { fullName: 'Fictional Allowance-less Overtime', primaryEmail: `${randomUUID()}@missing-item.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01',
    });
    employee = hired.employmentId;
    await setCompensation(ctx, { employmentId: employee, basicSalary: 2600, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(ctx, { personId: hired.personId, icNumber: '900101017932' });
    await seedPayComponentCatalog(ctx);
    const [cycle] = await owner.db.insert(schema.payrollCycle).values({ tenantId: base.tenantId, companyId: base.companyId, name: 'Fictional OT cycle', code: 'MISSING', runType: 'regular' }).returning();
    cycleId = cycle.id;
    ids = {};
    for (const [code, name] of [['A0128', 'Fictional shift allowance'], ['A0100', 'Fictional meal allowance'], ['S0002', 'Fictional site allowance']] as const)
      ids[code] = (await upsertPayComponent(ctx, item(code, name, { kind: 'fixed' }))).id;
    for (const [code, amount] of [['A0100', 312], ['S0002', 208]] as const)
      await setEmploymentPayComponent(ctx, { employmentId: employee, componentId: ids[code], amount, effectiveFrom: '2024-01-01' });
    onorId = (await upsertPayComponent(ctx, item('ONOR', 'NORMAL OT', INLINE))).id;
    context = { companyId: base.companyId, employmentId: employee, period: PERIOD, cycleId, asOf: DATE, currentCode: 'ONOR', input: '9' };
  });

  const link = async (source = NORMAL_OT) => {
    const saved = await savePayFormula(ctx, { formulaId: 'NORMAL_OT', description: 'Normal overtime 1.5x', method: 'write', source });
    await upsertPayComponent(ctx, item('ONOR', 'NORMAL OT', LINKED));
    return { id: saved.id, revisionId: saved.revisionId };
  };
  const slip = async (batchId: string) => (await owner.db.select().from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employee))))[0];
  const line = async (batchId: string, code: string) => ((await slip(batchId)).statutory as { componentLines: { code: string; amount: number }[] }).componentLines.find((l) => l.code === code)?.amount;
  const processed = async () => {
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: PERIOD, payrollCycleId: cycleId });
    await generatePayslips(ctx, { batchId });
    return batchId;
  };
  const simulate = (formula: ActiveFormula, at: PayFormulaContext = context) => withTenant(ctx, (tx) => simulatePayFormulaTx(tx, ctx, formula, at));

  it('the ONOR case: the tester and payroll processing pay Basic + the present allowances, A0128 counted as 0 and said so', async () => {
    const revision = await link();
    // Tester: 202.50 (hand-computed above), never the production refusal.
    const tested = await testPayFormula(ctx, { ...revision, context });
    expect(tested).toMatchObject({ passed: true, amount: '202.5', error: null, missingItems: [{ source: 'PayItemInput', code: 'A0128' }] });
    // The receipt keeps the zero-counted item after a reload (it rides on the tested event).
    const view = await getPayFormula(ctx, revision.id);
    expect(view?.tests.find((t) => t.id === tested.id)?.missingItems).toEqual([{ source: 'PayItemInput', code: 'A0128' }]);

    // Processing: a recurring ONOR row whose saved amount (9) is its {#Input}.
    await setEmploymentPayComponent(ctx, { employmentId: employee, componentId: onorId, amount: 9, effectiveFrom: '2024-01-01', allowZeroAmount: true });
    const batchId = await processed();
    expect(await line(batchId, 'ONOR')).toBe(202.5);
    expect(await line(batchId, 'A0100')).toBe(312);
    expect(await line(batchId, 'A0128')).toBeUndefined();
    const [evaluation] = await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId, batchId));
    expect(evaluation.amount).toBe('202.5');
    const detail = await getFormulaEvaluation(ctx, evaluation.id);
    expect(detail?.payload.missingItems).toEqual([{ source: 'PayItemInput', code: 'A0128' }]);
    // The read is retained with its 0, beside the real values of the present allowances.
    const reads = detail!.payload.reads.filter((r) => r.code === 'PayItemInput').map((r) => [r.args[0].value, r.value.value]);
    expect(reads).toEqual([['A0128', '0'], ['A0100', '312'], ['S0002', '208']]);
    expect(Number(tested.amount)).toBe(Number(evaluation.amount));
  });

  it('entry pricing and reprice/reprocess give the same 202.50 as the tester (the 145 refused October rows)', async () => {
    const key = await createIndividualTxnsBulk(ctx, { companyId: base.companyId, payPeriod: PERIOD, employmentIds: [employee], intendedCycleId: cycleId,
      rows: [{ kind: 'earning', componentId: onorId, txnDate: DATE, amount: 146.25, quantity: 9, unit: 'hours' }] });
    const id = key.ids[0];
    const batchId = await processed();
    expect(Number((await slip(batchId)).grossPay)).toBe(3266.25); // 2,600 + 312 + 208 + 146.25
    const revision = await link();
    const k = randomUUID();
    await reprocessSelectedEmployees(ctx, { batchId, employmentIds: [employee], idempotencyKey: k });
    const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, k));
    const outcome = (job.result as ReprocessJobResult).outcomes[0];
    expect(outcome).toMatchObject({ status: 'reprocessed', reasonCode: null });
    expect(outcome.repricedItems).toEqual([{ componentId: onorId, code: 'ONOR', name: 'NORMAL OT', count: 1, quantity: 9, unit: 'hours', before: 146.25, after: 202.5 }]);
    const [row] = await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id, id));
    expect(row).toMatchObject({ amount: '202.50', calculationMethod: 'formula', pricingSource: 'saved_formula', pricingRef: revision.revisionId });
    expect(Number((await slip(batchId)).grossPay)).toBe(3322.5); // 2,600 + 312 + 208 + 202.50
    const entry = await previewIndividualTxnInput(ctx, { componentId: onorId, employmentId: employee, companyId: base.companyId, payPeriod: PERIOD, txnDate: DATE,
      amount: 0, quantity: 9, unit: 'hours', method: 'formula', cycleId, batchId });
    expect(entry.amount).toBe(202.5);
    const tested = await testPayFormula(ctx, { ...revision, context: { ...context, batchId } });
    expect(tested).toMatchObject({ passed: true, amount: '202.5' });
  });

  it('a present A0128 is read, not zero-counted: 209.25 and nothing is reported missing', async () => {
    await setEmploymentPayComponent(ctx, { employmentId: employee, componentId: ids.A0128, amount: 104, effectiveFrom: '2024-01-01' });
    const revision = await link();
    expect(await testPayFormula(ctx, { ...revision, context })).toMatchObject({ passed: true, amount: '209.25', missingItems: [] });
  });

  it('an unknown Pay Item code is still refused, at save and at evaluation', async () => {
    await expect(savePayFormula(ctx, { formulaId: 'UNKNOWN_CODE', description: 'Misspelled code', method: 'write', source: 'Return {#Basic} + {#PayItemInput}("A0182")' }))
      .rejects.toThrow(/A referenced Pay Item is unavailable: A0182/);
    for (const call of ['PayItemInput', 'PayItem', 'PayItemNoProrate'])
      expect(await simulate(probe(`Return {#Basic} + {#${call}}("A0182")`))).toMatchObject({ passed: false, amount: null, missingItems: [],
        error: expect.stringContaining(`Payroll source ${call} is unavailable or not permitted`) });
  });

  it('an archived Pay Item keeps its current refusal', async () => {
    await link();
    await owner.db.update(schema.payComponent).set({ archivedAt: new Date() }).where(eq(schema.payComponent.id, ids.A0128));
    expect(await simulate(probe('Return {#Basic} + {#PayItemInput}("A0128")'))).toMatchObject({ passed: false, error: expect.stringContaining('Payroll source PayItemInput is unavailable or not permitted') });
    await expect(withTenant(ctx, (tx) => loadSavedFormulaProgramTx(tx, ctx, 'NORMAL_OT', base.companyId))).rejects.toThrow(/A referenced Pay Item is unavailable: A0128/);
  });

  it('a Pay Item the employee HAS whose value cannot be determined still refuses, never 0', async () => {
    await withTenant(ctx, async (tx) => {
      const onor: ResolvablePayComponent = { code: 'ONOR', kind: 'allowance', amount: 9, rule: { kind: 'formula_builder', formulaId: 'PROBE', dependencies: [] }, prorates: false, prorateOverride: null, rounding: 'none', formulaInput: '9', currentInput: '9', resolutionOrder: 1 };
      // A0100 is in the run, but its saved input is not known (formulaInput undefined) and it is not yet resolved.
      const a0100: ResolvablePayComponent = { code: 'A0100', kind: 'allowance', amount: 312, rule: { kind: 'fixed' }, prorates: false, rounding: 'none', resolutionOrder: 0 };
      const prepare = (source: string) => preparePayFormulaRuntimeTx(tx, ctx, context, { components: [a0100, onor], scope: { basic: 2600, daysWorked: 31, hours: 0, components: { BASIC: 2600 } }, basic: '2600', proratedBasic: '2600', factor: '1' }, probe(source));
      const rule = onor.rule as Extract<PayRule, { kind: 'formula_builder' }>;
      for (const call of ['PayItemInput', 'PayItem', 'PayItemNoProrate']) {
        const prepared = await prepare(`Return {#${call}}("A0100")`);
        expect(() => prepared.runtime.resolve(rule, onor)).toThrow(`Payroll source ${call} is unavailable or not permitted`);
        expect(prepared.evaluations).toEqual([]);
      }
      // In the same snapshot an item the employee does not have is the only zero.
      const prepared = await prepare('Return {#PayItemInput}("A0128") + {#PayItem}("S0002") + 5');
      expect(prepared.runtime.resolve(rule, onor)).toBe('5');
      expect(prepared.evaluations[0].missingItems).toEqual([{ source: 'PayItemInput', code: 'A0128' }, { source: 'PayItem', code: 'S0002' }]);
    });
  });

  it('a permission-denied Pay Item source is refused, never counted as 0', async () => {
    const saved = await savePayFormula(ctx, { formulaId: 'DENIED', description: 'Denied compensation source', method: 'write', source: 'Return {#PayItemInput}("A0128") + 1' });
    expect(await testPayFormula(ctx, { ...saved, context })).toMatchObject({ passed: true, amount: '1' });
    await owner.db.insert(schema.payrollPermissionGrant).values(['hr_admin', 'super_admin'].map((role) => ({ tenantId: base.tenantId, companyId: base.companyId, role, permissionKey: 'report.read.compensation', allowed: false })));
    const before = (await owner.db.select().from(schema.payFormulaTest)).length;
    await expect(testPayFormula(ctx, { ...saved, context })).rejects.toThrow(/permission is unavailable/);
    expect(await owner.db.select().from(schema.payFormulaTest)).toHaveLength(before);
  });

  it('an Accumulation group sums its present members and counts a missing member as 0', async () => {
    await saveFormulaAccumulationGroup(ctx, { code: 'OT_GROSS', members: ['A0100', 'A0128', 'S0002'] });
    const saved = await savePayFormula(ctx, { formulaId: 'ACCUMULATED', description: 'Accumulated overtime base', method: 'write', source: 'Return ({#Basic} + {#Accumulation}("OT_GROSS")) / 26 / 8 * 1.5 * {#Input}' });
    // (2,600 + 312 + 0 + 208) / 26 / 8 × 1.5 × 9 = 202.50, the same figure as the PayItemInput formula.
    expect(await testPayFormula(ctx, { ...saved, context })).toMatchObject({ passed: true, amount: '202.5', missingItems: [{ source: 'Accumulation', code: 'A0128', group: 'OT_GROSS' }] });
  });

  it('a formula that reads only present items keeps its previous fingerprint inputs: no zero-counted marker', async () => {
    const saved = await savePayFormula(ctx, { formulaId: 'PRESENT_ONLY', description: 'Present items only', method: 'write', source: 'Return {#PayItemInput}("A0100") + {#PayItem}("S0002")' });
    const tested = await testPayFormula(ctx, { ...saved, context });
    expect(tested).toMatchObject({ passed: true, amount: '520', missingItems: [] });
    const events = await owner.db.select().from(schema.payFormulaEvent).where(and(eq(schema.payFormulaEvent.testId, tested.id), eq(schema.payFormulaEvent.kind, 'tested')));
    expect(events.map((e) => e.detail)).toEqual([{ passed: true }]);
  });
});
