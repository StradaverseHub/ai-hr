/**
 * Wave 2C — multi-cycle statutory computation core (ADR-0024). GOLDEN test: it produces the figures
 * for the accountant sign-off worksheet (ADR-0024 §7) and proves the invariants that make multiple
 * same-month runs statutorily correct:
 *   - the per-run figures SUM to the exact one-batch monthly figures (LHDN MTD: month = one computation);
 *   - SOCSO/EIS are charged ONCE for the month (Act 4 s.6(7)/6(9)) — a bonus run adds 0;
 *   - EPF increments sum to the one-batch month; the employer rate is anchored to the normal monthly wage.
 *
 * ⚠️ Corrected r197 (item bdf7d248): this header said "EPF uses the combined-month round-up". The engine
 * does NOT round a combined wage+bonus base once — it takes the Third Schedule band on the NORMAL wage
 * and adds a flat percentage on the additional stream, each rounded up to RM1 separately. The figures
 * below still hold (they are the engine's, and the sum-to-one-batch invariant is real), but they hold at
 * a wage where the two readings happen to agree — see #1. Whether KWSP requires the band on the combined
 * base is an OPEN accountant sign-off: STATUTORY-SOURCES.md §2, "Bonus/additional combination rule",
 * still unticked. Worked divergence: localization/my/multicycle.ts header.
 * Pure computation only (no DB) — the kernel wiring is gated and lands in a later slice.
 */
import { describe, expect, it } from 'vitest';
import { epf, socso, eis, statutory, PCB_ZERO_ACC, type PcbAccumulators, type TaxProfile } from '../localization/my/payroll';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { computeMonthlyRuns } from '../localization/my/multicycle';

const CFG = DEFAULT_MY_STATUTORY;
const profile: TaxProfile = { category: 1, children: 0 };
const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;

/** Replay N normal months (mirrors the kernel's prior-payslip accumulation) to seed prior-month PCB. */
function priorMonths(count: number, wage: number): PcbAccumulators {
  const cap = CFG.pcb.reliefs.epfReliefCap;
  const acc = { netRemuneration: 0, epfClaimed: 0, pcbPaid: 0, zakatPaid: 0, lpAccumulated: 0 };
  for (let m = 1; m <= count; m++) {
    const s = statutory(wage, profile, 0, 0, { month: m, acc });
    const claimed = Math.min(s.epfEmployee, Math.max(0, cap - acc.epfClaimed));
    acc.netRemuneration = Math.round((acc.netRemuneration + wage - claimed) * 100) / 100;
    acc.epfClaimed = Math.round((acc.epfClaimed + claimed) * 100) / 100;
    acc.pcbPaid = Math.round((acc.pcbPaid + s.pcb) * 100) / 100;
  }
  return acc;
}

