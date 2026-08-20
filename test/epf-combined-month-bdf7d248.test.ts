/**
 * bdf7d248 (r210) — EPF reads the Third Schedule ONCE for the month.
 *
 * THE REPORTED FAULT, reproduced on production 2026-08-20. Employee A0001, ISEDECOR BINA, January 2026:
 * a regular run of RM7,413.00 (employee EPF 825, employer 900) then a bonus run of RM1,650.71, on which
 * the system recorded 182 / 199. The reporter asked twice for 176 / 192.
 *
 * THE DISAGREEMENT WAS NEVER ABOUT THE INCREMENT METHOD. `core/payroll.ts` already re-runs the
 * cumulative month for an additional run and pays the delta (`earlierRunByEmp` + `deltaStat`) — that is
 * why the employer figure was 199 (12% of the bonus) and not 215 (13%). It was about how the month's
 * contribution is READ off the schedule:
 *
 *   before r210   band(7,413) + ceil(1,650.71 × rate)  =  1,007 employee / 1,099 employer
 *   after  r210   band(7,413 + 1,650.71 = 9,063.71)    =  1,001 employee / 1,092 employer
 *
 * and 1,001 − 825 = 176, 1,092 − 900 = 192 — the reporter's figures, and the acceptance criterion for
 * this item. Six and seven ringgit a month, on a table that only ever describes a month.
 *
 * WHAT THIS FILE PINS beyond that headline: that the PCB relief leg Kₜ is re-derived from the SAME
 * single lookup (so it still caps coherently against the RM4,000 annual EPF relief), that the pay-item
 * carve-outs are applied BEFORE the base is combined, that the non-citizen flat-rate path is deliberately
 * NOT combined, that an i-Topup election still only ever raises a side, and — stated rather than hidden —
 * the one case where the new reading makes the month's EMPLOYER total fall below what an earlier run in
 * the same month already contributed.
 */
import { describe, expect, it } from 'vitest';
import {
  epf,
  epfContribution,
  pcbMonth,
  statutory,
  type PcbAccumulators,
  type TaxProfile,
} from '../localization/my/payroll';
import { computeMonthlyRuns } from '../localization/my/multicycle';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';

const CFG = DEFAULT_MY_STATUTORY;
const profile: TaxProfile = { category: 1, children: 0 };

describe('bdf7d248 — A0001 January 2026, the reporter’s own month', () => {
  it('the month is ONE lookup: 7,413.00 + 1,650.71 reads the RM9,100 row', () => {
    // Every figure here is a literal, not a re-derivation of the code under test: the same expression
    // written twice cannot tell you the expression changed.
    expect(epf(7413.0, 1650.71)).toEqual({ employee: 1001, employer: 1092 });
    // …and it is the SAME answer as paying the whole month on one payslip, which is the property the
    // reporter was actually asking for. One cycle and two cycles must not differ.
    expect(epf(9063.71, 0)).toEqual({ employee: 1001, employer: 1092 });
    // The regular run alone is unchanged — nothing about the already-issued January payslip moves.
    expect(epf(7413.0, 0)).toEqual({ employee: 825, employer: 900 });
  });

  it('the bonus run therefore contributes RM176 employee and RM192 employer', () => {
    const { runs, monthly } = computeMonthlyRuns({
      month: 1,
      profile,
      runs: [
        { runType: 'regular', payment: 7413.0 },
        { runType: 'bonus', payment: 1650.71 },
      ],
    });
    const [regular, bonus] = runs;
    expect(regular.epfEmployee).toBe(825);
    expect(regular.epfEmployer).toBe(900);
    expect(bonus.epfEmployee).toBe(176); // was 182
    expect(bonus.epfEmployer).toBe(192); // was 199
    expect(monthly.epfEmployee).toBe(1001);
    expect(monthly.epfEmployer).toBe(1092);
  });

  it('the employer 13%/12% step follows the MONTH, not the salary line alone', () => {
    // A RM4,800 earner paid a RM1,000 bonus: the month is RM5,800, so the schedule row that applies is
    // a 12% row. Before r210 the salary was banded at 13% and 13% of the bonus was added beside it,
    // which charged the employer RM754 for a month the table prices at RM696.
    expect(epf(4800, 0)).toEqual({ employee: 528, employer: 624 });
    expect(epf(4800, 1000)).toEqual({ employee: 638, employer: 696 });
  });
});

