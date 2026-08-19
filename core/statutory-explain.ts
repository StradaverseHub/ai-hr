/**
 * Feedback 6b4ca488 part 2 — the working behind EPF, SOCSO, EIS, SKBBK, HRDF and PCB.
 *
 * THE GAP. app/payroll/pcb-detail (item 45df860a) explains ONE of the six: it reads the payslip's own
 * persisted `pcbMeta`, so an old slip explains itself with the rules that were true when it ran. For the
 * other five you could see the amount and nothing else — no wage the contribution was charged on, no
 * rate, no split between what came off take-home and what the employer funded. This module is the same
 * idea for all six, and it copies pcb-explain.ts's posture deliberately, including its refusals.
 *
 * ══ THE ONE RULE THIS FILE EXISTS TO ENFORCE ══
 *
 * READ THE PERSISTED WORKING. NEVER RECOMPUTE. Every figure below comes off the payslip's own
 * `statutory` blob — the amounts the run wrote, and the wage bases (`statutory.bases`) it recorded them
 * against. Nothing here consults today's EPF table, today's PERKESO schedule, today's HRDF rate or the
 * employee's current statutory flags, and this module takes NO SessionContext so it cannot start:
 * an explanation that disagrees with the payslip printed beside it is the worst possible outcome, and
 * a screen that recomputes will produce one the first time a rate changes.
 *
 * WHY THERE IS A "RATE" AT ALL, given nothing stamps one. The rates were never persisted — only the
 * bases and the resulting amounts were. So the rate reported here is the EFFECTIVE rate this run
 * applied, `amount ÷ base`, derived from the two numbers the run itself wrote down. That is still
 * reading the working rather than recomputing it: it is arithmetic ON the recorded figures, and it is
 * algebraically incapable of disagreeing with the amount beside it, which a table lookup is not.
 * `ruleKind` says which kind of rule produced the amount, so the screen never presents a contribution
 * SCHEDULE lookup as if it were a percentage — see the note on `ruleKind` below.
 *
 * …AND WHY THERE IS NO RATE ON AN ADDITIONAL RUN. `amount ÷ base` is only a rate when the two terms
 * describe the same money, and on a bonus / off-cycle / adjustment run they do NOT. The AMOUNTS such a
 * run stamps are INCREMENTS — `deltaStat` (core/payroll.ts:412) re-runs the month with and without this
 * run's additional remuneration and keeps the difference — while the BASES it stamps are the CUMULATIVE
 * month (core/payroll.ts:4890, "on an additional run that is the cumulative month"). Dividing one by the
 * other yields a percentage that is not any statutory rate and never was: RM5,000 basic already run,
 * then a RM10,000 bonus, gives 1,100 ÷ 15,000 = 7.33%, an EPF rate that does not exist. So on an
 * additional run BOTH effective rates are NULL, exactly as they are when the base was never recorded —
 * "we cannot derive a rate from these two figures" and "the rate was 7.33%" are different statements,
 * and only the first is true. This is the same trap `deltaStat`'s own comment documents for PCB.
 *
 * ══ WHAT AN OLD PAYSLIP GETS ══
 *
 * `statutory.bases` is stamped only from r187 onward and is present on a MINORITY of payslips (61 of
 * 121 production rows carried nothing at the time item 0253dc7c measured it). Those rows report
 * `base: null` and `workingNotRecorded: true`, and the screen SAYS SO. They are never filled in from
 * gross pay, from the payslip's wage columns, or from anything else:
 *   - EPF excludes overtime and SOCSO/EIS do not, so no single earnings figure is any of the bases;
 *   - each base is already net of the per-item statutory ticks and of ticked deductions;
 *   - and a wage base is exactly the number a reader has come to this screen to trust.
 * "We did not record what this was charged on" and "it was charged on nothing" are different
 * statements, and the second must never be printed when the first is meant.
 */
import { payslipProvenance, payslipStatutoryBases, type StatutoryBases } from './payslip-recompute';
import { payslipEmployerBorne, type EmployerBorneView } from './payslip-employer-borne';

