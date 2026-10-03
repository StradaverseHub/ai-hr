import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { importBatchComponents, listPayComponents, listSupportedBatchComponents, unsupportedTaxableReason, upsertPayComponent } from '../core/pay-components';
import { setCompensation } from '../core/comp';
import { requirePackFor } from '../localization/registry';
import { readPcbNonCash } from '../localization/noncash-benefits';
import { createBatch, generatePayslips, setPayrollBatchComponent } from '../packs/payroll/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const state = vi.hoisted(() => ({ session: null as SessionContext | null }));
vi.mock('@/lib/session', () => ({ getSession: async () => state.session }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
import { createComponentAction, updateComponentAction } from '../app/admin/pay-components/actions';

function form(kind: 'bik' | 'vola', code = 'BIK_HOUSE') {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ code, name: code, kind: 'non_payable', displayCategory: kind,
    eaFormLine: kind === 'bik' ? 'EA_B3' : 'EA_B4', includedInPcb: 'on', pcbRemunerationType: 'normal',
    pcbExemptionCode: 'PCB_TAXABLE', roundingMethod: 'none', rule: '' })) fd.set(key, value);
  return fd;
}
async function location(action: (fd: FormData) => Promise<unknown>, fd: FormData) {
  try { await action(fd); throw new Error('Action did not redirect'); }
  catch (error) {
    const message = (error as Error).message;
    if (!message.startsWith('REDIRECT:')) throw error;
    return decodeURIComponent(message.slice(9));
  }
}

