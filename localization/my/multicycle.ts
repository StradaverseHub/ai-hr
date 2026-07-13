/**
 * Multi-cycle payroll — statutory computation core (Wave 2C, ADR-0024).
 *
 * GATED: these are pure functions only; they are NOT wired into the live payroll kernel (see
 * ADR-0024 §5 — enabled by MULTI_CYCLE_PAYROLL_ENABLED after accountant sign-off of the §7 worksheet).
 *
 * The statutory month is ONE computation. We model multiple same-month runs as INCREMENTS of the
 * monthly total: re-run the cumulative month after adding each run, and the run's contribution is the
 * delta versus the month so far. This single idea makes every statutory item correct by construction:
 *  - the per-run figures sum to the EXACT one-batch monthly figures (LHDN MTD: the month is one
 *    computation; the regular run is normal remuneration Y1, later runs are additional remuneration);
 *  - SOCSO/EIS are charged ONCE for the month (Act 4 s.6(7)/6(9)) — a bonus run adds nothing to the
 *    SOCSO/EIS base, so its delta is 0 (a salary-split run tops up to the monthly band);
 *  - EPF uses the combined-month round-up (the cumulative call rounds the combined base once).
 *
 * v1 requires runs[0] to be the regular run (it supplies Y1); later runs are additional remuneration.
 * Reversals/negative deltas are out of scope (clamped ≥ 0) — see ADR-0024 §6.
 */
import { statutory, type EpfElection, type PcbAccumulators, type TaxProfile } from './payroll';
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
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
};

type MonthlyFigures = {
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
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
  opts?: { socsoCategory?: 1 | 2; eisEligible?: boolean; resident?: boolean; flatTaxRate?: number | null; epfElection?: EpfElection };
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
    const m = statutory(cumNormal, p.profile, cumAdditional, cumOt, { month: p.month, acc: p.priorAcc }, p.opts, rules);
    last = {
      epfEmployee: m.epfEmployee,
      epfEmployer: m.epfEmployer,
      socsoEmployee: m.socsoEmployee,
      socsoEmployer: m.socsoEmployer,
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
      eisEmployee: clampDelta(last.eisEmployee, prev.eisEmployee),
      eisEmployer: clampDelta(last.eisEmployer, prev.eisEmployer),
      pcb: clampDelta(last.pcb, prev.pcb),
    };
    out.push(res);
    prev = { ...res, ...{ // carry the cumulative monthly (not the delta) as the new baseline
      epfEmployee: last.epfEmployee, epfEmployer: last.epfEmployer,
      socsoEmployee: last.socsoEmployee, socsoEmployer: last.socsoEmployer,
      eisEmployee: last.eisEmployee, eisEmployer: last.eisEmployer, pcb: last.pcb,
    } };
  }

  return { runs: out, monthly: last };
}

function blank(runType: RunType): MonthRunResult {
  return { runType, epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0, socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0 };
}
function emptyMonthly(version: string): MonthlyFigures {
  return { epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0, socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0, pcbBonus: 0, version };
}