/** The six the request names, in the order the screen lists them. */
export const STATUTORY_EXPLAIN_KEYS = ['epf', 'socso', 'skbbk', 'eis', 'hrdf', 'pcb'] as const;
export type StatutoryExplainKey = (typeof STATUTORY_EXPLAIN_KEYS)[number];

/**
 * WHICH KIND OF RULE produced the amount. The screen needs this because presenting all six the same way
 * would be a lie about three of them:
 *
 *   'rate'     — a percentage of the wage (the HRD Corp levy, and nothing else). `base × rate = amount`
 *                is the actual working, so showing the rate as a multiplication is truthful.
 *   'schedule' — a CONTRIBUTION SCHEDULE lookup: the amount is the figure the band the wage falls in
 *                prescribes, NOT the product of the wage and a percentage, and the two disagree by
 *                cents for almost every wage. Two different schedules land here:
 *                  · SOCSO, EIS and SKBBK — PERKESO's contribution schedule.
 *                  · EPF — the KWSP THIRD SCHEDULE (localization/my/statutory-tables.ts:200, applied at
 *                    localization/my/payroll.ts:126 `bandFor(partA, wage)`). EPF was first classified
 *                    'rate' here and that was wrong: for every monthly wage up to RM20,000 — which is
 *                    very nearly all of them — the kernel does a BAND LOOKUP, exactly as it does for
 *                    PERKESO, and the band amount is the rate applied to the band's UPPER limit rounded
 *                    UP to the next ringgit. Wage 2,990 pays 330 (the 3,000 band), not 11% × 2,990 =
 *                    328.90, so "Percentage of wage" mislabelled the largest deduction on the payslip
 *                    and printed a multiplication that does not evaluate. Above RM20,000 the schedule
 *                    ends and the percentage applies — still rounded up to the ringgit, so the printed
 *                    product would not evaluate there either.
 *                `effectiveEmployeeRate` is still reported for all of these, but as a check figure the
 *                screen must caption as effective — never as "the rate".
 *   'mtd'      — LHDN's computerised MTD calculation (PCB). Reliefs, accumulators and a schedule; not
 *                expressible as a rate at all. The whole working already lives at /payroll/pcb-detail
 *                off the same payslip's `pcbMeta`, and this module deliberately does NOT reimplement it
 *                — one PCB display, which is exactly what 45df860a's plan settled.
 */
export type StatutoryRuleKind = 'rate' | 'schedule' | 'mtd';

export type StatutoryItemExplanation = {
  key: StatutoryExplainKey;
  ruleKind: StatutoryRuleKind;
  /**
   * The wage this agency was ACTUALLY charged on, as the run recorded it. NULL means the run predates
   * the `statutory.bases` stamp — never 0, and never substituted from gross. See the header.
   */
  base: number | null;
  /**
   * EPF only, and null for everything else: the additional (bonus / off-cycle) stream, which EPF charges
   * separately from the normal wage. Kept as its own field rather than folded into `base` because the
   * two streams can carry different rates and the reader is entitled to see both terms.
   */
  additionalBase: number | null;
  /**
   * `base + additionalBase` — THE ONE FIGURE every surface calls "the statutory wage", and the reason it
   * is derived here rather than at each call site. EPF is the only item with two streams, so a summary
   * column adding them, a working line adding them and an export column NOT adding them is a drift
   * nobody would notice until an auditor did: the table would say 5,000 while the working line beside it
   * charged 5,100 for the same 561. Null exactly when `base` is null, so an unrecorded working stays
   * unrecorded.
   */
  totalBase: number | null;
  /** The FULL employee share as computed and as FILED. An employer-bears election never reduces this. */
  employeeReported: number;
  /** What genuinely came off take-home: `employeeReported` less the part the employer funded. */
  employeeTakeHome: number;
  /** The part of the employee share the employer funded on their behalf. 0 on every other payslip. */
  employerBorne: number;
  /** The employer's own share. 0 for the employee-only items (SKBBK, PCB). */
  employer: number;
  /**
   * `employeeReported ÷ (base + additionalBase)`, i.e. the rate this run effectively applied. NULL when
   * the base was not recorded or is zero — a rate over an unknown or zero wage is not a number, and
   * printing 0% would read as "this employee is exempt", which is a different statement. ALSO null on
   * every additional run, where the amount is an increment and the base is the cumulative month, so the
   * quotient is not a rate at all — see the header.
   */
  effectiveEmployeeRate: number | null;
  /** Likewise for the employer share. */
  effectiveEmployerRate: number | null;
  /** True when this run recorded no wage base for this item. The screen must say so in place of the base. */
  workingNotRecorded: boolean;
};

