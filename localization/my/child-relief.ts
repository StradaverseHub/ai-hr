/**
 * MY child relief — THE ONE PLACE the qualifying-children COUNT and the RINGGIT are worked out
 * (item 04b88724, r340 fix pass).
 *
 * WHY THIS FILE EXISTS, stated plainly because the round that skipped it shipped the exact defect the
 * approved plan predicted. The plan said: "Expose the COUNT alongside the AMOUNT from that one function
 * rather than computing units in the view — two call sites that each work out C is exactly the
 * duplicate-source-of-truth problem CLAUDE.md section 1 forbids. Put it where both payroll and the screen
 * read it." The first attempt left the amount in the pack and re-derived the count in TWO other places —
 * core/dependents.ts and components/identity-tax-card.tsx — and the screen read the wrong one, printing a
 * child-relief figure in ringgit that this repo's own PCB kernel contradicted. There is now exactly one
 * derivation, and it is here.
 *
 * WHAT "ONE DERIVATION" MEANS CONCRETELY:
 *   · `childReliefPrices` is the only place `units = amountRM ÷ perChild` is written. LHDN's specification
 *     prices each s.48 category as a number of QUALIFYING CHILDREN ("considered with 4 children") and the
 *     ruleset stores the ringgit; the two are the same statement and this converts between them once.
 *   · `childReliefFor` is the only walk of a keyed grid, and the only place a 50%-shared child is halved.
 *   · `childReliefAmountFor` (./payroll.ts — the function the payroll kernel calls) is now this function's
 *     `.amountRM`, so the money on the payslip and the count on the screen cannot come apart: they are two
 *     fields of one return value.
 *
 * CLIENT-SAFE BY CONSTRUCTION. The Identification & Tax card is an interactive island: it has to price a
 * grid WHILE the admin types into it, so it cannot wait for a server round trip, and handing it a copy of
 * the arithmetic is what went wrong the first time. It therefore calls this same function through the
 * client seam (`CountryPackClient.payroll.childReliefFor`, localization/registry.client.ts). That is why
 * this is a LEAF: it imports only ./statutory-tables (pure data) and type-only from ../country-pack, so
 * nothing db-backed can reach a client bundle through it. Do not import db/client, a server action or
 * next-intl/server here — see the header of ./client.ts for what that would drag in.
 *
 * An explicit tax category applies HASiL 2026 MTD eligibility: category 1 has C = 0.
 * Omitted categories retain raw pricing for family/category reference calculations.
 */
import type { ChildReliefFigure, ChildReliefInput, ChildReliefPrice, ChildReliefRow } from '../country-pack';
import {
  CHILD_RELIEF_CATEGORY_KEYS,
  DEFAULT_MY_STATUTORY,
  type StatutoryRuleset,
} from './statutory-tables';

/** A keyed count is a whole number of children, zero or more. Anything else contributes nothing — an
 *  unparseable cell is a data error, not a reason to fail a payroll run (the setter drops it on write). */
const whole = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;

/**
 * What the resolved ruleset prices each s.48 category at, in the canonical order
 * `CHILD_RELIEF_CATEGORY_KEYS` declares: the RINGGIT and the QUALIFYING-CHILDREN COUNT.
 *
 * The ringgit comes from `pcb.reliefs.childByCategory`, falling back to the pack's built-in map when the
 * resolved ruleset predates 2026.7 — the same optional-with-fallback shape `childReliefAmountFor` has
 * always had, so a stored override that omits the map keeps computing byte-identically.
 *
 * The COUNT is `amountRM ÷ perChild`, which is exact by construction rather than by coincidence: every
 * figure in `childByCategory` IS the specification's qualifying-children count multiplied by the RM2,000
 * per-child relief, which localization/my/statutory-tables.ts states per value with its printed-page
 * citation and test/child-relief-figures-04b88724.test.ts asserts. A ruleset with a zero or missing
 * per-child figure prices no counts at all (0 rather than Infinity), and the caller then shows the ringgit
 * alone rather than a number nobody can read.
 */
