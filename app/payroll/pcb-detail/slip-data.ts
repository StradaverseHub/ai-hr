/**
 * ad7bc503 — THE READS BEHIND THE REPORTER'S SECTIONS 2, 4, 7 AND 8, IN ONE PLACE.
 *
 * WHY THIS FILE EXISTS AT ALL. `core/pcb-explain.ts` is PURE and must stay pure: it explains a payslip
 * from what the payslip recorded, and giving it a database connection is how a screen that "cannot
 * recompute the tax" acquires the means to. The four new sections need facts that are NOT on the payslip
 * — the employee's child grid, their disability flags, the relief declaration in force for the month and
 * the previous employer's Section D — so those reads live here, beside the screen, and the shaping of
 * them into rows stays in core/ where a test can reach it without rendering anything.
 *
 * ⚠️ IT ADDS NO NEW DOOR. Every figure comes through an EXISTING admin-gated, RLS-fenced read
 * (`listEmployees`, `listTp1DeclarationsForPersonYear`, `getTp3ForPersonYear`), and the two queries
 * written here are fenced on the caller's own `companyIds` / on a `personId` that came out of the
 * scope-fenced roster, and fail CLOSED on an empty scope — the same posture, and the same two-line shape,
 * as every read in core/payroll-view.ts. An out-of-scope employment returns null, so a tampered
 * `payslipId` is indistinguishable from a payslip that does not exist.
 *
 * ⚠️ AND IT WRITES NOTHING AND RECORDS NOTHING. Explaining a deduction is a read.
 *
 * ── WHICH DECLARATIONS ARE "THIS MONTH'S", AND WHY IT IS `tp1CountForYear` AND NOTHING ELSE ──────────
 * ⚠️ ONE ROW PER MONTH, **SUMMED** — NOT "LATEST WINS". A year holds up to twelve declarations, one per
 * deduction month, and HR is taught to key each month's INCREMENT: `core/tax-relief.ts` makes the limit
 * check additive across them and `core/payroll.ts` feeds
 * `tp1CountForYear(rows, { throughMonth: pMonth }).total`. Taking only the newest row would make a second
 * declaration REDUCE the relief — January 3,000 then June 2,000 would show 2,000, not 5,000 — silently,
 * with no error anywhere. An EARLIER BUILD OF THIS FILE DID EXACTLY THAT: it narrowed, collapsed and then
 * sorted `[0]`, so the screen whose whole purpose is to reconcile with the payroll figure itemised one
 * declaration out of the several the kernel had summed, and RM 3,000 of relief that was genuinely used
 * appeared nowhere. Both columns now come from `tp1CountForYear` itself, which is not a re-implementation
 * of the rule but the rule — the same function, over the same column list (`TP1_COUNTABLE_COLUMNS`) and
 * the same `WHERE` (`tp1CountableWhere`), as the feed that actually fed the kernel.
 *
 * The two columns are the SAME function asked the agency's two questions, exactly as core/tax-relief.ts
 * describes them: `throughMonth: <this payroll month>` is "the money in force NOW", which is what payroll
 * took, and `throughMonth: null` is the whole assessment year, which is what the printed schedule's
 * Accumulated column and the annual limit check ask. One rule, two questions, one implementation.
 *
 * ⚠️ AND NOT `getTp1AccumulatedForPerson` FOR THE ACCUMULATED COLUMN, WHICH IS WHAT IT LOOKS LIKE IT IS
 * FOR. That function's `deductionMonth` is the month to LEAVE OUT (its own doc: "already claimed means the
 * OTHER months"), so passing `null` to mean "the whole year" excludes the month-LESS bucket — every
 * pre-r209 whole-year declaration — and the Accumulated column silently lost their money.
 *
 * ── TODAY'S DECLARATION, NOT A STAMP FROM THE RUN, AND THE SCREEN SAYS SO ───────────────────────────
 * The payslip's `pcbMeta` carries ΣLP and LP1 as COMBINED totals; there is no per-category stamp, and
 * this item may not change what a payslip records. So these are the employee's CURRENT declarations. If
 * they were edited after the run, the itemisation will differ from the totals the worksheet above shows
 * — which is the identical posture, and carries the identical warning, as `reliefSource: 'current'` and
 * as `previousEmploymentForPayslip`.
 */