export type StatutoryExplanation = {
  items: StatutoryItemExplanation[];
  /**
   * The headline flag: this payslip carries no `statutory.bases` object at all, so EVERY item's working
   * is unavailable. Distinct from a per-item `workingNotRecorded` so the screen can lead with one honest
   * banner instead of repeating the same caveat six times.
   */
  basesNotRecorded: boolean;
  /**
   * An additional (bonus / off-cycle / adjustment) run stamps the bases of the CUMULATIVE MONTH, not of
   * the money that run alone paid — A0006's 2026-01 bonus payslip is all zeros yet stamps an EPF base of
   * 5,100. Without this flag the screen would appear to charge a wage the slip beside it does not show.
   *
   * The SAME flag means the AMOUNTS are increments (`deltaStat`), which is why it also suppresses every
   * effective rate: the two terms come from different quantities and their quotient is not a rate. The
   * screen's banner must say BOTH halves — a banner that discloses only the cumulative wage leaves a
   * reader to assume the amount beside it belongs to that wage.
   */
  basesCoverWholeMonth: boolean;
  /** The statutory ruleset version stamped by the run, when it recorded one. */
  rulesetVersion: string | null;
  /** The employer-borne view this explanation was built from, for the screen's disclosure line. */
  employerBorne: EmployerBorneView;
  totals: {
    employeeReported: number;
    employeeTakeHome: number;
    employerBorne: number;
    employer: number;
  };
};

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

/** `amount ÷ base`, or null when the base is unknown or zero. Never 0 — see the field doc. */
function effectiveRate(amount: number, base: number | null): number | null {
  if (base == null || base <= 0) return null;
  return amount / base;
}

type Blob = {
  epfEmployee?: unknown;
  epfEmployer?: unknown;
  socsoEmployee?: unknown;
  socsoEmployer?: unknown;
  socsoSkbbk?: unknown;
  eisEmployee?: unknown;
  eisEmployer?: unknown;
  hrdf?: unknown;
  pcb?: unknown;
};

/**
 * Build the six-item explanation from ONE payslip's stored statutory blob.
 *
 * Pure, total and defensive about shape — a `statutory` blob is plain jsonb with no validator, so every
 * field is read through `n()` and a missing or garbage `bases` degrades to "not recorded" rather than
 * throwing on a payslip screen.
 *
 * @param statutory the payslip's OWN blob, exactly as stored. Not today's configuration.
 * @param runType   the run's cycle. Anything other than 'regular' is an additional run, whose bases
 *                  describe the cumulative month (`isAdditionalRun`, core/payroll.ts:3700).
 */
