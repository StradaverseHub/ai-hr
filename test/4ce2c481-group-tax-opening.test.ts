/**
 * Board 4ce2c481 — INCOME-TAX HISTORY FOLLOWS THE EMPLOYEE ACROSS GROUP COMPANIES ("Automatic group TP3", owner decision
 * of 26 November 2026). Real PostgreSQL, real row security, real imports and payroll runs, fictional people.
 *
 * The acceptance test the board item names: a same-employment transfer (company A imported January to September, company
 * B native from October). B's November PCB must equal the single-employer equivalent, computed INDEPENDENTLY: a control
 * employee who had the identical history at B alone, so B's own replay (the unchanged code path) produces the figure.
 * The imported months deducted no PCB, so the cumulative method has a shortfall to recover, which is what makes a
 * missing history visible: an employee with no earlier history at all is the "B only" figure the defect produced.
 */
import {and, asc, eq, inArray, sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {withTenant, type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {createCompany} from '../core/admin';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createMovementEvent} from '../core/movement';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch, generatePayslips} from '../core/payroll';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {previewPayrollHistoryUpload, confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {confirmTaxBasisRecalculation, getTaxBasisBatch, previewTaxBasisRecalculation} from '../core/payroll-tax-basis';
import {listPayComponents, seedPayComponentCatalog, setEmploymentPayComponent, upsertPayComponent} from '../core/pay-components';
import {payrollProcessJobHandler, requestPayrollProcessing} from '../core/payroll-processing-job';
import {groupTaxOpeningTx, groupTp3Outcome, readGroupTaxOpeningStamp, summarizeGroupTaxOpening, groupTaxPriorSlips} from '../core/payroll-group-tax-opening';
import {explainPcb, pcbWorksheet} from '../core/pcb-explain';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll, entitledCtx, owner, resetDb, seedBase, setModule, setSetting, type Base} from './harness';

vi.hoisted(() => {
  vi.stubEnv('AIHR_DB_PROCESS_ROLE', 'worker');
  vi.stubEnv('AIHR_DB_POOL_MAX', '2');
});

let b: Base, ctx: SessionContext, coB: string, deptB: string;
const months = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => String(from + i).padStart(2, '0'));
const historyRows = (employeeNo: string, company: string, monthList: string[], extra: [string, string][] = []) => monthList.flatMap(month => [
  [employeeNo, `2026-${month}`, 'ME', 'BASIC', company, '5000'], [employeeNo, `2026-${month}`, 'ME', 'EEEPF', company, '550'],
  [employeeNo, `2026-${month}`, 'ME', 'EESOCSO', company, '0'], [employeeNo, `2026-${month}`, 'ME', 'EEEIS', company, '0'],
  [employeeNo, `2026-${month}`, 'ME', 'PCB', company, '0'], ...extra.map(([code, amount]) => [employeeNo, `2026-${month}`, 'ME', code, company, amount]),
]);
async function importHistory(rows: string[][]) {
  const draft = await previewPayrollHistoryUpload(ctx, {name: 'history.csv', operationKey: randomUUID(),
    content: Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS), ...rows]))});
  expect(draft.plan.counts.invalid).toBe(0);
  await confirmPayrollHistoryUpload(ctx, {attemptId: draft.attemptId, previewHash: draft.plan.previewHash, confirmReplacement: true});
}
async function hire(code: string, name: string, ic: string, companyId: string, departmentId: string, hiredOn = '2025-01-01', terminatedOn?: string) {
  const employmentId = (await hireEmployee(ctx, {person: {fullName: name, primaryEmail: `group-tax-${code}-${randomUUID().slice(0, 6)}@example.test`}, companyId,
    departmentId, employmentType: 'full_time', employeeCode: code, hiredOn})).employmentId;
  const [subject] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
  await setCompensation(ctx, {employmentId, basicSalary: 5000, effectiveFrom: hiredOn});
  await setStatutoryProfileMY(ctx, {personId: subject.personId, icNumber: ic, taxCategory: 1, numChildren: 0});
  if (terminatedOn) await owner.db.update(schema.employment).set({terminatedOn}).where(eq(schema.employment.id, employmentId));
  return {employmentId, personId: subject.personId};
}
/** Another employment of the SAME person (a resignation and a new hire elsewhere in the group): hired, then pointed at the
 * existing person, as a rehire of the same IC is recorded. */
