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
 * (`listEmployees`, `getTp1AccumulatedForPerson`, `listTp1DeclarationsForPersonYear`,
 * `getTp1ByIdForPerson`, `getTp3ForPersonYear`), and the one query written here is fenced on the
 * caller's own `companyIds` and fails CLOSED on an empty scope — the same posture, and the same
 * two-line shape, as every read in core/payroll-view.ts. An out-of-scope employment returns null, so a
 * tampered `payslipId` is indistinguishable from a payslip that does not exist.
 *
 * ⚠️ AND IT WRITES NOTHING AND RECORDS NOTHING. Explaining a deduction is a read.
 *
 * ── WHICH DECLARATION IS "THE CURRENT MONTH'S", AND WHY IT IS NOT A `WHERE` CLAUSE ──────────────────
 * `tp1EffectiveFromMonth` is the rule — Section F's approved-for month, then the deduction month, then
 * January — and it lives in TypeScript because r201/r209 proved what happens when two halves of the
 * system each answer it for themselves: the payroll feed summed legacy rows the limit check skipped, and
 * money moved. So this file NEVER compares `deduction_month` in SQL. It takes the year's rows from the
 * shared read, narrows them with the exported rule, and collapses newest-wins with the exported
 * collapse — the same two functions, in the same order, as the feed that actually fed the kernel.
 *
 * ── TODAY'S DECLARATION, NOT A STAMP FROM THE RUN, AND THE SCREEN SAYS SO ───────────────────────────
 * The payslip's `pcbMeta` carries ΣLP and LP1 as COMBINED totals; there is no per-category stamp, and
 * this item may not change what a payslip records. So these are the employee's CURRENT declarations. If
 * they were edited after the run, the itemisation will differ from the totals the worksheet above shows
 * — which is the identical posture, and carries the identical warning, as `reliefSource: 'current'` and
 * as `previousEmploymentForPayslip`.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '@/db/client';
import { employment, employeeStatutoryMy, isTp1Categories2026 } from '@/db/schema';
import { listEmployees } from '@/core/read';
import {
  TP1_ITEMS,
  TP1_REBATES,
  collapseTp1ApprovedByMonth,
  getTp1AccumulatedForPerson,
  getTp1ByIdForPerson,
  listTp1DeclarationsForPersonYear,
  tp1EffectiveFromMonth,
} from '@/core/tax-relief';
import { getTp3ForPersonYear } from '@/core/tp3';
import type { PcbChildProfile, PcbSlipCatalogueItem, PcbSlipSide } from '@/core/pcb-explain';

/** Everything the four new sections need, resolved. Every member is independently nullable, because a
 *  missing declaration and a missing child grid are different absences and the screen says which. */
export type PcbSlipData = {
  /** `employee_statutory_my` — the tax position the reporter's section 1 and section 2 ask for. */
  profile: (PcbChildProfile & { taxCategory: number | null }) | null;
  /** The relief declaration in force for THIS payroll month, itemised. */
  currentDeduction: PcbSlipSide | null;
  /** The year's counted attribution — the ACCUMULATED column of the agency's own schedule. */
  accumulatedDeduction: PcbSlipSide | null;
  /** The previous employer's Section D, itemised (reporter section 4). */
  previousDeduction: PcbSlipSide | null;
  /** The same two sides again for the Section D rebate lines (reporter section 8). */
  currentRebate: PcbSlipSide | null;
  accumulatedRebate: PcbSlipSide | null;
};

/** The agency's schedule as the pack declares it, narrowed to what the row builder reads. */
export const SLIP_ITEMS: readonly PcbSlipCatalogueItem[] = TP1_ITEMS;
export const SLIP_REBATES: readonly PcbSlipCatalogueItem[] = TP1_REBATES;

