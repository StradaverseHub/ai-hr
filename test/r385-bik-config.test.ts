import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { importBatchComponents, listPayComponents, listSupportedBatchComponents, unsupportedTaxableReason, upsertPayComponent, updatePayComponent, seedPayComponentCatalog, PayComponentStatutoryConfigError } from '../core/pay-components';
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
import { dryRunComponentImportAction } from '../app/payroll/[batchId]/import-actions';

function form(kind: 'bik' | 'vola', code = 'BIK_HOUSE') {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ label: code, code, name: code, kind: 'non_payable', displayCategory: kind,
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

  // 8edeef41 — the reporter's BKBOP: Non-Payable, BIK, PCB ticked, PCB_TAXABLE, EPF and EPF Bonus off. The locked
  // form posts Normal; every other setting is saved exactly as chosen.
  it('saves the BKBOP configuration as Normal with its other settings unchanged', async () => {
    const fd = form('bik', 'BKBOP'); fd.set('name', 'BIK-Buyout Payment'); fd.set('label', 'BIK-Buyout Payment'); fd.set('eaFormLine', '');
    expect(fd.get('includedInEpf')).toBeNull(); expect(fd.get('epfBonus2012')).toBeNull();
    expect(await location(createComponentAction, fd)).toContain('toast=toastSaved');
    const row = (await listPayComponents(ctx)).find(c => c.code === 'BKBOP')!;
    expect(row).toMatchObject({ name: 'BIK-Buyout Payment', label: 'BIK-Buyout Payment', kind: 'non_payable', isNonPayable: true,
      displayCategory: 'bik', eaFormLine: null, includedInPcb: true, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
      includedInEpf: false, epfBonus2012: false, includedInSocsoEis: false, includedInHrdfBase: false });
    expect((await listSupportedBatchComponents(ctx)).map(c => c.id)).toContain(row.id);
  });

  // 8edeef41 (owner decision 2026-11-25) — BKBOP saves as Additional, keeps it through an unrelated edit, and can be
  // switched back to Normal; every other setting is kept exactly.
  it('saves BKBOP as Additional, retains it on reopen and edit, and switches back to Normal with other settings kept', async () => {
    const fd = form('bik', 'BKBOP'); fd.set('name', 'BIK-Buyout Payment'); fd.set('label', 'BIK-Buyout Payment'); fd.set('eaFormLine', '');
    fd.set('pcbRemunerationType', 'additional');
    expect(await location(createComponentAction, fd)).toContain('toast=toastSaved');
    const before = (await listPayComponents(ctx)).find(c => c.code === 'BKBOP')!;
    expect(before).toMatchObject({ kind: 'non_payable', displayCategory: 'bik', includedInPcb: true, pcbRemunerationType: 'additional',
      pcbExemptionCode: 'PCB_TAXABLE', includedInEpf: false, epfBonus2012: false });
    expect(unsupportedTaxableReason(before)).toBeNull();
    expect((await listSupportedBatchComponents(ctx)).map(c => c.id)).toContain(before.id);
    fd.set('name', 'BIK-Buyout Payment (renamed)');
    expect(await location(updateComponentAction, fd)).toContain('toast=toastSaved');
    const renamed = (await listPayComponents(ctx)).find(c => c.id === before.id)!;
    expect(renamed.pcbRemunerationType).toBe('additional'); expect(renamed.name).toBe('BIK-Buyout Payment (renamed)');
    fd.set('pcbRemunerationType', 'normal');
    expect(await location(updateComponentAction, fd)).toContain('toast=toastSaved');
    const after = (await listPayComponents(ctx)).find(c => c.id === before.id)!;
    const kept = ['code', 'label', 'kind', 'isNonPayable', 'displayCategory', 'eaFormLine', 'includedInPcb', 'pcbExemptionCode',
      'includedInEpf', 'epfBonus2012', 'includedInSocsoEis', 'includedInHrdfBase', 'prorates', 'archivedAt'] as const;
    expect(Object.fromEntries(kept.map(k => [k, after[k]]))).toEqual(Object.fromEntries(kept.map(k => [k, before[k]])));
    expect(after.pcbRemunerationType).toBe('normal');
    expect(unsupportedTaxableReason(after)).toBeNull();
  });

  it('refuses a forged maintenance edit for an absent code instead of creating a new row', async () => {
    const before = await listPayComponents(ctx, {includeArchived: true});
    expect(await location(updateComponentAction, form('bik', 'ABSENT_EDIT'))).toContain('error=errorComponentUnavailable');
    expect(await listPayComponents(ctx, {includeArchived: true})).toEqual(before);
  });

  it.each([createComponentAction, updateComponentAction])('reports genuinely missing/invalid selections and exact benefit refusals before persistence', async (action) => {
    const updating = action === updateComponentAction;
    if (updating) expect(await location(createComponentAction, form('bik'))).toContain('toast=toastSaved');
    const stored = updating ? (await listPayComponents(ctx)).find(c => c.code === 'BIK_HOUSE')! : null;
    const projection = (row: NonNullable<typeof stored>) => ({ code: row.code, name: row.name, kind: row.kind,
      isNonPayable: row.isNonPayable, displayCategory: row.displayCategory, eaFormLine: row.eaFormLine,
      includedInPcb: row.includedInPcb, includedInEpf: row.includedInEpf, includedInSocsoEis: row.includedInSocsoEis,
      includedInHrdfBase: row.includedInHrdfBase, pcbRemunerationType: row.pcbRemunerationType,
      pcbExemptionCode: row.pcbExemptionCode, epfBonus2012: row.epfBonus2012 });
    async function assertRetained() {
      const current = (await listPayComponents(ctx)).filter(c => c.code === 'BIK_HOUSE');
      if (stored) { expect(current).toHaveLength(1); expect(projection(current[0])).toEqual(projection(stored)); }
      else expect(current).toEqual([]);
    }
    const cases: [string, string, string][] = [
      ['pcbRemunerationType', '', 'errorStatutory_pcbRemunerationTypeRequired'],
      ['pcbRemunerationType', 'bik', 'errorStatutory_pcbRemunerationTypeRequired'],
      ['pcbExemptionCode', '', 'errorStatutory_pcbExemptionTypeRequired'],
      ['pcbExemptionCode', 'INVALID', 'errorStatutory_pcbExemptionTypeInvalid'],
      ['eaFormLine', 'EA_B4', 'errorBenefit_classification_conflict'],
    ];
    for (const [key, value, expected] of cases) {
      const fd = form('bik'); fd.set(key, value);
      expect(await location(action, fd), `${key}=${value}`).toContain(`error=${expected}`);
      await assertRetained();
    }
    const optional = form('bik'); optional.set('pcbRemunerationType', 'optional_deduction'); optional.set('pcbExemptionCode', 'LP_VOLUNTARY_EPF');
    expect(await location(action, optional)).toContain('error=errorBenefit_remuneration_type_not_supported');
    await assertRetained();
    // 8edeef41 — EPF Bonus 2012 is its own reason, reported only when that box is ticked; it is checked first.
    const bonus = form('bik'); bonus.set('includedInEpf', 'on'); bonus.set('epfBonus2012', 'on');
    expect(await location(action, bonus)).toContain('error=errorBenefit_epf_bonus_not_allowed');
    await assertRetained();
    bonus.set('pcbRemunerationType', 'additional');
    expect(await location(action, bonus)).toContain('error=errorBenefit_epf_bonus_not_allowed');
    await assertRetained();
    const unknown = form('bik'); unknown.set('displayCategory', ''); unknown.set('eaFormLine', '');
    expect(await location(action, unknown)).toContain('error=errorUnsupportedTaxable');
    await assertRetained();
  });

  it('description-only maintenance retains legacy BASIC NULL classification and identity, while actual edits remain strict', async () => {
    await seedPayComponentCatalog(ctx);
    const legacy = (await listPayComponents(ctx)).find(row => row.code === 'BASIC')!;
    expect(legacy).toMatchObject({ label: null, includedInPcb: true, pcbRemunerationType: null, pcbExemptionCode: null, pendingInputKind: null });
    const payload = () => {
      const fd = new FormData();
      for (const key of ['code', 'name', 'kind', 'label', 'description', 'eaFormLine', 'roundingMethod', 'displayCategory', 'pcbRemunerationType', 'pcbExemptionCode'] as const) fd.set(key, String(legacy[key] ?? ''));
      fd.set('rule', legacy.rule ? JSON.stringify(legacy.rule) : '');
      for (const key of ['includedInEpf', 'includedInSocsoEis', 'includedInPcb', 'includedInHrdfBase', 'epfBonus2012', 'prorates', 'orpOvertime', 'orpUnpaidLeave'] as const) if (legacy[key]) fd.set(key, 'on');
      return fd;
    };
    const fd = payload(); fd.set('description', 'Board20 legacy description edit (fictional)');
    expect(await location(updateComponentAction, fd)).toContain('toast=toastSaved');
    const saved = (await listPayComponents(ctx)).find(row => row.id === legacy.id)!;
    expect(saved).toEqual({ ...legacy, description: 'Board20 legacy description edit (fictional)' });
    // The authoritative writer accepts this same unchanged legacy pair without trusting any form marker.
    await updatePayComponent(ctx, { ...saved, description: 'Owner-side description only' });
    const ownerSaved = (await listPayComponents(ctx)).find(row => row.id === legacy.id)!;
    expect(ownerSaved).toEqual({ ...saved, description: 'Owner-side description only' });
    const incomplete = payload(); incomplete.set('pcbRemunerationType', 'normal');
    expect(await location(updateComponentAction, incomplete)).toContain('error=errorStatutory_pcbExemptionTypeRequired');
    await expect(updatePayComponent(ctx, { ...ownerSaved, pcbRemunerationType: 'normal' })).rejects.toBeInstanceOf(PayComponentStatutoryConfigError);
    const changedFlag = payload(); changedFlag.delete('includedInEpf');
    expect(await location(updateComponentAction, changedFlag)).toContain('error=errorStatutory_pcbRemunerationTypeRequired');
    const forgedType = payload(); forgedType.set('pcbRemunerationType', 'INVALID');
    expect(await location(updateComponentAction, forgedType)).toContain('error=errorStatutory_pcbRemunerationTypeRequired');
    expect((await listPayComponents(ctx)).find(row => row.id === legacy.id)).toEqual(ownerSaved);
    const copied = payload(); copied.set('code', 'BASIC_COPY'); copied.set('label', 'Fictional copy');
    expect(await location(createComponentAction, copied)).toContain('error=errorStatutory_pcbRemunerationTypeRequired');
    // Completing the pair is valid; an old blank-pair form must then be refused, never erase completion.
    const complete = payload(); complete.set('pcbRemunerationType', 'normal'); complete.set('pcbExemptionCode', 'PCB_TAXABLE');
    expect(await location(updateComponentAction, complete)).toContain('toast=toastSaved');
    const completed = (await listPayComponents(ctx)).find(row => row.id === legacy.id)!;
    expect(completed).toMatchObject({ pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' });
    expect(await location(updateComponentAction, payload())).toContain('error=errorStatutory_pcbRemunerationTypeRequired');
    await expect(updatePayComponent(ctx, { ...ownerSaved })).rejects.toBeInstanceOf(PayComponentStatutoryConfigError);
    expect((await listPayComponents(ctx)).find(row => row.id === legacy.id)).toEqual(completed);
  });
  it('cash display/EA metadata and a valid label edit do not force remapping an unchanged legacy PCB pair', async () => {
    await seedPayComponentCatalog(ctx);
    const legacy = (await listPayComponents(ctx)).find(row => row.code === 'BASIC')!;
    await updatePayComponent(ctx, { ...legacy, label: 'Basic display', displayCategory: 'basic', eaFormLine: 'EA_B1A' });
    expect((await listPayComponents(ctx)).find(row => row.id === legacy.id)).toEqual({ ...legacy, label: 'Basic display', displayCategory: 'basic', eaFormLine: 'EA_B1A' });
  });
  it('a legacy partial setter preserves stored classification when changing an unrelated field', async () => {
    expect(await location(createComponentAction, form('bik'))).toContain('toast=toastSaved');
    const existing = (await listPayComponents(ctx)).find(c => c.code === 'BIK_HOUSE')!;
    await upsertPayComponent(ctx, { code: existing.code, name: 'Legacy unrelated rename', kind: existing.kind,
      isNonPayable: existing.isNonPayable, prorates: existing.prorates, includedInPcb: existing.includedInPcb,
      includedInEpf: existing.includedInEpf, includedInSocsoEis: existing.includedInSocsoEis,
      includedInHrdfBase: existing.includedInHrdfBase, eaFormLine: existing.eaFormLine, roundingMethod: existing.roundingMethod });
    const saved = (await listPayComponents(ctx)).find(c => c.id === existing.id)!;
    expect(saved.name).toBe('Legacy unrelated rename');
    expect(saved.pcbRemunerationType).toBe(existing.pcbRemunerationType);
    expect(saved.pcbExemptionCode).toBe(existing.pcbExemptionCode);
    expect(saved.displayCategory).toBe(existing.displayCategory);
    expect(saved.epfBonus2012).toBe(existing.epfBonus2012);
    expect(saved.eaFormLine).toBe(existing.eaFormLine);
  });

  it('unticking PCB keeps benefit/EA identity and clears tax classification without creating an invented benefit type', async () => {
    const fd = form('vola'); fd.delete('includedInPcb');
    expect(await location(createComponentAction, fd)).toContain('toast=toastSaved');
    const saved = (await listPayComponents(ctx)).find(c => c.code === 'BIK_HOUSE')!;
    const untaxed = { id: saved.id, code: 'BIK_HOUSE', label: 'BIK_HOUSE', kind: 'non_payable', isNonPayable: true,
      displayCategory: 'vola', eaFormLine: 'EA_B4', includedInPcb: false, pcbRemunerationType: null, pcbExemptionCode: null };
    expect(saved).toMatchObject(untaxed);
    // The posted selections are deliberately still present: only the screen checkbox retires them.
    expect(fd.get('pcbRemunerationType')).toBe('normal'); expect(fd.get('pcbExemptionCode')).toBe('PCB_TAXABLE');
    fd.set('includedInPcb', 'on');
    expect(await location(updateComponentAction, fd)).toContain('toast=toastSaved');
    expect((await listPayComponents(ctx)).find(c => c.id === saved.id)).toMatchObject({ includedInPcb: true, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' });
    fd.delete('includedInPcb');
    expect(await location(updateComponentAction, fd)).toContain('toast=toastSaved');
    expect((await listPayComponents(ctx)).find(c => c.id === saved.id)).toMatchObject(untaxed);
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

  // 8edeef41 (2026-11-25) — the same journey with BKBOP saved as Additional: PCB takes it through Yt (Kt 0), cash and the
  // agency bases do not move, the payslip saves a version 2 snapshot, and switching the item back to Normal later never
  // rewrites that saved working.
  it('an Additional benefit saved by the action reaches Yt with Kt 0, saves a v2 snapshot and keeps it frozen', async () => {
    const employee = await hireEmployee(ctx, { person: { fullName: 'Synthetic Additional Benefit', primaryEmail: `${randomUUID()}@r385.test` }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2025-01-01' });
    await requirePackFor('MY').statutory.set(ctx, { personId: employee.personId, icNumber: '900101880001' });
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 12000, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
    const fd = form('bik', 'BKBOP'); fd.set('pcbRemunerationType', 'additional');
    expect(await location(createComponentAction, fd)).toContain('toast=toastSaved');
    const row = (await listPayComponents(ctx)).find(c => c.code === 'BKBOP')!;
    const baseline = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(ctx, { batchId: baseline.batchId });
    const batch = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-07' });
    await setPayrollBatchComponent(ctx, { batchId: batch.batchId, employmentId: employee.employmentId, componentId: row.id, amount: 800 });
    await generatePayslips(ctx, { batchId: batch.batchId });
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employee.employmentId));
    const before = slips.find(s => s.batchId === baseline.batchId)!, after = slips.find(s => s.batchId === batch.batchId)!;
    const statutory = after.statutory as Record<string, any>, prior = before.statutory as Record<string, any>;
    const saved = readPcbNonCash(statutory.pcbNonCash)!;
    expect(saved.version).toBe(2); expect(saved.owned.bik).toBe(800);
    expect(saved.ownedEntries).toEqual([expect.objectContaining({ code: 'BKBOP', taxable: 800, stream: 'additional' })]);
    expect(statutory.pcbMeta.trace.Y1).toBe(12000); expect(statutory.pcbMeta.trace.Yt).toBe(800); expect(statutory.pcbMeta.trace.Kt).toBe(0);
    expect(Number(statutory.pcbBonus)).toBeGreaterThan(0);
    expect(after.grossPay).toBe(before.grossPay); expect(Number(after.bonus)).toBe(0);
    for (const key of ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'eisEmployee', 'eisEmployer'] as const) expect(statutory[key]).toBe(prior[key]);
    expect(statutory.bases.epf).toBe(prior.bases.epf); expect(statutory.bases.epfAdditional).toBe(prior.bases.epfAdditional); expect(statutory.bases.socsoEis).toBe(prior.bases.socsoEis);
    expect(statutory.bases.pcb).toBe(12800);
    // The month's Normal-only payslip is still written as version 1, with no stream key anywhere.
    expect(prior.pcbNonCash.version).toBe(1); expect(JSON.stringify(prior.pcbNonCash)).not.toContain('stream');
    const frozen = JSON.stringify(after.statutory);
    fd.set('pcbRemunerationType', 'normal');
    expect(await location(updateComponentAction, fd)).toContain('toast=toastSaved');
    const [unchanged] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id, after.id));
    expect(JSON.stringify(unchanged.statutory)).toBe(frozen);
  });

  it('CSV preview and import recognise configured BIK/VOLA while preserving generic noncash refusal', async () => {
    const email = `${randomUUID()}@r385.test`;
    const employee = await hireEmployee(ctx, { person: { fullName: 'Synthetic Benefit Import', primaryEmail: email }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2025-01-01' });
    const batch = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-07' });
    for (const kind of ['bik', 'vola'] as const) expect(await location(createComponentAction, form(kind, kind.toUpperCase()))).toContain('toast=toastSaved');
    await upsertPayComponent(ctx, { label: 'Unclassified', code: 'UNKNOWN', name: 'Unclassified', kind: 'non_payable', isNonPayable: true,
      prorates: false, includedInPcb: true, includedInEpf: false, includedInSocsoEis: false, includedInHrdfBase: false,
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' });
    for (const [code, eaFormLine, pcbRemunerationType, pcbExemptionCode] of [
      ['CONFLICT', 'EA_B4', 'normal', 'PCB_TAXABLE'], ['ADDITIONAL', 'EA_B3', 'additional', 'PCB_TAXABLE'], ['OPTIONAL', 'EA_B3', 'optional_deduction', 'LP_VOLUNTARY_EPF'],
    ] as const) await upsertPayComponent(ctx, { label: code, code, name: code, kind: 'non_payable', isNonPayable: true,
      displayCategory: 'bik', eaFormLine, prorates: false, includedInPcb: true, includedInEpf: false,
      includedInSocsoEis: false, includedInHrdfBase: false, pcbRemunerationType, pcbExemptionCode });
    const refused = await importBatchComponents(ctx, { batchId: batch.batchId,
      csvText: `employee,component,amount\n${email},CONFLICT,700\n${email},ADDITIONAL,800\n${email},OPTIONAL,600`, dryRun: true });
    // 8edeef41 (2026-11-25) — an Additional BIK is a valid PCB input now; Optional Deduction stays refused.
    expect(refused.valid).toBe(1);
    // The service keeps the stable reason; the action words it from the shared import catalogue.
    expect(refused.rows.map(r => [r.code, r.ok, r.error, r.taxableReason])).toEqual([
      ['CONFLICT', false, 'Unsupported component: CONFLICT.', 'classification_conflict'],
      ['ADDITIONAL', true, null, undefined],
      ['OPTIONAL', false, 'Unsupported component: OPTIONAL.', 'remuneration_type_not_supported'],
    ]);
    const explained = await dryRunComponentImportAction(batch.batchId, `employee,component,amount\n${email},CONFLICT,700\n${email},OPTIONAL,800\n${email},UNKNOWN,900`);
    expect(explained.rows.map(r => r.error)).toEqual([
      'Unsupported component: CONFLICT. importIssue_classification_conflict',
      'Unsupported component: OPTIONAL. importIssue_remuneration_type_not_supported',
      'Unsupported component: UNKNOWN. importIssue_unrecognised_taxable_item',
    ]);
    const csvText = `employee,component,amount\n${email},BIK,700\n${email},VOLA,800\n${email},UNKNOWN,900`;
    const preview = await importBatchComponents(ctx, { batchId: batch.batchId, csvText, dryRun: true });
    expect(preview.valid).toBe(2); expect(preview.imported).toBe(0);
    expect(await owner.db.select().from(schema.payrollBatchComponent).where(eq(schema.payrollBatchComponent.batchId, batch.batchId)).orderBy(schema.payrollBatchComponent.id)).toEqual([]);
    expect(preview.rows.map(r => [r.code, r.ok])).toEqual([['BIK', true], ['VOLA', true], ['UNKNOWN', false]]);
    expect([preview.rows[2].error, preview.rows[2].taxableReason]).toEqual(['Unsupported component: UNKNOWN.', 'unrecognised_taxable_item']);
    const result = await importBatchComponents(ctx, { batchId: batch.batchId, csvText, dryRun: false });
    expect(result.imported).toBe(2);
    const saved = await owner.db.select().from(schema.payrollBatchComponent).where(and(eq(schema.payrollBatchComponent.batchId, batch.batchId), eq(schema.payrollBatchComponent.employmentId, employee.employmentId))).orderBy(schema.payrollBatchComponent.amount);
    expect(saved.map(r => r.amount)).toEqual(['700.00', '800.00']);
  });
});

it('8edeef41: EPF Bonus 2012 and Remuneration Type are separate refusals; Normal and Additional are both valid', () => {
  const bik = { code: 'BKBOP', kind: 'non_payable', displayCategory: 'bik', isNonPayable: true, includedInPcb: true,
    includedInEpf: false, includedInSocsoEis: false, pcbRemunerationType: 'normal', epfBonus2012: false };
  expect(unsupportedTaxableReason(bik)).toBeNull();
  expect(unsupportedTaxableReason({ ...bik, pcbRemunerationType: 'additional' })).toBeNull();
  expect(unsupportedTaxableReason({ ...bik, pcbRemunerationType: 'optional_deduction' })).toBe('remuneration_type_not_supported');
  expect(unsupportedTaxableReason({ ...bik, includedInEpf: true, epfBonus2012: true })).toBe('epf_bonus_not_allowed');
  expect(unsupportedTaxableReason({ ...bik, includedInEpf: true, epfBonus2012: true, pcbRemunerationType: 'additional' })).toBe('epf_bonus_not_allowed');
  // Not subject to PCB: neither refusal applies (the benefit is not a PCB input).
  expect(unsupportedTaxableReason({ ...bik, includedInPcb: false, pcbRemunerationType: 'additional' })).toBeNull();
});

it('uses the canonical typed reason for noncash kind conflicts rather than claiming the selected type is absent', () => {
  expect(unsupportedTaxableReason({ code: 'BROKEN', kind: 'deduction', displayCategory: 'bik', isNonPayable: true,
    includedInPcb: true, includedInEpf: false, includedInSocsoEis: false, pcbRemunerationType: 'normal' })).toBe('unsupported_kind');
});