async function rehire(personId: string, code: string, companyId: string, departmentId: string, hiredOn: string, terminatedOn?: string) {
  const employmentId = (await hireEmployee(ctx, {person: {fullName: 'Fictional rehire ' + code, primaryEmail: `group-tax-rehire-${code}-${randomUUID().slice(0, 6)}@example.test`},
    companyId, departmentId, employmentType: 'full_time', employeeCode: code, hiredOn})).employmentId;
  await owner.db.update(schema.employment).set({personId, ...(terminatedOn ? {terminatedOn} : {})}).where(eq(schema.employment.id, employmentId));
  await setCompensation(ctx, {employmentId, basicSalary: 5000, effectiveFrom: hiredOn});
  return employmentId;
}
async function run(companyId: string, payPeriod: string, as: SessionContext = ctx) {
  const {batchId} = await createBatch(as, {companyId, payPeriod});
  await generatePayslips(as, {batchId});
  return batchId;
}
const slipOf = async (batchId: string, employmentId: string) => {
  const [row] = await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  return row;
};
/** The database's own refusal text (drizzle wraps it as the error's cause). */
const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: {message?: string; cause?: {message?: string}}) => String(e?.cause?.message ?? e?.message));
const pcbOf = async (batchId: string, employmentId: string) => Number((((await slipOf(batchId, employmentId))?.statutory ?? {}) as {pcb?: number}).pcb);
const metaOf = async (batchId: string, employmentId: string) => (((await slipOf(batchId, employmentId))?.statutory ?? {}) as {pcbMeta?: Record<string, unknown>}).pcbMeta;

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'payroll', 'active');
  await setModule(b.tenantId, 'multi_cycle_payroll', 'disabled');
  await setSetting(b.tenantId, 'payroll.reset_enabled', true);
  ctx = await entitledCtx(b);
  await owner.db.update(schema.company).set({companyLabel: 'COA', legalName: 'Fictional Group Berhad'}).where(eq(schema.company.id, b.companyId));
  await owner.db.insert(schema.companyStatutoryMy).values({tenantId: b.tenantId, companyId: b.companyId, lhdnEmployerNo: 'E 1234567-08'})
    .onConflictDoUpdate({target: schema.companyStatutoryMy.companyId, set: {lhdnEmployerNo: 'E 1234567-08'}});
  coB = (await createCompany(ctx, {legalName: 'Fictional Solutions Sdn Bhd', country: 'MY', currency: 'MYR'})).id;
  await owner.db.update(schema.company).set({companyLabel: 'COB'}).where(eq(schema.company.id, coB));
  [{id: deptB}] = await owner.db.insert(schema.department).values({tenantId: b.tenantId, companyId: coB, name: 'Solutions'}).returning({id: schema.department.id});
  await seedPayrollCycleCatalog(ctx, b.companyId);
  await seedPayrollCycleCatalog(ctx, coB);
});
afterEach(() => { delete process.env.PAYROLL_PROCESS_STEP_EMPLOYEES; delete process.env.PAYROLL_PROCESS_CHUNK_BUDGET_MS; });
afterAll(closeAll);

describe('the pure rules', () => {
  it('replaces a TP3 that lists only contributing group companies, holds a mixed one, applies an outside one', () => {
    const group = new Set(['E123456708']);
    expect(groupTp3Outcome([], 0, group)).toBe('apply');
    expect(groupTp3Outcome(['E999'], 0, group)).toBe('apply');
    expect(groupTp3Outcome(['E123456708'], 0, group)).toBe('replaced');
    expect(groupTp3Outcome(['E123456708', 'E999'], 0, group)).toBe('conflict');
    expect(groupTp3Outcome(['E123456708'], 1, group)).toBe('conflict');
  });
  it('reads a malformed stamp as none and folds months as prior slips', () => {
    expect(readGroupTaxOpeningStamp({groupTaxOpening: {version: 2, months: []}})).toBeNull();
    expect(readGroupTaxOpeningStamp({groupTaxOpening: {version: 1, months: [{companyId: 'x', period: '2026-13'}]}})).toBeNull();
    const month = {companyId: 'a', companyName: 'A', period: '2026-01', source: 'imported' as const, slips: 1, y: 5000, epf: 550, pcb: 0, zakat: 0, zakatRebate: 0,
      lp: 0, tp1Lp: 0, exemptionUsed: {PCB_TRA_BUSINESS: 100}, bik: 0, vola: 0, noncashComplete: false, unusable: null};
    expect(groupTaxPriorSlips({employmentId: 'e', months: [month], tp3: 'apply'})[0].statutory).toMatchObject({bases: {pcb: 5000}, epfEmployee: 550, exemptionUsed: {PCB_TRA_BUSINESS: 100}});
    expect(summarizeGroupTaxOpening([month, {...month, period: '2026-02'}])).toEqual([expect.objectContaining({companyName: 'A', periods: ['2026-01', '2026-02'], y: 10000, epf: 1100, exemptionUsed: {PCB_TRA_BUSINESS: 200}})]);
  });
});

