/**
 * r372 (item d4f6848f) — THE MONTH'S STATUTORY WAGE, DERIVED ONCE FOR ALL THREE READS.
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────────────────────────────
 * In a month that held more than one payroll run, the WAGE column on Borang A (EPF, "Upah") and on the
 * PERKESO SOCSO/EIS surfaces ("Employee Salary") was overstated by roughly one month's wage per extra
 * run. The CONTRIBUTION AMOUNTS were correct throughout and this module does not touch them.
 *
 * WHY, PRECISELY, BECAUSE THE WRONG WORD HERE COSTS A ROUND. `core/payroll.ts` stamps
 * `payslip.statutory.bases` on every payslip. `bases.epf` and `bases.socsoEis` are the WHOLE MONTH'S
 * figure, RE-DERIVED from compensation on every run of the month — they are IDENTICAL on each run, they
 * do NOT accumulate, and taking a difference between them would be wrong. Only `bases.epfAdditional` is
 * genuinely cumulative (`statAdditional = earlierRun.additional + bonus` on an additional or restating
 * run). Three reads then SUMMED those bases across the month's payslips, which is right for a delta
 * (ADR-0024: the statutory legs are increments) and wrong for a whole-month figure: summing identical
 * whole-month figures multiplies the month by the run count.
 *
 * ⚠️ THE PER-PAYSLIP STAMP IS NOT TOUCHED AND MUST NOT BE. It is the `now` side of the statutory delta
 * each run charges (r187 / 017d9c25 / ADR-0085); moving it would move money. The correction is entirely
 * at the reporting seam, which is this module.
 *
 * ── ONE DERIVATION, THREE CONSUMERS ──────────────────────────────────────────────────────────────
 *   • localization/my/borang-a.ts        — Upah (EPF), printed AND on the i-Akaun upload file
 *   • localization/my/borang-8a.ts       — the salary the PERKESO ASSIST upload file carries
 *   • localization/my/socso-eis-file.ts  — the SAME PERKESO file, resolved by its own query
 * The third one is not a copy of the second: it has its own batch query, its own accumulator and its own
 * download route. r296 is what happened the last time those two paths resolved one PERKESO field
 * separately — one wrote `gross_pay`, the other the stamped base, and the two files disagreed. So this is
 * a shared DERIVATION and not a shared recipe: all three call `monthWagesFrom`, and none of them restates
 * what a month's wage is.
 *
 * ⚠️ r372 (item f022dd70) ADDED A SECOND ENTRY POINT, `scopedMonthWagesFrom`, AND IT IS NOT A SECOND
 * DERIVATION. When an operator picks which payroll cycles a statutory file covers, the month's wage is no
 * longer the answer: the two EPF streams belong to different runs and only one of them decomposes. Read
 * that function's own header before touching either. `monthWagesFrom` is UNCHANGED and is still what every
 * unfiltered download takes, which is what makes "tick everything and nothing moves" true by construction.
 *
 * ── "LATEST RUN" IS AN INVARIANT HERE, NOT A POSITION ────────────────────────────────────────────
 * The month's wage is the one stamped by the GREATEST `payroll_batch.run_seq` among the rows handed in.
 * `run_seq` is `NOT NULL DEFAULT 1` and uniquely indexed on `(pay_period_id, run_seq)`, so the maximum is
 * well defined. The fold below is explicit and order-independent: there is no `[length-1]`, no "the last
 * row", and no reliance on the caller's `ORDER BY`. A caller that orders by employee name (all three do)
 * gets the same answer as one that orders by anything else.
 *
 * WHY NOT `closed_at` / `released_at`: `unlockClosedBatch` sets only `{ status: 'processed' }` and leaves
 * both timestamps behind, so a reopened run still looks closed by those columns and would sort as if it
 * were the newest thing that happened. `run_seq` is the only column that answers "which run came later".
 *
 * WHY A RESET RUN NEEDS NO EXCLUSION: `resetProcessedBatch` DELETEs the run's payslips before flipping
 * the batch to draft (`core/payroll.ts`, `tx.delete(payslip) … returning`). A reset run therefore hands
 * in no row at all and drops out of the fold by construction rather than by a predicate somebody could
 * later "simplify" away. Asserted, not assumed — see test/statutory-month-wage.test.ts.
 *
 * ── AND WHERE ONE FIGURE IS NOT THE TRUTH, IT REFUSES ────────────────────────────────────────────
 * If two runs of one month stamped DIFFERENT `bases.epf` (or different `bases.socsoEis`), the month's
 * normal remuneration changed between them — a mid-month increment or a scope change — and no single wage
 * figure is the month's wage. Printing whichever run happened to be last would be a figure nobody can
 * stand behind (CLAUDE.md §8), so the flag is raised, the person is NAMED on the review screen and the
 * document is held. `localization/my/multicycle-worksheet.ts` already refuses this exact shape as
 * `inconsistent_run_bases`, on the same 0.005 tolerance, and this is deliberately the same rule.
 *
 * The two agencies are flagged SEPARATELY. EPF's Upah is charged on `bases.epf` and PERKESO's salary box
 * on `bases.socsoEis`; a carve-out that moves one and not the other must not hold the other agency's
 * form, which is a document that is still entirely correct. "Test the row count the form is ruled for."
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);

/**
 * How far two runs' stamped bases may differ and still be called the same figure. Sen-level rounding
 * noise, and the SAME tolerance `localization/my/multicycle-worksheet.ts` refuses on, deliberately: one
 * repository must not hold two answers to "are these the same wage".
 */