export function childReliefPrices(reliefs?: StatutoryRuleset['pcb']['reliefs']): ChildReliefPrice[] {
  const amounts = reliefs?.childByCategory ?? DEFAULT_MY_STATUTORY.pcb.reliefs.childByCategory ?? {};
  const perChild = reliefs?.perChild ?? DEFAULT_MY_STATUTORY.pcb.reliefs.perChild;
  const divisor = typeof perChild === 'number' && Number.isFinite(perChild) && perChild > 0 ? perChild : 0;
  const priced: ChildReliefPrice[] = [];
  for (const key of CHILD_RELIEF_CATEGORY_KEYS) {
    const amountRM = amounts[key];
    if (typeof amountRM !== 'number' || !Number.isFinite(amountRM)) continue;
    priced.push({ key, amountRM, units: divisor > 0 ? amountRM / divisor : 0 });
  }
  return priced;
}

/**
 * ONE employee's child relief: the qualifying-children COUNT, the RINGGIT, and the working behind them.
 *
 * Two inputs, because this repo's PCB kernel has exactly two child legs and no third:
 *   `from: 'table'`      — the 'auto_table' mode's keyed grid, priced category by category. This is the
 *                          expression core/payroll.ts (~5625) and core/payroll-view.ts (~1487) use for an
 *                          employee in that mode, via `childReliefAmountFor`.
 *   `from: 'headCount'`  — every other mode: `num_children × perChild`, which makes the qualifying count
 *                          equal to the head count. 'manual' and 'auto' both land here, and an eligible
 *                          child in 'auto' is therefore worth ONE qualifying child whatever category is
 *                          recorded against it. Printing its category's units instead would print a
 *                          figure the payslip denies (CLAUDE.md §8).
 *
 * `rows` is the working: one line per priced grid cell, split by claim share so "claimed in full or
 * shared" is visible rather than averaged away. A head count has no per-category working, so its `rows`
 * is empty — the caller that wants per-child lines (the Family register) builds them from the children it
 * holds, each one unit, which is this function's own head-count answer for a single child.
 *
 * ROUNDING: none, deliberately. A 50%-shared child is worth half its category's ringgit, so it is worth
 * half a qualifying child (one shared child under 18 ⇒ QC 0.5, RM1,000). Rounding the count here would
 * make it disagree with the money beside it, and the money is what the payslip deducts. The projection of
 * P is truncated once, downstream, exactly as it is today. What LHDN's specification intends QC to read as
 * in a shared-claim case is NOT known — see the note in core/dependents.ts.
 */
/** HASiL 2026 computerised MTD specification, category 1: C = 0 (page 10). */
export const childReliefAllowed = (category: number | undefined) => category !== 1;

export function childReliefFor(p: ChildReliefInput): ChildReliefFigure {
  if (p.from === 'headCount') {
    const children = childReliefAllowed(p.taxCategory) ? whole(p.children) : 0;
    const perChild =
      typeof p.perChild === 'number' && Number.isFinite(p.perChild) ? Math.max(0, p.perChild) : 0;
    return { units: children, amountRM: children * perChild, rows: [] };
  }
  const { table } = p;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return { units: 0, amountRM: 0, rows: [] };
  const grid = table as Record<string, unknown>;
  const rows: ChildReliefRow[] = [];
  let units = 0;
  let amountRM = 0;
  for (const price of p.prices) {
    const cell = grid[price.key];
    if (!cell || typeof cell !== 'object') continue;
    const c = cell as { full?: unknown; half?: unknown };
    // One line PER SHARE. A 50% child is worth exactly half the category, in ringgit AND in units.
    for (const [sharePercent, children, unitEach, rateEach] of [
      [100, whole(c.full), price.units, price.amountRM],
      [50, whole(c.half), price.units / 2, price.amountRM / 2],
    ] as const) {
      if (children === 0) continue;
      const lineUnits = childReliefAllowed(p.taxCategory) ? children * unitEach : 0;
      const lineRM = childReliefAllowed(p.taxCategory) ? children * rateEach : 0;
      units += lineUnits;
      amountRM += lineRM;
      rows.push({ category: price.key, sharePercent, children, units: lineUnits, amountRM: lineRM });
    }
  }
  return { units, amountRM, rows };
}
