/**
 * Feedback 5a29686c — which Year and Month the Individual Payslip dropdowns may offer.
 *
 * THE DEFECT. The Year dropdown was `Array.from({ length: 11 }, (_, i) => nowYear + 1 - i)` — the same
 * eleven years for every employee, whether or not any of them held a payslip. A reader could choose
 * 2031, or a year before this person was hired, and get a blank screen that said nothing about why.
 * For most employees nine of the eleven options led nowhere. The request that raised it read the
 * screen's "Payroll runs in this selection" card as a history list and asked for a Year / Month /
 * Cycle selector instead; reproducing it found the selector already built and THIS the real gap.
 *
 * WHY IT IS PURE AND SEPARATE. The rules below are the whole of the change, and every one of them is a
 * judgement that can be got wrong quietly — a dropdown that omits the value it is displaying, or that
 * empties itself before an employee is chosen, still renders and still returns 200. Kept out of the
 * page so they are asserted directly, the way `history-breakdown.ts` is.
 *
 * THE THREE RULES, and the reason for each:
 *
 *   1. THE OPTIONS ARE THE EMPLOYEE'S OWN PERIODS. `periods` is the distinct 'YYYY-MM' set from that
 *      employee's payslips (core/payroll-view.ts `listPayslipRunsFor`, which r210 widened from the bare
 *      period to the whole run), already fenced on the caller's companies. Every option therefore leads
 *      to a payslip.
 *
 *   2. THE SELECTED VALUE IS ALWAYS AN OPTION, even when it has no payslip. A <select> whose value is
 *      absent from its options silently displays the first option instead, so a URL carrying
 *      ?year=2031 would FILTER on 2031 while the control read "All" — the screen would be lying about
 *      what it applied. Carrying the guarded selection in is what keeps control and query agreeing.
 *      It is not a dead option: it is there BECAUSE it is what is currently being asked for.
 *
 *   3. NO PERIODS ⇒ THE OLD WINDOW, deliberately. Before an employee is chosen, and for an employee
 *      with no payslips at all, there is nothing to derive from. An empty Year dropdown is worse than
 *      a wide one, so the screen degrades to exactly the behaviour it had before this change — never
 *      to nothing.
 *      [r210 SPLITS THIS RULE IN TWO. It was right about "nobody chosen yet" and wrong about "chosen,
 *      and holds nothing": that reader is offered eleven dead years and twelve dead months on the one
 *      screen that already knows the answer is "no payslip". `payslipPeriodOptionsFor` below is the
 *      rule this function is now reached through; call THAT from a screen, not this directly.]
 */

/** Every month, in the order a dropdown shows them. The no-periods fallback for `months`. */
export const ALL_MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/** How many years the fallback window spans, and how far ahead it reaches — unchanged from the fixed
 *  window this replaced, so "no employee chosen" looks exactly as it always has. */
const FALLBACK_YEARS = 11;
const FALLBACK_AHEAD = 1;

export type PeriodOptions = {
  /** Newest year first — the order the dropdown lists them, and the order the payslip read returns. */
  years: number[];
  /** '01'..'12', ascending. */
  months: string[];
};

/**
 * @param periods  distinct 'YYYY-MM' this employee has a payslip for (any order; deduped here anyway).
 * @param selected the GUARDED current selection — what the query is actually filtering on, not the raw
 *                 query string. `year` absent means "All"; `month` is 1..12.
 * @param nowYear  today's year, injected so the fallback window is testable without mocking the clock.
 */