describe('Wave 2C — computeMonthlyRuns (ADR-0024 sign-off figures)', () => {
  // Worksheet scenario: resident Cat-1, basic RM5,000, May (month 5), Jan–Apr each a normal RM5,000.
  const priorAcc = priorMonths(4, 5000);
  const { runs, monthly } = computeMonthlyRuns({
    month: 5,
    profile,
    priorAcc,
    runs: [
      { runType: 'regular', payment: 5000 },
      { runType: 'bonus', payment: 10000 },
    ],
  });
  const [r1, r2] = runs;
  // The single-batch reference for the same month (RM5,000 normal + RM10,000 bonus).
  const oneBatch = statutory(5000, profile, 10000, 0, { month: 5, acc: priorAcc });

  // #1 — RM1,650 is the engine's figure: band(5,000).employee 550 + ceil(10,000 × 11%) 1,100.
  // It is NOT evidence of a "round the combined base once" rule. RM5,000 and RM15,000 are both exact
  // Third Schedule band uppers whose 11% is a whole ringgit, so band-on-normal + flat-on-bonus,
  // band-on-combined and ceil(15,000 × 11%) all coincide at RM1,650 here. At a wage that is not a band
  // upper they diverge (bdf7d248: normal 7,413 + bonus 1,650.71 → engine 1,007, band-on-combined 1,001).
  // The assertion pins the ENGINE, which is what this sign-off worksheet reports.
  it('#1 EPF employee for the month = band(5,000) 550 + ceil(10,000 × 11%) 1,100 = RM1,650', () => {
    expect(monthly.epfEmployee).toBe(1650);
    expect(sum([r1.epfEmployee, r2.epfEmployee])).toBe(1650);
  });

  it('#2 EPF employer anchored at 13% (normal wage ≤ RM5,000), not 12% → RM1,950', () => {
    expect(monthly.epfEmployer).toBe(epf(5000, 10000, CFG.epf).employer);
    expect(monthly.epfEmployer).toBe(1950); // 12% would be 1,800
    expect(sum([r1.epfEmployer, r2.epfEmployer])).toBe(1950);
  });

  it('#3 ONE SOCSO contribution for the month, on RM5,000; the bonus run adds RM0', () => {
    const band = socso(5000, 1, CFG.socso);
    expect(r1.socsoEmployee).toBe(band.employee);
    expect(r1.socsoEmployer).toBe(band.employer);
    expect(r2.socsoEmployee).toBe(0);
    expect(r2.socsoEmployer).toBe(0);
    expect(sum([r1.socsoEmployee, r2.socsoEmployee])).toBe(band.employee);
  });

  it('#4 ONE EIS contribution for the month, on RM5,000; the bonus run adds RM0', () => {
    const band = eis(5000, CFG.eis);
    expect(r1.eisEmployee).toBe(band.employee);
    expect(r2.eisEmployee).toBe(0);
    expect(r2.eisEmployer).toBe(0);
  });

  it('#6 the bonus run carries additional-remuneration MTD (> 0)', () => {
    expect(r2.pcb).toBeGreaterThan(0);
  });

  it('#7 run 1 PCB + run 2 PCB == the single-batch monthly MTD', () => {
    expect(sum([r1.pcb, r2.pcb])).toBeCloseTo(oneBatch.pcb, 2);
    expect(monthly.pcb).toBeCloseTo(oneBatch.pcb, 2);
  });

  it('#7/#8 the cumulative monthly figures equal the one-batch computation (same ruleset version)', () => {
    expect(monthly.epfEmployee).toBe(oneBatch.epfEmployee);
    expect(monthly.epfEmployer).toBe(oneBatch.epfEmployer);
    expect(monthly.socsoEmployee).toBe(oneBatch.socsoEmployee);
    expect(monthly.eisEmployee).toBe(oneBatch.eisEmployee);
    expect(monthly.pcb).toBeCloseTo(oneBatch.pcb, 2);
    expect(monthly.version).toBe(oneBatch.version);
  });

  it('emits the worksheet figures (visible in the test output for sign-off)', () => {
    const figures = {
      run1: { socso: r1.socsoEmployee, eis: r1.eisEmployee, epfEmp: r1.epfEmployee, pcb: r1.pcb },
      run2: { socso: r2.socsoEmployee, eis: r2.eisEmployee, epfEmp: r2.epfEmployee, pcb: r2.pcb },
      monthly: { epfEmp: monthly.epfEmployee, epfEr: monthly.epfEmployer, pcb: monthly.pcb },
    };
    // Documented here so the worksheet's "system figure" column has a source of truth.
    expect(figures.monthly.epfEmp).toBe(1650);
    expect(figures.run2.socso).toBe(0);
  });
});

describe('Wave 2C — three runs (regular + two additional)', () => {
  // v1 scope: the regular run carries the full monthly normal pay; every other run is additional
  // remuneration (excluded from SOCSO/EIS, MTD Steps 1–5). A bonus + a separate adjustment both ride
  // the additional path; their increments must sum to the single-batch monthly figures.
  it('increments across regular + bonus + adjustment sum to the one-batch month; SOCSO charged once', () => {
    const priorAcc = PCB_ZERO_ACC; // January, no priors — the invariant holds for any seed
    const { runs, monthly } = computeMonthlyRuns({
      month: 1,
      profile,
      priorAcc,
      runs: [
        { runType: 'regular', payment: 5000 },
        { runType: 'bonus', payment: 8000 },
        { runType: 'adjustment', payment: 2000 },
      ],
    });
    const [r1, r2, r3] = runs;
    const oneBatch = statutory(5000, profile, 10000, 0, { month: 1, acc: priorAcc });
    // EPF combined round-up across all three runs.
    expect(sum([r1.epfEmployee, r2.epfEmployee, r3.epfEmployee])).toBe(epf(5000, 10000, CFG.epf).employee);
    // ONE SOCSO/EIS contribution: only the regular run carries it; both additional runs add RM0.
    expect(r1.socsoEmployee).toBe(socso(5000, 1, CFG.socso).employee);
    expect(r2.socsoEmployee).toBe(0);
    expect(r3.socsoEmployee).toBe(0);
    expect(r2.eisEmployee).toBe(0);
    expect(r3.eisEmployee).toBe(0);
    // PCB increments sum to the single-batch monthly MTD.
    expect(sum([r1.pcb, r2.pcb, r3.pcb])).toBeCloseTo(oneBatch.pcb, 2);
    expect(monthly.pcb).toBeCloseTo(oneBatch.pcb, 2);
  });
});
