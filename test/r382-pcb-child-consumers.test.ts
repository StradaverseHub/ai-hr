import fs from 'node:fs';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childReliefFor, childReliefPrices } from '../localization/my/child-relief';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { pcbMonth } from '../localization/my/payroll';
import { repriceChildQualificationReliefs } from '../localization/child-qualification';
import { explainPcb, pcbSlipSections, pcbClosingSections, pcbWorksheet } from '../core/pcb-explain';
import { qualifyingChildReliefFor } from '../core/dependents';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import { saveStatutoryRulesetMY } from '../localization/my/statutory-config';
import { createBatch, generatePayslips } from '../core/payroll';
import { payslipForReview } from '../core/payroll-view';
import { withTenant } from '../db/client';
import { statutoryRuleset } from '../db/schema';
import { PcbDetailView } from '../app/payroll/pcb-detail/pcb-detail-view';
import { pcbDetailPdfResponse } from '../app/payroll/pcb-detail/shared';
import { extractedText } from './helpers/pcb-pdf-text';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
const state = vi.hoisted(() => ({ locale: 'en', auth: null as any }));
vi.mock('../lib/scope', async importOriginal => ({ ...await importOriginal<any>(), scopedAdmin: async () => state.auth }));
vi.mock('next-intl/server', async () => { const { createTranslator } = await import('next-intl'); const fs = await import('node:fs'); return { getTranslations: async (arg: any) => { const locale = typeof arg === 'string' ? state.locale : arg.locale ?? state.locale; return createTranslator({ locale, messages: JSON.parse(fs.readFileSync(`messages/${locale}.json`, 'utf8')), namespace: typeof arg === 'string' ? arg : arg.namespace }); } }; });
const sides = { profile: null, catalogue: [], rebateCatalogue: [], currentDeduction: null, accumulatedDeduction: null, previousDeduction: null, currentRebate: null, accumulatedRebate: null };
function generated(q = 2000, legacy = false) {
  const pcb = structuredClone(DEFAULT_MY_STATUTORY.pcb);
  if (legacy) { delete pcb.reliefs.childQualificationVersion; delete pcb.reliefs.childQualificationWeights; pcb.reliefs.perChild = q; }
  else pcb.reliefs = repriceChildQualificationReliefs({ ...pcb.reliefs, perChild: q }, pcb.reliefs);
  const table = { under_18: { full: 1 } };
  const figure = childReliefFor({ from: 'table', taxCategory: 3, table, prices: childReliefPrices(pcb.reliefs) });
  const childWorking = { mode: 'auto_table' as const, table, rows: figure.rows, categoryUnits: { under_18: figure.units }, headCount: 1 };
  return pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, pcb, profile: { category: 3, childReliefAmount: figure.amountRM, childReliefCount: figure.units, childWorking } });
}
const read = (run: ReturnType<typeof generated>, edit?: (m: any) => void, fallback: any = null) => {
  const meta = structuredClone(run.snapshot); edit?.(meta);
  const x = explainPcb({ pcb: run.total, pcbBonus: run.additional, pcbMeta: meta }, fallback);
  if (x.kind !== 'mtd') throw Error('Expected generated resident trace');
  return x;
};

