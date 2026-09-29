/**
 * Multi-cycle payroll — statutory computation core (Wave 2C, ADR-0024).
 *
 * GATED: these are pure functions only; they are NOT wired into the live payroll kernel (see
 * ADR-0024 §5 — enabled by MULTI_CYCLE_PAYROLL_ENABLED after accountant sign-off of the §7 worksheet).
 *
 * The statutory month is ONE computation. We model multiple same-month runs as INCREMENTS of the
 * monthly total: re-run the cumulative month after adding each run, and the run's contribution is the
 * delta versus the month so far. This single idea makes every statutory item correct by construction:
 *  - the per-run figures sum to the one-batch monthly figures (LHDN MTD: the month is one computation;
 *    the regular run is normal remuneration Y1, later runs are additional remuneration). ⚠️ r210: this
 *    holds everywhere EXCEPT the EPF EMPLOYER column across the RM5,000 step, where the published table
 *    steps DOWN (13% → 12%) and the month as one lookup can be SMALLER than the regular run alone
 *    already produced. `clampDelta` floors the increment at 0 rather than emitting a negative
 *    contribution (§6), so RM5,000 + RM50 sums to RM650 against a one-batch RM612. Pinned in
 *    test/epf-combined-month-bdf7d248.test.ts; it is the one case where "the runs sum to the month" is
 *    an aspiration rather than a fact, and closing it needs the reversals ADR, not a code change here;
 *  - SOCSO/EIS are charged ONCE for the month (Act 4 s.6(7)/6(9)) — a bonus run adds nothing to the
 *    SOCSO/EIS base, so its delta is 0 (a salary-split run tops up to the monthly band). This covers
 *    all THREE SOCSO-family legs: employer, employee, and the employee-deducted SKBBK leg that rides
 *    the same bands (`socsoSkbbk`), which the kernel also treats as a delta key;
 *  - EPF reads the Third Schedule ONCE for the month: the cumulative call adds the month's normal wage
 *    and additional remuneration together, looks that single base up in Part A (so the employer 13%/12%
 *    step follows the month's whole pay), and each run's figure is the difference. Before r210 this
 *    line described an intention rather than the code — `epf()` banded the normal wage on its own and
 *    added a straight percentage of the bonus beside it, which on a RM7,413 + RM1,650.71 month gave
 *    RM1,007/RM1,099 against the schedule's own RM1,001/RM1,092. Item bdf7d248 made the claim true.
 *
 * ⚠️ IT READS NO PAYSLIP, AND THAT IS WHY `opts` HAS TO BE COMPLETE (item 70b14723). Every figure here is
 * RE-DERIVED from wages through `statutory()`; nothing consults what a run actually wrote. So any
 * per-employee election missing from `opts` is an election this module models as absent — and the result is
 * not an error, it is a plausible wrong number. A manual EPF AMOUNT is the sharpest case: leave
 * `epfElection.employeeAmount` out and the replay produces the Third Schedule figure, the worksheet finds it
 * matches neither reading, and `localization/my/multicycle-worksheet.ts` prints a fabricated ringgit
 * difference as `unexplained` on a document its own header calls one an accountant signs. `statutoryOptsOf`
 * there is the one builder of this bag and carries the amounts; keep the two moving together.
 *
 * v1 requires runs[0] to be the regular run (it supplies Y1); later runs are additional remuneration.
 * Reversals/negative deltas are out of scope (clamped ≥ 0) — see ADR-0024 §6.
 *
 * ⚠️ r337 — THE KERNEL NO LONGER REQUIRES THAT, AND THIS MODULE STILL DOES. Item 23e7dac3 lifted the
 * regular-run-first rule in `core/payroll.ts` (ADR-0085 §5 step 5): a bonus or off-cycle run may open
 * the month, and the regular run restates it when it lands. This module is the one that is UNWIRED, and
 * it was left as it is deliberately — its contract above is what `test/multicycle-compute.test.ts` and
 * the ADR-0024 §7 figures were signed off against, and re-deriving those under a second ordering rule
 * would move a signed-off document for no caller. The two are therefore NOT interchangeable any more:
 * the worksheet screen that drives this module reports a month whose first run is not regular as
 * `first_run_not_regular` and excludes it, which is now reachable in ordinary use rather than only on
 * hand-built data. Stated so the divergence is a recorded decision, not a discovery.
 */
import { statutory, type PcbAccumulators, type TaxProfile } from './payroll';
import { DEFAULT_MY_STATUTORY, type StatutoryRuleset } from './statutory-tables';

export type RunType = 'regular' | 'off_cycle' | 'bonus' | 'adjustment';

/** One run's pay within the month. `payment` for a regular run is the normal monthly remuneration
 *  (Y1); for any other run it is additional remuneration. `overtime` rides the SOCSO/EIS/PCB base. */
export type MonthRunInput = { runType: RunType; payment: number; overtime?: number };

export type MonthRunResult = {
  runType: RunType;
  /** This run's INCREMENTAL statutory contribution (delta vs the month so far), clamped ≥ 0. */
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  /**
   * SKBBK (Lindung 24 Jam) — the EMPLOYEE-deducted leg that rides on the SOCSO bands. It is a
   * contribution field like any other and the kernel treats it as one (core/payroll.ts DELTA_KEYS
   * includes `socsoSkbbk`, and payslip net pay subtracts it alongside the SOCSO employee share). It is
   * banded monthly exactly as SOCSO is, so it is charged ONCE for the month here and an additional run
   * adds 0 — the same invariant, on a leg that is LARGER than the SOCSO employee share it sits beside.
   * Omitting it understated the employee-side SOCSO family by roughly 60%.
   */
  socsoSkbbk: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
};

