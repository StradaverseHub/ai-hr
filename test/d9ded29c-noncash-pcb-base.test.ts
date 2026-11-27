/**
 * Board d9ded29c — taxable BIK/VOLA in a SAVED historical tax basis (an accepted payroll-history import or an Income Tax
 * Correction from Recalculate Income Tax Value) is part of the PCB base later payroll folds into year-to-date Y.
 *
 * Pure: the country pack's replay produces the saved basis exactly as the import and the recalculation save it (version 1,
 * `pcb` = cash normal + additional, benefits in `pcbNonCash`); the read-time PCB base and the prior-month fold are then
 * asserted against figures worked out by hand below, never recomputed through the code under test.
 */
import {describe, expect, it} from 'vitest';
import {replayMyTaxBasis, boundMyTaxBasis, type TaxBasisItemSetting, type TaxBasisReplayInput, type TaxBasisSourceSlip} from '../localization/my/tax-basis-replay';
import {foldPriorSlipIntoAccumulators, type PcbAccumulators} from '../localization/my/payroll';
import {DEFAULT_MY_STATUTORY} from '../localization/my/statutory-tables';
import {ownedTaxableNonCash, pcbBaseWithNonCash, readPcbNonCash} from '../localization/noncash-benefits';
import {effectiveTaxBasisPcb} from '../core/payroll-tax-basis-read';
import {formatNoncashBaseGapReport, summarizeNoncashBaseGaps, type NoncashBaseGapRow} from '../core/payroll-noncash-base-report';

const basic: TaxBasisItemSetting = {id: 'basic', code: 'BASIC', name: 'Basic salary', kind: 'earning', includedInPcb: true, pcbRemunerationType: 'normal', pcbExemptionCode: null, isNonPayable: false, epfBonus2012: false};
const benefit = (id: string, code: string, exemption: string, stream: 'normal' | 'additional' = 'normal', kind: 'bik' | 'vola' = 'bik'): TaxBasisItemSetting => ({
  id, code, name: `Fictional ${code}`, kind: 'allowance', includedInPcb: true, pcbRemunerationType: stream, pcbExemptionCode: exemption,
  isNonPayable: true, epfBonus2012: false, displayCategory: kind, eaFormLine: kind === 'bik' ? 'EA_B3' : 'EA_B4'});
const BKCAR = benefit('bkcar', 'BKCAR', 'PCB_TAXABLE'), BKDRV = benefit('bkdrv', 'BKDRV', 'PCB_TAXABLE');
// PCB_PERQUISITE: annual exemption limit RM2,000 (MY_PCB_EXEMPTION_CODES).
const PERK = benefit('perk', 'PERK', 'PCB_PERQUISITE');
const VOLA = benefit('vola', 'HOUSE', 'PCB_TAXABLE', 'normal', 'vola');
const BKBOP = benefit('bkbop', 'BKBOP', 'PCB_TAXABLE', 'additional');
const rules = (periods: string[]) => Object.fromEntries(periods.map(period => [period, {rules: DEFAULT_MY_STATUTORY, hash: `verified-${period}`}]));
type Line = TaxBasisSourceSlip['sourceLines'][number];
const cash = (code: string, amount: number): Line => ({code, amount, direction: 'earning'});
const nc = (setting: TaxBasisItemSetting, amount: number, rowNum: number): Line => ({code: setting.code, amount, direction: 'noncash', settingId: setting.id, rowNum});
function imported(id: string, period: string, lines: Line[], runOrder = 1): TaxBasisSourceSlip {
  return {id, period, runOrder, sourceKind: 'import', sourceLines: lines, statutory: {pcb: 0, epfEmployee: 0, lp: 0, zakat: 0},
    expectedGross: lines.filter(l => l.direction === 'earning').reduce((n, l) => Math.round((n + l.amount) * 100) / 100, 0), expectedOtherDeductions: 0};
}
function replay(slips: TaxBasisSourceSlip[], settings: TaxBasisItemSetting[], upToMonth = 12): TaxBasisReplayInput {
  return {year: 2026, upToMonth, slips, settings: [basic, ...settings], rulesByPeriod: rules([...new Set(slips.map(s => s.period))]), openingExemptionUsed: {}};
}
const zero = (): PcbAccumulators => ({netRemuneration: 0, epfClaimed: 0, pcbPaid: 0, grossRemuneration: 0});
/** The prior month as later payroll reads it: the effective statutory overlay the canonical reader returns. */
const asRead = (basis: {pcb: number; pcbNonCash?: unknown}, epfEmployee = 0) =>
  ({bases: {pcb: effectiveTaxBasisPcb(basis)}, epfEmployee, pcb: 0, ...(basis.pcbNonCash ? {pcbNonCash: basis.pcbNonCash} : {})});