describe('bdf7d248 — the PCB relief leg Kₜ comes out of the same lookup', () => {
  it('the two legs always add back up to the month’s employee contribution', () => {
    for (const [w, b] of [
      [7413.0, 1650.71],
      [5001, 1001],
      [5000, 10000],
      [12000, 50],
      [25000, 4000],
      [3000, 0],
    ] as const) {
      const c = epfContribution(w, b, CFG.epf);
      // `statutory()` hands pcbMonth `employee − employeeOnBonus` as K₁ and `employeeOnBonus` as Kₜ.
      // If those two ever stopped summing to the contribution actually deducted, the employee would be
      // claiming relief on EPF they did not pay, or losing relief on EPF they did.
      expect(c.employee - c.employeeOnBonus).toBe(epf(w, 0, CFG.epf).employee);
      expect(c.employeeOnBonus).toBe(epf(w, b, CFG.epf).employee - epf(w, 0, CFG.epf).employee);
    }
  });

  it('AT THE RM4,000 RELIEF CAP the new leg is clipped and the old one was not — PCB moves by RM1', () => {
    // The boundary case, in literals so it cannot re-derive itself.
    //   normal wage 12,000 → schedule row 12,000 → K₁ = 1,320
    //   bonus 50           → month 12,050 → row 12,100 → 1,331, so Kₜ = 1,331 − 1,320 = 11
    //   the pre-r210 leg   → ceil(50 × 11%) = 6
    // Prior months have claimed K = 2,670, so the relief left for this month is 4,000 − 2,670 − 1,320
    // = RM10. The NEW leg (11) is clipped by that RM10; the OLD leg (6) never reached it. Same wage,
    // same bonus, one ringgit of tax between the two readings.
    const K = 2670;
    const K1 = 1320;
    const acc: PcbAccumulators = { netRemuneration: 117480, epfClaimed: K, pcbPaid: 0 };
    expect(CFG.pcb.reliefs.epfReliefCap).toBe(4000);
    expect(epf(12000, 0, CFG.epf).employee).toBe(K1);
    expect(epfContribution(12000, 50, CFG.epf).employeeOnBonus).toBe(11);

    const common = { monthlyWage: 12000, epfMonthly: K1, month: 12, profile, acc, additional: 50 };
    expect(pcbMonth({ ...common, epfOnAdditional: 11 }).total).toBe(14200); // clipped to the last RM10
    expect(pcbMonth({ ...common, epfOnAdditional: 6 }).total).toBe(14201); // the pre-r210 leg
    // …and this is the one `statutory()` actually feeds through.
    expect(statutory(12000, profile, 50, 0, { month: 12, acc }).pcb).toBe(14200);
  });
});

describe('bdf7d248 — the carve-outs are applied BEFORE the base is combined', () => {
  // If an excluded amount were taken out of the wage and then the raw `additional` added back, the
  // exclusion would leak straight back in through the addition. Each case is asserted against a literal
  // AND against the equivalent uncarved call, so it states both the figure and the equivalence.
  it('epfWageExcluded / epfAdditionalExcluded leave the base at (wage − x) + (additional − y)', () => {
    const both = statutory(6000, profile, 2000, 0, { month: 3 }, { epfWageExcluded: 1000, epfAdditionalExcluded: 500 });
    expect({ ee: both.epfEmployee, er: both.epfEmployer }).toEqual({ ee: 715, er: 780 });
    expect(epf(5000, 1500, CFG.epf)).toEqual({ employee: 715, employer: 780 });

    const wageOnly = statutory(6000, profile, 2000, 0, { month: 3 }, { epfWageExcluded: 1000 });
    expect({ ee: wageOnly.epfEmployee, er: wageOnly.epfEmployer }).toEqual({ ee: 770, er: 840 });
    expect(epf(5000, 2000, CFG.epf)).toEqual({ employee: 770, employer: 840 });
  });

  it('an additional item excluded in full leaves exactly the normal-wage month', () => {
    const s = statutory(6000, profile, 2000, 0, { month: 3 }, { epfAdditionalExcluded: 2000 });
    expect({ ee: s.epfEmployee, er: s.epfEmployer }).toEqual({ ee: 660, er: 720 });
    expect(epf(6000, 0, CFG.epf)).toEqual({ employee: 660, employer: 720 });
    // …and the bonus leg for PCB is zero, because no EPF was charged on additional remuneration.
    expect(epfContribution(6000, 0, CFG.epf).employeeOnBonus).toBe(0);
  });

  it('the deduction-side reduction (epfWageDeduction) also lands before the addition', () => {
    const s = statutory(6000, profile, 2000, 0, { month: 3 }, { epfWageDeduction: 1000 });
    expect({ ee: s.epfEmployee, er: s.epfEmployer }).toEqual({ ee: 770, er: 840 });
  });
});