type MonthlyFigures = {
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  socsoSkbbk: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  pcbBonus: number;
  version: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compute every run in a month by the incremental method. Returns each run's delta figures plus the
 * final cumulative `monthly` figures (which equal the single-batch computation for the month's totals).
 */
export function computeMonthlyRuns(p: {
  month: number;
  profile?: TaxProfile;
  /** Prior-MONTH PCB accumulators (∑(Y−K), K, X, Z) — same seed the one-batch path uses. */
  priorAcc?: PcbAccumulators;
  rules?: StatutoryRuleset;
  /**
   * The employee attributes the engine derives from, passed straight through to `statutory`.
   *
   * WIDENED (r209, worksheet slice) from a hand-copied five-member subset
   * `{ socsoCategory, eisEligible, resident, flatTaxRate, epfElection }` to the pack's OWN option bag.
   * That subset was written when `statutory` had five options; it has since grown `subjectToSocso`,
   * `subjectToSkbbk`, `epfAge`, `epfCitizenship` and the pay-item base carve-outs, so the narrow copy
   * silently computed a 60-year-old, a foreign worker and an exempted scheme as if they were none of
   * those things. This is a TYPE widening on an optional pass-through: every existing caller supplies a
   * value assignable to the old subset and computes byte-identically (the golden test above is the
   * proof). It does NOT wire this module into the kernel — ADR-0024 §5 still gates that on the §7
   * worksheet sign-off.
   */
  opts?: NonNullable<Parameters<typeof statutory>[5]>;
  /**
   * This MONTH's TP1 optional deduction (∑LP leg) and zakat-via-salary, if any. Supplied to every
   * cumulative call, so the month's zakat offsets the month's MTD exactly once and the runs' deltas
   * still sum to the month. Omitted ⇒ both zero, which is byte-identical to the previous behaviour.
   */
  lpCurrent?: number;
  zakatCurrent?: number;
  /** Ordered by run_seq. runs[0] should be the regular run (ADR-0024 §6). */
  runs: MonthRunInput[];
}): { runs: MonthRunResult[]; monthly: MonthlyFigures } {
  const rules = p.rules ?? DEFAULT_MY_STATUTORY;
  let cumNormal = 0;
  let cumAdditional = 0;
  let cumOt = 0;
  let prev: MonthRunResult = blank('regular');
  let last: MonthlyFigures = emptyMonthly(rules.version);
  const out: MonthRunResult[] = [];

  for (const run of p.runs) {
    if (run.runType === 'regular') cumNormal += run.payment;
    else cumAdditional += run.payment; // off_cycle / bonus / adjustment = additional remuneration
    cumOt += run.overtime ?? 0;

    // Re-compute the whole month with cumulative bases; the run's figure is the increment.
    const m = statutory(
      cumNormal,
      p.profile,
      cumAdditional,
      cumOt,
      { month: p.month, acc: p.priorAcc, lpCurrent: p.lpCurrent, zakatCurrent: p.zakatCurrent },
      p.opts,
      rules,
    );
    last = {
      epfEmployee: m.epfEmployee,
      epfEmployer: m.epfEmployer,
      socsoEmployee: m.socsoEmployee,
      socsoEmployer: m.socsoEmployer,
      socsoSkbbk: m.socsoSkbbk,
      eisEmployee: m.eisEmployee,
      eisEmployer: m.eisEmployer,
      pcb: m.pcb,
      pcbBonus: m.pcbBonus,
      version: m.version,
    };
    const clampDelta = (now: number, before: number) => Math.max(0, round2(now - before));
    const res: MonthRunResult = {
      runType: run.runType,
      epfEmployee: clampDelta(last.epfEmployee, prev.epfEmployee),
      epfEmployer: clampDelta(last.epfEmployer, prev.epfEmployer),
      socsoEmployee: clampDelta(last.socsoEmployee, prev.socsoEmployee),
      socsoEmployer: clampDelta(last.socsoEmployer, prev.socsoEmployer),
      socsoSkbbk: clampDelta(last.socsoSkbbk, prev.socsoSkbbk),
      eisEmployee: clampDelta(last.eisEmployee, prev.eisEmployee),
      eisEmployer: clampDelta(last.eisEmployer, prev.eisEmployer),
      pcb: clampDelta(last.pcb, prev.pcb),
    };
    out.push(res);
    prev = { ...res, ...{ // carry the cumulative monthly (not the delta) as the new baseline
      epfEmployee: last.epfEmployee, epfEmployer: last.epfEmployer,
      socsoEmployee: last.socsoEmployee, socsoEmployer: last.socsoEmployer, socsoSkbbk: last.socsoSkbbk,
      eisEmployee: last.eisEmployee, eisEmployer: last.eisEmployer, pcb: last.pcb,
    } };
  }

  return { runs: out, monthly: last };
}

function blank(runType: RunType): MonthRunResult {
  return { runType, epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0, socsoEmployer: 0, socsoSkbbk: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0 };
}
function emptyMonthly(version: string): MonthlyFigures {
  return { epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0, socsoEmployer: 0, socsoSkbbk: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0, pcbBonus: 0, version };
}