describe('the reporter\'s January: imported BASIC 90,000.00, BKCAR 2,083.33 and BKDRV 600.00, both PCB_TAXABLE', () => {
  const [row] = replayMyTaxBasis(replay([imported('jan', '2026-01', [cash('BASIC', 90000), nc(BKCAR, 2083.33, 2), nc(BKDRV, 600, 3)])], [BKCAR, BKDRV], 1));
  it('keeps the saved basis as cash only (version 1, the stored contract) with the benefits owned beside it', () => {
    expect(row.basis.version).toBe(1);
    expect(row.basis.pcb).toBe(90000);
    expect(row.basis.items.find(i => i.code === 'BKCAR')).toMatchObject({amount: 2083.33, taxable: 2083.33, exempt: 0});
    expect(row.basis.items.find(i => i.code === 'BKDRV')).toMatchObject({amount: 600, taxable: 600, exempt: 0});
  });
  it('reads it as a PCB base of 92,683.33 and folds 92,683.33 into Y (90,000.00 + 2,083.33 + 600.00)', () => {
    // By hand: cash 90,000.00; taxable benefits 2,083.33 + 600.00 = 2,683.33; base 92,683.33. One run owns the month, so
    // cumulative = owned and Y = base − (cumulative − owned) = 92,683.33.
    expect(pcbBaseWithNonCash(row.basis.pcb, row.basis.pcbNonCash)).toBe(92683.33);
    expect(effectiveTaxBasisPcb(row.basis)).toBe(92683.33);
    expect(ownedTaxableNonCash(row.basis.pcbNonCash)).toBe(2683.33);
    const acc = zero();
    foldPriorSlipIntoAccumulators(acc, {gross: 90000, statutory: asRead(row.basis)}, 4000);
    expect(acc.grossRemuneration).toBe(92683.33);
    expect(acc.netRemuneration).toBe(92683.33);
    // The defect, for contrast: the saved cash base read as the whole base loses exactly the 2,683.33 of benefits.
    const before = zero();
    foldPriorSlipIntoAccumulators(before, {gross: 90000, statutory: {bases: {pcb: row.basis.pcb}, pcbNonCash: row.basis.pcbNonCash, pcb: 0}}, 4000);
    expect(before.grossRemuneration).toBe(90000);
  });
  it('ten such months add 26,833.30 of benefits to Y, each counted once', () => {
    const slips = Array.from({length: 10}, (_, i) => imported(`m${i + 1}`, `2026-${String(i + 1).padStart(2, '0')}`, [cash('BASIC', 90000), nc(BKCAR, 2083.33, 2), nc(BKDRV, 600, 3)]));
    const acc = zero();
    for (const r of replayMyTaxBasis(replay(slips, [BKCAR, BKDRV], 10))) foldPriorSlipIntoAccumulators(acc, {gross: 90000, statutory: asRead(r.basis)}, 4000);
    // By hand: 10 × 90,000.00 = 900,000.00 cash; 10 × 2,683.33 = 26,833.30 benefits; Y = 926,833.30.
    expect(acc.grossRemuneration).toBe(926833.3);
  });
});

describe('exempt parts and annual exemption limits', () => {
  it('counts only the taxable part of a capped benefit, across the annual RM2,000 PCB_PERQUISITE limit', () => {
    // By hand, PERK 1,500.00 a month against RM2,000 a year: Jan exempt 1,500 taxable 0; Feb exempt 500 taxable 1,000;
    // Mar exempt 0 taxable 1,500. With BASIC 5,000.00 the bases are 5,000.00, 6,000.00 and 6,500.00 (Y 17,500.00).
    const slips = ['01', '02', '03'].map(m => imported(`p${m}`, `2026-${m}`, [cash('BASIC', 5000), nc(PERK, 1500, 2)]));
    const rows = replayMyTaxBasis(replay(slips, [PERK], 3));
    expect(rows.map(r => r.basis.items.find(i => i.code === 'PERK')).map(i => [i!.exempt, i!.taxable])).toEqual([[1500, 0], [500, 1000], [0, 1500]]);
    expect(rows.map(r => effectiveTaxBasisPcb(r.basis))).toEqual([5000, 6000, 6500]);
    const acc = zero();
    for (const r of rows) foldPriorSlipIntoAccumulators(acc, {gross: 6500, statutory: asRead(r.basis)}, 4000);
    expect(acc.grossRemuneration).toBe(17500);
  });
  it('a fully exempt or not-subject benefit adds nothing', () => {
    const notSubject = {...BKCAR, id: 'free', code: 'FREE', includedInPcb: false, pcbExemptionCode: null};
    const [row] = replayMyTaxBasis(replay([imported('x', '2026-01', [cash('BASIC', 5000), nc(notSubject, 800, 2)])], [notSubject], 1));
    expect(effectiveTaxBasisPcb(row.basis)).toBe(5000);
    expect(ownedTaxableNonCash(row.basis.pcbNonCash)).toBe(0);
  });
  it('VOLA is counted like BIK', () => {
    const [row] = replayMyTaxBasis(replay([imported('h', '2026-01', [cash('BASIC', 5000), nc(VOLA, 1200, 2)])], [VOLA], 1));
    expect(effectiveTaxBasisPcb(row.basis)).toBe(6200); // 5,000.00 + 1,200.00
  });
});

