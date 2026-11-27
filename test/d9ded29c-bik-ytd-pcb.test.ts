/**
 * Board d9ded29c — taxable BIK/VOLA from imported payroll history, from months saved through Recalculate Income Tax Value,
 * and from another group company's months reaches year-to-date PCB income (Y) exactly once. Real PostgreSQL, real row
 * security, real imports and payroll runs, fictional people and amounts.
 *
 * THE EXPECTED PCB FIGURES ARE WORKED OUT BY HAND (LHDN 2026 computerised method, docs/forms/pcb-spec-2026-*), never by the
 * code under test. Common facts: resident, category 1, no children, no TP1/zakat/TP3, EPF Part A (born 1985). February
 * 2026: n = 12 − 2 = 10, n + 1 = 11. February's own pay: BASIC 5,000.00 → Y1 = Y2 = 5,000.00, K1 = 11 % × 5,000 = 550.00.
 * D = 9,000.00. Table 1: 35,001–50,000 → M 35,000, R 6 %, B 600; 50,001–70,000 → M 50,000, R 11 %, B 1,500.
 * MTD = [(P − M) × R + B − (Z + X)] / (n + 1), truncated to two decimals, then rounded up to the next 5 sen.
 */
import {and, eq, sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {withTenant, type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {createCompany} from '../core/admin';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createMovementEvent} from '../core/movement';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch, generatePayslips} from '../core/payroll';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {previewPayrollHistoryUpload, confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {confirmTaxBasisRecalculation, previewTaxBasisRecalculation} from '../core/payroll-tax-basis';
import {readEffectiveTaxBasesTx} from '../core/payroll-tax-basis-read';
import {setEmploymentPayComponent, upsertPayComponent} from '../core/pay-components';
import {explainPcb, pcbAccumulatedRemunerationSection} from '../core/pcb-explain';
import {noncashBaseGapRowsTx} from '../core/payroll-noncash-base-report';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll, entitledCtx, owner, resetDb, seedBase, setModule, setSetting, type Base} from './harness';

vi.hoisted(() => {
  vi.stubEnv('AIHR_DB_PROCESS_ROLE', 'worker');
  vi.stubEnv('AIHR_DB_POOL_MAX', '2');
});

let b: Base, ctx: SessionContext, coB: string, deptB: string, travel: string;
const january = (employeeNo: string, company: string, lines: [string, string][]) =>
  lines.map(([code, amount]) => [employeeNo, '2026-01', 'ME', code, company, amount]);
const statutoryZero: [string, string][] = [['EESOCSO', '0'], ['EEEIS', '0'], ['PCB', '0']];
async function importHistory(rows: string[][]) {
  const draft = await previewPayrollHistoryUpload(ctx, {name: 'fictional-history.csv', operationKey: randomUUID(),
    content: Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS), ...rows]))});
  expect(draft.plan.issues).toEqual([]);
  expect(draft.plan.counts.invalid).toBe(0);
  await confirmPayrollHistoryUpload(ctx, {attemptId: draft.attemptId, previewHash: draft.plan.previewHash, confirmReplacement: true});
}
async function hire(code: string, ic: string, companyId = b.companyId, departmentId = b.deptA) {
  const employmentId = (await hireEmployee(ctx, {person: {fullName: `Fictional ${code}`, primaryEmail: `bik-ytd-${code}-${randomUUID().slice(0, 6)}@example.test`}, companyId,
    departmentId, employmentType: 'full_time', employeeCode: code, hiredOn: '2025-01-01'})).employmentId;
  const [subject] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
  await setCompensation(ctx, {employmentId, basicSalary: 5000, effectiveFrom: '2025-01-01'});
  await setStatutoryProfileMY(ctx, {personId: subject.personId, icNumber: ic, taxCategory: 1, numChildren: 0});
  return employmentId;
}
async function run(companyId: string, payPeriod: string) {
  const {batchId} = await createBatch(ctx, {companyId, payPeriod});
  await generatePayslips(ctx, {batchId});
  return batchId;
}
const slipOf = async (batchId: string, employmentId: string) => {
  const [row] = await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  expect(row).toBeDefined();
  return row;
};
type Stat = {pcb: number; bases: {pcb: number}; pcbMeta: {ytdGross: number; ytdNet: number; epfClaimed: number; pcbPaid: number; P1: number};
  pcbNonCash: {accumulated: {bik: number; vola: number; complete: boolean}}};
