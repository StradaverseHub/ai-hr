/** Owner, 11 November 2026 — ONE net-swing threshold (the Salary payroll loop's, 15% by default), and "check the payroll
 * first": the part of a change a payroll record explains (a bonus or off-cycle run, a recorded salary change, approved
 * overtime, unpaid leave and absence, days paid, a statutory rules change) is taken out before the flag compares, and a
 * figure set by hand never explains anything. NO DATABASE: the pay-difference service, the Salary loop's flag and the
 * anomaly layer's `net-swing` detector are all pure.
 *
 * Every figure is worked by hand from fixtures shaped as the payroll kernel stamps payslips (the same shapes
 * test/pay-difference.test.ts and test/payroll-cycle-swing.test.ts use). */
import { describe, expect, it } from 'vitest';
import { explainNetChange, type StoredPayslipRow } from '../core/pay-difference';
import { DEFAULT_SWING_THRESHOLD_BP, netSwingFor, swingMonths, swingThresholdOrDefault } from '../core/loops/net-swing';
import { DETECTORS, type DetectorContext, type PayslipFigures } from '../core/payroll-anomaly-detectors';

type Stat = Record<string, unknown>;
const statutory = (over: Stat = {}): Stat => ({
  version: 'my-2026.1', epfEmployee: 550, epfEmployer: 650, socsoEmployee: 24.75, socsoEmployer: 86.65, socsoSkbbk: 0, eisEmployee: 9.9,
  eisEmployer: 9.9, pcb: 120, hrdf: 0, zakat: 0, zakatInTotal: true,
  bases: { epf: 5000, epfAdditional: 0, socsoEis: 5000, pcb: 5000, hrdf: 5000 },
  salaryBasis: { version: 1, basicSalary: 5000, effectiveFrom: '2024-01-01' }, ...over,
});
const row = (over: Partial<StoredPayslipRow> & { statutory?: Stat } = {}): StoredPayslipRow => ({
  companyId: 'co-a', company: 'Fictional Ceria Sdn Bhd', payPeriod: '2026-09', runType: 'regular', runSeq: 1, basic: '5000.00',
  allowance: '0.00', overtime: '0.00', bonus: '0.00', gross: '5000.00', statutory: statutory(), otherDeductions: '0.00',
  totalDeductions: '704.65', net: '4295.35', daysWorked: '30.00', ...over,
});
// September: net 4,295.35.
const SEPTEMBER = row();
// October, unchanged regular run (4,295.35) and a 1,000 bonus run netting 890.00: +20.72%, all of it the run's.
const OCT_SAME = row({ payPeriod: '2026-10' });
const OCT_BONUS = row({ payPeriod: '2026-10', runType: 'bonus', runSeq: 2, basic: '0.00', bonus: '1000.00', gross: '1000.00', totalDeductions: '110.00',
  net: '890.00', statutory: statutory({ epfEmployee: 110, socsoEmployee: 0, eisEmployee: 0, pcb: 0 }) });
// October with a recorded salary change to 6,000 and its computed EPF of 660: deductions 814.65, net 5,185.35, +890.00 = 20.72%.
const OCT_RAISE = row({ payPeriod: '2026-10', basic: '6000.00', gross: '6000.00', totalDeductions: '814.65', net: '5185.35',
  statutory: statutory({ epfEmployee: 660, salaryBasis: { version: 2, basicSalary: 6000, effectiveFrom: '2026-10-01' } }) });
// The same raise, but the EPF typed by hand as 0 (the schedule said 660): deductions 154.65, net 5,845.35, +1,550.00 = 36.09%.
const OCT_RAISE_BY_HAND = row({ payPeriod: '2026-10', basic: '6000.00', gross: '6000.00', totalDeductions: '154.65', net: '5845.35',
  statutory: statutory({ epfEmployee: 0, salaryBasis: { version: 2, basicSalary: 6000, effectiveFrom: '2026-10-01' },
    adjustment: { reason: 'Typed by a fictional payroll officer', lines: { epfEmployee: { system: 660, applied: 0 } } } }) });
// October with a 1,000 allowance nobody recorded a reason for: net 5,295.35, +23.28%.
const OCT_EXTRA = row({ payPeriod: '2026-10', allowance: '1000.00', gross: '6000.00', net: '5295.35' });

const input = (thresholdBp = DEFAULT_SWING_THRESHOLD_BP) => ({ period: '2026-10', companyId: 'co-a', thresholdBp, exclusions: [] as string[] });