describe('a same-employment transfer: A imported January to September, B native from October', () => {
  it('B November PCB equals the single-employer equivalent, discloses the group months and stays per company', async () => {
    const moved = await hire('0007', 'Fictional Chang', '850505055555', b.companyId, b.deptA);
    const control = await hire('0008', 'Fictional Lim', '850606065555', coB, deptB);
    const fresh = await hire('0009', 'Fictional Wong', '850707075555', coB, deptB);
    await importHistory(historyRows('0007', 'COA', months(1, 9)));
    await importHistory(historyRows('0008', 'COB', months(1, 9)));
    await createMovementEvent(ctx, {employmentId: moved.employmentId, kind: 'entityTransfer', effectiveDate: '2026-10-01', companyId: coB, departmentId: deptB});

    const october = await run(coB, '2026-10');
    const november = await run(coB, '2026-11');
    // The single-employer equivalent, month by month: same PCB and the same accumulators the formula was given.
    expect(await pcbOf(october, moved.employmentId)).toBe(await pcbOf(october, control.employmentId));
    expect(await pcbOf(november, moved.employmentId)).toBe(await pcbOf(november, control.employmentId));
    const formulaInputs = (m: Record<string, unknown> | undefined) => Object.fromEntries(['month', 'n', 'ytdNet', 'ytdGross', 'epfClaimed', 'pcbPaid', 'P1']
      .map(key => [key, m?.[key]]));
    expect(formulaInputs(await metaOf(november, moved.employmentId))).toEqual(formulaInputs(await metaOf(november, control.employmentId)));
    // The history matters: without it (the defect) the figure is the B-only one, and that is lower.
    expect(await pcbOf(november, moved.employmentId)).toBeGreaterThan(await pcbOf(november, fresh.employmentId));

    // The payslip records what it was given, totals per company and month, and the explanation discloses it.
    const slip = await slipOf(november, moved.employmentId);
    const stamp = readGroupTaxOpeningStamp(slip.statutory);
    expect(stamp?.months.map(m => [m.companyName, m.period, m.source, m.y, m.epf])).toEqual(months(1, 9).map(m => ['Fictional Group Berhad', `2026-${m}`, 'imported', 5000, 550]));
    expect(stamp?.companies).toEqual([expect.objectContaining({companyId: b.companyId, periods: months(1, 9).map(m => `2026-${m}`), y: 45000, epf: 4950, pcb: 0})]);
    const explained = explainPcb(slip.statutory, null);
    expect(explained).toMatchObject({kind: 'mtd', groupOpening: {tp3Replaced: false, companies: [expect.objectContaining({companyName: 'Fictional Group Berhad'})]}});
    expect(pcbWorksheet(explained, null).sections.map(s => s.heading)).toContain('worksheetGroupHeading');
    expect(readGroupTaxOpeningStamp((await slipOf(november, control.employmentId)).statutory)).toBeNull();

    // No payroll record moved: A's imported months still belong to A, and B's runs hold only B's months (EA stays per company).
    const aSlips = await owner.db.select({period: schema.payrollBatch.payPeriod}).from(schema.payslip).innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
      .where(and(eq(schema.payslip.employmentId, moved.employmentId), eq(schema.payrollBatch.companyId, b.companyId))).orderBy(asc(schema.payrollBatch.payPeriod));
    expect(aSlips.map(r => r.period)).toEqual(months(1, 9).map(m => `2026-${m}`));

    // Recalculate Income Tax Value at B shows the group months read-only, outside the preview hash.
    const preview = await previewTaxBasisRecalculation(ctx, {companyId: coB, year: 2026, upToMonth: 11, employmentIds: [moved.employmentId]});
    expect(preview.employees[0].groupOpening).toMatchObject({tp3: 'apply', missing: [],
      companies: [{companyId: b.companyId, companyName: 'Fictional Group Berhad', periods: months(1, 9).map(m => `2026-${m}`), sources: ['imported'], taxable: 45000, epf: 4950, pcb: 0}]});

    // B's payroll administrator without A rights: the same PCB, and the definer answers only for B's own employments
    // (A's admin question is refused outright). The transferred EMPLOYMENT is B's now, so its own payslips were already
    // readable to B under payslip_rls before this item; the totals-only boundary for another employment is pinned below.
    const bOnly = {...ctx, grants: [{role: 'hr_admin', companyId: coB}]} as SessionContext;
    const totals = await withTenant(bOnly, tx => tx.execute<{company_id: string; period: string; y: string}>(sql`select * from app.payroll_group_tax_opening(${coB}::uuid,'2026-11',array[${moved.employmentId}::uuid])`));
    expect(totals.map(r => [r.company_id, r.period, Number(r.y)])).toEqual(months(1, 9).map(m => [b.companyId, `2026-${m}`, 5000]));
    expect(Object.keys(totals[0]).some(key => /payslip|line|item/i.test(key))).toBe(false);
    await expect(refusal(withTenant(bOnly, tx => tx.execute(sql`select * from app.payroll_group_tax_opening(${b.companyId}::uuid,'2026-11',array[${moved.employmentId}::uuid])`)))).resolves.toMatch(/Payroll administration/);
    const december = await run(coB, '2026-12', bOnly);
    expect(await pcbOf(december, moved.employmentId)).toBe(await pcbOf(december, control.employmentId));

    // SCALE rule 2: the opening read is a bounded number of statements whatever the chunk size (here 1,500 employments).
    let statements = 0;
    const counted = await withTenant(ctx, async tx => {
      const spy = new Proxy(tx, {get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' && (key === 'execute' || key === 'select') ? (...args: unknown[]) => { statements++; return (value as (...a: unknown[]) => unknown).apply(target, args); } : value;
      }});
      return groupTaxOpeningTx(spy, {runCompanyId: coB, payPeriod: '2026-11', employmentIds: [moved.employmentId, ...Array.from({length: 1499}, () => randomUUID())]});
    });
    expect(counted.get(moved.employmentId)?.months).toHaveLength(9);
    expect(statements).toBeLessThanOrEqual(3);

    // Another tenant sees nothing.
    const other = await seedBase();
    await setModule(other.tenantId, 'payroll', 'active');
    const otherCtx = await entitledCtx(other);
    await expect(refusal(withTenant(otherCtx, tx => tx.execute(sql`select * from app.payroll_group_tax_opening(${coB}::uuid,'2026-11',array[${moved.employmentId}::uuid])`)))).resolves.toMatch(/Payroll administration/);
    expect(await withTenant(otherCtx, tx => tx.execute(sql`select * from app.payroll_group_tax_opening(${other.companyId}::uuid,'2026-11',array[${moved.employmentId}::uuid])`))).toHaveLength(0);
  }, 240000);

  it('a TP3 that lists company A is replaced by the group history, not added on top', async () => {
    const moved = await hire('0007', 'Fictional Chang', '850505055555', b.companyId, b.deptA);
    const control = await hire('0008', 'Fictional Lim', '850606065555', coB, deptB);
    await importHistory(historyRows('0007', 'COA', months(1, 9)));
    await importHistory(historyRows('0008', 'COB', months(1, 9)));
    await createMovementEvent(ctx, {employmentId: moved.employmentId, kind: 'entityTransfer', effectiveDate: '2026-10-01', companyId: coB, departmentId: deptB});
    // The figures HR keyed by hand for A's months, as a TP3 naming A by its E-number.
    await owner.db.insert(schema.employeeTp3).values({tenantId: b.tenantId, personId: moved.personId, assessmentYear: 2026, previousEmployers: [{name: 'Fictional Group Berhad', tin: 'E1234567-08'}]});
    await owner.db.update(schema.employeeStatutoryMy).set({tp3Year: 2026, tp3NetRemuneration: '40050', tp3EpfClaimed: '4950', tp3PcbPaid: '0', tp3ZakatPaid: '0'})
      .where(eq(schema.employeeStatutoryMy.personId, moved.personId));
    const october = await run(coB, '2026-10');
    expect(await pcbOf(october, moved.employmentId)).toBe(await pcbOf(october, control.employmentId));
    expect(readGroupTaxOpeningStamp((await slipOf(october, moved.employmentId)).statutory)?.tp3).toBe('replaced');
    expect(((await slipOf(october, moved.employmentId)).statutory as {taxBasisOpeningExemptionUsed?: unknown}).taxBasisOpeningExemptionUsed).toEqual({});
  }, 180000);
});