export const WAGE_BASE_TOLERANCE = 0.005;

/** One payslip of the month, as all three reads can cheaply produce it. */
export type MonthWageSlip = {
  employmentId: string;
  /** `payroll_batch.run_seq` of the run that wrote this payslip. NOT NULL DEFAULT 1 in the schema. */
  runSeq: number;
  /** `payslip.statutory`, exactly as stored. Read defensively — a pre-r187 payslip has no `bases`. */
  statutory: unknown;
};

/** One employee's month. Every figure is TAKEN off a stamped payslip and none is re-derived. */
export type MonthWage = {
  /**
   * UPAH — `bases.epf + bases.epfAdditional` from the greatest-`run_seq` payslip that stamped a basis.
   * 0 when nothing in the month stamped one, which `epfRecorded` is what says.
   */
  epf: number;
  /**
   * The PERKESO salary box — `bases.socsoEis` from the greatest-`run_seq` payslip that stamped one.
   * NULL means "no run in this month recorded one", which is a REFUSAL downstream and never a zero.
   */
  socsoEis: number | null;
  /**
   * FALSE as soon as ONE payslip in the month carried no `bases` object at all — the month's EPF wage is
   * then unknown for this person. Borang A's existing rule, unchanged: 61 of 121 production payslips
   * predate the stamp, and "we do not know" is a different statement from "it was zero".
   */
  epfRecorded: boolean;
  /** Which run the EPF figure came from. Null when none stamped one. Carried so a caller can say so. */
  epfFromRunSeq: number | null;
  /** Which run the SOCSO/EIS figure came from. Null when none stamped one. */
  socsoEisFromRunSeq: number | null;
  /**
   * The month's runs were charged on DIFFERENT EPF wages, so no single Upah is the truth. Also raised when
   * the cumulative additional stream went DOWN across `run_seq`, because the fold relies on the greatest
   * run carrying the whole month's additional remuneration and a regression would understate it.
   */
  epfInconsistent: boolean;
  /** The month's runs were charged on DIFFERENT SOCSO/EIS wages, so no single salary figure is the truth. */
  socsoEisInconsistent: boolean;
  /**
   * r372 (item f022dd70) — THE SELECTED RUNS CHARGED NO SOCSO/EIS WAGE AT ALL, and the figure beside this
   * flag is therefore the whole month's and not the selection's.
   *
   * Only ever true under `scopedMonthWagesFrom`. SOCSO, EIS and SKBBK are charged ONCE for the month on the
   * REGULAR run (ADR-0024: an additional run adds 0), so a selection holding only bonus / off-cycle runs
   * has no PERKESO money in it — while `bases.socsoEis` is stamped on those runs anyway, because the kernel
   * re-derives it from the month's compensation on every run. Printing it would put a full month's salary
   * beside contributions of zero. Always false for an unfiltered month, which is every caller that passes
   * no selection.
   */
  socsoEisOutsideSelection: boolean;
};