describe('r385 full pay-item classification through actual maintenance actions and CSV', () => {
  let base: Base; let ctx: SessionContext;
  beforeAll(migrateTestDb);
  beforeEach(async () => { await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'typed_pay_components', 'active'); ctx = await entitledCtx(base); state.session = ctx; });
  afterAll(closeAll);

  it.each(['bik', 'vola'] as const)('create and update accept valid Normal %s and retain the saved settings', async (kind) => {
    const fd = form(kind, `${kind.toUpperCase()}_HOUSE`);
    expect(await location(createComponentAction, fd)).toContain('toast=toastSaved');
    let row = (await listPayComponents(ctx)).find(c => c.code === fd.get('code'))!;
    expect(row).toMatchObject({ kind: 'non_payable', isNonPayable: true, displayCategory: kind, includedInPcb: true,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE', eaFormLine: kind === 'bik' ? 'EA_B3' : 'EA_B4' });
    fd.set('name', 'Renamed benefit');
    expect(await location(updateComponentAction, fd)).toContain('toast=toastSaved');
    row = (await listPayComponents(ctx)).find(c => c.id === row.id)!;
    expect(row.name).toBe('Renamed benefit'); expect(row.pcbRemunerationType).toBe('normal');
    expect(row.displayCategory).toBe(kind); expect(row.pcbExemptionCode).toBe('PCB_TAXABLE');
    expect((await listSupportedBatchComponents(ctx)).map(c => c.id)).toContain(row.id);
  });

  it.each([createComponentAction, updateComponentAction])('reports genuinely missing/invalid selections and exact benefit refusals before persistence', async (action) => {
    const cases: [string, string, string][] = [
      ['pcbRemunerationType', '', 'errorStatutory_pcbRemunerationTypeRequired'],
      ['pcbRemunerationType', 'bik', 'errorStatutory_pcbRemunerationTypeRequired'],
      ['pcbExemptionCode', '', 'errorStatutory_pcbExemptionTypeRequired'],
      ['pcbExemptionCode', 'INVALID', 'errorStatutory_pcbExemptionTypeInvalid'],
      ['eaFormLine', 'EA_B4', 'errorBenefit_classification_conflict'],
      ['pcbRemunerationType', 'additional', 'errorBenefit_normal_remuneration_required'],
    ];
    for (const [key, value, expected] of cases) {
      const fd = form('bik'); fd.set(key, value);
      expect(await location(action, fd), `${key}=${value}`).toContain(`error=${expected}`);
    }
    const optional = form('bik'); optional.set('pcbRemunerationType', 'optional_deduction'); optional.set('pcbExemptionCode', 'LP_VOLUNTARY_EPF');
    expect(await location(action, optional)).toContain('error=errorBenefit_normal_remuneration_required');
    const bonus = form('bik'); bonus.set('includedInEpf', 'on'); bonus.set('epfBonus2012', 'on');
    expect(await location(action, bonus)).toContain('error=errorBenefit_normal_remuneration_required');
    const unknown = form('bik'); unknown.set('displayCategory', ''); unknown.set('eaFormLine', '');
    expect(await location(action, unknown)).toContain('error=errorUnsupportedTaxable');
    expect((await listPayComponents(ctx)).filter(c => c.code === 'BIK_HOUSE')).toEqual([]);
  });

  it('unticking PCB keeps benefit/EA identity and clears tax classification without creating an invented benefit type', async () => {
    const fd = form('vola'); fd.delete('includedInPcb');
    expect(await location(createComponentAction, fd)).toContain('toast=toastSaved');
    expect((await listPayComponents(ctx)).find(c => c.code === 'BIK_HOUSE')).toMatchObject({ displayCategory: 'vola', eaFormLine: 'EA_B4', includedInPcb: false, pcbRemunerationType: null, pcbExemptionCode: null });
  });

  it('a benefit saved by the action reaches the existing PCB snapshot without changing cash bases or rewriting history', async () => {
    const employee = await hireEmployee(ctx, { person: { fullName: 'Synthetic Saved Benefit', primaryEmail: `${randomUUID()}@r385.test` }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2025-01-01' });
    await requirePackFor('MY').statutory.set(ctx, { personId: employee.personId, icNumber: '900101880001' });
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 12000, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
    const fd = form('vola', 'VOLA_SAVED');
    expect(await location(createComponentAction, fd)).toContain('toast=toastSaved');
    const row = (await listPayComponents(ctx)).find(c => c.code === 'VOLA_SAVED')!;
    const baseline = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(ctx, { batchId: baseline.batchId });
    const batch = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-07' });
    await setPayrollBatchComponent(ctx, { batchId: batch.batchId, employmentId: employee.employmentId, componentId: row.id, amount: 800 });
    await generatePayslips(ctx, { batchId: batch.batchId });
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employee.employmentId)).orderBy(schema.payslip.batchId);
    expect(slips).toHaveLength(2);
    const before = slips.find(s => s.batchId === baseline.batchId)!, after = slips.find(s => s.batchId === batch.batchId)!;
    const statutory = after.statutory as Record<string, any>, prior = before.statutory as Record<string, any>;
    expect(readPcbNonCash(statutory.pcbNonCash)?.owned.vola).toBe(800);
    expect(statutory.pcbMeta.trace.Y1).toBe(12800); expect(after.grossPay).toBe(before.grossPay);
    expect(statutory.bases.epf).toBe(prior.bases.epf); expect(statutory.bases.socsoEis).toBe(prior.bases.socsoEis);
    const frozen = JSON.stringify(after.statutory);
    fd.delete('includedInPcb');
    expect(await location(updateComponentAction, fd)).toContain('toast=toastSaved');
    const [unchanged] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id, after.id));
    expect(JSON.stringify(unchanged.statutory)).toBe(frozen);
  });

  it('CSV preview and import recognise configured BIK/VOLA while preserving generic noncash refusal', async () => {
    const email = `${randomUUID()}@r385.test`;
    const employee = await hireEmployee(ctx, { person: { fullName: 'Synthetic Benefit Import', primaryEmail: email }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2025-01-01' });
    const batch = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-07' });
    for (const kind of ['bik', 'vola'] as const) expect(await location(createComponentAction, form(kind, kind.toUpperCase()))).toContain('toast=toastSaved');
    await upsertPayComponent(ctx, { code: 'UNKNOWN', name: 'Unclassified', kind: 'non_payable', isNonPayable: true,
      prorates: false, includedInPcb: true, includedInEpf: false, includedInSocsoEis: false, includedInHrdfBase: false,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' });
    for (const [code, eaFormLine, pcbRemunerationType] of [
      ['CONFLICT', 'EA_B4', 'normal'], ['ADDITIONAL', 'EA_B3', 'additional'],
    ] as const) await upsertPayComponent(ctx, { code, name: code, kind: 'non_payable', isNonPayable: true,
      displayCategory: 'bik', eaFormLine, prorates: false, includedInPcb: true, includedInEpf: false,
      includedInSocsoEis: false, includedInHrdfBase: false, pcbRemunerationType, pcbExemptionCode: 'PCB_TAXABLE' });
    const refused = await importBatchComponents(ctx, { batchId: batch.batchId,
      csvText: `employee,component,amount\n${email},CONFLICT,700\n${email},ADDITIONAL,800`, dryRun: true });
    expect(refused.valid).toBe(0);
    expect(refused.rows.map(r => r.error)).toEqual([
      'Unsupported component: CONFLICT. BIK and living accommodation classifications conflict; make Pay Category and EA reporting consistent.',
      'Unsupported component: ADDITIONAL. Monthly BIK and living accommodation require Normal remuneration and cannot use EPF Bonus 2012.',
    ]);
    const csvText = `employee,component,amount\n${email},BIK,700\n${email},VOLA,800\n${email},UNKNOWN,900`;
    const preview = await importBatchComponents(ctx, { batchId: batch.batchId, csvText, dryRun: true });
    expect(preview.valid).toBe(2); expect(preview.imported).toBe(0);
    expect(preview.rows.map(r => [r.code, r.ok])).toEqual([['BIK', true], ['VOLA', true], ['UNKNOWN', false]]);
    expect(preview.rows[2].error).toBe('Unsupported component: UNKNOWN. No supported taxable classification; select the applicable benefit Pay Category and tax settings.');
    const result = await importBatchComponents(ctx, { batchId: batch.batchId, csvText, dryRun: false });
    expect(result.imported).toBe(2);
    const saved = await owner.db.select().from(schema.payrollBatchComponent).where(and(eq(schema.payrollBatchComponent.batchId, batch.batchId), eq(schema.payrollBatchComponent.employmentId, employee.employmentId))).orderBy(schema.payrollBatchComponent.amount);
    expect(saved.map(r => r.amount)).toEqual(['700.00', '800.00']);
  });
});

it('uses the canonical typed reason for noncash kind conflicts rather than claiming the selected type is absent', () => {
  expect(unsupportedTaxableReason({ code: 'BROKEN', kind: 'deduction', displayCategory: 'bik', isNonPayable: true,
    includedInPcb: true, includedInEpf: false, includedInSocsoEis: false, pcbRemunerationType: 'normal' })).toBe('unsupported_kind');
});
