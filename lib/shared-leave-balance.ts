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
 * r343 (1478c281) — DOES THIS ROW HOLD ANYTHING OF ITS OWN? The OTHER question the card-folding rule asks.
 *
 * `isPoolBorrower` above answers "is this row's balance somebody ELSE's". This answers "is there anything on
 * this row for a card to show". The two are read TOGETHER, in ONE place — the a0b90c81 gate in core/read.ts —
 * so a future reader sees the whole rule at once instead of finding half of it there and half of it in a
 * second filter somewhere else.
 *
 * WHY IT EXISTS. r341 narrowed the fold to the pooling pointer, which was right: before it, EVERY member of a
 * placed shared group lost its card, so Marriage Leave's 177.00 days were invisible to 59 employments. But it
 * also made FOUR cards APPEAR that had none — Caregiver, Examination, Graduation and Study, each reading
 * 0.00 — on a ticket whose whole point was FEWER cards. A member card that holds nothing of its own tells the
 * employee nothing the merged card does not already say, so it draws no card.
 *
 * ⚠️ WHICH FIGURES IT READS — EXACTLY THE FOUR THE CARD WOULD HAVE PRINTED, AND NOTHING ELSE. `accrued`,
 * `taken`, `pending` and `balance`, as `leaveBalances` derives them for THIS leave type from `leave_ledger`
 * (accruals, debits, adjustments) and from this type's own undecided requests. So "draws no card" and "the
 * card would have read four zeros" are one sentence, checkable against the screen rather than inferred.
 * Measured on production 2026-09-26: MRL holds 177.00 ledger days across 59 employments and keeps its card;
 * CGL, EXM, GD and STD hold 0.00 and lose theirs.
 *
 * ⚠️ THREE DIFFERENT KINDS OF NOTHING, AND THIS IS DELIBERATELY ONLY THE FIRST. A zero balance, an
 * unconfigured entitlement and a cycle that has not opened are three different states of the world:
 *
 *  1. NOTHING ON THE LEDGER FOR THIS PERSON — what this reads. No accrual, no debit, no adjustment and no
 *     pending request: there is no figure to print. It is a statement about this EMPLOYMENT, so two
 *     colleagues in the same group can honestly see a different number of cards.
 *
 *  2. NO ENTITLEMENT TABLE CONFIGURED — NOT read, and it must not be. That is a statement about HR's
 *     configuration rather than about this employee; it lives in the breakdown (`leaveEntitlementBreakdown`,
 *     a query per row rather than a field already on the row); and r209's trap is precisely what happens when
 *     a display decision starts consulting a member's own entitlement story — see `balanceStoryTypeId` below
 *     for the red "create an entitlement table for it" notice it printed over days the employee could in fact
 *     spend. The two states are not even the same set: a type WITH a table that has granted this person
 *     nothing still reads four zeros, and a type with NO table that was granted days by adjustment holds
 *     something.
 *
 *  3. A CYCLE THAT HAS NOT OPENED YET — NOT read either. On the self-service path these figures are the WHOLE
 *     ledger, so a type that has ever held a day still holds something and keeps its card. A card that came
 *     and went with the leave year would read as the days having been taken away.
 *
 * ⚠️ AND THE CARD COMES BACK BY ITSELF. Because the condition reads the ledger and not a list of type names
 * or a switch, granting one day to a hidden member puts its card back on the next page load, carrying that
 * day. Nothing needs un-hiding and nobody needs to remember anything.
 *
 * ⚠️ IT SAYS NOTHING ABOUT THE RIGHT TO APPLY. `mayAppearInApplyMenu` does not consult this and must not: an
 * employee whose Caregiver Leave card is hidden may still apply for Caregiver Leave. That distinction is the
 * whole of item a0b90c81.
 *
 * WHY THIS DOES NOT COLLAPSE INTO `isPoolBorrower`, which matters because a borrower's `accrued` and
 * `balance` ARE zeroed by the pooling pass: `taken` and `pending` are FILED-TYPE attributed (690d4400), so a
 * borrower that has taken or reserved days holds something by this predicate and is folded by the POINTER —
 * the other reason, and a different one. Both directions are pinned in
 * test/1478c281-empty-member-cards.test.ts.
 */