const stat = async (batchId: string, employmentId: string) => (await slipOf(batchId, employmentId)).statutory as unknown as Stat;
const januarySlip = async (employmentId: string) => {
  const rows = await withTenant(ctx, tx => tx.execute<{id: string}>(sql`select p.id from payslip p join payroll_batch b on b.id=p.batch_id where p.employment_id=${employmentId}::uuid and b.pay_period='2026-01'`));
  expect(rows).toHaveLength(1);
  return rows[0].id;
};
const savedBytes = async (id: string) => (await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id, id)))[0];

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'payroll', 'active');
  await setModule(b.tenantId, 'multi_cycle_payroll', 'disabled');
  await setModule(b.tenantId, 'typed_pay_components', 'active');
  await setSetting(b.tenantId, 'payroll.reset_enabled', true);
  ctx = await entitledCtx(b);
  await owner.db.update(schema.company).set({companyLabel: 'COA', legalName: 'Fictional Group Berhad'}).where(eq(schema.company.id, b.companyId));
  coB = (await createCompany(ctx, {legalName: 'Fictional Solutions Sdn Bhd', country: 'MY', currency: 'MYR'})).id;
  await owner.db.update(schema.company).set({companyLabel: 'COB'}).where(eq(schema.company.id, coB));
  [{id: deptB}] = await owner.db.insert(schema.department).values({tenantId: b.tenantId, companyId: coB, name: 'Solutions'}).returning({id: schema.department.id});
  await seedPayrollCycleCatalog(ctx, b.companyId);
  await seedPayrollCycleCatalog(ctx, coB);
  const [trv] = await owner.db.insert(schema.payComponent).values({tenantId: b.tenantId, code: 'TRV', name: 'Travel allowance', kind: 'allowance',
    displayCategory: 'allowance', includedInPcb: false, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE'}).returning({id: schema.payComponent.id});
  travel = trv.id;
  await owner.db.insert(schema.payComponent).values({tenantId: b.tenantId, code: 'BKCAR', name: 'Fictional benefit-in-kind car', kind: 'allowance',
    displayCategory: 'bik', eaFormLine: 'EA_B3', isNonPayable: true, includedInPcb: true, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE'});
});
afterAll(closeAll);

describe('imported history', () => {
  it('a January BKCAR 3,000.00 reaches February\'s Y once; February PCB 136.40; the report lists it; no saved byte changes', async () => {
    const aina = await hire('0007', '850202025555');
    await importHistory(january('0007', 'COA', [['BASIC', '5000.00'], ['BKCAR', '3000.00'], ['EEEPF', '0'], ...statutoryZero]));
    const jan = await januarySlip(aina);
    const before = await savedBytes(jan);
    // The saved January keeps cash only in its import projection and base (the stored contract); the effective read adds
    // the 3,000.00 benefit: 5,000.00 + 3,000.00 = 8,000.00.
    expect((before.statutory as {bases: {pcb: number}}).bases.pcb).toBe(5000);
    const effective = (await withTenant(ctx, tx => readEffectiveTaxBasesTx(tx, ctx, [jan], {includeImported: true}))).get(jan)!;
    expect(effective.basis.pcb).toBe(5000);
    expect((effective.statutory.bases as {pcb: number}).pcb).toBe(8000);

    const february = await run(b.companyId, '2026-02');
    const feb = await stat(february, aina);
    // By hand: Y = 8,000.00 (cash 5,000.00 + BKCAR 3,000.00), K = 0 (January EPF 0), X = 0, Σ(Y−K) = 8,000.00.
    // K2 = [4,000 − (0 + 550 + 0)] / 10 = 345.00 (< K1 550.00).
    // P = 8,000 + (5,000 − 550) + (5,000 − 345) × 10 − 9,000 = 8,000 + 4,450 + 46,550 − 9,000 = 50,000.00.
    // Tax = (50,000 − 35,000) × 6 % + 600 = 1,500.00. MTD = 1,500.00 / 11 = 136.3636… → 136.36 → 136.40.
    expect(feb.pcbMeta.ytdGross).toBe(8000);
    expect(feb.pcbMeta.ytdNet).toBe(8000);
    expect(feb.pcbMeta.P1).toBe(50000);
    expect(feb.pcb).toBe(136.4);
    expect(feb.pcbNonCash.accumulated).toEqual({bik: 3000, vola: 0, complete: true});
    // PCB / MTD Calculation Detail: accumulated BIK shows the amount, not "Not recorded".
    const explained = explainPcb(feb as unknown as Record<string, unknown>, null);
    expect(explained.kind).toBe('mtd');
    if (explained.kind !== 'mtd') throw new Error('Expected a resident MTD explanation');
    const accumulated = pcbAccumulatedRemunerationSection(explained, null).rows;
    expect(accumulated.find(r => r.caption === 'slipAccBik')?.first).toEqual({kind: 'money', amount: 3000});
    expect(accumulated.find(r => r.caption === 'slipAccVola')?.first).toEqual({kind: 'money', amount: 0});
    // Nothing saved was rewritten.
    expect(await savedBytes(jan)).toEqual(before);

    // The pre-release report, read only: Aina's January, 3,000.00 of BIK, with a later processed payroll.
    const rows = await owner.client.begin('isolation level repeatable read read only', tx => noncashBaseGapRowsTx(tx, b.tenantId, 2026));
    expect(rows).toEqual([{tenantId: b.tenantId, companyId: b.companyId, companyName: 'Fictional Group Berhad', employmentId: aina, employeeCode: '0007',
      period: '2026-01', source: 'imported', bik: 3000, vola: 0, laterPayroll: true}]);
    await expect(owner.client.begin(tx => noncashBaseGapRowsTx(tx, b.tenantId, 2026))).rejects.toThrow(/READ ONLY/);
  }, 180000);

  it('an imported month without benefits counts as a complete zero; February PCB 120.00', async () => {
    const badrul = await hire('0008', '850303035555');
    await importHistory(january('0008', 'COA', [['BASIC', '5000.00'], ['EEEPF', '0'], ...statutoryZero]));
    const feb = await stat(await run(b.companyId, '2026-02'), badrul);
    // By hand: Y = 5,000.00, P = 5,000 + 4,450 + 46,550 − 9,000 = 47,000.00; tax = 12,000 × 6 % + 600 = 1,320.00;
    // MTD = 1,320.00 / 11 = 120.00.
    expect(feb.pcbMeta.ytdGross).toBe(5000);
    expect(feb.pcb).toBe(120);
    expect(feb.pcbNonCash.accumulated).toEqual({bik: 0, vola: 0, complete: true});
  }, 180000);
});

describe('a month saved through Recalculate Income Tax Value (stored cash-only, version 1)', () => {
  it('previews January as 8,500.00 including 3,000.00 of benefits, saves the revision unchanged in meaning, and February counts the benefit', async () => {
    const aina = await hire('0007', '850202025555');
    await importHistory(january('0007', 'COA', [['BASIC', '5000.00'], ['TRV', '500.00'], ['BKCAR', '3000.00'], ['EEEPF', '0'], ...statutoryZero]));
    await owner.db.update(schema.payComponent).set({includedInPcb: true}).where(eq(schema.payComponent.id, travel));
    const preview = await previewTaxBasisRecalculation(ctx, {companyId: b.companyId, year: 2026, upToMonth: 1, employmentIds: [aina]});
    const [who] = preview.employees;
    // By hand: before = imported cash 5,000.00 + BKCAR 3,000.00 = 8,000.00; after = 5,000.00 + TRV 500.00 + 3,000.00 = 8,500.00.
    expect(who.status).toBe('ready');
    expect(who.months.map(m => [m.beforeTaxable, m.taxable, m.difference, m.beforeBenefits, m.benefits, m.ytdTaxable, m.ytdBenefits]))
      .toEqual([[8000, 8500, 500, 3000, 3000, 8500, 3000]]);
    expect([who.beforeTaxable, who.taxable, who.difference, who.beforeBenefits, who.benefits]).toEqual([8000, 8500, 500, 3000, 3000]);
    expect(who.months[0].items.find(i => i.code === 'BKCAR')).toMatchObject({amount: 3000, taxable: 3000, exempt: 0});
    await confirmTaxBasisRecalculation(ctx, {previewId: preview.previewId, previewHash: preview.previewHash});
    const [revision] = await owner.db.select().from(schema.payrollTaxBasisRevision);
    expect(revision.basis.version).toBe(1);
    expect(revision.basis.pcb).toBe(5500);

    const feb = await stat(await run(b.companyId, '2026-02'), aina);
    // By hand: Y = 8,500.00, K = 0, X = 0. P = 8,500 + 4,450 + 46,550 − 9,000 = 50,500.00.
    // Tax = (50,500 − 50,000) × 11 % + 1,500 = 1,555.00. MTD = 1,555.00 / 11 = 141.3636… → 141.36 → 141.40.
    expect(feb.pcbMeta.ytdGross).toBe(8500);
    expect(feb.pcbMeta.P1).toBe(50500);
    expect(feb.pcb).toBe(141.4);
    expect(feb.pcbNonCash.accumulated).toEqual({bik: 3000, vola: 0, complete: true});
    // A repeat preview after the save is unchanged: the representation never flips an employee to "ready".
    const again = await previewTaxBasisRecalculation(ctx, {companyId: b.companyId, year: 2026, upToMonth: 1, employmentIds: [aina]});
    expect(again.employees[0].status).toBe('unchanged');
    expect(again.employees[0].months.map(m => [m.beforeTaxable, m.taxable, m.difference])).toEqual([[8500, 8500, 0]]);
  }, 240000);
});

describe('a native month with a benefit', () => {
  it('is unchanged: January base 5,600.00, February Y 5,600.00, and the preview shows no negative difference', async () => {
    const chen = await hire('0009', '850404045555');
    const drv = await upsertPayComponent(ctx, {label: 'BKDRV', code: 'BKDRV', name: 'Fictional benefit-in-kind driver', kind: 'non_payable', isNonPayable: true, prorates: false,
      includedInPcb: true, includedInEpf: false, includedInSocsoEis: false, includedInHrdfBase: false, displayCategory: 'bik', eaFormLine: 'EA_B3',
      pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE', epfBonus2012: false});
    await setEmploymentPayComponent(ctx, {employmentId: chen, componentId: drv.id, amount: 600, effectiveFrom: '2026-01-01'});
    const jan = await stat(await run(b.companyId, '2026-01'), chen);
    expect(jan.bases.pcb).toBe(5600); // 5,000.00 + 600.00, stamped by live payroll as before
    const feb = await stat(await run(b.companyId, '2026-02'), chen);
    expect(feb.pcbMeta.ytdGross).toBe(5600); // January's own benefit, once
    expect(feb.pcbMeta.ytdNet).toBe(5050); // 5,600.00 − January EPF 550.00
    const preview = await previewTaxBasisRecalculation(ctx, {companyId: b.companyId, year: 2026, upToMonth: 1, employmentIds: [chen]});
    const month = preview.employees[0].months[0];
    expect([month.beforeTaxable, month.taxable, month.difference, month.beforeBenefits, month.benefits]).toEqual([5600, 5600, 0, 600, 600]);
  }, 180000);
});

describe('a group company\'s imported month', () => {
  it('A\'s January BKCAR 3,000.00 reaches Y at B after an Entity Transfer; February PCB at B 136.40', async () => {
    const moved = await hire('0010', '850505055555');
    await importHistory(january('0010', 'COA', [['BASIC', '5000.00'], ['BKCAR', '3000.00'], ['EEEPF', '550'], ...statutoryZero]));
    await createMovementEvent(ctx, {employmentId: moved, kind: 'entityTransfer', effectiveDate: '2026-02-01', companyId: coB, departmentId: deptB});
    const feb = await stat(await run(coB, '2026-02'), moved);
    // By hand: group Y = 5,000.00 + 3,000.00 = 8,000.00; K = 550.00 (A's January EPF); Σ(Y−K) = 7,450.00; X = 0.
    // K2 = [4,000 − (550 + 550)] / 10 = 290.00. P = 7,450 + 4,450 + (5,000 − 290) × 10 − 9,000 = 50,000.00.
    // Tax = 15,000 × 6 % + 600 = 1,500.00. MTD = 1,500.00 / 11 → 136.36 → 136.40.
    expect(feb.pcbMeta.ytdGross).toBe(8000);
    expect(feb.pcbMeta.ytdNet).toBe(7450);
    expect(feb.pcb).toBe(136.4);
    expect(feb.pcbNonCash.accumulated).toEqual({bik: 3000, vola: 0, complete: true});
  }, 180000);
});