/**
 * The reasons the three reads put on their readiness lists. EXPORTED CONSTANTS, not three literals, for
 * the same reason the derivation itself is shared: two surfaces wording one refusal differently is how an
 * operator checks one document and downloads another.
 *
 * Plain English, like the reasons beside them ('EPF member no.', 'IC') — `ReportReadiness.missing` is
 * rendered verbatim by both review screens and has never been a message-key list.
 */
export const EPF_WAGE_INCONSISTENT_REASON =
  'EPF wage basis (this month’s payroll runs were charged on DIFFERENT wages, so no single Upah figure is ' +
  'the month’s wage — check the runs before filing)';
export const SOCSO_WAGE_INCONSISTENT_REASON =
  'SOCSO/EIS wage basis (this month’s payroll runs were charged on DIFFERENT wages, so no single salary ' +
  'figure is the month’s wage — check the runs before filing)';
/**
 * r372 (item f022dd70) — the refusal for a payroll-cycle selection that holds no PERKESO money.
 *
 * DELIBERATELY NOT WORDED AS AN ABSENCE. "No SOCSO/EIS wage was recorded" is what `socsoEis: null` already
 * says and it would send an operator to look for data that is present and correct. What is true here is
 * narrower and actionable: the money is on a run they did not tick.
 */
export const SOCSO_NOT_IN_SELECTION_REASON =
  'SOCSO and EIS are charged once for the month, on the regular payroll run, and the payroll cycles you ' +
  'selected do not include it — there is no SOCSO or EIS in this selection to file';

type Bases = { epf: number; epfAdditional: number; socsoEis: number | null };

/**
 * `payslip.statutory.bases`, read by SHAPE. Returns null when there is no `bases` object at all (a payslip
 * written before r187), which is a different fact from a `bases` object whose `socsoEis` is absent.
 */
function basesOf(statutory: unknown): Bases | null {
  const st = (statutory ?? {}) as Record<string, unknown>;
  const b = st.bases;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const r = b as Record<string, unknown>;
  return {
    epf: round2(num(r.epf)),
    epfAdditional: round2(num(r.epfAdditional)),
    socsoEis: r.socsoEis === undefined || r.socsoEis === null ? null : round2(num(r.socsoEis)),
  };
}

/**
 * Resolve every employee's month from the month's payslips: ONE wage per employee per month, whatever
 * number of runs the month held.
 *
 * Pass EVERY payslip of the month, for every run, in any order. The two figures are folded independently
 * because their presence rules differ and always have: Borang A treats ONE unstamped payslip as making
 * the whole month's EPF wage unknown, while the PERKESO reads use the base if ANY run of the month
 * stamped one. Both rules are preserved exactly; this module changes what is SUMMED, not what is KNOWN.
 */