describe('r382 immutable exact child reader contract', () => {
  it('retains exact fractional C and category sums from a legacy-priced new run', () => {
    const run = generated(3000, true); const x = read(run);
    expect(x.trace?.childCountVersion).toBe(1);
    expect(x.trace?.childCount).toBe(2 / 3);
    expect(x.trace?.childWorking?.categoryUnits.under_18).toBe(2 / 3);
    expect(x.reliefs.children).toBe(2000);
  });
  it('new C must reconcile with the ACTUAL saved child deduction', () => {
    const x = read(generated(), m => { m.reliefs.children += .01; });
    expect(x.trace?.childCount).toBeNull(); expect(x.trace?.childWorking).toBeNull();
    const section = pcbSlipSections(x, sides)[0];
    expect(section.rows.find(r => r.caption === 'slipChildCount')?.first).toEqual({ kind: 'notRecorded' });
    expect(x.reliefs.children).toBe(2000.01); // Do not repair issued payroll to fit the trace.
  });
  it('new category-unit sums cannot borrow the old 0.005 count tolerance', () => {
    const x = read(generated(), m => { m.trace.childCount += .000001; });
    // This C still rounds to the same child money: only the exact category provenance can reject it.
    expect(x.reliefs.children).toBe(2000); expect(x.trace?.childCount).toBeNull(); expect(x.trace?.childWorking).toBeNull();
  });
  it.each([undefined, null, '2000', NaN, -1])('new C cannot use current relief fallback when saved children is %s', children => {
    const x = read(generated(), m => { if (children === undefined) delete m.reliefs; else m.reliefs.children = children; }, { individual: 9000, spouse: 0, children: 2000, disabledIndividual: 0, disabledSpouse: 0, total: 11000, lp: 0 });
    expect(x.trace?.childCount).toBeNull(); expect(x.trace?.childWorking).toBeNull();
  });
  it('unknown count versions remain unavailable rather than being treated as a modern or legacy count', () => {
    const x = read(generated(), m => { m.trace.childCountVersion = 2; });
    expect(x.trace?.childCount).toBeNull(); expect(x.trace?.childDeductionPerChild).toBeNull(); expect(x.trace?.childWorking).toBeNull();
  });
  it('legacy rounded C and legacy availability retain their original stored interpretation', () => {
    const x = read(generated(3000, true), m => { delete m.trace.childCountVersion; m.trace.childCount = .67; });
    expect(x.trace?.childCount).toBe(.67); expect(x.trace?.childWorking?.categoryUnits.under_18).toBe(2 / 3);
    expect(x.reliefs.children).toBe(2000);
    const missing = read(generated(), m => { delete m.trace.childCountVersion; delete m.trace.childDeductionPerChild; });
    expect(missing.trace?.childCount).toBeNull(); expect(missing.trace?.childWorking).toBeNull();
  });
  it('overflowing recorded category sums cannot pass an Infinity-to-Infinity tolerance comparison', () => {
    const x = read(generated(0), m => {
      m.trace.childCount = 0;
      const w = m.trace.childWorking;
      w.table.under_18.half = 1; w.headCount = 2;
      w.rows[0].units = 1e308;
      w.rows.push({ ...w.rows[0], sharePercent: 50 });
      w.categoryUnits.under_18 = 1e308;
    });
    expect(x.trace?.childCount).toBeNull(); expect(x.trace?.childWorking).toBeNull();
  });
  it('coherent zero-Q working retains positive qualifying counts beside zero saved deduction', () => {
    const x = read(generated(0));
    expect(x.trace?.childCount).toBe(1); expect(x.trace?.childDeductionPerChild).toBe(0);
    expect(x.trace?.childWorking?.categoryUnits.under_18).toBe(1); expect(x.reliefs.children).toBe(0);
  });
});

