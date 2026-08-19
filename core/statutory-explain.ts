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
 * `ruleKind` says which kind of rule produced the amount, so the screen never presents a PERKESO
 * schedule lookup as if it were a percentage — see the note on `ruleKind` below.
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
 *   'rate'     — a percentage of the wage (EPF, HRD Corp levy). `base × rate = amount` is the actual
 *                working, so showing the rate as a multiplication is truthful.
 *   'schedule' — a PERKESO CONTRIBUTION SCHEDULE lookup (SOCSO, EIS, SKBBK). The amount comes from the
 *                band the wage falls in, NOT from multiplying by a percentage; the two disagree by
 *                cents for almost every wage. `effectiveEmployeeRate` is still reported for these, but
 *                as a check figure the screen must caption as effective — never as "the rate".
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
   * nobody would notice until an auditor did: the table would say 5,000 while the formula beside it read
   * 5,100 × 11% = 561. Null exactly when `base` is null, so an unrecorded working stays unrecorded.
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
   * printing 0% would read as "this employee is exempt", which is a different statement.
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
    effectiveEmployeeRate: effectiveRate(employeeReported, rateBase),
    effectiveEmployerRate: effectiveRate(employer, rateBase),
    workingNotRecorded: base == null,
  });

  const items: StatutoryItemExplanation[] = [
    item('epf', 'rate', epfBase, n(st.epfEmployee), n(st.epfEmployer), eb.borne.epf, epfAdditional, epfTotalBase),
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
    basesCoverWholeMonth: runType !== 'regular',
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