describe('the pay-difference service explains a net change from the payroll records', () => {
  it('a bonus run explains its own net, and nothing else', () => {
    expect(explainNetChange([SEPTEMBER, OCT_SAME, OCT_BONUS], { period: '2026-10', companyId: 'co-a' })).toEqual({
      net: { current: 5185.35, previous: 4295.35, change: 890 }, byCause: { additional_run: 890 }, explained: 890, unexplained: 0 });
  });
  it('a recorded salary change explains the basic and the computed deductions on it', () => {
    // Basic +1,000, EPF +110 (computed, and no larger than the change it follows).
    expect(explainNetChange([SEPTEMBER, OCT_RAISE], { period: '2026-10', companyId: 'co-a' })).toEqual({
      net: { current: 5185.35, previous: 4295.35, change: 890 }, byCause: { salary_change: 890 }, explained: 890, unexplained: 0 });
  });
  it('a figure set by hand explains nothing, and makes the whole change unexplained', () => {
    expect(explainNetChange([SEPTEMBER, OCT_RAISE_BY_HAND], { period: '2026-10', companyId: 'co-a' })).toEqual({
      net: { current: 5845.35, previous: 4295.35, change: 1550 }, byCause: {}, explained: 0, unexplained: 1550 });
  });
  it('a change with no record behind it stays unexplained; a cause with no amount explains nothing', () => {
    expect(explainNetChange([SEPTEMBER, OCT_EXTRA], { period: '2026-10', companyId: 'co-a' })).toMatchObject({ explained: 0, unexplained: 1000 });
    // One day fewer paid, but the basic did not move: days_paid is recorded and accounts for 0.
    const fewerDays = row({ payPeriod: '2026-10', daysWorked: '29.00', allowance: '445.00', gross: '5445.00', net: '4740.35' });
    expect(explainNetChange([SEPTEMBER, fewerDays], { period: '2026-10', companyId: 'co-a' })).toMatchObject({ byCause: {}, unexplained: 445 });
    // Nothing to compare: null.
    expect(explainNetChange([OCT_SAME], { period: '2026-10', companyId: 'co-a' })).toBeNull();
  });
});

describe('the net-swing flag compares only what the payroll does not explain', () => {
  it('a bonus run explains the change: no flag', () => {
    expect(netSwingFor('e1', [SEPTEMBER, OCT_SAME, OCT_BONUS], input())).toMatchObject({
      swingBp: 2072, unexplainedBp: 0, explainedBy: ['additional_run'], flagged: false, excluded: false });
  });
  it('a salary change record explains the change: no flag', () => {
    expect(netSwingFor('e1', [SEPTEMBER, OCT_RAISE], input())).toMatchObject({
      swingBp: 2072, unexplainedBp: 0, explainedBy: ['salary_change'], flagged: false });
  });
  it('a bonus plus an unexplained extra over 15% is flagged', () => {
    // 1,890.00 / 4,295.35 = 44.00%; the bonus run explains 890.00 and the 1,000 left is 23.28%.
    expect(netSwingFor('e1', [SEPTEMBER, OCT_EXTRA, OCT_BONUS], input())).toMatchObject({
      swingBp: 4400, unexplainedBp: 2328, explainedBy: ['additional_run'], flagged: true });
    // An unexplained extra UNDER the threshold beside a bonus is not: 500 allowance (11.64%) plus the bonus run.
    const smallExtra = row({ payPeriod: '2026-10', allowance: '500.00', gross: '5500.00', net: '4795.35' });
    expect(netSwingFor('e1', [SEPTEMBER, smallExtra, OCT_BONUS], input())).toMatchObject({ swingBp: 3236, unexplainedBp: 1164, flagged: false });
  });
  it('a figure set by hand is flagged, even beside a salary change that would otherwise explain it', () => {
    expect(netSwingFor('e1', [SEPTEMBER, OCT_RAISE_BY_HAND], input())).toMatchObject({
      swingBp: 3609, unexplainedBp: 3609, explainedBy: [], causes: ['salary_change', 'set_by_hand'], flagged: true });
    // And no approved exclusion excuses it.
    const excluded = { ...input(), exclusions: ['cause:salary_change', 'cause:set_by_hand'] };
    expect(netSwingFor('e1', [SEPTEMBER, OCT_RAISE_BY_HAND], excluded)).toMatchObject({ flagged: true, excluded: false });
  });
});