const EMPTY: PcbSlipData = {
  profile: null,
  currentDeduction: null,
  accumulatedDeduction: null,
  previousDeduction: null,
  currentRebate: null,
  accumulatedRebate: null,
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
): Promise<(PcbChildProfile & { taxCategory: number | null }) | null> {
  if (p.companyIds.length === 0) return Promise.resolve(null);
  return withTenant(s, async (tx) => {
    const [row] = await tx
      .select({
        taxCategory: employeeStatutoryMy.taxCategory,
        childReliefMode: employeeStatutoryMy.childReliefMode,
        childReliefTable: employeeStatutoryMy.childReliefTable,
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
      disabledIndividual: row.disabledIndividual,
      disabledSpouse: row.disabledSpouse,
    };
  });
}

/** A declaration's per-line figures, or the "counts but carries no attribution" signal. */
const side = (attributed: boolean, amounts: PcbSlipSide['amounts'], total: unknown): PcbSlipSide => ({
  attributed,
  amounts,
  total,
});

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
  if (!emp) return { ...EMPTY, profile };
  const personId = emp.personId;

  const [months, counted, tp3] = await Promise.all([
    listTp1DeclarationsForPersonYear(s, { personId, assessmentYear: p.taxYear }),
    // The whole year, nothing excluded: this is the ACCUMULATED column, which is the agency's own
    // question and the same figure the printed TP1 prints.
    getTp1AccumulatedForPerson(s, { personId, assessmentYear: p.taxYear, deductionMonth: null }),
    getTp3ForPersonYear(s, { personId, assessmentYear: p.taxYear }),
  ]);

  // THE RULE, NOT A QUERY. Narrow to what was in force by this payroll month, THEN collapse newest-wins
  // per month — in that order, because collapsing first hands back an August correction for March and
  // then drops it, deleting the original's money from every month between (core/tax-relief.ts, r209).
  const inForce = months.filter((r) => r.status === 'approved' && tp1EffectiveFromMonth(r) <= p.month);
  const winner = collapseTp1ApprovedByMonth(inForce).sort(
    (a, b) => tp1EffectiveFromMonth(b) - tp1EffectiveFromMonth(a) || (b.deductionMonth ?? 0) - (a.deductionMonth ?? 0),
  )[0];
  const row = winner ? await getTp1ByIdForPerson(s, { personId, id: winner.id }) : null;
  const payload = row && isTp1Categories2026(row.categories) ? row.categories : null;

  // A declaration exists but predates the catalogue: its money is real and counted, and there is no
  // honest way to split it across C1–C17 (core/tax-relief.ts says so in as many words). `attributed:
  // false` is what makes every line read "recorded only in combination" rather than "not recorded".
  const currentDeduction = row ? side(payload != null, payload ? { items: payload.items } : null, row.tp1Amount) : null;
  const currentRebate = row
    ? side(payload != null, payload?.rebates ? { items: payload.rebates } : null, null)
    : null;

  // The year's counted attribution. `unattributedTotal` above zero means some counted money carries no
  // C1–C17 attribution, so the per-line figures are incomplete — the section's note says so rather than
  // letting a reader add up seventeen lines and wonder why they miss the total.
  const accumulatedItems: PcbSlipSide['amounts'] = {
    items: Object.fromEntries(
      Object.entries(counted.items).map(([code, amount]) => [
        code,
        { amount, subItems: counted.subItems[code] ?? {} },
      ]),
    ),
  };
  const accumulatedDeduction = side(true, accumulatedItems, counted.total);
  const accumulatedRebate = side(true, accumulatedItems, null);

  // Section D of the TP3 — the previous employer's reliefs, keyed c1…c17 exactly as `tp1_relief` keys
  // them, which is why the SAME row builder reads both sides. Only when the form's own deduction year is
  // this payslip's: a declaration for another year seeded nothing and must not be shown as though it did.
  const sectionD = tp3 && tp3.assessmentYear === p.taxYear ? (tp3.payload?.sectionD ?? null) : null;
  const previousDeduction = sectionD ? side(true, { items: sectionD }, null) : null;

  return {
    profile,
    currentDeduction,
    accumulatedDeduction,
    previousDeduction,
    currentRebate,
    accumulatedRebate,
  };
}
