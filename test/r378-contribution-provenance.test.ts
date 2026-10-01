import { payslipConfiguredContributions } from '../core/payslip-configured-contributions';
import { buildPayslipPdfData } from '../lib/payslip-pdf';
import { payslipForReview } from '../core/payroll-view';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  deletePayComponent,
  listPayComponents,
  PayComponentInUseError,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
} from '../core/pay-components';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';


let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); });
afterAll(closeAll);
describe('configured contribution provenance without changing payroll money', () => {
  it('distinguishes record-only contribution from cash remuneration using real processed slips', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, { person: { fullName: 'Synthetic Contribution', primaryEmail: 'r378-contribution@acme.test' }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    for (const [code, kind, nonPayable, amount] of [['DIRECTOR', 'allowance', false, 400], ['COMPANY_PLAN', 'contribution', true, 250], ['CASH_CONTRIB', 'contribution', false, 150]] as const) {
      await upsertPayComponent(a, { code, name: code, kind, includedInEpf: false, includedInSocsoEis: false, includedInPcb: false, includedInHrdfBase: false, isNonPayable: nonPayable, prorates: false });
      const item = (await listPayComponents(a)).find(row => row.code === code)!;
      await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: item.id, amount, effectiveFrom: '2026-01-01' });
    }
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    await generatePayslips(await entitledCtx(base), { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const st = ps.statutory as { componentLines: {code: string; buckets: {bucket: string; amount: number}[]}[]; recordLines: {code: string; amount: number; nonPayable?: boolean}[] };
    expect(st.componentLines.find(line => line.code === 'DIRECTOR')?.buckets).toEqual([{ bucket: 'reimburse', amount: 400 }]);
    expect(st.componentLines.find(line => line.code === 'CASH_CONTRIB')?.buckets).toEqual([{ bucket: 'reimburse', amount: 150 }]);
    expect(st.componentLines.some(line => line.code === 'COMPANY_PLAN')).toBe(false);
    expect(st.recordLines.find(line => line.code === 'COMPANY_PLAN')).toMatchObject({ amount: 250, nonPayable: true, kind: 'contribution' });
    expect(payslipConfiguredContributions(st)).toEqual([{code: 'COMPANY_PLAN', name: 'COMPANY_PLAN', amount: 250}]);
    expect(payslipConfiguredContributions({recordLines: [{code: 'HISTORIC', name: 'Historic benefit', amount: 250, nonPayable: true}]})).toEqual([]);
    expect(Number(ps.grossPay)).toBe(5550);
    const review = await payslipForReview(a, {companyIds: [base.companyId], payslipId: ps.id});
    expect(review).not.toBeNull();
    const pdf = buildPayslipPdfData({...review!, employee: review!.employeeName}, {epf:'EPF', socso:'SOCSO', eis:'EIS', skbbk:'SKBBK', tax:'Tax'});
    expect(pdf.employee).toBe('Synthetic Contribution');
    expect(pdf.configuredEmployerContributions).toEqual([{code: 'COMPANY_PLAN', name: 'COMPANY_PLAN', amount: 250}]);
    expect(pdf.nonPayableLines).toEqual([]);
    expect(pdf.gross).toBe(Number(ps.grossPay));
    expect(pdf.net).toBe(Number(ps.netPay));
    expect(pdf.employerCost).toBe(Number(ps.employerCost));
  });
});
