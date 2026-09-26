/**
 * Item 20837372 (r345) — WHAT ONE KEYED TP3 SECTION C BOX CONTRIBUTES, AND WHAT IT DOES NOT.
 *
 * ── WHY THIS IS A MODULE AND NOT FOUR EXPRESSIONS IN THE PAGE ───────────────────────────────────────
 * r342 made the ARITHMETIC hold each Section C line to its statutory limit. It did not make the screen
 * say so, and the reporter contested the item a third time for exactly that reason: the capping was
 * correct and invisible, so the only way to tell it worked was to do the sum by hand.
 *
 * The four figures below are what the screen prints beside each box. They are derived here, once, so
 * that a test can assert them against the reporter's own worked examples — an expression buried in JSX
 * can only be asserted by reading the file back as a string, which proves the code was written, not
 * that it computes the right number.
 *
 * ⚠️ THIS IS A PRESENTATION HELPER AND NOT A SECOND AUTHOR OF THE FIGURE THE TAX USES. The totals on
 * that screen are read off `Tp3AccumulatorSeed` (`exemptTotal`, `epfAllowable`), NOT summed from these.
 * `core/tp3.ts` remains the only place that decides what the calculation may use; this decides only how
 * one line is explained. Keeping the two apart is what stops them disagreeing — which is the defect the
 * whole item exists to correct, in the other direction.
 */

/** The four figures shown beside one Section C box. `null` means "no claim is being made". */
export type Tp3LineFigures = {
  /** The part of the keyed amount the calculation is allowed to use. */
  exempt: number | null;
  /** The part above the limit, which stays taxable. NULL where no limit is sourced. */
  excess: number | null;
  /** What is left of the limit. NULL where no limit is sourced. */
  remaining: number | null;
};

/**
 * ⚠️ `limit === null` MEANS NO LIMIT IS SOURCED — which is NOT a limit of infinity and NOT a limit of
 * zero. Such a line contributes whole, so `exempt` is the keyed figure and `excess` / `remaining` are
 * null: the screen leaves those cells EMPTY rather than printing `0.00`.
 *
 * A `0.00` excess asserts "we checked, and nothing is over". For a line with no sourced limit that is a
 * claim this repo cannot make, and CLAUDE.md §8 is explicit that an absent box asserts nothing while
 * `0.00` asserts the money does not exist. C2(iii) and C2(v) carry no printed limit and must therefore
 * show blank cells, not zeroes.
 *
 * An empty box behaves the same way: nothing keyed is not the same statement as "nil is exempt", so
 * `exempt` is null until a figure exists.
 */
export function tp3LineFigures(
  entered: number | null | undefined,
  limit: number | null | undefined,
): Tp3LineFigures {
  const v = Number(entered ?? 0);
  if (limit == null) return { exempt: v > 0 ? v : null, excess: null, remaining: null };
  return {
    exempt: Math.min(v, limit),
    excess: Math.max(v - limit, 0),
    remaining: Math.max(limit - v, 0),
  };
}
