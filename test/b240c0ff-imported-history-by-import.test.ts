/**
 * b240c0ff — imported payroll history: "<Pay Cycle> - By Import" on every run label, each imported pay item
 * kept as its own line, and NOTHING about any figure moving.
 *
 * Integration, through the public upload/confirm owner (core/payroll-history-revisions.ts) and the real
 * reads the screens use. Fixtures are fictional.
 *
 *  · the file's own lines land on the payslip AND its revision snapshot as `statutory.importedLines` (componentLines shape, a key no EA reader sees);
 *  · UPL and a second deduction stay two lines, under "Other deductions", whose figure is unchanged;
 *  · every read a screen labels from carries the import identity, and the shared helper names the run
 *    "Monthly - By Import"; the Transaction View cycle filter finds it under its real cycle;
 *  · an overwrite shows the cycle of the LATEST file;
 *  · EA and the monthly statutory figures are identical to the figures the file states, with a pay-item →
 *    EA-box mapping in place that WOULD move them if the imported lines were read as EA evidence;
 *  · a file still headed "DOE Code" imports.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { previewPayrollHistoryUpload, confirmPayrollHistoryUpload } from '../core/payroll-history-revisions';
import { hireEmployee } from '../core/org';
import { seedPayrollCycleCatalog } from '../core/payroll-cycle';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { eaStatement, MY_REPORTS } from '../localization/my/reports';
import {
  listFilableRunsForPeriod,
  listPayrollRegisterAcross,
  listPayslipRunsFor,
  listProcessedPayslipsAcross,
  payslipForReview,
} from '../core/payroll-view';
import { listBatches } from '../core/payroll';
import { applyFilters } from '../app/(app)/payroll/dashboard-logic';
import { payrollRunLabel, payslipCycleLabel } from '../core/payslip-cycle-label';
import { deriveHistoryBreakdown } from '../app/(app)/payroll/transaction-view/history-breakdown';
import { pivotHistoryGrid } from '../app/(app)/payroll/transaction-view/history-pivot';
import { buildPayslipPdfData, payslipPresentationRows } from '../lib/payslip-pdf';
import { PAYROLL_HISTORY_HEADERS } from '../lib/payroll-history-import-schema';
import { toCsv } from '../lib/csv';
import { todayInKualaLumpur } from '../lib/hr-date';
import { labels } from './fixtures/payslip-pdf-fixture';
import { closeAll, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';

let b: Base, ctx: SessionContext, employmentId: string;
// Two full years back, through the repository's HR date owner, so the month is always closed history.
const year = Number(todayInKualaLumpur().slice(0, 4)) - 2;
const period = `${year}-01`;
const contributions = MY_REPORTS.find((r) => r.id === 'my.contributions')!;

/**
 * One employee-month, every figure stated by the file:
 *   gross      = 5000 + 300                                   = 5300.00
 *   deductions = 250 (UPL) + 100 (D002) + 583 + 24.75 + 9.90 + 150 = 1117.65
 *   net        = 5300 − 1117.65                               = 4182.35
 *   other deductions (UPL + D002)                             =  350.00
 */
const monthLines = (cycle = 'ME') => [
  ['0007', period.replace('-', ''), cycle, 'BASIC', '000AC', '5000.00'],
  ['0007', period.replace('-', ''), cycle, 'A010', '000AC', '300.00'],
  ['0007', period.replace('-', ''), cycle, 'UPL', '000AC', '250.00'],
  ['0007', period.replace('-', ''), cycle, 'D002', '000AC', '100.00'],
  ['0007', period.replace('-', ''), cycle, 'EEEPF', '000AC', '583.00'],
  ['0007', period.replace('-', ''), cycle, 'EESOCSO', '000AC', '24.75'],
  ['0007', period.replace('-', ''), cycle, 'EEEIS', '000AC', '9.90'],
  ['0007', period.replace('-', ''), cycle, 'PCB', '000AC', '150.00'],
  ['0007', period.replace('-', ''), cycle, 'EREPF', '000AC', '689.00'],
  ['0007', period.replace('-', ''), cycle, 'ERSOCSO', '000AC', '86.65'],
  ['0007', period.replace('-', ''), cycle, 'EREIS', '000AC', '9.90'],
];
const upload = (headers: string[] = Array.from(PAYROLL_HISTORY_HEADERS), lines = monthLines()) =>
  previewPayrollHistoryUpload(ctx, {
    name: 'history.csv',
    content: Buffer.from(toCsv([headers, ...lines])),
    operationKey: randomUUID(),
  });