describe('streams, cycles and saved shapes', () => {
  it('an Additional-stream benefit is in the base (it is Yt in the month, and Y for later months)', () => {
    const [row] = replayMyTaxBasis(replay([imported('b', '2026-07', [cash('BASIC', 9000), nc(BKBOP, 4111, 2)])], [BKBOP], 7));
    expect([row.basis.normal, row.basis.additional, row.basis.pcb]).toEqual([9000, 0, 9000]);
    expect(readPcbNonCash(row.basis.pcbNonCash)?.version).toBe(2);
    expect(effectiveTaxBasisPcb(row.basis)).toBe(13111); // 9,000.00 + 4,111.00
  });
  it('two imported cycles of one month: each benefit enters Y once, under the cycle that owns it', () => {
    // By hand: cycle 1 BASIC 5,000.00 + BIK 300.00; cycle 2 BASIC 1,000.00 + BIK 200.00. Cycle 2's cumulative is 500.00 but
    // it owns 200.00, so the fold takes 1,000.00 + 200.00. Y for the month = 5,300.00 + 1,200.00 = 6,500.00.
    const rows = replayMyTaxBasis(replay([imported('c1', '2026-01', [cash('BASIC', 5000), nc(BKCAR, 300, 2)], 1),
      imported('c2', '2026-01', [cash('BASIC', 1000), nc(BKCAR, 200, 3)], 2)], [BKCAR], 1));
    expect(rows.map(r => effectiveTaxBasisPcb(r.basis))).toEqual([5300, 1500]);
    const acc = zero();
    for (const r of rows) foldPriorSlipIntoAccumulators(acc, {gross: 0, statutory: asRead(r.basis)}, 4000);
    expect(acc.grossRemuneration).toBe(6500);
  });
  it('a basis without benefits, and a native-shaped stamp, are unchanged', () => {
    expect(pcbBaseWithNonCash(5000, undefined)).toBe(5000);
    expect(ownedTaxableNonCash(undefined)).toBe(0);
    expect(effectiveTaxBasisPcb({pcb: 5000})).toBe(5000);
    expect(() => effectiveTaxBasisPcb({pcb: 5000, pcbNonCash: {version: 1, owned: {bik: 1}}})).toThrow(/malformed/);
  });
  it('held-opening review ranges show the month\'s taxable minimum with its benefits', () => {
    const bounds = boundMyTaxBasis({year: 2026, upToMonth: 1, slips: [imported('j', '2026-01', [cash('BASIC', 90000), nc(BKCAR, 2083.33, 2)])], settings: [basic, BKCAR], rulesByPeriod: rules(['2026-01'])});
    expect(bounds.months[0].taxableMin).toBe(92083.33);
  });
});

describe('the pre-release affected-employee report (pure part)', () => {
  const row = (over: Partial<NoncashBaseGapRow>): NoncashBaseGapRow => ({tenantId: 't', companyId: 'c1', companyName: 'Fictional Berhad', employmentId: 'e1', employeeCode: 'F001',
    period: '2026-01', source: 'imported', bik: 2683.33, vola: 0, laterPayroll: true, ...over});
  it('totals per employee and company, once per month', () => {
    const rows = [row({}), row({period: '2026-02'}), row({employmentId: 'e2', employeeCode: 'F002', source: 'reviewed', bik: 500, vola: 300, laterPayroll: false})];
    const {employees, companies} = summarizeNoncashBaseGaps(rows);
    expect(employees.map(e => [e.employeeCode, e.periods, e.missing, e.laterPayroll])).toEqual([['F001', ['2026-01', '2026-02'], 5366.66, true], ['F002', ['2026-01'], 800, false]]);
    expect(companies).toEqual([{tenantId: 't', companyId: 'c1', companyName: 'Fictional Berhad', employees: 2, months: 3, bik: 5866.66, vola: 300, missing: 6166.66}]);
    const lines = formatNoncashBaseGapReport(2026, rows);
    expect(lines).toContain('employee,t,Fictional Berhad,F001,e1,2026-01 2026-02,imported,5366.66,0.00,5366.66,yes');
    expect(lines.at(-1)).toBe('# 2 employees, 1 companies.');
  });
});
