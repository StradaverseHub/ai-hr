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

/**
 * 2a57a007 — ONE BORROWER'S CONTRIBUTION TO THE POOL, AS DATA.
 *
 * The pool row's Share and Pending Share are SUMS over the borrowers. A sum is not an answer to "who
 * spent it": on a two-borrower pool (production has Emergency → Annual AND Compassionate → Special) the
 * pool row said "3.00 days went somewhere" and stopped. This is the same figure, itemised by the code the
 * days were filed under, so the badge beside the figure, the Explain panel's list and the export's source
 * column all read ONE list rather than each deriving its own.
 *
 * Both figures are POSITIVE — see `SharedLeaveBalanceInfo.contributions` for why the pool row no longer
 * carries a minus.
 */
export type SharedPoolContribution = {
  leaveTypeId: string;
  /** The borrower's name, in the viewer's locale — what a sentence says. */
  leaveType: string;
  /** The borrower's leave CODE ("EL"), or null when the type has none — what a badge shows. */
  code: string | null;
  /** Approved days this borrower drew from the pool. Positive. */
  share: number;
  /** Days this borrower has reserved against the pool awaiting a decision. Positive. */
  pendingShare: number;
};

export type SharedLeaveBalanceInfo = {
  /** The leave type whose LEDGER holds the pool — the one every debit for every member lands on. */
  sourceLeaveTypeId: string;
  sourceLeaveTypeName: string;
  /** Every type that draws on it, source first, in the viewer's locale. Two or more by construction. */
  contributingLeaveTypes: string[];
  /**
   * 2a57a007 — WHAT EACH BORROWER TOOK, itemised, on EVERY member's row (both halves carry the same list,
   * because it is one pool's story and the two rows must not tell it differently).
   *
   * ⚠️ THE FIGURES IN HERE ARE POSITIVE, AND SO IS THE `share` / `pendingShare` COLUMN THEY ADD UP TO.
   * 39136455 modelled the transfer as a SIGNED one — the pool carried −N, the borrower +N — and its header
   * in core/read.ts states the invariant that made the minus safe: *across a pool, sum(balance) equals the
   * pool's own ledger balance, because the shares cancel*. That invariant is about `balance`, and it still
   * holds untouched: a borrower's `balance` is 0 and the pool keeps its own. The DISPLAYED transfer is a
   * different thing — "how many days moved", which has no sign, asked on a grid whose every other figure is
   * a magnitude. The minus read as a deduction taken twice. See core/read.ts where the sign is decided.
   *
   * Optional so every caller and fixture that predates it compiles unchanged; absent ⇒ nothing to itemise,
   * which every reader renders as no badge, no list and an empty export cell rather than as a zero.
   */
  contributions?: SharedPoolContribution[];
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
 * 2a57a007 — IS THIS ROW A BORROWER? Named ONCE, here, because three separate display decisions turn on it
 * and a fourth reader must not re-derive it from a figure:
 *   · the borrower's Taken / Pending Approval columns read 0.00 (its days are reported under Share) —
 *     app/leave/employee-balances/rows.ts;
 *   · the badge and the per-type Explain list belong to the POOL row, not to the borrower's;
 *   · the export's two source columns name the pool on a borrower's row and the borrowers on the pool's.
 *
 * `false` for an ordinary unpooled type AND for the pool's own row, which is what every caller wants: the
 * pool row is not borrowing from itself.
 */
export function isPoolBorrower(row: { leaveTypeId: string; sharedBalance?: SharedLeaveBalanceInfo | null }): boolean {
  return row.sharedBalance != null && row.sharedBalance.sourceLeaveTypeId !== row.leaveTypeId;
}

/**
 * 2a57a007 — the borrowers that actually moved days in ONE of the two columns, in the order core/read.ts
 * built them. A contribution of 0.00 is dropped: a badge reading "EL 0.00 days" beside a Share column that
 * already reads 0.00 is noise, and the absence of a badge is the honest statement that nothing moved.
 *
 * `which` is the column being captioned, so a type that took approved days but has nothing pending gets a
 * badge on Share and none on Pending Share.
 */
export function poolBadges(
  info: SharedLeaveBalanceInfo | null | undefined,
  which: 'share' | 'pendingShare',
): SharedPoolContribution[] {
  return (info?.contributions ?? []).filter((c) => c[which] !== 0);
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