export function holdsNothingOfItsOwn(row: {
  accrued: number;
  taken: number;
  pending: number;
  balance: number;
}): boolean {
  // `=== 0` accepts `-0` (they compare equal), which is what the rounding upstream can produce and what the
  // card would print as "0.00" anyway.
  return row.accrued === 0 && row.taken === 0 && row.pending === 0 && row.balance === 0;
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

/**
 * 2a57a007 (r340) — THE BORROWER'S OWN ENTITLEMENT, WHICH IS NOTHING, SAID AS A NORMAL FACT.
 *
 * `balanceStoryTypeId` above points a borrower's BALANCE STORY at the pool, and that is right: the pool's
 * ledger is where those days live. It also, and not by design, pointed the borrower's own ENTITLEMENT
 * columns at the pool — so Emergency Leave printed Annual Leave's Entitlement (7.00), Annual Leave's Earned
 * to Date (2.50) and Annual Leave's entitlement TABLE NAME, beside a Balance of 0.00. A row cannot hold
 * seven days of entitlement and no balance at once; the reporter said so and was right.
 *
 * ⚠️ WHY THIS IS NOT "POINT THE BREAKDOWN AT THE BORROWER" — READ `balanceStoryTypeId` ABOVE FIRST. r209
 * shipped exactly that and produced the worst possible screen: a borrower reading its own (permanently
 * empty) breakdown printed a RED "create an entitlement table for it" notice, which is the one instruction
 * that would END the borrowing this arrangement exists for. The pool's breakdown stays the source of the
 * balance story. What changes is narrower: the two columns that are statements about THIS leave type read
 * this type's own facts, and the diagnostic that fires on a missing table is told which kind of missing it
 * is looking at.
 *
 * TWO SITUATIONS, TOLD APART. `balance_source_type_id` non-null already IS "this type has no table BECAUSE
 * it borrows" — normal, and it should read as normal. Everything else with no table has one BY MISTAKE, and
 * that is the state r209's notice exists to raise. The distinction is in the data; only the presentation
 * conflated them. `pooledEntitlementCaption` below is that distinction, named once, so the screen's caption
 * and the export's status column cannot decide it two different ways.
 */

export type PooledEntitlementCaption = {
  /** The i18n leaf under `me.leaveBalanceTable` naming the arrangement. */
  labelKey: 'statusPooledEntitlement';
  /** The leaf carrying the hover explanation of why the absence of a table is CORRECT here. */
  tipKey: 'statusPooledEntitlementTip';
  /** The pool's leave-type name, interpolated as `{pool}`. */
  pool: string;
};

/**
 * THE POOLED CAPTION, OR NULL — and null means "say whatever you said before, exactly as before".
 *
 * `entitlementFromPool` is the pool's leave-type NAME on a BORROWER's row (set by
 * app/leave/employee-balances/rows.ts off `isPoolBorrower`), null on the pool's own row and on every type in
 * no pool. When it is set it OUTRANKS `entitlementStatus`, because that status was resolved for the POOL,
 * and because r209's amber diagnostic must not fire here at all.
 *
 * ⚠️ DELIBERATELY NARROW: this decides the POOLED branch only and leaves `ENTITLEMENT_STATUS_LABEL_KEY` /
 * `ENTITLEMENT_STATUS_TIP_KEY` / `entitlementStatusNeedsNotice` reading exactly as they read before on every
 * other row — which is what keeps 31e39d74's and r266's cross-surface guards pinning the thing they were
 * written to pin. A `null` return is the statement that this row is not the case this item is about.
 */
export function pooledEntitlementCaption(row: { entitlementFromPool: string | null }): PooledEntitlementCaption | null {
  return row.entitlementFromPool == null
    ? null
    : { labelKey: 'statusPooledEntitlement', tipKey: 'statusPooledEntitlementTip', pool: row.entitlementFromPool };
}