export function payslipPeriodOptions(
  periods: readonly string[],
  selected: { year?: number; month?: number },
  nowYear: number,
): PeriodOptions {
  // Only well-formed 'YYYY-MM' contributes. A malformed row would otherwise produce a NaN year that
  // sorts unpredictably and renders as an empty option nobody can select.
  const clean = periods.filter((p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p));

  const periodYears = [...new Set(clean.map((p) => Number(p.slice(0, 4))))];
  const years = periodYears.length
    ? [...new Set([...(selected.year != null ? [selected.year] : []), ...periodYears])].sort((a, b) => b - a)
    : Array.from({ length: FALLBACK_YEARS }, (_, i) => nowYear + FALLBACK_AHEAD - i);

  // Months narrow to the CHOSEN year. With no year chosen they are every month this employee was ever
  // paid in — still strictly fewer dead options than all twelve, and it keeps the two dropdowns
  // consistent rather than having Month ignore what Year already said.
  const periodMonths = [
    ...new Set(
      clean.filter((p) => selected.year == null || Number(p.slice(0, 4)) === selected.year).map((p) => p.slice(5, 7)),
    ),
  ];
  const selectedMonth = selected.month != null ? [String(selected.month).padStart(2, '0')] : [];
  // THE FALLBACK CONDITION IS `clean`, NOT `periodMonths` — and the difference is the whole defect over
  // again. An employee WITH payslips who is looking at a year that holds none has no month worth
  // offering: falling back to all twelve there would put twelve dead options back on the screen under a
  // different name. It offers the selected month alone (rule 2), or nothing but "All". Only an employee
  // with no payslips AT ALL gets the wide list, for the reason in rule 3.
  const months = clean.length ? [...new Set([...selectedMonth, ...periodMonths])].sort() : [...ALL_MONTHS];

  return { years, months };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * 5a29686c, r210 — THE OTHER TWO DROPDOWNS, AND WHICH PAYSLIP THE FOUR OF THEM DESCRIBE.
 *
 * WHAT THE MARKED-UP SCREENSHOT SETTLED. r209 (above) narrowed Year and Month to the employee's own
 * periods and stopped there, because the request had been read as "the Year/Month/Cycle selector is
 * missing" and the selector was already built. It is built, but all four boxes DEFAULT TO "All", so they
 * never describe the payslip on screen — and with all four on "All" every run the employee has matches,
 * which is why the "Payroll runs in this selection" card underneath read as a payslip history. The boxes
 * were decoration; that card was the real navigation.
 *
 * SO THE RULE HERE IS: the four boxes always show the payslip on screen, and every option in every box
 * leads to a payslip. Three things follow, and each is a judgement that fails silently:
 *
 *   1. THE LISTS ARE A HIERARCHY — Company, then Year, then Month, then run — and each list is narrowed
 *      by the ones ABOVE it, never by the ones below. Narrowing every list by the other three was the
 *      obvious reading and it is a trap: an employee paid by company A in 2025 and company B in 2026
 *      would get a Year list holding only B's years and a Company list holding only 2026's companies, and
 *      A's payslips become unreachable from B's. Narrowing downwards only, every payslip is at most four
 *      changes away and Company is never narrowed at all.
 *
 *   2. A STALE LOWER CHOICE IS DROPPED, NOT APPLIED. The form is a plain GET form: changing Year posts
 *      the Month and run that belonged to the OLD year with it. Applying those as written would answer a
 *      one-click year change with "no payroll has been calculated", which is the same dead end the wide
 *      Year window used to produce. So a constraint that would leave nothing is dropped and the next one
 *      is tried — and what the boxes then display is what was actually applied, so nothing is hidden.
 *      COMPANY IS THE EXCEPTION and is never dropped: it is the top of the hierarchy, every option in it
 *      exists, and silently answering "company A" with a payslip from company B would be a worse answer
 *      than none.
 *
 *   3. THE RUN IS PART OF THE CYCLE CHOICE. `payroll_batch_period_run_uq` makes run_seq unique within a
 *      pay period, so company + period + run_seq names exactly one run: folding run_seq into the cycle
 *      option value is what makes a fully specified selection resolve to ONE payslip, and it is the whole
 *      reason the "Payroll runs in this selection" card could finally be deleted rather than merely
 *      re-labelled. Two runs sharing company, year, month and cycle were previously separable ONLY by
 *      that card.
 *
 * Pure and DB-free for the same reason the r209 rules above are: a selection rule that resolves to the
 * wrong payslip, or a list that quietly empties, still renders and still returns 200.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/** One payroll run this employee holds a payslip in — `PayslipRunRow` from core/payroll-view.ts, restated
 *  structurally so these rules can be asserted without a database or a drizzle type. */
export type PayslipRun = {
  payslipId: string;
  companyId: string;
  /** 'YYYY-MM'. */
  payPeriod: string;
  runType: string;
  runSeq: number;
};

/** What the URL asked for, already scope-guarded by the page. Every field is optional: absent means
 *  "no opinion", which is how the screen opens. */
export type PayslipRequest = {
  companyId?: string;
  payslipId?: string;
  year?: number;
  month?: number;
  runType?: string;
  runSeq?: number;
};

/** What the screen shows: the payslip, and the four values its dropdowns display. Absent ⇒ that box
 *  shows "All", which only happens when nothing resolved. */
export type PayslipSelection = {
  payslipId: string | null;
  companyId?: string;
  year?: number;
  month?: number;
  runType?: string;
  runSeq?: number;
};

/** One entry in the RUN-TYPE list — the chooser at the top of the screen. `value` is what the form
 *  posts and the links carry.
 *  [r363 (e0b6e3b8) REWORDED THIS LINE, which read "One entry in the Payroll-cycle list". The control is
 *  labelled "Run type" now; "Payroll cycle" was also the label of the payslip field below it, and since
 *  r360 that field prints the configured cycle NAME. Nothing about this type or its producer changed.] */
export type PayslipRunChoice = { value: string; runType: string; runSeq: number };

/** The cycle option's value: the run type AND the run number, because the type alone does not name a run.
 *  `:` is safe — run types are the `payroll_run_type` enum literals, none of which contains one. */
export function runOptionValue(runType: string, runSeq: number): string {
  return `${runType}:${runSeq}`;
}

/**
 * The inverse. A BARE run type is accepted and means "any run of that type": every link and bookmark
 * made before r210 carries `?cycle=bonus`, and those must keep working rather than silently becoming
 * "no cycle chosen" — which would look identical on screen and quietly change which payslip opened.
 */
export function parseRunOption(v: string | undefined): { runType: string; runSeq?: number } | undefined {
  if (!v) return undefined;
  const m = /^([a-z_]+)(?::([1-9]\d{0,3}))?$/.exec(v);
  return m ? { runType: m[1], runSeq: m[2] ? Number(m[2]) : undefined } : undefined;
}

const WELL_FORMED = /^\d{4}-(0[1-9]|1[0-2])$/;
const yearOf = (r: PayslipRun) => Number(r.payPeriod.slice(0, 4));
const monthOf = (r: PayslipRun) => Number(r.payPeriod.slice(5, 7));

/** Newest period first, then the lowest run number, then company — the SAME order the index read and
 *  `listProcessedPayslipsAcross` return, so "the latest payslip" means one thing everywhere. Sorted here
 *  as well so the rule is total: it must not depend on the caller having preserved SQL's order. */
function byNewestRun(a: PayslipRun, b: PayslipRun): number {
  return (
    b.payPeriod.localeCompare(a.payPeriod) || a.runSeq - b.runSeq || a.companyId.localeCompare(b.companyId)
  );
}

/** A constraint that would leave NOTHING is dropped rather than applied — see note 2 above. */
function narrow(pool: PayslipRun[], pred: (r: PayslipRun) => boolean): PayslipRun[] {
  const next = pool.filter(pred);
  return next.length ? next : pool;
}

const describes = (r: PayslipRun): PayslipSelection => ({
  payslipId: r.payslipId,
  companyId: r.companyId,
  year: yearOf(r),
  month: monthOf(r),
  runType: r.runType,
  runSeq: r.runSeq,
});

/**
 * Which payslip the four boxes describe, and therefore what they display.
 *
 * @param runs every run this employee holds a payslip in, ALREADY fenced on the caller's companies.
 * @param req  the scope-guarded query. `companyId` is honoured strictly; `payslipId` names one run and
 *             wins outright when it resolves.
 */
export function resolvePayslipSelection(runs: readonly PayslipRun[], req: PayslipRequest): PayslipSelection {
  // A malformed period would give a NaN year that no narrowing can match and that renders as an empty
  // option — the same defensive filter the r209 rules above apply, for the same reason.
  const all = runs.filter((r) => WELL_FORMED.test(r.payPeriod)).sort(byNewestRun);

  // COMPANY IS A FENCE-SHAPED CHOICE, so it is never relaxed. An in-scope company this employee was never
  // paid by resolves to nothing, and the screen says so.
  const inCompany = req.companyId ? all.filter((r) => r.companyId === req.companyId) : all;
  const none: PayslipSelection = { payslipId: null, ...(req.companyId ? { companyId: req.companyId } : {}) };
  if (inCompany.length === 0) return none;

  // An explicit payslip (the back link from PCB Detail and Statutory Explanation) names ONE run and
  // settles all four boxes. It is matched against the fenced index, so a tampered id resolves to nothing
  // rather than to somebody else's run — and, deliberately, not to a different payslip either: a link
  // that named a slip and silently opened another would be worse than an honest empty screen.
  if (req.payslipId) {
    const hit = inCompany.find((r) => r.payslipId === req.payslipId);
    return hit ? describes(hit) : none;
  }

  let pool = inCompany;
  if (req.year != null) pool = narrow(pool, (r) => yearOf(r) === req.year);
  if (req.month != null) pool = narrow(pool, (r) => monthOf(r) === req.month);
  if (req.runType) pool = narrow(pool, (r) => r.runType === req.runType);
  if (req.runSeq != null) pool = narrow(pool, (r) => r.runSeq === req.runSeq);
  return describes(pool[0]);
}

/**
 * The Company list: every company this employee actually holds a payslip in — NOT the reader's whole
 * scope, which was the r209 gap on this box. Company sits at the top of the hierarchy and is narrowed by
 * nothing, so a transferred employee keeps both employers and neither becomes unreachable.
 *
 * `selectedCompanyId` is carried in even when it holds no payslip, for r209's rule 2 reason: a <select>
 * whose value is missing from its options displays the first one instead, and the box would then name a
 * company the screen had not filtered on.
 */
export function payslipCompanyIds(runs: readonly PayslipRun[], selectedCompanyId?: string): string[] {
  const ids = [...new Set(runs.map((r) => r.companyId))];
  return selectedCompanyId && !ids.includes(selectedCompanyId) ? [selectedCompanyId, ...ids] : ids;
}

/**
 * The RUN-TYPE list for the company, year and month now showing — the levels ABOVE it. Ascending by
 * run number, which is the order the runs happened in.
 *
 * [r363 (e0b6e3b8) REWORDED THE FIRST LINE, which read "The Payroll-cycle list for the company, year and
 * month now showing". The chooser this feeds is labelled "Run type" from r363 on, because "Payroll cycle"
 * was ALSO the label of the field inside the payslip, and that field has printed the company's own
 * configured cycle name since r360. THIS FUNCTION IS UNCHANGED — what it offers, in what order, is
 * exactly what it offered before, and r363 deliberately did not touch it.]
 *
 * Deduped by value because two companies can each hold a run of the same type and number in one month
 * (run_seq is unique per pay period, and a transferred employee has two pay periods). The Company box is
 * what separates those, which is why this list is narrowed by it.
 */
export function payslipRunChoices(
  runs: readonly PayslipRun[],
  sel: { companyId?: string; year?: number; month?: number },
  /** The value the control is DISPLAYING, carried in when the runs do not contain it — r209's rule 2:
   *  a <select> whose value is missing from its options shows the first one instead, so the box would
   *  name a cycle other than the one the URL asked for. Absent when nothing is being displayed. */
  selectedValue?: string,
): PayslipRunChoice[] {
  const here =
    sel.companyId && sel.year != null && sel.month != null
      ? runs
          .filter((r) => WELL_FORMED.test(r.payPeriod))
          .filter((r) => r.companyId === sel.companyId && yearOf(r) === sel.year && monthOf(r) === sel.month)
      : [];
  const seen = new Set<string>();
  const choices: PayslipRunChoice[] = [];
  for (const r of here) {
    const value = runOptionValue(r.runType, r.runSeq);
    if (seen.has(value)) continue;
    seen.add(value);
    choices.push({ value, runType: r.runType, runSeq: r.runSeq });
  }
  const parsed = selectedValue && !seen.has(selectedValue) ? parseRunOption(selectedValue) : undefined;
  if (parsed) choices.push({ value: selectedValue!, runType: parsed.runType, runSeq: parsed.runSeq ?? 1 });
  return choices.sort((a, b) => a.runSeq - b.runSeq || a.value.localeCompare(b.value));
}

/**
 * Year and Month, split into the two cases r209's rule 3 could not tell apart.
 *
 * NOBODY CHOSEN YET ⇒ THE WIDE WINDOW, exactly as before: there is nothing to derive from, and an empty
 * Year dropdown on an untouched screen is worse than a wide one.
 *
 * AN EMPLOYEE WHO HOLDS NOTHING HERE ⇒ NOTHING, which is the half r209 got wrong by treating both as the
 * same "no periods". Offering that reader eleven years and twelve months is eleven dead options and
 * twelve more, on the one screen that already knows the answer is "this person has no payslip". The
 * screen says so in words instead.
 */
export function payslipPeriodOptionsFor(
  employeeChosen: boolean,
  periods: readonly string[],
  selected: { year?: number; month?: number },
  nowYear: number,
): PeriodOptions {
  if (!employeeChosen) return payslipPeriodOptions([], {}, nowYear);
  if (periods.length === 0) {
    // Rule 2 still applies to the one value the control may be DISPLAYING, or the box would name a year
    // other than the one the screen was asked for. Everything else is left off: there is nothing else.
    return {
      years: selected.year != null ? [selected.year] : [],
      months: selected.month != null ? [String(selected.month).padStart(2, '0')] : [],
    };
  }
  return payslipPeriodOptions(periods, selected, nowYear);
}