const confirm = (preview: Awaited<ReturnType<typeof upload>>) =>
  confirmPayrollHistoryUpload(ctx, {
    attemptId: preview.attemptId,
    previewHash: preview.plan.previewHash,
    confirmReplacement: true,
  });

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'payroll', 'active');
  ctx = await entitledCtx(b);
  await owner.db.update(schema.company).set({ companyLabel: '000AC' }).where(eq(schema.company.id, b.companyId));
  await seedPayrollCycleCatalog(ctx, b.companyId);
  await owner.db.insert(schema.payComponent).values([
    { tenantId: b.tenantId, code: 'BASIC', name: 'Basic salary', kind: 'allowance', displayCategory: 'basic' },
    // ⚠️ MAPPED TO AN EA BOX ON PURPOSE. If the imported line were read as EA evidence, the routing would
    // move this RM300 out of B1(c) Allowances into B1(b) Fees. The EA assertions below prove it does not.
    { tenantId: b.tenantId, code: 'A010', name: 'Meal allowance', kind: 'allowance', displayCategory: 'allowance', eaFormLine: 'director_fee' },
    { tenantId: b.tenantId, code: 'UPL', name: 'Unpaid leave', kind: 'deduction', displayCategory: 'deduction' },
    { tenantId: b.tenantId, code: 'D002', name: 'Staff welfare fund', kind: 'deduction', displayCategory: 'deduction' },
  ]);
  const hired = await hireEmployee(ctx, {
    person: { fullName: 'Fictional import employee', primaryEmail: 'b240@fixture.test' },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    employeeCode: '0007',
    hiredOn: `${year - 1}-01-01`,
  });
  employmentId = hired.employmentId;
});
afterAll(closeAll);

const effectiveRows = () => listProcessedPayslipsAcross(ctx, { companyIds: [b.companyId] });