export function monthWagesFrom(slips: readonly MonthWageSlip[]): Map<string, MonthWage> {
  type Acc = {
    out: MonthWage;
    /** Min/max over the stamped runs — order-independent, so "do they disagree" is not a position. */
    minEpf: number;
    maxEpf: number;
    minSocso: number;
    maxSocso: number;
    /** The greatest additional stream any run stamped, against the one the chosen run stamped. */
    maxAdditional: number;
    chosenAdditional: number;
    epfStamped: number;
    socsoStamped: number;
  };
  const acc = new Map<string, Acc>();

  for (const s of slips) {
    let a = acc.get(s.employmentId);
    if (!a) {
      a = {
        out: {
          epf: 0,
          socsoEis: null,
          epfRecorded: true,
          epfFromRunSeq: null,
          socsoEisFromRunSeq: null,
          epfInconsistent: false,
          socsoEisInconsistent: false,
          socsoEisOutsideSelection: false,
        },
        minEpf: Infinity,
        maxEpf: -Infinity,
        minSocso: Infinity,
        maxSocso: -Infinity,
        maxAdditional: 0,
        chosenAdditional: 0,
        epfStamped: 0,
        socsoStamped: 0,
      };
      acc.set(s.employmentId, a);
    }
    const b = basesOf(s.statutory);
    if (!b) {
      // ONE unstamped payslip is enough to make the month's EPF wage unknown for this person. It does NOT
      // clear a SOCSO/EIS base another run of the month recorded — that is the PERKESO reads' own rule and
      // it is deliberately left as it was.
      a.out.epfRecorded = false;
      continue;
    }

    a.epfStamped += 1;
    a.minEpf = Math.min(a.minEpf, b.epf);
    a.maxEpf = Math.max(a.maxEpf, b.epf);
    a.maxAdditional = Math.max(a.maxAdditional, b.epfAdditional);
    // THE FOLD: the greatest run_seq wins, whatever order the rows arrived in. `>` and not `>=`, so a
    // duplicate run_seq (which the unique index on (pay_period_id, run_seq) forbids) cannot flip the
    // answer on row order.
    if (a.out.epfFromRunSeq === null || s.runSeq > a.out.epfFromRunSeq) {
      a.out.epfFromRunSeq = s.runSeq;
      a.out.epf = round2(b.epf + b.epfAdditional);
      a.chosenAdditional = b.epfAdditional;
    }

    if (b.socsoEis !== null) {
      a.socsoStamped += 1;
      a.minSocso = Math.min(a.minSocso, b.socsoEis);
      a.maxSocso = Math.max(a.maxSocso, b.socsoEis);
      if (a.out.socsoEisFromRunSeq === null || s.runSeq > a.out.socsoEisFromRunSeq) {
        a.out.socsoEisFromRunSeq = s.runSeq;
        a.out.socsoEis = b.socsoEis;
      }
    }
  }

  const out = new Map<string, MonthWage>();
  for (const [employmentId, a] of acc) {
    if (a.epfStamped > 1) {
      if (a.maxEpf - a.minEpf > WAGE_BASE_TOLERANCE) a.out.epfInconsistent = true;
      // The fold relies on the greatest run carrying the WHOLE month's additional stream
      // (`statAdditional = earlierRun.additional + bonus`, so it is monotonically non-decreasing across
      // run_seq). If it ever is not, the chosen run understates the month and no figure may be printed.
      if (a.maxAdditional - a.chosenAdditional > WAGE_BASE_TOLERANCE) a.out.epfInconsistent = true;
    }
    if (a.socsoStamped > 1 && a.maxSocso - a.minSocso > WAGE_BASE_TOLERANCE) {
      a.out.socsoEisInconsistent = true;
    }
    out.set(employmentId, a.out);
  }
  return out;
}

/**
 * r372 (item f022dd70) — ONE PAYSLIP OF THE MONTH WHEN THE OPERATOR HAS PICKED WHICH RUNS TO FILE.
 *
 * `runType` IS REQUIRED HERE AND OPTIONAL NOWHERE. It is the whole discriminator of the scoped fold below
 * and a caller that forgot it would silently file the wrong wage, so the TYPE demands it rather than a
 * comment asking for it. `payroll_batch.run_type` is `NOT NULL DEFAULT 'regular'`, so every caller has it.
 */
export type ScopedMonthWageSlip = MonthWageSlip & {
  /** `payroll_batch.run_type` — 'regular' | 'off_cycle' | 'bonus' | 'adjustment'. */
  runType: string;
};

/** The one place the word 'regular' means "this run paid the month's normal remuneration". */
const REGULAR = 'regular';