describe('one threshold: the Salary loop setting, failing safe to 15%', () => {
  it('a setting that cannot be used is 15%, never "no check"', () => {
    expect(DEFAULT_SWING_THRESHOLD_BP).toBe(1500);
    for (const bad of [undefined, null, Number.NaN, '2000', 99, 5001, 1500.5, -1, Infinity]) {
      expect(swingThresholdOrDefault(bad), String(bad)).toBe(1500);
    }
    for (const good of [100, 1000, 2500, 5000]) expect(swingThresholdOrDefault(good)).toBe(good);
  });
  it('the months a comparison reads are the period and the three before it, across a year end', () => {
    expect(swingMonths('2026-02')).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
  });
});

// ── the anomaly layer's detector and the Salary loop's flag on the SAME input ────────────────────────────────────────
const figures = (netPay: number): PayslipFigures => ({
  grossPay: 5000, netPay, basicSalary: 5000, allowance: 0, overtimePay: 0, bonus: 0, totalDeductions: 704.65, daysWorked: 30, statutory: {},
});
const detector = DETECTORS.find((d) => d.id === 'net-swing')!;
const ctxFor = (rows: StoredPayslipRow[], thresholdBp: unknown): DetectorContext => ({
  employmentId: 'e1',
  current: figures(4295.35),
  prior: figures(4295.35),
  profile: { hasBankProfile: true, hasTaxProfile: true, paymentMethod: 'bank_transfer', hiredOn: '2020-01-01', terminatedOn: null, concurrentPaidEmploymentIds: [] },
  activity: { attendanceDays: 22, approvedLeaveDays: 0 },
  period: { start: '2026-10-01', end: '2026-10-31', calendarDays: 31 },
  caps: {},
  eventIds: [],
  swing: { period: '2026-10', companyId: 'co-a', rows, thresholdBp: thresholdBp as number, exclusions: [] },
});

describe('the anomaly detector and the Salary loop cannot disagree', () => {
  const cases: [string, StoredPayslipRow[]][] = [
    ['bonus only', [SEPTEMBER, OCT_SAME, OCT_BONUS]],
    ['salary change', [SEPTEMBER, OCT_RAISE]],
    ['bonus and an unexplained extra', [SEPTEMBER, OCT_EXTRA, OCT_BONUS]],
    ['set by hand', [SEPTEMBER, OCT_RAISE_BY_HAND]],
    ['unexplained extra', [SEPTEMBER, OCT_EXTRA]],
    ['unchanged', [SEPTEMBER, OCT_SAME]],
  ];
  for (const thresholdBp of [1500, 2500, 4000]) {
    for (const [name, rows] of cases) {
      it(`${name} at ${thresholdBp / 100}%`, () => {
        const loop = netSwingFor('e1', rows, input(thresholdBp));
        const found = detector.evaluate(ctxFor(rows, thresholdBp), {});
        expect(found.length > 0, name).toBe(loop?.flagged === true);
      });
    }
  }

  it('the detector ignores any per-detector threshold: params never change the answer', () => {
    const rows = [SEPTEMBER, OCT_EXTRA];
    for (const params of [{}, { netSwingPct: 30 }, { netSwingPct: 60 }, { netSwingPct: 5 }]) {
      expect(detector.evaluate(ctxFor(rows, 1500), params)).toHaveLength(1);
      expect(detector.evaluate(ctxFor(rows, 2500), params)).toHaveLength(0);
    }
  });

  it('an unreadable threshold in the context judges at 15%', () => {
    // 23.28% unexplained: flagged at the 15% fallback (it would not be at 25%).
    for (const bad of [undefined, Number.NaN, 0, 99999]) expect(detector.evaluate(ctxFor([SEPTEMBER, OCT_EXTRA], bad), {})).toHaveLength(1);
    // 11.64% unexplained: not flagged at 15%.
    const small = row({ payPeriod: '2026-10', allowance: '500.00', gross: '5500.00', net: '4795.35' });
    expect(detector.evaluate(ctxFor([SEPTEMBER, small], undefined), {})).toHaveLength(0);
  });

  it('a flag carries the explained causes and the unexplained share as a ratio', () => {
    const [f] = detector.evaluate(ctxFor([SEPTEMBER, OCT_EXTRA, OCT_BONUS], 1500), {});
    // 2328 / 4400 of the change is unexplained.
    expect(f.facts).toMatchObject({ movementPct: 44, thresholdPct: 15, explainedCauses: 'additional_run', unexplainedShare: 0.529 });
    expect(f.severity).toBe('review');
  });
});
