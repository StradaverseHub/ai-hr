/** Real open-period payroll → authorized read → shared Statutory Explanation component → Chromium capture.
 * Fictional identities only; the read's empty/other-company fences are exercised before rendering.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const { readFileSync } = await import('node:fs');
  return { getLocale: async () => 'en', getTranslations: async (namespace: string) => createTranslator({
    locale: 'en', messages: JSON.parse(readFileSync('messages/en.json', 'utf8')), namespace,
    onError: error => { throw error; },
  }) };
});
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
const JSDOM = createRequire(import.meta.url)('jsdom').JSDOM as new (html: string) => { window: { document: Document; close(): void } };
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { payslipForReview } from '../core/payroll-view';
import { explainStatutory } from '../core/statutory-explain';
import { listPayComponents, seedPayComponentCatalog, setEmploymentPayComponent, setPayrollBatchComponent, upsertPayComponent } from '../core/pay-components';
import { StatutoryDetailView } from '../app/payroll/statutory-detail/statutory-detail-view';
import messages from '../messages/en.json';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, resetDb, seedBase, setModule } from './harness';
import { listProcessedPayslipsAcross } from '../core/payroll-view';
import { captureAiReviewScreenshots } from './helpers/ai-review-screenshots';

beforeAll(async () => { await migrateTestDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeAll(); });

describe('ffb6c2e0 — the authorized open payroll explanation, rendered', () => {
  it('shows the independent wage switch and reconciles every non-EPF table with processed amounts', async () => {
    const base = await seedBase();
    let a = adminCtx(base);
    await seedPayComponentCatalog(a);
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    a = await entitledCtx(base);
    for (const [code, included] of [['AWARD_A', true], ['AWARD_B', false]] as const) {
      await upsertPayComponent(a, { code, name: code === 'AWARD_A' ? 'Example award A' : 'Example award B', label: code,
        kind: 'allowance', includedInEpf: true, includedInSocsoEis: included, includedInPcb: true,
        includedInHrdfBase: false, isNonPayable: false, prorates: false,
        epfBonus2012: true, pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE' });
    }
    const ids = new Map((await listPayComponents(a, { includeArchived: true })).map(row => [row.code, row.id]));
    const e = await hireEmployee(a, { person: { fullName: 'Fictional Inclusion Reviewer', primaryEmail: 'inclusion@fixture.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101018851', subjectToSkbbk: true });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: ids.get('BASIC')!, amount: 1000, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-10' });
    await setPayrollBatchComponent(a, { batchId, employmentId: e.employmentId, componentId: ids.get('AWARD_A')!, amount: 200 });
    await setPayrollBatchComponent(a, { batchId, employmentId: e.employmentId, componentId: ids.get('AWARD_B')!, amount: 100 });
    await generatePayslips(a, { batchId });
    const rows = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], employmentId: e.employmentId });
    expect(rows).toHaveLength(1);
    const payslipId = rows[0].id;
    expect(await payslipForReview(a, { companyIds: [], payslipId })).toBeNull();
    expect(await payslipForReview(a, { companyIds: ['99999999-9999-4999-8999-999999999999'], payslipId })).toBeNull();
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId });
    expect(row).not.toBeNull();
    if (!row) throw new Error('Authorized fixture must resolve');
    expect(row.batchStatus).toBe('processed');
    const explanation = explainStatutory(row.statutory, row.runType);
    expect(explanation.traceStatus).toBe('recorded');
    const trace = explanation.trace!;
    expect([trace.socso.wage, trace.skbbk.wage, trace.eis.wage]).toEqual([1200, 1200, 1200]);
    const html = renderToStaticMarkup(await StatutoryDetailView({ ctx: { payslipId, employeeCode: row.employeeCode,
      employeeName: row.employeeName, company: row.company, periodLabel: 'October 2026', payPeriod: row.payPeriod,
      runType: row.runType, runSeq: row.runSeq, currency: row.currency ?? null }, explanation }));
    const dom = new JSDOM(html);
    try {
      const labels = messages.payroll.statutoryDetail;
      for (const heading of [labels.traceColSocsoWages, labels.traceColSkbbkWages, labels.traceColEisWages]) {
        const table = [...dom.window.document.querySelectorAll('table')].find(table => table.querySelector('thead th:last-child')?.textContent === heading);
        expect(table, `actual ${heading} item table`).toBeDefined();
        const rows = [...table!.querySelectorAll('tbody tr')];
        const awardA = rows.find(row => row.querySelector('td')?.textContent?.includes('AWARD_A'))!;
        const awardB = rows.find(row => row.querySelector('td')?.textContent?.includes('AWARD_B'))!;
        expect(awardA.querySelector('td:last-child')!.textContent).toContain('200.00');
        expect(awardB.querySelector('td:last-child')!.textContent).toContain('0.00');
        expect(rows.at(-1)!.querySelector('td:last-child')!.textContent).toContain('1,200.00');
        expect(awardA.textContent).not.toContain(labels.traceTreatSocsoExcludedBonus2012);
      }
      expect(dom.window.document.body.textContent).toContain('Fictional Inclusion Reviewer');
    } finally { dom.window.close(); }
    await captureAiReviewScreenshots(html, 'en', 'feedback-ffb6c2e0',
      'Actual open-period fictional payroll; authorized company-scoped read; shared StatutoryDetailView component. Server access read exercised; static browser render.');
  }, 120_000); // DB processing plus hosted application CSS/font loading and desktop/mobile Chromium capture.
});
