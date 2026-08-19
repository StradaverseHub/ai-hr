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
