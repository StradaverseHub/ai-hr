/**
 * Item 7f5cc653 — the KWSP Part A bonus note on REAL payslips, through the kernel and the database.
 *
 * Fictional fixtures only. Expected figures are literal and hand-computed, never read off the table:
 *
 *   Basic 4,200 + Car Allowance 500 (EPF, normal) + Sales Commission 1,786.83 (EPF + EPF Bonus 2012)
 *     normal 4,700, bonus 1,786.83, total 6,486.83
 *     employer 6,486.83 × 13% = 843.2879 → rounded up → 844 (the old combined-row reading gave 780)
 *     employee row 6,400.01 – 6,500.00 → 11% × 6,500 = 715
 *
 *   Then the month is CLOSED and the commission's EPF Bonus 2012 tick is removed: the closed payslip keeps
 *   844 and its trace byte-for-byte. A new open draft reads the latest saved setting: the commission is now
 *   normal EPF wages, so 6,486.83 reads the 6,500 row → 715 / 780 (12% × 6,500), with no bonus-note trace.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips, markRunsAffectedByPayComponent, reprocessSelectedEmployees } from '../core/payroll';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  setPayrollBatchComponent,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { explainStatutory } from '../core/statutory-explain';
import { epfTraceRows } from '../app/payroll/statutory-detail/statutory-trace';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let a: SessionContext;

const item = (code: string, name: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  label: name, code, name, kind: 'allowance',
  includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false,
  isNonPayable: false, prorates: false,
  pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE', epfBonus2012: false,
  ...over,
});
const CAR = item('CARX', 'Car Allowance');
const COMMISSION = (over: Partial<PayComponentInput> = {}) =>
  item('COMMX', 'Sales Commission', { pcbRemunerationType: 'additional', epfBonus2012: true, ...over });

const idByCode = async (code: string) =>
  (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === code)!.id;

async function setup() {
  await seedPayComponentCatalog(a);
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  a = await entitledCtx(base);
  await upsertPayComponent(a, CAR);
  await upsertPayComponent(a, COMMISSION());
  const e = await hireEmployee(a, {
    person: { fullName: 'Fictional Employee A', primaryEmail: 'employee-a@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  // Born 1 Jan 1990: a Malaysian citizen below 60 — KWSP Part A, Auto (statutory) EPF category.
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015401' });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4200, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('BASIC'), amount: 4200, effectiveFrom: '2026-01-01' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('CARX'), amount: 500, effectiveFrom: '2026-01-01' });
  return e;
}

async function draftWithCommission(employmentId: string, payPeriod: string) {
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod });
  await setPayrollBatchComponent(a, { batchId, employmentId, componentId: await idByCode('COMMX'), amount: 1786.83 });
  await generatePayslips(a, { batchId });
  return batchId;
}

async function slipOf(batchId: string, employmentId: string) {
  const [row] = await owner.db.select().from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  return row!;
}
type Stat = Record<string, number> & {
  statutoryTrace?: { epf: Record<string, unknown> & { employerBonusRule?: Record<string, number> } };
};
const statOf = (s: { statutory: unknown }) => s.statutory as Stat;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
});
afterAll(async () => {
  await closeAll();
});

describe('7f5cc653 — Auto (statutory) employee with an EPF Bonus 2012 commission', () => {
  it('draft: employer 844 (13% of 6,486.83 rounded up), employee 715; the trace and the explanation agree', async () => {
    const e = await setup();
    const batchId = await draftWithCommission(e.employmentId, '2026-10');
    const st = statOf(await slipOf(batchId, e.employmentId));
    expect([st.epfEmployee, st.epfEmployer]).toEqual([715, 844]);

    const epfTrace = st.statutoryTrace!.epf;
    expect(epfTrace).toMatchObject({ part: 'A', mode: 'auto', normalWage: 4700, bonusWage: 1786.83, base: 6486.83, employee: 715, employer: 844 });
    expect(epfTrace.employerBonusRule).toEqual({ normalWage: 4700, threshold: 5000, rate: 0.13, base: 6486.83, exact: 843.29, amount: 844 });

    const ex = explainStatutory(st, 'regular');
    expect(ex.traceStatus).toBe('recorded');
    const t = (key: string, values?: Record<string, string>) => (values ? `${key}(${Object.values(values).join('|')})` : key);
    const rows = epfTraceRows(ex.trace!, t, (n) => n.toFixed(2), 'en-MY');
    expect(rows).toContainEqual({ label: 'traceEpfBonusRuleEmployer', value: 'traceEpfBonusRuleEmployerValue(6486.83|13%|843.29|844.00)' });
    expect(rows).toContainEqual({ label: 'traceEpfBonusRuleEmployee', value: 'traceEpfBonusRuleEmployeeValue(traceRange(6400.01|6500.00)|715.00)' });
    expect(rows.map((r) => r.label), 'the 12% row figure never applied, so it is not shown').not.toContain('traceEpfRowEmployer');
  });

  it('a closed payslip never moves when the pay item changes; a new open draft reads the latest setting', async () => {
    const e = await setup();
    const closedBatchId = await draftWithCommission(e.employmentId, '2026-10');
    await closeBatch(a, { batchId: closedBatchId });
    const before = await slipOf(closedBatchId, e.employmentId);
    expect([statOf(before).epfEmployee, statOf(before).epfEmployer]).toEqual([715, 844]);

    // The commission stops being EPF Bonus 2012: from now on it is normal EPF wages.
    await upsertPayComponent(a, COMMISSION({ epfBonus2012: false }));
    const marked = await markRunsAffectedByPayComponent(a, { componentId: await idByCode('COMMX'), code: 'COMMX' });
    expect(marked.map((m) => m.batchId)).not.toContain(closedBatchId);
    await expect(reprocessSelectedEmployees(a, { batchId: closedBatchId, employmentIds: [e.employmentId], reason: 'try a closed month' })).rejects.toThrow();

    const after = await slipOf(closedBatchId, e.employmentId);
    expect(after.statutory).toEqual(before.statutory);
    expect([statOf(after).epfEmployee, statOf(after).epfEmployer]).toEqual([715, 844]);

    // A new open draft: normal 6,486.83, no bonus → row 6,400.01 – 6,500.00 → 11% × 6,500 = 715, 12% × 6,500 = 780.
    const openBatchId = await draftWithCommission(e.employmentId, '2026-11');
    const open = statOf(await slipOf(openBatchId, e.employmentId));
    expect([open.epfEmployee, open.epfEmployer]).toEqual([715, 780]);
    expect(open.statutoryTrace!.epf).toMatchObject({ normalWage: 6486.83, bonusWage: 0, base: 6486.83 });
    expect(open.statutoryTrace!.epf.employerBonusRule).toBeUndefined();
  });
});