import { and, eq, inArray, like, lt } from 'drizzle-orm';
import { withTenant, type SessionContext } from '@/db/client';
import { employment, employeeStatutoryMy, payrollBatch, payslip, tp1Relief } from '@/db/schema';
import { listEmployees } from '@/core/read';
import {
  TP1_COUNTABLE_COLUMNS,
  TP1_ITEMS,
  TP1_REBATES,
  listTp1DeclarationsForPersonYear,
  tp1CountForYear,
  tp1CountableWhere,
  type Tp1CountableRow,
  type Tp1Counted,
} from '@/core/tax-relief';
import { getTp3ForPersonYear } from '@/core/tp3';
import type {
  PcbAccumulatedRemuneration,
  PcbChildHeadCount,
  PcbChildProfile,
  PcbSlipCatalogueItem,
  PcbSlipSide,
} from '@/core/pcb-explain';
import { PCB_CHILD_CATEGORIES } from '@/core/pcb-explain';

/** Everything the four new sections need, resolved. Every member is independently nullable, because a
 *  missing declaration and a missing child grid are different absences and the screen says which. */
export type PcbSlipData = {
  /** `employee_statutory_my` — the tax position the reporter's section 1 and section 2 ask for. */
  profile: (PcbChildProfile & { taxCategory: number | null; numChildren: number | null }) | null;
  /** r370 — how many children are on record, and from which record. NULL ⇒ none was ever recorded. The
   *  SUM lives here and not in core/, for the reason `priorRemuneration` below does. */
  childHeadCount: PcbChildHeadCount | null;
  /** The relief declaration in force for THIS payroll month, itemised. */
  currentDeduction: PcbSlipSide | null;
  /** The year's counted attribution — the ACCUMULATED column of the agency's own schedule. */
  accumulatedDeduction: PcbSlipSide | null;
  /** The previous employer's Section D, itemised (reporter section 4). */
  previousDeduction: PcbSlipSide | null;
  /** The same two sides again for the Section D rebate lines (reporter section 8). */
  currentRebate: PcbSlipSide | null;
  accumulatedRebate: PcbSlipSide | null;
  /** r361 — the year's PRIOR payslips, itemised by the payslip's own component columns. NULL when the
   *  employment could not be resolved in scope; an employee with no prior month this year yields zeroes,
   *  which is a true statement about a real, readable year and not the same thing. */
  accumulatedRemuneration: PcbAccumulatedRemuneration | null;
};

/** The agency's schedule as the pack declares it, narrowed to what the row builder reads. */
export const SLIP_ITEMS: readonly PcbSlipCatalogueItem[] = TP1_ITEMS;
export const SLIP_REBATES: readonly PcbSlipCatalogueItem[] = TP1_REBATES;

const EMPTY: PcbSlipData = {
  profile: null,
  childHeadCount: null,
  currentDeduction: null,
  accumulatedDeduction: null,
  previousDeduction: null,
  currentRebate: null,
  accumulatedRebate: null,
  accumulatedRemuneration: null,
};

/**
 * The employee's stored tax position. Fenced on `companyIds` and fails CLOSED on an empty scope.
 *
 * A LEFT JOIN, deliberately: an employment with no `employee_statutory_my` row at all is a real state
 * (a non-Malaysian hire, an incomplete onboarding), and it must read as "not recorded" rather than as a
 * row of Nos. `disabled_individual` is NOT NULL with a default, so a present row's `false` IS a recorded
 * answer and prints as one; an ABSENT row asserts nothing and prints nothing.
 */
function taxProfile(
  s: SessionContext,
  p: { companyIds: string[]; employmentId: string },
): Promise<(PcbChildProfile & { taxCategory: number | null; numChildren: number | null }) | null> {
  if (p.companyIds.length === 0) return Promise.resolve(null);
  return withTenant(s, async (tx) => {
    const [row] = await tx
      .select({
        taxCategory: employeeStatutoryMy.taxCategory,
        childReliefMode: employeeStatutoryMy.childReliefMode,
        childReliefTable: employeeStatutoryMy.childReliefTable,
        // r370 — the HEAD COUNT for the reporter's sequence 2, which is not C. `num_children` is NOT NULL
        // with a default of 0, so exactly as `disabled_individual` is treated four lines down, a PRESENT
        // row's value is a recorded answer and an ABSENT row asserts nothing.
        numChildren: employeeStatutoryMy.numChildren,
        disabledIndividual: employeeStatutoryMy.disabledIndividual,
        disabledSpouse: employeeStatutoryMy.disabledSpouse,
      })
      .from(employment)
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(and(eq(employment.id, p.employmentId), inArray(employment.companyId, p.companyIds)))
      .limit(1);
    // No such employment in scope, or no statutory row behind it: nothing is asserted about either.
    if (!row || row.childReliefMode == null) return null;
    return {
      taxCategory: row.taxCategory == null ? null : Number(row.taxCategory),
      mode: row.childReliefMode,
      table: (row.childReliefTable as PcbChildProfile['table']) ?? null,
      numChildren: row.numChildren == null ? null : Number(row.numChildren),
      disabledIndividual: row.disabledIndividual,
      disabledSpouse: row.disabledSpouse,
    };
  });
}