/**
 * r372 (item f022dd70) — THE WAGE FOR A CHOSEN SUBSET OF THE MONTH'S RUNS.
 *
 * ── WHY THIS IS NOT `monthWagesFrom` WITH A SHORTER LIST ─────────────────────────────────────────
 * Payroll Cycle selection lets an operator file ONE run of a month on its own — the bonus run before month
 * end, the catch-up run for somebody who was overlooked. The obvious implementation is to hand
 * `monthWagesFrom` only the selected runs' payslips. THAT PRODUCES A WRONG STATUTORY FIGURE, and it is the
 * "right shape, wrong numbers" failure the KWSP writer's header was written about:
 *
 *   `bases.epf` is the WHOLE MONTH'S normal wage and the kernel stamps it on EVERY run, including a bonus
 *   run that paid nothing but the bonus (core/payroll.ts `statBases.epf = wagesExOt − exclusions`, computed
 *   from the month's compensation with no reference to what this run actually paid). So a Bonus-only
 *   selection fed to the whole-month fold prints the month's full salary as Upah beside contributions that
 *   only cover the bonus. A Borang A that says RM9,000 wage / RM120 contribution is not a partial filing;
 *   it is a wrong one, and i-Akaun has no way to tell.
 *
 * ── WHAT THE SELECTION WAS ACTUALLY CHARGED ON, STREAM BY STREAM ─────────────────────────────────
 * The kernel charges EPF on two streams and they decompose differently:
 *
 *   NORMAL (`bases.epf`)              — the month's ordinary remuneration, paid by the REGULAR run.
 *                                       `isAdditionalRun = batch.runType !== 'regular'` (core/payroll.ts),
 *                                       and an additional run pays only the bonus bucket
 *                                       (`bonusOnlyComponentLines`). So the normal stream belongs to the
 *                                       selection if and only if the selection holds a regular run.
 *   ADDITIONAL (`bases.epfAdditional`)— CUMULATIVE across `run_seq`
 *                                       (`statAdditional = earlierRun.additional + bonus`). The money one
 *                                       run added is therefore its stamp MINUS the previous stamped run's,
 *                                       and the selection's share is the sum of its own runs' increments.
 *
 * ⚠️ WHICH IS WHY THIS TAKES THE WHOLE MONTH AND A SELECTION, NOT A PRE-FILTERED LIST. An increment cannot
 * be read off a run whose predecessor was filtered out of the query. Hand in every payslip of the month;
 * `selection` says which of them the operator ticked. A read that filtered its SQL instead would compute
 * the first selected run's increment against zero and hand an operator the whole month's bonus.
 *
 * ── AND IT AGREES WITH THE UNFILTERED FOLD WHEN EVERYTHING IS TICKED ─────────────────────────────
 * Selecting every run telescopes the increments back to the greatest run's cumulative stamp, so the answer
 * equals `monthWagesFrom`'s to the sen. That equality is asserted, not asserted-by-comment. It is also why
 * the three reads still OMIT the parameter entirely for "All": the no-change guarantee then holds by
 * construction — the old code path runs, unchanged — rather than by this function agreeing with it.
 *
 * ── PERKESO IS NOT EPF AND IS NOT DECOMPOSED ─────────────────────────────────────────────────────
 * `bases.socsoEis` has no additional stream: SOCSO, EIS and SKBBK are charged ONCE for the month, on the
 * regular run (ADR-0024 — an additional run adds 0). A selection without the regular run has no PERKESO
 * money in it at all, so the figure is flagged `socsoEisOutsideSelection` and the document is HELD by the
 * caller's readiness list rather than filed as a full month's salary beside zeros.
 */
