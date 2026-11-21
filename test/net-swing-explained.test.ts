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
      net: { current: 5185.35, previous: 4295.35, change: 890 }, byCause: { additional_run: 890 }, explained: 890, unexplained: 0, handSet: false });
  });
  it('a recorded salary change explains the basic and the computed deductions on it', () => {
    // Basic +1,000 (the salary record moved by exactly 1,000), EPF +110: moving WITH the raise and within September's
    // recorded employee rate, 550 / 5,000 = 11% × 1,000 = 110.
    expect(explainNetChange([SEPTEMBER, OCT_RAISE], { period: '2026-10', companyId: 'co-a' })).toEqual({
      net: { current: 5185.35, previous: 4295.35, change: 890 }, byCause: { salary_change: 890 }, explained: 890, unexplained: 0, handSet: false });
  });
  it('a figure set by hand explains nothing, and makes the whole change unexplained', () => {
    expect(explainNetChange([SEPTEMBER, OCT_RAISE_BY_HAND], { period: '2026-10', companyId: 'co-a' })).toEqual({
      net: { current: 5845.35, previous: 4295.35, change: 1550 }, byCause: {}, explained: 0, unexplained: 1550, handSet: true });
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

// ── a record must ACCOUNT FOR the amount, not merely exist (review repair, 11 November 2026) ─────────────────────────
const explain = (rows: StoredPayslipRow[]) => explainNetChange(rows, { period: '2026-10', companyId: 'co-a' })!;
describe('a cause that is present explains no more than its record supports', () => {
  it('salary change: at most the recorded new basic less the old one', () => {
    // The salary record moved by 100 (5,000 → 5,100) but the basic paid moved by 1,000: 100 explained, 900 is not.
    const keyed = row({ payPeriod: '2026-10', basic: '6000.00', gross: '6000.00', net: '5295.35',
      statutory: statutory({ salaryBasis: { version: 2, basicSalary: 5100, effectiveFrom: '2026-10-01' } }) });
    expect(explain([SEPTEMBER, keyed])).toMatchObject({ byCause: { salary_change: 100 }, explained: 100, unexplained: 900 });
    expect(netSwingFor('e1', [SEPTEMBER, keyed], input())).toMatchObject({ unexplainedBp: 2095, flagged: true });
    // The basic moved the OTHER way from the salary record: nothing explained.
    const opposite = row({ payPeriod: '2026-10', basic: '4500.00', gross: '4500.00', net: '3795.35',
      statutory: statutory({ salaryBasis: { version: 2, basicSalary: 5500, effectiveFrom: '2026-10-01' } }) });
    expect(explain([SEPTEMBER, opposite])).toMatchObject({ byCause: {}, unexplained: -500 });
  });
  it('overtime: only when the hours changed, at most the change in hours × the stamped hourly rate', () => {
    // 10 hours recorded at 36.045 an hour = 360.45, but 3,604.50 of overtime paid: 360.45 explained, 3,244.05 is not.
    const ot = (amount: string, net: string) => row({ payPeriod: '2026-10', overtime: amount, gross: (5000 + Number(amount)).toFixed(2), net,
      statutory: statutory({ otDetail: { total: 360.45, lines: [{ kind: 'workday', qty: 10, unit: 'hours', rate: 36.045, amount: 360.45 }] } }) });
    expect(explain([SEPTEMBER, ot('360.45', '4655.80')])).toMatchObject({ byCause: { overtime_hours: 360.45 }, unexplained: 0 });
    expect(explain([SEPTEMBER, ot('3604.50', '7899.85')])).toMatchObject({ byCause: { overtime_hours: 360.45 }, unexplained: 3244.05 });
    expect(netSwingFor('e1', [SEPTEMBER, ot('3604.50', '7899.85')], input())).toMatchObject({ flagged: true });
  });
  it('days paid, unpaid leave and absence explain nothing: the payslip does not stamp the day rate they are priced at', () => {
    // 5 unpaid days, 1,000 deducted: the cause is recorded, but nothing ties 1,000 to 5 days.
    const unpaid = row({ payPeriod: '2026-10', otherDeductions: '1000.00', totalDeductions: '1704.65', net: '3295.35', statutory: statutory({ unpaidLeave: { days: 5, amount: 1000 } }) });
    expect(explain([SEPTEMBER, unpaid])).toMatchObject({ byCause: {}, explained: 0, unexplained: -1000 });
    expect(netSwingFor('e1', [SEPTEMBER, unpaid], input())).toMatchObject({ causes: ['unpaid_leave'], unexplainedBp: 2328, flagged: true });
  });
  it('a statutory knock-on moves WITH the earnings change, and never beyond the previous recorded rate', () => {
    // A raise of 1,000 with EPF going DOWN by 100 (computed): the wrong way, so it is not explained.
    const wrongWay = row({ payPeriod: '2026-10', basic: '6000.00', gross: '6000.00', totalDeductions: '604.65', net: '5395.35',
      statutory: statutory({ epfEmployee: 450, salaryBasis: { version: 2, basicSalary: 6000, effectiveFrom: '2026-10-01' } }) });
    expect(explain([SEPTEMBER, wrongWay])).toMatchObject({ byCause: { salary_change: 1000 }, unexplained: 100 });
    // A cut of 1,000 with EPF down 110: explained both ways (a decrease is a knock-on too).
    const cut = row({ payPeriod: '2026-10', basic: '4000.00', gross: '4000.00', totalDeductions: '594.65', net: '3405.35',
      statutory: statutory({ epfEmployee: 440, salaryBasis: { version: 2, basicSalary: 4000, effectiveFrom: '2026-10-01' } }) });
    expect(explain([SEPTEMBER, cut])).toMatchObject({ byCause: { salary_change: -890 }, explained: -890, unexplained: 0 });
    // A raise of 1,000 with EPF up by 500: September's rate (11%) supports 110; the other 390 is not explained.
    const tooMuch = row({ payPeriod: '2026-10', basic: '6000.00', gross: '6000.00', totalDeductions: '1204.65', net: '4795.35',
      statutory: statutory({ epfEmployee: 1050, salaryBasis: { version: 2, basicSalary: 6000, effectiveFrom: '2026-10-01' } }) });
    expect(explain([SEPTEMBER, tooMuch])).toMatchObject({ byCause: { salary_change: 890 }, unexplained: -390 });
  });
  it('a figure set by hand on ANY run of either month, a bonus run included, explains nothing', () => {
    // A PCB of 500 typed onto the October bonus run (the schedule said 0): bonus net 390.
    const typedBonus = row({ payPeriod: '2026-10', runType: 'bonus', runSeq: 2, basic: '0.00', bonus: '1000.00', gross: '1000.00', totalDeductions: '610.00',
      net: '390.00', statutory: statutory({ epfEmployee: 110, socsoEmployee: 0, eisEmployee: 0, pcb: 500,
        adjustment: { reason: 'Typed by a fictional payroll officer', lines: { pcb: { system: 0, applied: 500 } } } }) });
    expect(explain([SEPTEMBER, OCT_SAME, typedBonus])).toMatchObject({ handSet: true, explained: 0, unexplained: 390 });
    // At 5%: the 9.08% change is flagged with the typed PCB; without it the bonus run explains everything.
    expect(netSwingFor('e1', [SEPTEMBER, OCT_SAME, typedBonus], input(500))).toMatchObject({ unexplainedBp: 908, flagged: true });
    expect(netSwingFor('e1', [SEPTEMBER, OCT_SAME, OCT_BONUS], input(500))).toMatchObject({ unexplainedBp: 0, flagged: false });
    // And typed onto the PREVIOUS month's bonus run: still nothing explained.
    const typedSeptBonus = { ...typedBonus, payPeriod: '2026-09' };
    expect(explain([SEPTEMBER, typedSeptBonus, OCT_SAME, OCT_BONUS])).toMatchObject({ handSet: true, explained: 0 });
  });
  it('the flag is the unexplained change ALONE: an explained raise offsetting an unexplained cut is flagged', () => {
    // A recorded raise of 1,000 (with its 110 EPF) and 890 of allowance gone with no record: net unchanged, 890 unexplained.
    const offset = row({ payPeriod: '2026-10', basic: '6000.00', allowance: '-890.00', gross: '5110.00', totalDeductions: '814.65', net: '4295.35',
      statutory: statutory({ epfEmployee: 660, salaryBasis: { version: 2, basicSalary: 6000, effectiveFrom: '2026-10-01' } }) });
    expect(explain([SEPTEMBER, offset])).toMatchObject({ net: { change: 0 }, byCause: { salary_change: 890 }, unexplained: -890 });
    expect(netSwingFor('e1', [SEPTEMBER, offset], input())).toMatchObject({ changed: false, swingBp: 0, unexplainedBp: 2072, direction: 'down', flagged: true });
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
const ctxFor = (rows: StoredPayslipRow[], thresholdBp: unknown, over: { runType?: string; readable?: boolean; current?: number; prior?: number } = {}): DetectorContext => ({
  employmentId: 'e1',
  current: figures(over.current ?? 4295.35),
  prior: figures(over.prior ?? 4295.35),
  profile: { hasBankProfile: true, hasTaxProfile: true, paymentMethod: 'bank_transfer', hiredOn: '2020-01-01', terminatedOn: null, concurrentPaidEmploymentIds: [] },
  activity: { attendanceDays: 22, approvedLeaveDays: 0 },
  period: { start: '2026-10-01', end: '2026-10-31', calendarDays: 31 },
  caps: {},
  eventIds: [],
  swing: { period: '2026-10', companyId: 'co-a', runType: over.runType ?? 'regular', rows, thresholdBp: thresholdBp as number,
    thresholdReadable: over.readable ?? true, exclusions: [] },
});

describe('the anomaly detector and the Salary loop cannot disagree', () => {
  const cases: [string, StoredPayslipRow[]][] = [
    ['bonus only', [SEPTEMBER, OCT_SAME, OCT_BONUS]],
    ['salary change', [SEPTEMBER, OCT_RAISE]],
    ['bonus and an unexplained extra', [SEPTEMBER, OCT_EXTRA, OCT_BONUS]],
    ['set by hand', [SEPTEMBER, OCT_RAISE_BY_HAND]],
    ['unexplained extra', [SEPTEMBER, OCT_EXTRA]],
    ['unchanged', [SEPTEMBER, OCT_SAME]],
    ['unpaid leave', [SEPTEMBER, row({ payPeriod: '2026-10', otherDeductions: '1000.00', totalDeductions: '1704.65', net: '3295.35', statutory: statutory({ unpaidLeave: { days: 5, amount: 1000 } }) })]],
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
    expect(f.facts).toMatchObject({ movementPct: 44, thresholdPct: 15, thresholdSource: 'company', comparedWith: 'previous_paid_month',
      explainedCauses: 'additional_run', unexplainedShare: 0.529 });
    expect(f.severity).toBe('review');
  });

  it('says so when the company setting could not be read and the 15% default was used', () => {
    const [f] = detector.evaluate(ctxFor([SEPTEMBER, OCT_EXTRA], 1500, { readable: false }), {});
    expect(f.facts).toMatchObject({ thresholdPct: 15, thresholdSource: 'default_company_setting_unreadable' });
  });

  it('never a vacuous pass: with no previous paid month in the window it compares like with like against the prior cycle', () => {
    // Only October is in the months read (the closed prior cycle is older than the window): the Salary loop has nothing to
    // compare, so the detector compares the batch with the prior cycle the gate found: 4,000 → 6,000, +50%.
    expect(netSwingFor('e1', [OCT_EXTRA], input())).toBeNull();
    const [f] = detector.evaluate(ctxFor([OCT_EXTRA], 1500, { current: 6000, prior: 4000 }), {});
    expect(f.facts).toMatchObject({ movementPct: 50, comparedWith: 'previous_run_of_same_type', unexplainedShare: 1 });
    expect(detector.evaluate(ctxFor([OCT_EXTRA], 1500, { current: 4200, prior: 4000 }), {})).toEqual([]); // +5%
  });

  it('a bonus or off-cycle batch never explains itself: a bonus keyed 10× too large is flagged against the last bonus run', () => {
    // The months read would call the bonus run "explained" (additional_run); the detector does not ask them for a bonus batch.
    const tenfold = row({ payPeriod: '2026-10', runType: 'bonus', runSeq: 2, basic: '0.00', bonus: '10000.00', gross: '10000.00', totalDeductions: '1100.00',
      net: '8900.00', statutory: statutory({ epfEmployee: 1100, socsoEmployee: 0, eisEmployee: 0, pcb: 0 }) });
    const rows = [SEPTEMBER, OCT_SAME, tenfold];
    expect(netSwingFor('e1', rows, input())).toMatchObject({ flagged: false });
    for (const runType of ['bonus', 'off_cycle']) {
      const [f] = detector.evaluate(ctxFor(rows, 1500, { runType, current: 8900, prior: 890 }), {});
      expect(f.facts, runType).toMatchObject({ movementPct: 900, comparedWith: 'previous_run_of_same_type', explainedCauses: '' });
    }
    // At the company threshold, like with like: a bonus 10% over last year's is not flagged at 15%.
    expect(detector.evaluate(ctxFor(rows, 1500, { runType: 'bonus', current: 979, prior: 890 }), {})).toEqual([]);
  });
});