/**
 * The year's APPROVED declarations in the shape `tp1CountForYear` reduces — the SAME column list and the
 * SAME `WHERE` the payroll feed and the limit check use, both exported from core/tax-relief.ts precisely
 * so that "a column the rule needs can never reach one side and not the other".
 *
 * ⚠️ WHY IT IS NOT `listTp1DeclarationsForPersonYear`: that read does not select `categories`, so every
 * row would come back unattributed and the whole schedule would read "recorded only in combination". It is
 * still called, first, in `pcbSlipData` — it is the ADMIN GATE on this person (`requireAdminTarget`), and
 * it throws before this query is reached for a caller who is not one.
 *
 * `personId` has already come out of the scope-fenced roster, and the read runs under `withTenant`, so RLS
 * confines it exactly as it confines `core/tax-relief.ts`'s own accumulated read.
 */
function countableDeclarations(
  s: SessionContext,
  p: { personId: string; assessmentYear: number },
): Promise<Tp1CountableRow[]> {
  return withTenant(s, (tx) =>
    tx.select(TP1_COUNTABLE_COLUMNS).from(tp1Relief).where(tp1CountableWhere(p.personId, p.assessmentYear)),
  );
}

/**
 * r361 / bf3c9712 — THE YEAR'S PRIOR PAYSLIPS, SUMMED BY THE PAYSLIP'S OWN FOUR MONEY COLUMNS.
 *
 * ⚠️ THE PREDICATE IS `core/payroll.ts`'s OWN, CHARACTER FOR CHARACTER, AND THAT IS THE POINT. The
 * accumulators this itemisation sits beside (Y, K, X, Z) are replayed by `priorSlips` in core/payroll.ts
 * over `employment_id = … AND pay_period LIKE '<year>-%' AND pay_period < '<this month>'` — no company
 * predicate, because an employment belongs to one company and a transfer does not rewrite which batch
 * paid a month. Adding a company filter here (which `localization/my/reports.ts` eaStatement needs,
 * because an EA speaks FOR one employer) would itemise a different set of slips from the one the totals
 * were built from, and the block would silently under-report a transferred employee's year.
 *
 * ⚠️ AND IT IS `<`, NOT `<=`. The agency's block is headed "for previous month's in the current year";
 * this payroll month's own remuneration is the CURRENT MONTH'S REMUNERATION section, further down the
 * same document. An off-by-one here double-counts the month being explained.
 *
 * ⚠️ WHAT IT IS NOT. These are the PAID figures — the four columns, as issued. Y accumulates `bases.pcb`,
 * the figure PCB is CHARGED on, which excludes every exempt ringgit (spec rule 9); and the accumulators
 * are additionally seeded by the Form TP3, which this query cannot see. So the itemisation and the
 * totals beneath it are two different measures of the year and need not add up. `core/pcb-explain.ts`
 * prints them in two separate columns for that reason and its section note says so in words.
 *
 * NO NEW DOOR: `employmentId` has already come out of the scope-fenced roster in `pcbSlipData`, and the
 * read runs under `withTenant`, so RLS confines it exactly as it confines every other read in this file.
 */