describe('b240c0ff — imported payroll history keeps its lines and its Pay Cycle', () => {
  it('stamps each pay item line on the payslip AND the snapshot; category totals are the file’s', async () => {
    const preview = await upload();
    expect(preview.plan.counts).toEqual({ created: 1, replaced: 0, unchanged: 0, invalid: 0 });
    const done = await confirm(preview);

    const slips = await withTenant(ctx, (tx) => tx.select().from(schema.payslip));
    expect(slips).toHaveLength(1);
    const [slip] = slips;
    // The figures are exactly the file's, as before.
    expect([slip.basicSalary, slip.allowance, slip.grossPay, slip.otherDeductions, slip.totalDeductions, slip.netPay]).toEqual(
      ['5000.00', '300.00', '5300.00', '350.00', '1117.65', '4182.35'],
    );
    const st = slip.statutory as Record<string, unknown>;
    expect(st.componentLines).toBeUndefined();
    expect(st.importedLines).toEqual([
      { code: 'A010', name: 'Meal allowance', amount: 300, buckets: [{ bucket: 'wage', amount: 300 }] },
      { code: 'UPL', name: 'Unpaid leave', amount: 250, buckets: [{ bucket: 'deduct', amount: 250 }] },
      { code: 'D002', name: 'Staff welfare fund', amount: 100, buckets: [{ bucket: 'deduct', amount: 100 }] },
    ]);
    // Basic and the statutory figures are NOT pay item lines: each already has its own row.
    expect((st.importedLines as { code: string }[]).map((l) => l.code)).not.toContain('BASIC');
    expect(st.epfEmployee).toBe(583);
    expect(st.pcb).toBe(150);

    // The revision snapshot holds the identical blob (the 0602 equality trigger accepted the write).
    const [snap] = await owner.db
      .select()
      .from(schema.payrollHistoryImportSnapshot)
      .where(eq(schema.payrollHistoryImportSnapshot.id, done.changes[0].snapshotId!));
    expect((snap.values as { statutory: unknown }).statutory).toEqual(slip.statutory);
  });

  it('every read a screen labels from names the run "Monthly - By Import"; the cycle filter finds it under Monthly', async () => {
    await confirm(await upload());

    const rows = await effectiveRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    // Still stored as an adjustment run — deliberately (regular-uniqueness index, live-run guard, PCB/AR).
    expect(row.runType).toBe('adjustment');
    expect(row.historyImportAttemptId).toEqual(expect.any(String));
    expect(row.historyImportCycleName).toBe('Monthly');
    expect(payrollRunLabel(row, 'Adjustment')).toBe('Monthly - By Import');

    // Transaction View's cycle filter: imported history sits under its real cycle (Monthly ⇒ regular)…
    expect(await listProcessedPayslipsAcross(ctx, { companyIds: [b.companyId], cycle: 'regular' })).toHaveLength(1);
    // …and no longer under "Adjustment".
    expect(await listProcessedPayslipsAcross(ctx, { companyIds: [b.companyId], cycle: 'adjustment' })).toHaveLength(0);

    // Individual Payslip's run picker.
    const runs = await listPayslipRunsFor(ctx, { companyIds: [b.companyId], employmentId });
    expect(runs.map((r) => payrollRunLabel(r, 'Adjustment'))).toEqual(['Monthly - By Import']);
    // The statutory previews' run picker (cycle name resolved in the read).
    const filable = await listFilableRunsForPeriod(ctx, { companyIds: [b.companyId], companyId: b.companyId, periodKey: period });
    expect(filable.map((r) => payslipCycleLabel({ cycleName: r.cycleName, runTypeLabel: 'Adjustment' }))).toEqual(['Monthly - By Import']);
    // The payslip review read (Individual Payslip, statutory detail).
    const review = await payslipForReview(ctx, { companyIds: [b.companyId], payslipId: row.id });
    expect(review && payrollRunLabel(review, 'Adjustment')).toBe('Monthly - By Import');
    // The register (custom report, transaction detail export) — the stored run type stays for matching.
    const register = await listPayrollRegisterAcross(ctx, { companyIds: [b.companyId] });
    expect(register.map((r) => [r.payrollCycle, payrollRunLabel(r, r.payrollCycle)])).toEqual([['adjustment', 'Monthly - By Import']]);
    // The payroll list / process wizard / batch pages read listBatches.
    const batches = await listBatches(ctx, [b.companyId]);
    expect(batches.map((x) => payrollRunLabel(x, 'Adjustment'))).toEqual(['Monthly - By Import']);
    // The payroll list's Payroll Cycle filter: under its imported cycle's run type (Monthly ⇒ regular),
    // never under "Adjustment", while the stored run type stays 'adjustment'.
    const listFilter = (cycles: string[]) => applyFilters(batches, { periods: [period], companyIds: [], cycles, statuses: [] });
    expect(batches.map((x) => [x.runType, x.filterRunType])).toEqual([['adjustment', 'regular']]);
    expect(listFilter(['regular'])).toHaveLength(1);
    expect(listFilter(['adjustment'])).toHaveLength(0);
    expect(listFilter([])).toHaveLength(1);
  });

  it('UPL and a second deduction are listed separately under Other deductions, with totals unchanged', async () => {
    await confirm(await upload());
    const [row] = await effectiveRows();

    // Transaction View → History breakdown (and the Individual Payslip screen, which renders the same one).
    const br = deriveHistoryBreakdown(row);
    expect(br.absence.residual).toBe(350);
    expect(br.deductionLines).toEqual([
      { code: 'UPL', name: 'Unpaid leave', amount: 250 },
      { code: 'D002', name: 'Staff welfare fund', amount: 100 },
    ]);
    expect(br.allowanceLines).toEqual([{ code: 'A010', name: 'Meal allowance', amount: 300 }]);
    expect(br.totalDeductions).toBe(1117.65);
    expect(br.net).toBe(4182.35);

    // Transaction View → Grid: one row per item, under Deductions, the lump and the totals unchanged.
    const grid = pivotHistoryGrid({ rows: [row], year });
    const month = (code: string) => grid.rows.filter((r) => r.code === code).map((r) => [r.group, r.months[0]]);
    expect(month('UPL')).toEqual([['deduction', 250]]);
    expect(month('D002')).toEqual([['deduction', 100]]);
    expect(month('OTHER_DED')).toEqual([['deduction', 350]]);
    expect(month('TOTAL_DED')).toEqual([['summary', 1117.65]]);
    expect(grid.rows.every((r) => payrollRunLabel(r, 'Adjustment') === 'Monthly - By Import')).toBe(true);

    // The payslip document (PDF and the employee's statement share these rows).
    const data = buildPayslipPdfData(
      {
        employee: row.employeeName, employeeCode: row.employeeCode, company: row.company, companyReg: null,
        payPeriod: row.payPeriod, basic: row.basic, allowance: row.allowance, overtime: row.overtime, bonus: row.bonus,
        gross: row.gross, statutory: row.statutory, otherDeductions: row.otherDeductions,
        totalDeductions: row.totalDeductions, net: row.net, employerCost: 0, daysWorked: null,
      },
      { epf: 'EPF', socso: 'SOCSO', eis: 'EIS', tax: 'PCB', skbbk: 'SKBBK' },
    );
    const { deductions, earnings } = payslipPresentationRows(data, labels, String);
    expect(deductions.map((r) => [r.label, r.amount])).toEqual([
      ['EPF', 583], ['SOCSO', 24.75], ['EIS', 9.9], ['PCB', 150], ['Unpaid leave', 250], ['Staff welfare fund', 100],
    ]);
    expect(deductions.map((r) => r.label)).not.toContain(labels.otherDeductions);
    // The rows still add up to TOTAL DEDUCTIONS, computed independently of the renderer.
    expect(Math.round(deductions.reduce((s, r) => s + (r.amount ?? 0), 0) * 100) / 100).toBe(250 + 100 + 583 + 24.75 + 9.9 + 150);
    expect(earnings.map((r) => [r.label, r.amount])).toEqual([[labels.basicSalary, 5000], ['Meal allowance', 300]]);
  });

  it('an overwrite shows the Pay Cycle of the latest file', async () => {
    await confirm(await upload());
    // The admin renames the cycle; the next file is the correction.
    await owner.db
      .update(schema.payrollCycle)
      .set({ name: 'Monthly Payroll' })
      .where(and(eq(schema.payrollCycle.companyId, b.companyId), eq(schema.payrollCycle.code, 'ME')));
    const correction = await upload(Array.from(PAYROLL_HISTORY_HEADERS), monthLines().map((l) => (l[3] === 'UPL' ? [...l.slice(0, 5), '200.00'] : l)));
    expect(correction.plan.counts.replaced).toBe(1);
    await confirm(correction);

    const rows = await effectiveRows();
    expect(rows.map((r) => [payrollRunLabel(r, 'Adjustment'), r.otherDeductions])).toEqual([['Monthly Payroll - By Import', '300.00']]);
    expect(deriveHistoryBreakdown(rows[0]).deductionLines.map((l) => [l.code, l.amount])).toEqual([['UPL', 200], ['D002', 100]]);
  });

  it('EA and the monthly statutory figures are exactly the file’s, with a pay-item → EA-box mapping in place', async () => {
    const person = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
    await setStatutoryProfileMY(ctx, { personId: person[0].personId, icNumber: '900101015523' });
    await confirm(await upload());

    const ea = await eaStatement(ctx, { employmentId, year: String(year) });
    expect(ea).not.toBeNull();
    // Independent expected values: the file's own lines.
    expect(ea!.partB.gross).toBeCloseTo(5300, 2);
    expect(ea!.partB.grossSalary).toBeCloseTo(5000, 2);
    expect(ea!.partB.allowances).toBeCloseTo(300, 2);
    // A010 is mapped to Fees; were the imported line read as EA evidence it would have moved here.
    expect(ea!.partB.directorFee).toBeCloseTo(0, 2);
    expect(ea!.partD.mtd).toBeCloseTo(150, 2);
    expect(ea!.partE.epf).toBeCloseTo(583, 2);

    const monthly = await contributions.generate(ctx, { companyId: b.companyId, periodKey: period });
    expect(monthly.rows).toHaveLength(1);
    expect(Number(monthly.rows[0].gross)).toBeCloseTo(5300, 2);
    expect(Number(monthly.rows[0].epf)).toBeCloseTo(583 + 689, 2);
  });

  it('a file still headed "DOE Code" imports exactly as the new heading does', async () => {
    const legacy = Array.from(PAYROLL_HISTORY_HEADERS).map((h) => (h === 'Pay Items Code' ? 'DOE Code' : h));
    expect(legacy).toContain('DOE Code');
    const preview = await upload(legacy);
    expect(preview.plan.issues).toEqual([]);
    expect(preview.plan.counts).toEqual({ created: 1, replaced: 0, unchanged: 0, invalid: 0 });
    await confirm(preview);
    const [row] = await effectiveRows();
    expect(row.net).toBe('4182.35');

    // A file with the column missing altogether names it by the heading the reader can see.
    const missing = await upload(
      ['Employee No', 'Payroll Period', 'Payroll Cycle', 'Company Code', 'Amount'],
      [['0007', '202401', 'ME', '000AC', '1.00']],
    );
    expect(missing.plan.issues.map((i) => i.reason)).toContain('Missing required column: Pay Items Code');
  });
});