export function explainStatutory(statutory: unknown, runType: string): StatutoryExplanation {
  const st = (statutory ?? {}) as Blob;
  const bases: StatutoryBases | null = payslipStatutoryBases(statutory);
  const eb = payslipEmployerBorne(statutory);
  const socsoEisBase = bases ? bases.socsoEis : null;
  // `isAdditionalRun`, core/payroll.ts:3700 — the same test, so this module's notion of "additional"
  // cannot drift from the one that decided to stamp increments against a cumulative base.
  const amountsAreIncremental = runType !== 'regular';

  // EPF is charged on TWO streams and the reader must see both terms, so the rate is taken over their
  // sum — that is the wage the recorded employee share was actually produced from.
  const epfBase = bases ? bases.epf : null;
  const epfAdditional = bases ? bases.epfAdditional : null;
  const epfTotalBase = epfBase == null ? null : r2(epfBase + (epfAdditional ?? 0));

  const item = (
    key: StatutoryExplainKey,
    ruleKind: StatutoryRuleKind,
    base: number | null,
    employeeReported: number,
    employer: number,
    borne: number,
    additionalBase: number | null = null,
    rateBase: number | null = base,
  ): StatutoryItemExplanation => ({
    key,
    ruleKind,
    base,
    additionalBase,
    totalBase: base == null ? null : r2(base + (additionalBase ?? 0)),
    employeeReported: r2(employeeReported),
    // Mirrors payslipEmployerBorne's own clamp: the borne amount IS the employee share by construction,
    // but a hand-edited blob must not be able to print a negative deduction on an explanation screen.
    employeeTakeHome: Math.max(0, r2(employeeReported - borne)),
    employerBorne: r2(borne),
    employer: r2(employer),
    // An increment over a cumulative wage is not a rate — see the header. Null rather than a number
    // nobody can act on, so the screen has one "no rate is derivable" path instead of two stories.
    effectiveEmployeeRate: amountsAreIncremental ? null : effectiveRate(employeeReported, rateBase),
    effectiveEmployerRate: amountsAreIncremental ? null : effectiveRate(employer, rateBase),
    workingNotRecorded: base == null,
  });

  const items: StatutoryItemExplanation[] = [
    // EPF is a SCHEDULE item, not a rate one: the normal monthly wage is looked up in the KWSP Third
    // Schedule band table for every wage up to RM20,000. See the `ruleKind` note above for why the
    // first cut's 'rate' was wrong and what it printed.
    item('epf', 'schedule', epfBase, n(st.epfEmployee), n(st.epfEmployer), eb.borne.epf, epfAdditional, epfTotalBase),
    item('socso', 'schedule', socsoEisBase, n(st.socsoEmployee), n(st.socsoEmployer), eb.borne.socso),
    // SKBBK (Lindung 24 Jam) is an employee-side leg of the same PERKESO schedule, gated independently of
    // SOCSO (item 5a461b99). Employer share 0 — it has none, which is why 0 here is a fact and not a gap.
    item('skbbk', 'schedule', socsoEisBase, n(st.socsoSkbbk), 0, eb.borne.skbbk),
    item('eis', 'schedule', socsoEisBase, n(st.eisEmployee), n(st.eisEmployer), eb.borne.eis),
    // HRD Corp levy: employer-only, so employeeReported 0 and nothing can be borne on the employee's
    // behalf. Zero on a company whose HRDF status is 'not_registered', which is most of them.
    item('hrdf', 'rate', bases ? bases.hrdf : null, 0, n(st.hrdf), 0),
    // PCB carries `tax` in the employer-borne map, not `pcb`. The MTD working itself is NOT rebuilt here
    // — /payroll/pcb-detail already renders it from this same payslip's `pcbMeta`, and a second display
    // of one calculation is exactly what 45df860a's plan refused.
    item('pcb', 'mtd', bases ? bases.pcb : null, n(st.pcb), 0, eb.borne.tax),
  ];

  const sum = (f: (i: StatutoryItemExplanation) => number) => r2(items.reduce((a, i) => a + f(i), 0));

  return {
    items,
    basesNotRecorded: bases == null,
    basesCoverWholeMonth: amountsAreIncremental,
    // Read through the kernel's OWN accessor rather than a second copy of `st.version` — two readers of
    // one stamp is how a screen starts reporting a different ruleset from the reprocess diff.
    rulesetVersion: payslipProvenance(statutory).rulesetVersion,
    employerBorne: eb,
    totals: {
      employeeReported: sum((i) => i.employeeReported),
      employeeTakeHome: sum((i) => i.employeeTakeHome),
      employerBorne: sum((i) => i.employerBorne),
      employer: sum((i) => i.employer),
    },
  };
}