function priorRemuneration(
  s: SessionContext,
  p: { employmentId: string; taxYear: number; month: number },
): Promise<PcbAccumulatedRemuneration> {
  const boundary = `${p.taxYear}-${String(p.month).padStart(2, '0')}`;
  return withTenant(s, async (tx) => {
    const slips = await tx
      .select({
        basic: payslip.basicSalary,
        allowance: payslip.allowance,
        overtime: payslip.overtimePay,
        bonus: payslip.bonus,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(
        and(
          eq(payslip.employmentId, p.employmentId),
          like(payrollBatch.payPeriod, `${p.taxYear}-%`),
          lt(payrollBatch.payPeriod, boundary),
        ),
      )
      // CLAUDE.md §8: any asserted array out of a query carries an ORDER BY. The three sums below do not
      // depend on it — addition does not care — but the test that pins WHICH slips were counted reads the
      // list, and an unordered result makes that assertion about nothing in particular.
      .orderBy(payrollBatch.payPeriod);
    const num = (v: unknown) => {
      const x = Number(v ?? 0);
      return Number.isFinite(x) ? x : 0;
    };
    let grossSalary = 0;
    let allowances = 0;
    let additional = 0;
    for (const sl of slips) {
      // The agency's "gross salary, wages or leave pay (INCLUDING OVERTIME PAY)" is one line, and it is
      // the same pairing `eaStatement` makes for the EA's Part B 1(a).
      grossSalary = round2(grossSalary + num(sl.basic) + num(sl.overtime));
      allowances = round2(allowances + num(sl.allowance));
      // `bonus` IS the Yt additional-remuneration stream (core/payroll.ts: "`allowanceApplied` (the Y1
      // wage stream) and `bonus` (the Yt additional stream)"), so it is the agency's ACCUMULATED
      // ADDITIONAL REMUNERATION line and not part of the normal-remuneration lines above it.
      additional = round2(additional + num(sl.bonus));
    }
    return { grossSalary, allowances, additional };
  });
}

/** Two decimals, because a running total of numeric(12,2) columns otherwise drifts into binary dust and
 *  prints RM 1,234.5600000000001 on a tax document. Not a tax rule and not a rounding of any figure the
 *  engine produced — only the sum of figures it already wrote down. */
const round2 = (v: number) => Math.round(v * 100) / 100;

/** A declaration's per-line figures, or the "counts but carries no attribution" signal. */
const side = (attributed: boolean, amounts: PcbSlipSide['amounts'], total: unknown): PcbSlipSide => ({
  attributed,
  amounts,
  total,
});

/**
 * ONE COUNTED COLUMN, AS THE SCHEDULE PRINTS IT. Nothing is summed here: `tp1CountForYear` has already
 * done every addition, and this only names which of its outputs each column of the form is.
 *
 * `null` when the year holds no counted declaration at all — the honest absence the plan promises, and
 * the one the whole §8 decision on this screen is about.
 *
 * ⚠️ A MIXED YEAR IS REPORTED AS UNATTRIBUTED, DELIBERATELY. `unattributedTotal` is money that reached
 * payroll through a pre-catalogue declaration, which core/tax-relief.ts says in as many words there is "no
 * honest way to split" across C1–C17. When some of the year's money is attributed and some is not, an
 * itemisation drawn from the attributed part alone is INCOMPLETE and does not add up to the total beneath
 * it — and a reader looking at seventeen lines that fall short of the roll-up has no way to tell an
 * unattributed declaration from a missing line. So the side reports `attributed: false`, every line reads
 * "recorded only in combination", and the roll-up carries every ringgit. That understates the detail we
 * hold; it asserts nothing untrue, which is the trade CLAUDE.md §8 asks for on this surface.
 */
const countedSide = (c: Tp1Counted): PcbSlipSide | null => {
  if (c.sources.length === 0) return null;
  const attributed = c.sources.every((r) => r.attributed);
  return side(
    attributed,
    attributed
      ? {
          items: Object.fromEntries(
            Object.entries(c.items).map(([code, amount]) => [code, { amount, subItems: c.subItems[code] ?? {} }]),
          ),
        }
      : null,
    c.total,
  );
};

/**
 * r370 — HOW MANY CHILDREN ARE ON RECORD, AND FROM WHICH RECORD. NOT C.
 *
 * ⚠️ IT IS THE ONLY ADDITION ON THIS SURFACE THAT IS AN ARITHMETIC OPERATION, AND IT IS HERE ON PURPOSE.
 * `core/pcb-explain.ts` holds no operator below its marker (test/7f251381-pcb-lhdn-worksheet.test.ts
 * refuses one), because a file that shapes a tax explanation must not be able to produce a figure. The
 * other sum this surface needs — the year's prior payslips — is `priorRemuneration` above, for the same
 * reason and in the same place.
 *
 * WHICH RECORD ANSWERS DEPENDS ON THE MODE, and the three absences are three different sentences:
 *   · `auto_table` WITH a keyed grid  → the five categories added up, at the full AND the half rate. A
 *     half-rate child is still a child on record; the half is about who claims the relief, not about how
 *     many children exist, so it is counted here and the caption says the grid is what was added up.
 *   · `auto_table` with NO grid       → nothing. `num_children` is not consulted: the employee is set to
 *     use the grid, so a stale single total is not the record, and drawing it would report a figure the
 *     relief calculation did not read. core/child-relief-review.ts:18 documents this as a real state.
 *   · `manual`                        → `num_children`, which IS the record for such an employee.
 *   · no `employee_statutory_my` row  → nothing is asserted, exactly as the disability rows are not.
 */
function childHeadCountOf(
  profile: (PcbChildProfile & { numChildren: number | null }) | null,
): PcbChildHeadCount | null {
  if (profile == null) return null;
  if (profile.mode === 'manual') {
    return profile.numChildren == null ? null : { count: profile.numChildren, source: 'keyed' };
  }
  if (profile.mode !== 'auto_table' || profile.table == null) return null;
  let total = 0;
  for (const c of PCB_CHILD_CATEGORIES) {
    const cell = profile.table[c.key];
    if (cell == null) continue;
    // A keyed grid is SPARSE — `normaliseChildReliefTable` drops an all-zero category — so an absent cell
    // is the zero the admin left, which is the same reading `pcbChildSection` gives it.
    const full = typeof cell.full === 'number' && Number.isFinite(cell.full) ? cell.full : 0;
    const half = typeof cell.half === 'number' && Number.isFinite(cell.half) ? cell.half : 0;
    total += full + half;
  }
  return { count: total, source: 'grid' };
}

export async function pcbSlipData(
  s: SessionContext,
  p: { companyIds: string[]; employmentId: string; taxYear: number; month: number },
): Promise<PcbSlipData> {
  if (p.companyIds.length === 0 || !Number.isInteger(p.taxYear)) return EMPTY;
  // `listEmployees` is the scope-fenced roster every other admin surface resolves an employment through;
  // it is what turns this screen's `employmentId` into the `personId` the declaration reads need.
  const roster = await listEmployees(s, p.companyIds);
  const emp = roster.find((e) => e.employmentId === p.employmentId);
  const profile = await taxProfile(s, p);
  const childHeadCount = childHeadCountOf(profile);
  if (!emp) return { ...EMPTY, profile, childHeadCount };
  const personId = emp.personId;

  const [, rows, tp3, accumulatedRemuneration] = await Promise.all([
    // THE ADMIN GATE on this person, kept as the existing door it has always been. Its rows are not used:
    // it does not carry `categories`, which is why the countable read below exists.
    listTp1DeclarationsForPersonYear(s, { personId, assessmentYear: p.taxYear }),
    countableDeclarations(s, { personId, assessmentYear: p.taxYear }),
    getTp3ForPersonYear(s, { personId, assessmentYear: p.taxYear }),
    // r361 — the itemisation of the accumulated block. Keyed on the EMPLOYMENT, not the person: the
    // accumulators it sits beside are replayed per employment, and a person holding two concurrent
    // employments has two separate MTD calculations to explain.
    priorRemuneration(s, { employmentId: p.employmentId, taxYear: p.taxYear, month: p.month }),
  ]);

  // ⚠️ THE FEED'S OWN REDUCTION, ASKED THE AGENCY'S TWO QUESTIONS. `throughMonth: p.month` is character
  // for character what core/payroll.ts feeds the kernel for this batch month; `throughMonth: null` is the
  // whole assessment year, which is what the limit check asks and what the printed schedule's Accumulated
  // column means. Neither is a re-spelling of the effective-from rule: the rule is INSIDE this function,
  // which is the entire point of r201/r209. See the header for what happened when this file narrowed,
  // collapsed and then took one row.
  const thisMonth = tp1CountForYear(rows, { throughMonth: p.month });
  const wholeYear = tp1CountForYear(rows, { throughMonth: null });

  const currentDeduction = countedSide(thisMonth);
  const accumulatedDeduction = countedSide(wholeYear);
  // The rebate lines (D1) are keyed in the SAME map: `tp1CountForYear` folds `categories.rebates` into
  // `items` alongside `categories.items`, so one counted column serves the deduction schedule and the
  // rebate schedule both. The rebate section prints no roll-up — TP1_REBATES's own total is discarded by
  // core/tax-relief.ts on purpose — so it carries no total figure here either.
  const currentRebate = currentDeduction ? side(currentDeduction.attributed, currentDeduction.amounts, null) : null;
  const accumulatedRebate = accumulatedDeduction
    ? side(accumulatedDeduction.attributed, accumulatedDeduction.amounts, null)
    : null;

  // Section D of the TP3 — the previous employer's reliefs, keyed c1…c17 exactly as `tp1_relief` keys
  // them, which is why the SAME row builder reads both sides. Only when the form's own deduction year is
  // this payslip's: a declaration for another year seeded nothing and must not be shown as though it did.
  const sectionD = tp3 && tp3.assessmentYear === p.taxYear ? (tp3.payload?.sectionD ?? null) : null;
  const previousDeduction = sectionD ? side(true, { items: sectionD }, null) : null;

  return {
    profile,
    childHeadCount,
    currentDeduction,
    accumulatedDeduction,
    previousDeduction,
    currentRebate,
    accumulatedRebate,
    accumulatedRemuneration,
  };
}