describe('Recalculate Income Tax Value opens from the same group usage as processing', () => {
  it('A imported January to September, B native October and November: the recalculation of B gives the processed limits, as the single-employer control does', async () => {
    // A travel allowance capped at the annual PCB_TRA_BUSINESS limit, paid RM600 every month all year.
    await seedPayComponentCatalog(ctx);
    await upsertPayComponent(ctx, {label: 'Travel allowance', code: 'TRV', name: 'Travel allowance', kind: 'allowance', includedInEpf: true, includedInSocsoEis: true,
      includedInPcb: true, includedInHrdfBase: false, isNonPayable: false, prorates: false, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TRA_BUSINESS'});
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    ctx = await entitledCtx(b);
    const idOf = async (code: string) => (await listPayComponents(ctx, {includeArchived: true})).find(c => c.code === code)!.id;
    const moved = await hire('0007', 'Fictional Chang', '850505055555', b.companyId, b.deptA);
    const control = await hire('0008', 'Fictional Lim', '850606065555', coB, deptB);
    for (const e of [moved, control]) {
      await setEmploymentPayComponent(ctx, {employmentId: e.employmentId, componentId: await idOf('BASIC'), amount: 5000, effectiveFrom: '2025-01-01'});
      await setEmploymentPayComponent(ctx, {employmentId: e.employmentId, componentId: await idOf('TRV'), amount: 600, effectiveFrom: '2026-10-01'});
    }
    await importHistory(historyRows('0007', 'COA', months(1, 9), [['TRV', '600']]));
    await importHistory(historyRows('0008', 'COB', months(1, 9), [['TRV', '600']]));
    // Each original employer reviews its own imported months (RM0 opening, no TP3): RM5,400 of the RM6,000 limit used.
    for (const [companyId, e] of [[b.companyId, moved], [coB, control]] as const) {
      const p = await previewTaxBasisRecalculation(ctx, {companyId, year: 2026, upToMonth: 9, employmentIds: [e.employmentId]});
      expect(p.employees[0].status).toBe('ready');
      const batch = await confirmTaxBasisRecalculation(ctx, {previewId: p.previewId, previewHash: p.previewHash});
      expect((await getTaxBasisBatch(ctx, batch.id))?.completedCount).toBe(1);
    }
    await createMovementEvent(ctx, {employmentId: moved.employmentId, kind: 'entityTransfer', effectiveDate: '2026-10-01', companyId: coB, departmentId: deptB});
    const october = await run(coB, '2026-10');
    const november = await run(coB, '2026-11');
    const used = async (batchId: string, employmentId: string) => Object.fromEntries(Object.entries((((await slipOf(batchId, employmentId)).statutory) as {exemptionUsed?: Record<string, number>}).exemptionUsed ?? {}).filter(([, v]) => Number(v) !== 0));
    // Processing: the RM600 left goes in October, nothing in November, for both.
    expect(await used(october, moved.employmentId)).toEqual({PCB_TRA_BUSINESS: 600});
    expect(await used(november, moved.employmentId)).toEqual({});
    for (const batchId of [october, november]) {
      expect(await used(batchId, moved.employmentId)).toEqual(await used(batchId, control.employmentId));
      expect(await pcbOf(batchId, moved.employmentId)).toBe(await pcbOf(batchId, control.employmentId));
    }

    // The recalculation of B's year: the same allocation month by month, the same limits, for the moved employee and the control.
    const preview = await previewTaxBasisRecalculation(ctx, {companyId: coB, year: 2026, upToMonth: 11, employmentIds: [moved.employmentId, control.employmentId]});
    const movedRow = preview.employees.find(e => e.id === moved.employmentId)!, controlRow = preview.employees.find(e => e.id === control.employmentId)!;
    expect(movedRow.status).not.toBe('blocked');
    const nonzero = (u: Record<string, number>) => Object.fromEntries(Object.entries(u).filter(([, v]) => Number(v) !== 0));
    const byPeriod = (row: typeof movedRow, period: string) => nonzero(row.months.find(m => m.period === period)!.basis.exemptionUsed);
    for (const [period, batchId] of [['2026-10', october], ['2026-11', november]] as const) {
      expect(byPeriod(movedRow, period)).toEqual(await used(batchId, moved.employmentId));
      expect(byPeriod(movedRow, period)).toEqual(byPeriod(controlRow, period));
    }
    expect(movedRow.exemptionLedger).toEqual([expect.objectContaining({code: 'PCB_TRA_BUSINESS', openingUsed: 5400, usedAfter: 6000, remaining: 0})]);
    expect(controlRow.exemptionLedger).toEqual([expect.objectContaining({code: 'PCB_TRA_BUSINESS', openingUsed: 0, usedAfter: 6000, remaining: 0})]);
    expect(movedRow.groupOpening?.limits).toEqual([{code: 'PCB_TRA_BUSINESS', cap: 6000, used: 5400, remaining: 600}]);
  }, 300000);
});

describe('a transfer in the middle of a month', () => {
  it('counts the outgoing company\'s part of the month at the incoming company, and never the other way round', async () => {
    const moved = await hire('0007', 'Fictional Chang', '850505055555', b.companyId, b.deptA);
    await createMovementEvent(ctx, {employmentId: moved.employmentId, kind: 'entityTransfer', effectiveDate: '2026-10-16', companyId: coB, departmentId: deptB});
    const outgoing = await run(b.companyId, '2026-10');
    const incoming = await run(coB, '2026-10');
    expect(readGroupTaxOpeningStamp((await slipOf(outgoing, moved.employmentId)).statutory)).toBeNull();
    const stamp = readGroupTaxOpeningStamp((await slipOf(incoming, moved.employmentId)).statutory);
    expect(stamp?.months.map(m => [m.companyId, m.period, m.source])).toEqual([[b.companyId, '2026-10', 'processed']]);
    // Reprocessing the outgoing part afterwards still does not take the incoming part as earlier history.
    await generatePayslips(ctx, {batchId: outgoing, reprocessSubset: {employmentIds: [moved.employmentId]}});
    expect(readGroupTaxOpeningStamp((await slipOf(outgoing, moved.employmentId)).statutory)).toBeNull();
  }, 180000);
});

describe('new employments for the same person across three companies', () => {
  it('counts each earlier employment that ended before this one began, and keeps two concurrent jobs separate', async () => {
    const coC = (await createCompany(ctx, {legalName: 'Fictional Logistics Sdn Bhd', country: 'MY', currency: 'MYR'})).id;
    const [{id: deptC}] = await owner.db.insert(schema.department).values({tenantId: b.tenantId, companyId: coC, name: 'Logistics'}).returning({id: schema.department.id});
    await seedPayrollCycleCatalog(ctx, coC);
    // A: January to March, imported, then resigned. C: April to June, processed. B: from July.
    const first = await hire('0007', 'Fictional Chang', '850505055555', b.companyId, b.deptA, '2025-01-01', '2026-03-31');
    await importHistory(historyRows('0007', 'COA', months(1, 3)));
    const second = await rehire(first.personId, '0107', coC, deptC, '2026-04-01', '2026-06-30');
    for (const m of months(4, 6)) await run(coC, `2026-${m}`);
    const third = await rehire(first.personId, '0207', coB, deptB, '2026-07-01');
    // The single-employer equivalent at B: January to March imported, April to July processed, all at B.
    const control = await hire('0008', 'Fictional Lim', '850606065555', coB, deptB);
    await importHistory(historyRows('0008', 'COB', months(1, 3)));
    for (const m of months(4, 6)) {
      const {batchId} = await createBatch(ctx, {companyId: coB, payPeriod: `2026-${m}`});
      await generatePayslips(ctx, {batchId});
    }
    const july = await run(coB, '2026-07');
    expect(await pcbOf(july, third)).toBe(await pcbOf(july, control.employmentId));
    expect(readGroupTaxOpeningStamp((await slipOf(july, third)).statutory)?.companies.map(c => [c.companyName, c.periods.length])).toEqual([['Fictional Group Berhad', 3], ['Fictional Logistics Sdn Bhd', 3]]);
    expect(second).not.toBe(third);
    // B's payroll administrator without A or C rights cannot read the earlier employments' payslips, yet B's run is given
    // their totals per company and month, and nothing that names a payslip, a line or an item.
    const bOnly = {...ctx, grants: [{role: 'hr_admin', companyId: coB}]} as SessionContext;
    expect(await withTenant(bOnly, tx => tx.select({id: schema.payslip.id}).from(schema.payslip).where(inArray(schema.payslip.employmentId, [first.employmentId, second])))).toEqual([]);
    const totals = await withTenant(bOnly, tx => tx.execute<Record<string, unknown>>(sql`select * from app.payroll_group_tax_opening(${coB}::uuid,'2026-07',array[${third}::uuid])`));
    expect(totals.map(r => [r.company_id, r.period])).toEqual([...months(1, 3).map(m => [b.companyId, `2026-${m}`]), ...months(4, 6).map(m => [coC, `2026-${m}`])]);
    expect(Object.keys(totals[0]).some(key => /payslip|line|item/i.test(key))).toBe(false);

    // Two jobs at once: an employment at A that is still active contributes nothing to B.
    const twoJobs = await hire('0300', 'Fictional Siti', '850808085555', b.companyId, b.deptA);
    await importHistory(historyRows('0300', 'COA', months(1, 7)));
    const secondJob = await rehire(twoJobs.personId, '0301', coB, deptB, '2026-07-01');
    const alone = await hire('0302', 'Fictional Ravi', '850909095555', coB, deptB, '2026-07-01');
    const august = await run(coB, '2026-08');
    expect(readGroupTaxOpeningStamp((await slipOf(august, secondJob)).statutory)).toBeNull();
    expect(await pcbOf(august, secondJob)).toBe(await pcbOf(august, alone.employmentId));
  }, 300000);
});

describe('a contributing month without a usable tax basis', () => {
  const tick = () => runBulkJobTick(owner.client, {handlers: [payrollProcessJobHandler]});
  async function runJob(id: string, max = 400) {
    for (let i = 0; i < max; i++) {
      const [row] = await owner.client<{state: string; notified: boolean; result: unknown}[]>`select state,notified_at is not null as notified,result from bulk_job where id=${id}::uuid`;
      if (['completed', 'failed', 'cancelled'].includes(row.state) && row.notified) return row;
      if (!await tick()) await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('payroll processing job did not finish');
  }
  it('holds the B employee with the A month named, and never falls back to gross or zero', async () => {
    process.env.PAYROLL_PROCESS_STEP_EMPLOYEES = '1'; process.env.PAYROLL_PROCESS_CHUNK_BUDGET_MS = '1';
    // A capped travel allowance in A's imported months needs the previous-employer opening reviewed before use.
    await owner.db.insert(schema.payComponent).values({tenantId: b.tenantId, code: 'TRV', name: 'Travel allowance', kind: 'allowance', displayCategory: 'allowance',
      includedInPcb: true, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TRA_BUSINESS'});
    const moved = await hire('0007', 'Fictional Chang', '850505055555', b.companyId, b.deptA);
    const stayed = await hire('0008', 'Fictional Lim', '850606065555', coB, deptB);
    await importHistory(historyRows('0007', 'COA', months(1, 9), [['TRV', '500']]));
    await createMovementEvent(ctx, {employmentId: moved.employmentId, kind: 'entityTransfer', effectiveDate: '2026-10-01', companyId: coB, departmentId: deptB});
    const {batchId} = await createBatch(ctx, {companyId: coB, payPeriod: '2026-10'});
    const {jobId} = await requestPayrollProcessing(ctx, {batchId});
    const job = await runJob(jobId);
    expect(job.state).toBe('completed');
    expect((await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).map(s => s.employmentId)).toEqual([stayed.employmentId]);
    const [processed] = await owner.db.select({payload: schema.domainEvent.payload}).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, batchId), eq(schema.domainEvent.eventType, 'payroll-batch.processed')));
    expect(processed.payload).toMatchObject({taxHeld: [{employmentId: moved.employmentId, period: '2026-01'}]});
    expect(String((processed.payload as {taxHeld: {reason: string}[]}).taxHeld[0].reason)).toMatch(/Fictional Group Berhad for 2026-01 requires review/);
    // Outside a processing chunk the same history refuses the calculation rather than guessing.
    const direct = await createBatch(ctx, {companyId: coB, payPeriod: '2026-11'});
    await expect(generatePayslips(ctx, {batchId: direct.batchId})).rejects.toThrow(/Fictional Group Berhad for 2026-01 requires review/);
  }, 240000);
});