describe('bdf7d248 — the paths the combined rule deliberately does NOT reach', () => {
  it('the non-citizen FLAT 2%/2% path keeps rounding each leg on its own', () => {
    // There is no schedule here at all — nothing to look up once — so the combined-month rule has
    // nothing to say. Wage 2,800.60 → RM57, bonus 1,200.60 → RM25, and the month is RM82. Reading the
    // combined 4,001.20 at 2% would round to RM81 instead; this case exists to fail if someone extends
    // the rule here on the grounds of consistency.
    const c = epfContribution(2800.6, 1200.6, CFG.epf, undefined, { age: 30, citizenship: 'non_citizen' });
    expect({ ee: c.employee, er: c.employer }).toEqual({ ee: 82, er: 82 });
    expect(c.employeeOnBonus).toBe(25);
    expect(Math.ceil((2800.6 + 1200.6) * 0.02)).toBe(81); // what combining would have produced
  });

  it('Part E (citizen 60–<75) is UNCHANGED by this item and still bands the wage on its own', () => {
    // NOT an oversight and NOT a claim that Part E is right: item bdf7d248 was raised, measured and
    // approved on Part A figures only, so Part E keeps the reading it had. Its per-run increments are
    // self-consistent either way (the employer 4% has no rate step to cross), so nothing is broken by
    // leaving it — but the two parts now read the same statute differently, and that is a live question
    // for a follow-up rather than something to "tidy" silently on the strength of this file.
    const c = epfContribution(3000, 1000, CFG.epf, undefined, { age: 62, citizenship: 'citizen' });
    expect({ ee: c.employee, er: c.employer }).toEqual({ ee: 0, er: 160 });
    expect(c.employeeOnBonus).toBe(0);
  });
});

describe('bdf7d248 — i-Topup can still only RAISE a side', () => {
  it('an election below the statutory floor changes nothing, on the combined base', () => {
    expect(epf(5001, 1001, CFG.epf)).toEqual({ employee: 671, employer: 732 });
    expect(epf(5001, 1001, CFG.epf, { mode: 'voluntary_excess', employeeRate: 0.05 })).toEqual({
      employee: 671,
      employer: 732,
    });
  });

  it('an election above the floor is measured on the combined base too', () => {
    // 15% of the month (6,002) is RM901. The pre-r210 reading charged 15% of the wage and 15% of the
    // bonus separately and rounded each up, which came to RM902.
    expect(epf(5001, 1001, CFG.epf, { mode: 'voluntary_excess', employeeRate: 0.15 })).toEqual({
      employee: 901,
      employer: 732,
    });
  });

  it('exempt is still 0/0 whatever the bonus', () => {
    expect(epf(7413.0, 1650.71, CFG.epf, { mode: 'exempt' })).toEqual({ employee: 0, employer: 0 });
  });

  it('the raise-only property holds across the schedule, both sides', () => {
    for (const w of [0, 10, 900, 3000, 4999.99, 5000, 5000.01, 12000, 19999, 25000]) {
      for (const b of [0, 0.01, 500, 5000]) {
        const floor = epf(w, b, CFG.epf);
        for (const rate of [0, 0.05, 0.11, 0.13, 0.2]) {
          const ee = epf(w, b, CFG.epf, { mode: 'voluntary_excess', employeeRate: rate });
          const er = epf(w, b, CFG.epf, { mode: 'voluntary_excess', employerRate: rate });
          expect(ee.employee).toBeGreaterThanOrEqual(floor.employee);
          expect(ee.employer).toBe(floor.employer); // the other side stays statutory (semi-auto)
          expect(er.employer).toBeGreaterThanOrEqual(floor.employer);
          expect(er.employee).toBe(floor.employee);
        }
      }
    }
  });
});

describe('bdf7d248 — the consequence this change has that nobody asked for', () => {
  /**
   * READ THIS BEFORE "FIXING" THE NUMBERS BELOW. Because the employer column steps DOWN from 13% to
   * 12% at RM5,000, a small bonus paid to an employee at or just under that line makes the month's
   * employer contribution SMALLER than the salary run alone already produced: RM5,000 alone is RM650,
   * RM5,000 + RM50 is RM612. The increment method clamps a negative delta at zero (ADR-0024 §6, and
   * `deltaStat` in core/payroll.ts), so the bonus run contributes RM0 and the month ends RM38 over the
   * table figure rather than under it — nobody is short-paid, and nothing here is silently discarded.
   *
   * This is the schedule's own arithmetic, not an artefact of the change: the RM5,000 step is a real
   * cliff in the published table. It is pinned so the behaviour is a stated, tested consequence rather
   * than a surprise the first time a RM4,900 employee gets a RM200 bonus, and so a future reversals ADR
   * (§6) has a concrete case to work from.
   */
  it('a bonus that crosses the RM5,000 employer step can lower the month’s employer figure', () => {
    expect(epf(5000, 0, CFG.epf).employer).toBe(650); // 13% row
    expect(epf(5000, 50, CFG.epf).employer).toBe(612); // 12% row — RM38 LESS for a bigger month
    const { runs, monthly } = computeMonthlyRuns({
      month: 1,
      profile,
      runs: [
        { runType: 'regular', payment: 5000 },
        { runType: 'bonus', payment: 50 },
      ],
    });
    expect(runs[0].epfEmployer).toBe(650);
    expect(runs[1].epfEmployer).toBe(0); // clamped, never negative
    expect(monthly.epfEmployer).toBe(612);
    // The employee side has no such step, so it tops up normally.
    expect(runs[1].epfEmployee).toBe(11);
    expect(monthly.epfEmployee).toBe(561);
  });
});