let fixture: Base;
const ASOF = '2026-07-28';
async function hire() {
  const e = await hireEmployee(adminCtx(fixture), { person: { fullName: 'Synthetic Qualification', primaryEmail: `${randomUUID()}@test.local` }, companyId: fixture.companyId, departmentId: fixture.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
  await setStatutoryProfileMY(adminCtx(fixture), { personId: e.personId, icNumber: '900101145678' });
  await setTaxProfileMY(adminCtx(fixture), { personId: e.personId, taxCategory: 3, numChildren: 1, childReliefMode: 'auto_table', childReliefTable: { under_18: { full: 1, half: 0 } } });
  return e;
}
describe('r382 country owner Personnel and rendered slip consumers', () => {
  beforeAll(async () => { await migrateTestDb(); });
  beforeEach(async () => { await resetDb(); fixture = await seedBase(); });
  afterAll(async () => { await closeAll(); });
  it('Personnel accepts coherent zero Q through the country owner, retaining C', async () => {
    const rules = structuredClone(DEFAULT_MY_STATUTORY);
    rules.pcb.reliefs = repriceChildQualificationReliefs({ ...rules.pcb.reliefs, perChild: 0 }, rules.pcb.reliefs);
    await saveStatutoryRulesetMY(adminCtx(fixture), { effectiveFrom: '2026-07-01', version: 'synthetic-q-zero', data: rules });
    const e = await hire();
    const actual = await qualifyingChildReliefFor(adminCtx(fixture), { personId: e.personId, asOf: ASOF });
    expect(actual).not.toBeNull(); expect(actual!.perChild).toBe(0); expect(actual!.qualifyingChildren).toBe(1); expect(actual!.reliefRM).toBe(0);
    expect(actual!.breakdown.reduce((sum, row) => sum + row.units, 0)).toBe(1);
  });
  it('malformed stored legacy zero-Q positive prices are unavailable, never a fabricated C zero', async () => {
    const rules = structuredClone(DEFAULT_MY_STATUTORY); delete rules.pcb.reliefs.childQualificationVersion; delete rules.pcb.reliefs.childQualificationWeights; rules.pcb.reliefs.perChild = 0;
    // Model an existing legacy row. New publication already refuses this setting; the reader must also be honest.
    await withTenant(adminCtx(fixture), tx => tx.insert(statutoryRuleset).values({ tenantId: fixture.tenantId, country: 'MY', version: 'legacy-invalid-q-zero', effectiveFrom: '2026-07-01', data: rules }));
    const e = await hire();
    expect(await qualifyingChildReliefFor(adminCtx(fixture), { personId: e.personId, asOf: ASOF })).toBeNull();
  });
  it('a processed fractional child count reaches the actual six-locale screen and EN/MS downloaded PDF', async () => {
    const rules = structuredClone(DEFAULT_MY_STATUTORY);
    rules.pcb.reliefs.childQualificationWeights!.under_18 = 1.25;
    rules.pcb.reliefs.childByCategory!.under_18 = 2500;
    await saveStatutoryRulesetMY(adminCtx(fixture), { effectiveFrom: '2026-07-01', version: 'synthetic-quarter-weight', data: rules });
    const e = await hire();
    await setCompensation(adminCtx(fixture), { employmentId: e.employmentId, basicSalary: 14000, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(adminCtx(fixture), { payPeriod: '2026-07', paymentDate: '2026-07-31', companyId: fixture.companyId });
    await generatePayslips(adminCtx(fixture), { batchId });
    const saved = await owner.db.query.payslip.findFirst({ where: (s, { eq }) => eq(s.batchId, batchId) }); expect(saved).toBeTruthy();
    const ctx = adminCtx(fixture); state.auth = { s: ctx, scopeIds: [fixture.companyId] };
    const row = await payslipForReview(ctx, { companyIds: [fixture.companyId], payslipId: saved!.id }); expect(row).toBeTruthy();
    const x = explainPcb(row!.statutory, null); if (x.kind !== 'mtd') throw Error('Expected processed resident trace');
    expect(x.trace?.childCount).toBe(1.25); expect(x.reliefs.children).toBe(2500);
    const slip = pcbSlipSections(x, sides);
    for (const locale of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      state.locale = locale;
      const html = renderToStaticMarkup(await PcbDetailView({ ctx: { employeeCode: 'SYNTH', employeeName: 'Synthetic Qualification', company: 'Synthetic Company', periodLabel: 'July 2026', payPeriod: '2026-07', runType: 'regular', runSeq: 1, currency: 'MYR', rulesetVersion: null, identityNumber: null, identityIsPassport: false, taxNumber: null, taxCategory: 3 }, explanation: x, worksheet: pcbWorksheet(x, null), slip, closing: pcbClosingSections(x) }));
      expect(html).toContain('>1.25<'); expect(html).not.toContain('>1.3<');
      if (locale === 'en' || locale === 'ms') {
        const response = await pcbDetailPdfResponse(new Request(`http://test.local/payroll/pcb-detail/pdf?payslipId=${saved!.id}&lang=${locale}`), 'attachment');
        expect(response.status).toBe(200);
        const text = await extractedText(new Uint8Array(await response.arrayBuffer()));
        expect(text.split('\n')).toContain('1.25');
        expect(text.split('\n')).not.toContain('1.3');
        const caption = JSON.parse(fs.readFileSync(`messages/${locale}.json`, 'utf8')).payroll.pcbDetail.slipChildCount;
        expect(text).toContain(caption);
      }
    }
  });
});
