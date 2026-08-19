/**
 * r209 — ONE SHARED FIGURE, AND THE TYPES THAT SHARE IT, NAMED.
 *
 * `leave_type.balance_source_type_id` (cdf9ca48) makes a leave type spend ANOTHER type's balance. Emergency
 * Leave draws on Annual Leave on production today, and the ENGINE has always honoured it: the submit guard
 * and the approval debit both move to the source type (`resolveBalanceSourceTypeId`), and the pending
 * reservation covers every type that spends it (`balanceSpenderTypeIds`).
 *
 * THE READ DID NOT. `leaveBalances` grouped the ledger by leave type, so a borrowing type showed its own,
 * permanently empty ledger — Emergency Leave 0.00, beside an Annual Leave balance the employee could in
 * fact spend on it, with nothing on screen naming the connection. That is the shape this descriptor exists
 * to end: the figure is the pool's, and the caption says whose.
 *
 * A SEPARATE MECHANISM FROM SHARED LEAVE GROUPS, and they must not be confused. A shared GROUP
 * (core/leave-shared-group.ts) caps what may be TAKEN across several types in a year; it says nothing about
 * where days come from. This says the days come from one ledger. Both can exist on one tenant.
 *
 * Pure and DB-free so the server read that builds it and the client grids that caption it share one shape.
 * Substrate: pure type + derivation, no DomainEvent. // substrate: read-only, no event
 */

export type SharedLeaveBalanceInfo = {
  /** The leave type whose LEDGER holds the pool — the one every debit for every member lands on. */
  sourceLeaveTypeId: string;
  sourceLeaveTypeName: string;
  /** Every type that draws on it, source first, in the viewer's locale. Two or more by construction. */
  contributingLeaveTypes: string[];
};

/**
 * The types this row shares with, EXCLUDING the row itself — what a caption on that row should list.
 *
 * Naming a type as sharing with itself reads as a bug to the person looking at it, and on the SOURCE row
 * ("Annual Leave shares with Annual Leave") it is one. Returns an empty list when nothing else is in the
 * pool, which a caller renders as no caption at all rather than as an empty sentence.
 */
export function otherContributors(info: SharedLeaveBalanceInfo, leaveTypeName: string): string[] {
  return info.contributingLeaveTypes.filter((n) => n !== leaveTypeName);
}

/**
 * WHOSE ENTITLEMENT STORY A BALANCE ROW TELLS — the leave type whose `leaveEntitlementBreakdown` explains
 * the figures printed on this row. Itself for an ordinary type; THE POOL for a borrower.
 *
 * ⚠️ THIS IS NOT A REFINEMENT, IT IS THE OTHER HALF OF THE POOLING PASS, AND THE FIRST CUT SHIPPED WITHOUT
 * IT. `leaveBalances` replaces a borrower's `balance` / `accrued` / `taken` / `available` with the SOURCE's,
 * because the source's ledger IS the pool. Every OTHER figure on the row — YTD Entitled, Carried Forward,
 * Adjustment, Forfeited — and the entitlement STATUS come from the breakdown, and a borrower's own
 * breakdown describes a leave type that has no entitlement table and never will. Reading it beside the
 * pooled figures produced a row that contradicted itself:
 *
 *     Emergency Leave · YTD Entitled 0.00 · Carried Forward 0.00 · Balance 10.00
 *     ⚠ "This leave type has no entitlement table set up, so there is no number of days for anybody to be
 *        granted. Create an entitlement table for it."
 *
 * — a red notice, over days the employee can in fact spend, instructing HR to do the one thing that would
 * be wrong (a borrower with its own table would stop borrowing). The pool's breakdown is the true story of
 * where those days came from, so it is the one every grid tells, and the shared caption beside it says
 * whose figure it is.
 *
 * Returns the row's own id when nothing is pooled, so an ordinary type takes an identity path.
 */
export function balanceStoryTypeId(row: {
  leaveTypeId: string;
  sharedBalance?: SharedLeaveBalanceInfo | null;
}): string {
  return row.sharedBalance ? row.sharedBalance.sourceLeaveTypeId : row.leaveTypeId;
}
