/**
 * Item 7f5cc653 — KWSP Third Schedule Part A bonus note. NO DATABASE.
 *
 * "Where the employer pays bonus to an employee who receives monthly wages of RM5,000.00 and below, and upon
 * receiving the said bonus renders the wages received for that month to exceed RM5,000.00, the employer's
 * contribution shall be calculated at the rate of 13% of the amount of wages for the month." Contributions
 * with cents round UP to the next ringgit. Sources and the open primary-text confirmation:
 * docs/architecture/STATUTORY-SOURCES.md; the restated ADR-0024 §7 rows: docs/adr/0024-multi-cycle-payroll.md
 * (addendum 2026-11-16).
 *
 * EVERY EXPECTED FIGURE BELOW IS A LITERAL, HAND-COMPUTED, with its arithmetic beside it. None is read off
 * the Part A table or the helper under test. Fixtures are fictional.
 *
 * The reporter's Employee A: Basic 4,200 + Car Allowance 500 (normal EPF wages) + Sales Commission 1,786.83
 * (EPF Bonus 2012). Normal 4,700; total 6,486.83.
 *   employer: 6,486.83 × 13% = 843.2879 → rounded up → 844
 *   employee: the Part A row 6,400.01–6,500.00 → ceil(11% × 6,500) = 715 (the note names only the employer)
 */
import { describe, expect, it } from 'vitest';
import { epf, epfContribution, statutory, type TaxProfile } from '../localization/my/payroll';
import { computeMonthlyRuns } from '../localization/my/multicycle';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { epfTraceRows } from '../app/payroll/statutory-detail/statutory-trace';
import { buildStatutoryTraceLines } from '../core/statutory-trace';
import { explainStatutory } from '../core/statutory-explain';
import { STATUTORY_TRACE_AMOUNT_KEYS } from '../core/statutory-trace-explain';

const CFG = DEFAULT_MY_STATUTORY.epf;
const profile: TaxProfile = { category: 1, children: 0 };
const CITIZEN_35 = { age: 35, citizenship: 'citizen' as const };

describe('7f5cc653 — the reporter’s Employee A', () => {
  it('RM4,700 normal + RM1,786.83 EPF Bonus 2012: employee 715, employer 844 (was 780)', () => {
    // employer 6,486.83 × 0.13 = 843.2879 → 844; employee row 6,500 → 0.11 × 6,500 = 715.
    expect(epf(4700, 1786.83, CFG)).toEqual({ employee: 715, employer: 844 });
    expect(epfContribution(4700, 1786.83, CFG, undefined, CITIZEN_35)).toMatchObject({ employee: 715, employer: 844 });
  });

  it('the kernel call (statutory) carries the same figures', () => {
    const r = statutory(4700, profile, 1786.83, 0, { month: 1 }, { epfAge: 35, epfCitizenship: 'citizen' });
    expect([r.epfEmployee, r.epfEmployer]).toEqual([715, 844]);
  });

  it('two runs in one month: salary 517 / 611, bonus run 198 / 233, month 715 / 844', () => {
    // Salary run alone, RM4,700 → row 4,680.01–4,700.00: employee 0.11 × 4,700 = 517, employer 0.13 × 4,700 = 611.
    // Month 715 / 844 (above), so the bonus run charges 715 − 517 = 198 and 844 − 611 = 233.
    const { runs, monthly } = computeMonthlyRuns({
      month: 1,
      profile,
      runs: [
        { runType: 'regular', payment: 4700 },
        { runType: 'bonus', payment: 1786.83 },
      ],
    });
    expect([runs[0].epfEmployee, runs[0].epfEmployer]).toEqual([517, 611]);
    expect([runs[1].epfEmployee, runs[1].epfEmployer]).toEqual([198, 233]);
    expect([monthly.epfEmployee, monthly.epfEmployer]).toEqual([715, 844]);
  });
});