export function scopedMonthWagesFrom(
  slips: readonly ScopedMonthWageSlip[],
  /** The `run_seq` values the operator ticked. Every other run of the month is context, never content. */
  selection: ReadonlySet<number>,
): Map<string, MonthWage> {
  const byEmp = new Map<string, ScopedMonthWageSlip[]>();
  for (const s of slips) {
    const list = byEmp.get(s.employmentId);
    if (list) list.push(s);
    else byEmp.set(s.employmentId, [s]);
  }

  const out = new Map<string, MonthWage>();
  for (const [employmentId, rows] of byEmp) {
    // Only employees the SELECTION actually paid belong in the answer; a person paid solely in a run the
    // operator unticked is absent from the file, not present with zeros.
    if (!rows.some((r) => selection.has(r.runSeq))) continue;

    const w: MonthWage = {
      epf: 0,
      socsoEis: null,
      epfRecorded: true,
      epfFromRunSeq: null,
      socsoEisFromRunSeq: null,
      epfInconsistent: false,
      socsoEisInconsistent: false,
      socsoEisOutsideSelection: false,
    };

    // ASCENDING BY run_seq, EXPLICITLY. The increments below are the one place in this module where order
    // is load-bearing, so it is established here rather than inherited from the caller's ORDER BY (all
    // three reads order by employee name). `run_seq` is unique per pay period, so this total order is well
    // defined and the comparator needs no tiebreak.
    const ordered = [...rows].sort((a, b) => a.runSeq - b.runSeq);

    let previousCumulativeAdditional = 0;
    let additionalInSelection = 0;
    let normalBase: number | null = null;
    let minEpf = Infinity;
    let maxEpf = -Infinity;
    let minSocso = Infinity;
    let maxSocso = -Infinity;
    let epfStampedInSelection = 0;
    let socsoStampedInSelection = 0;
    let selectionHasRegularRun = false;

    for (const row of ordered) {
      const picked = selection.has(row.runSeq);
      const b = basesOf(row.statutory);
      if (!b) {
        // Same rule as the whole-month fold, applied to the selection: ONE unstamped payslip among the
        // runs being filed makes their EPF wage unknown for this person. An unstamped run the operator did
        // NOT tick says nothing about the runs they did.
        if (picked) w.epfRecorded = false;
        continue;
      }

      // THE INCREMENT THIS RUN ADDED to the cumulative additional stream — computed against the previous
      // STAMPED run of the MONTH, ticked or not, which is why the whole month has to be in `slips`.
      const increment = round2(b.epfAdditional - previousCumulativeAdditional);
      previousCumulativeAdditional = b.epfAdditional;

      if (!picked) continue;

      epfStampedInSelection += 1;
      minEpf = Math.min(minEpf, b.epf);
      maxEpf = Math.max(maxEpf, b.epf);
      if (row.runType === REGULAR) selectionHasRegularRun = true;
      // A NEGATIVE INCREMENT IS A REFUSAL, NOT A SUBTRACTION. The stream is monotonically non-decreasing by
      // construction; if it ever is not, the month is not what this derivation assumes and no Upah may be
      // printed. Same judgement the whole-month fold makes about a regressing stream.
      if (increment < -WAGE_BASE_TOLERANCE) w.epfInconsistent = true;
      else additionalInSelection = round2(additionalInSelection + Math.max(0, increment));
      // The normal stream is one figure for the month; take the greatest ticked run's copy so that "which
      // run did this come from" is an invariant and not a position. Disagreement is caught by min/max below.
      if (w.epfFromRunSeq === null || row.runSeq > w.epfFromRunSeq) {
        w.epfFromRunSeq = row.runSeq;
        normalBase = b.epf;
      }

      if (b.socsoEis !== null) {
        socsoStampedInSelection += 1;
        minSocso = Math.min(minSocso, b.socsoEis);
        maxSocso = Math.max(maxSocso, b.socsoEis);
        if (w.socsoEisFromRunSeq === null || row.runSeq > w.socsoEisFromRunSeq) {
          w.socsoEisFromRunSeq = row.runSeq;
          w.socsoEis = b.socsoEis;
        }
      }
    }

    // THE NORMAL STREAM ONLY IF THE SELECTION PAID IT. This single line is the difference between a
    // Bonus-only Borang A that reads RM5,000 and one that reads RM14,000 — see the header.
    w.epf = round2((selectionHasRegularRun && normalBase !== null ? normalBase : 0) + additionalInSelection);
    if (epfStampedInSelection > 1 && maxEpf - minEpf > WAGE_BASE_TOLERANCE) w.epfInconsistent = true;
    if (socsoStampedInSelection > 1 && maxSocso - minSocso > WAGE_BASE_TOLERANCE) {
      w.socsoEisInconsistent = true;
    }
    // A selection with no regular run charged no PERKESO money. The figure stays visible on the review
    // screen (naming the person is the only way they get named at all) and the flag is what holds the file.
    if (!selectionHasRegularRun && w.socsoEis !== null) w.socsoEisOutsideSelection = true;

    out.set(employmentId, w);
  }
  return out;
}

/** The month for one employee, with the all-absent answer for somebody the month has no payslip for. */
export function monthWageFor(wages: Map<string, MonthWage>, employmentId: string): MonthWage {
  return (
    wages.get(employmentId) ?? {
      epf: 0,
      socsoEis: null,
      epfRecorded: false,
      epfFromRunSeq: null,
      socsoEisFromRunSeq: null,
      epfInconsistent: false,
      socsoEisInconsistent: false,
      socsoEisOutsideSelection: false,
    }
  );
}