describe('7f5cc653 — the boundaries', () => {
  it('normal RM5,000.00 + RM0.01 bonus: employer ceil(13% × 5,000.01) = 651; employee row 5,100 = 561', () => {
    // 5,000.01 × 0.13 = 650.0013 → 651. Employee: row 5,000.01–5,100.00 → 0.11 × 5,100 = 561.
    expect(epf(5000, 0.01, CFG)).toEqual({ employee: 561, employer: 651 });
  });

  it('normal RM5,000.01 + RM1,000 bonus: normal above RM5,000, so the combined 12% row is unchanged', () => {
    // 6,000.01 → row 6,000.01–6,100.00: employee 0.11 × 6,100 = 671, employer 0.12 × 6,100 = 732.
    expect(epf(5000.01, 1000, CFG)).toEqual({ employee: 671, employer: 732 });
  });

  it('normal RM4,000 + RM1,000 = RM5,000: the month stays at RM5,000, the 13% row is unchanged', () => {
    // Row 4,980.01–5,000.00: employee 0.11 × 5,000 = 550, employer 0.13 × 5,000 = 650.
    expect(epf(4000, 1000, CFG)).toEqual({ employee: 550, employer: 650 });
  });

  it('normal RM4,000 + RM17,000 = RM21,000: 13% has no upper limit — employer 2,730, employee 2,310', () => {
    // Above the RM20,000 schedule: employer 21,000 × 0.13 = 2,730; employee 21,000 × 0.11 = 2,310.
    expect(epf(4000, 17000, CFG)).toEqual({ employee: 2310, employer: 2730 });
  });

  it('a bonus NOT ticked EPF Bonus 2012 is normal wages: the RM6,486.83 row applies, unchanged (780)', () => {
    // All on the normal stream → row 6,400.01–6,500.00: employee 0.11 × 6,500 = 715, employer 0.12 × 6,500 = 780.
    expect(epf(6486.83, 0, CFG)).toEqual({ employee: 715, employer: 780 });
  });

  it('the bdf7d248 reporter case (normal RM7,413 + RM1,650.71) is unchanged at 1,001 / 1,092', () => {
    // 9,063.71 → row 9,000.01–9,100.00: employee 0.11 × 9,100 = 1,001, employer 0.12 × 9,100 = 1,092.
    expect(epf(7413, 1650.71, CFG)).toEqual({ employee: 1001, employer: 1092 });
  });
});

describe('7f5cc653 — the categories the note does not touch', () => {
  it('Part E (citizen 62): normal-wage row + 4% of the bonus, unchanged — 0 / 260', () => {
    // Part E row 4,680.01–4,700.00: employer 0.04 × 4,700 = 188; bonus 1,786.83 × 0.04 = 71.4732 → 72. 188 + 72 = 260.
    expect(epfContribution(4700, 1786.83, CFG, undefined, { age: 62, citizenship: 'citizen' })).toMatchObject({ employee: 0, employer: 260 });
  });

  it('non-citizen flat 2% / 2%, unchanged — 130 / 130', () => {
    // 4,700 × 0.02 = 94; 1,786.83 × 0.02 = 35.7366 → 36. 94 + 36 = 130, each side.
    expect(epfContribution(4700, 1786.83, CFG, undefined, { age: 35, citizenship: 'non_citizen' })).toMatchObject({ employee: 130, employer: 130 });
  });

  it('age 75+: no contribution, unchanged — 0 / 0', () => {
    expect(epfContribution(4700, 1786.83, CFG, undefined, { age: 76, citizenship: 'citizen' })).toMatchObject({ employee: 0, employer: 0 });
  });

  it('manual amount: the typed figures, unchanged — 500 / 600', () => {
    const typed = { mode: 'manual_amount' as const, employeeAmount: 500, employerAmount: 600 };
    expect(epfContribution(4700, 1786.83, CFG, typed, CITIZEN_35)).toMatchObject({ employee: 500, employer: 600 });
  });

  it('manual percentage: the entered rates on the rounded wage, unchanged — 780 / 845', () => {
    // 6,486.83 rounds up to the next RM100 step above RM5,000: 6,500. 6,500 × 0.12 = 780; 6,500 × 0.13 = 845.
    const typed = { mode: 'manual_percentage' as const, employeeRate: 0.12, employerRate: 0.13 };
    expect(epfContribution(4700, 1786.83, CFG, typed, CITIZEN_35)).toMatchObject({ employee: 780, employer: 845 });
  });
});

describe('7f5cc653 — elected categories stand on the corrected statutory floor', () => {
  it('i-Topup with an employee increment only: the employer statutory side rises to 844', () => {
    // Employer: no increment, so the statutory figure: 6,486.83 × 0.13 = 843.2879 → 844 (was the 780 row).
    // Employee: (11% + 1%) × 6,486.83 = 778.4196 → 779, above the 715 row.
    const topup = { mode: 'topup_percentage' as const, employeeRate: 0.01, employerRate: null };
    expect(epfContribution(4700, 1786.83, CFG, topup, CITIZEN_35)).toMatchObject({ employee: 779, employer: 844 });
  });

  it('i-Topup with an employer increment: the increment is added to the corrected statutory 13%', () => {
    // Statutory employer rate under the note is 13%; + 1% = 14%. 6,486.83 × 0.14 = 908.1562 → 909 (> 844).
    const plus1 = { mode: 'topup_percentage' as const, employeeRate: null, employerRate: 0.01 };
    expect(epfContribution(4700, 1786.83, CFG, plus1, CITIZEN_35)).toMatchObject({ employee: 715, employer: 909 });
    // + 2% = 15%: 6,486.83 × 0.15 = 973.0245 → 974.
    const plus2 = { mode: 'topup_percentage' as const, employeeRate: null, employerRate: 0.02 };
    expect(epfContribution(4700, 1786.83, CFG, plus2, CITIZEN_35)).toMatchObject({ employee: 715, employer: 974 });
  });

  it('voluntary excess below the floor cannot lower it: employer stays 844', () => {
    // Elected employer 12%: 6,486.83 × 0.12 = 778.4196 → 779, below the 844 floor → 844.
    // Elected employee 15%: 6,486.83 × 0.15 = 973.0245 → 974, above the 715 row → 974.
    const elected = { mode: 'voluntary_excess' as const, employeeRate: 0.15, employerRate: 0.12 };
    expect(epf(4700, 1786.83, CFG, elected)).toEqual({ employee: 974, employer: 844 });
  });

  it('the elected employee rate with a statutory employer (semi-auto) keeps 844 through the shared helper', () => {
    // Employer: 6,486.83 × 0.13 = 843.2879 → 844. Employee: 11% entered on 6,500 (rounded wage) = 715.
    const semi = { mode: 'voluntary_excess' as const, employeeRate: 0.11, employerRate: null };
    expect(epf(4700, 1786.83, CFG, semi)).toEqual({ employee: 715, employer: 844 });
  });
});

describe('7f5cc653 — the explanation is the run’s own working', () => {
  const SEL = { epfAge: 35, epfCitizenship: 'citizen' as const, epfWageMonth: '2026-11' };

  it('the trace records the rule from the same statements that charged it', () => {
    const r = statutory(4700, undefined, 1786.83, 0, undefined, { ...SEL, trace: {} });
    const e = r.statutoryTrace!.epf;
    expect(e).toMatchObject({
      part: 'A', method: 'schedule_row', normalWage: 4700, bonusWage: 1786.83, base: 6486.83,
      band: { from: 6400.01, upTo: 6500 }, scheduleEmployee: 715, scheduleEmployer: 844, employee: 715, employer: 844,
    });
    // exact: 648,683 sen × 13% = 84,328.79 sen → 843.29 to the sen; charged 844.
    expect(e.employerBonusRule).toEqual({ normalWage: 4700, threshold: 5000, rate: 0.13, base: 6486.83, exact: 843.29, amount: 844 });
  });

  it('no trace field on a month the note does not apply to', () => {
    for (const [w, b] of [[4000, 1000], [5000.01, 1000], [6486.83, 0], [7413, 1650.71]] as const) {
      const e = statutory(w, undefined, b, 0, undefined, { ...SEL, trace: {} }).statutoryTrace!.epf;
      expect(e.employerBonusRule, `${w} + ${b}`).toBeUndefined();
    }
  });

  it('above RM20,000 the formula trace names the 13% employer rate', () => {
    const e = statutory(4000, undefined, 17000, 0, undefined, { ...SEL, trace: {} }).statutoryTrace!.epf;
    expect(e).toMatchObject({ method: 'schedule_formula', employeeRate: 0.11, employerRate: 0.13, scheduleEmployee: 2310, scheduleEmployer: 2730 });
    expect(e.employerBonusRule).toEqual({ normalWage: 4000, threshold: 5000, rate: 0.13, base: 21000, exact: 2730, amount: 2730 });
  });

  it('the rows: normal, bonus, total, rate decision, the 13% working, employee range — and no row-employer figure', () => {
    const r = statutory(4700, undefined, 1786.83, 0, undefined, { ...SEL, trace: {} });
    const t0 = r.statutoryTrace!;
    const items = buildStatutoryTraceLines({
      basic: 4200,
      lines: [
        { code: 'CAR', name: 'Car Allowance', buckets: [{ bucket: 'wage', amount: 500 }], epf: true, socso: true },
        { code: 'COMM', name: 'Sales Commission', buckets: [{ bucket: 'bonus', amount: 1786.83 }], epf: true, socso: true },
      ],
      bonus2012Codes: new Set(['COMM']), ownOvertimeCharged: true, unpaid: 0,
      totals: { epfNormal: t0.epf.normalWage, epfBonus: t0.epf.bonusWage, socsoEis: t0.socso.wage },
    });
    const thisRun = Object.fromEntries(STATUTORY_TRACE_AMOUNT_KEYS.map((k) => [k, r[k]]));
    const blob = {
      ...r,
      bases: { epf: 4700, epfAdditional: 1786.83, socsoEis: t0.socso.wage, pcb: 6486.83, hrdf: 0 },
      statutoryTrace: { ...t0, items, run: { kind: 'single', own: { epfAdditional: 1786.83, socsoWageExtra: 0 }, thisRun } },
    };
    const ex = explainStatutory(blob, 'regular');
    expect(ex.traceStatus).toBe('recorded');
    const t = (key: string, values?: Record<string, string>) => (values ? `${key}(${Object.values(values).join('|')})` : key);
    const money = (n: number) => n.toFixed(2);
    const rows = epfTraceRows(ex.trace!, t, money, 'en-MY');
    const labels = rows.map((row) => row.label);
    const at = (label: string) => labels.indexOf(label);
    expect(rows).toContainEqual({ label: 'traceEpfBonusRuleNormal', value: '4700.00' });
    expect(rows).toContainEqual({ label: 'traceEpfBonusRuleBonus', value: '1786.83' });
    expect(rows).toContainEqual({ label: 'traceEpfBonusRuleTotal', value: '6486.83' });
    expect(rows).toContainEqual({ label: 'traceEpfBonusRuleRate', value: 'traceEpfBonusRuleRateValue(4700.00|5000.00|13%)' });
    expect(rows).toContainEqual({ label: 'traceEpfBonusRuleEmployer', value: 'traceEpfBonusRuleEmployerValue(6486.83|13%|843.29|844.00)' });
    expect(rows).toContainEqual({ label: 'traceEpfBonusRuleEmployee', value: 'traceEpfBonusRuleEmployeeValue(traceRange(6400.01|6500.00)|715.00)' });
    expect(rows).toContainEqual({ label: 'traceMonthEmployee', value: '715.00' });
    expect(rows).toContainEqual({ label: 'traceMonthEmployer', value: '844.00' });
    // The row's 12% employer figure never applied, so it is not shown.
    expect(labels).not.toContain('traceEpfRowEmployer');
    expect(labels).not.toContain('traceEpfLookupWage');
    // The plan's order.
    const order = ['traceEpfBonusRuleNormal', 'traceEpfBonusRuleBonus', 'traceEpfBonusRuleTotal', 'traceEpfBonusRuleRate',
      'traceEpfBonusRuleEmployer', 'traceEpfBonusRuleEmployee', 'traceMonthEmployee', 'traceMonthEmployer'];
    expect(order.map(at).every((i, n, all) => i >= 0 && (n === 0 || i > all[n - 1]))).toBe(true);
  });

  it('a trace written before this item (no employerBonusRule) still reads and renders the range rows', () => {
    const r = statutory(4000, undefined, 1000, 0, undefined, { ...SEL, trace: {} });
    const rows = epfTraceRows({ ...r.statutoryTrace!, items: [], run: { kind: 'single', own: { epfAdditional: 1000, socsoWageExtra: 0 }, thisRun: {} } } as never,
      (k) => k, (n) => n.toFixed(2), 'en-MY');
    expect(rows).toContainEqual({ label: 'traceEpfRowEmployer', value: '650.00' });
    expect(rows.map((row) => row.label)).not.toContain('traceEpfBonusRuleEmployer');
  });
});
