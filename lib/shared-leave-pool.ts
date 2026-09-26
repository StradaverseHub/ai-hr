/**
 * r341 (8d3a7bff) — ONE CARD FOR ONE POOL: WHICH LEAVE-TYPE CARD A SHARED GROUP'S CEILING BELONGS ON.
 *
 * THE REPORTED FAULT. My Leave drew two cards both headed "Special Leave": the leave TYPE whose ledger holds
 * the days, and — beside it, with the stacked-layers icon — the shared GROUP of the same name. Two cards, one
 * pot, and the reporter read the second as a legacy duplicate.
 *
 * ⚠️ THE TWO SETTINGS BEHIND THOSE TWO CARDS ARE DIFFERENT THINGS AND MUST NOT BE RECONCILED.
 *   · `leave_shared_group` + `leave_shared_group_member` is a COMBINED CEILING — on production, Special
 *     Leave: 10.00 days across CGL CPL EXM GD MRL NDL STD, at most 3.00 per application. Enforced by
 *     `enforceSharedLeaveGroupLimit` (core/leave.ts). It is not a balance and holds no ledger.
 *   · `leave_type.balance_source_type_id` is a LEDGER ROUTE — CPL → SP, NDL → SP. A day of these spends
 *     Special Leave's own ledger. Resolved by `balanceStoryTypeId` (lib/shared-leave-balance.ts).
 * The member sets differ BY DESIGN: merging them would either put five types on a balance they do not draw
 * or drop five from a ceiling that caps them. So this module does not merge the SETTINGS — it merges the two
 * CARDS, by finding the one card whose ledger the group's ceiling is actually a ceiling on.
 *
 * WHAT IT DECIDES, for each placed group:
 *   · MERGED — the card that holds the group's pool. Its own figures are untouched; it gains the ceiling,
 *     the per-application cap and the membership line the group tile used to carry, and the group draws no
 *     tile of its own. That is the "one card" the reporter asked for.
 *   · ALSO-COUNTS — every other member that still draws a card of its own (it holds its own days; see the
 *     gate in core/read.ts). It keeps every figure and gains one line naming the ceiling it counts towards,
 *     so the connection is visible without the balance disappearing. On production that is Marriage Leave,
 *     with 177.00 days across 59 employments, AND IT ALONE: r343 (1478c281) added the second half of that
 *     gate, so CGL/EXM/GD/STD — each holding no days of its own — draw no card and therefore name no ceiling
 *     (and, with the card, lose the r209 caption that explained their 0.00 — see `holdsNothingOfItsOwn`). Nothing here
 *     decides that; this module reads the already-gated card list it is handed, which is why a member's card
 *     returning with its first granted day brings its ceiling line back with it and needs no change here.
 *   · STANDALONE — a group with no pooled member at all, i.e. no card whose ledger is the pot. There is
 *     nothing to merge onto, so it keeps drawing its own tile; folding it away would delete the only place
 *     the ceiling is shown. This is the out-of-the-box shape (`pnpm db:seed` configures no pooled type), so
 *     it is the branch most tenants take and it must stay byte-identical to before.
 *
 * PURE, DB-FREE AND FRAMEWORK-FREE so the RSC that pre-translates the lines and the unit tests that pin the
 * decision share ONE definition of it. Nothing here formats, translates or reads a balance.
 * Substrate: pure derivation, no DomainEvent. // substrate: read-only, no event
 */

/** The only two fields of a balance card this decision reads. `sharedBalance` is core/read.ts's pooling pass. */
export type PoolCardShape = {
  leaveTypeId: string;
  sharedBalance?: {
    sourceLeaveTypeId: string;
    /** The borrowers, itemised (2a57a007). Absent ⇒ nothing itemised, which is not the same as no pool. */
    contributions?: readonly { leaveTypeId: string }[];
  } | null;
};

/** The only two fields of a shared group this decision reads. */
export type CeilingGroupShape = {
  id: string;
  members: readonly { id: string }[];
};

export type SharedGroupCeilingPlan<G extends CeilingGroupShape> = {
  /** leaveTypeId → the group whose ceiling merges ONTO that card. At most one group per card. */
  mergedOnto: Map<string, G>;
  /** leaveTypeId → the groups it counts towards while keeping its own balance and its own card. */
  alsoCounts: Map<string, G[]>;
  /** Groups with no card holding their pool. They keep drawing their own tile, in the order given. */
  standalone: G[];
};

/**
 * Is this card the one whose LEDGER is a pool? `sharedBalance` is set on every member of a pool by
 * core/read.ts, and the source's row is the one whose id it points back at (`isPoolBorrower`'s complement).
 */
function poolLedgerOf(card: PoolCardShape): Set<string> | null {
  const info = card.sharedBalance;
  if (info == null || info.sourceLeaveTypeId !== card.leaveTypeId) return null;
  return new Set([card.leaveTypeId, ...(info.contributions ?? []).map((c) => c.leaveTypeId)]);
}

/**
 * Assign every placed shared group to the card that holds its pool, or to nothing.
 *
 * `cards` is the list as the employee will see it — already gated, already folded (core/read.ts). That
 * matters in both directions: a borrower whose card was folded is absent here, and its id is still reachable
 * through the POOL card's `contributions`, which is why the match is made against the pool's whole member
 * list rather than against the ids present in `cards`.
 *
 * ⚠️ DETERMINISTIC WITH NO SORT OF ITS OWN. Ties are broken by the order `cards` arrives in — the order the
 * server already decided and the screen already renders — because a group that merged onto a different card
 * between two page loads would read as the figures having moved.
 */
export function planSharedGroupCeilings<G extends CeilingGroupShape>(
  cards: readonly PoolCardShape[],
  groups: readonly G[],
): SharedGroupCeilingPlan<G> {
  const mergedOnto = new Map<string, G>();
  const alsoCounts = new Map<string, G[]>();
  const standalone: G[] = [];
  // Built once: one pass over the cards rather than one per group.
  const pools: { leaveTypeId: string; members: Set<string> }[] = [];
  for (const c of cards) {
    const members = poolLedgerOf(c);
    if (members) pools.push({ leaveTypeId: c.leaveTypeId, members });
  }
  const cardIds = new Set(cards.map((c) => c.leaveTypeId));
  for (const g of groups) {
    const memberIds = new Set(g.members.map((m) => m.id));
    // The pool this group's days actually live in: a pool is the group's when the group HAS a member drawing
    // on it. A card already carrying another group's ceiling is not taken twice — two groups sharing one
    // pool ledger is a configuration nothing in the product creates, and silently stacking two ceilings on
    // one card would print two contradictory limits for one figure.
    const host = pools.find(
      (p) => !mergedOnto.has(p.leaveTypeId) && [...p.members].some((id) => memberIds.has(id)),
    );
    if (!host) {
      // STANDALONE, AND NOTHING ELSE CHANGES. Its tile still says what the ceiling is and who is in it, so
      // repeating that on each member's card would add a line to every tenant that has a group and no pooled
      // type — the out-of-the-box shape. The ceiling line exists to carry information the vanished tile was
      // the only holder of; there is no vanished tile here.
      standalone.push(g);
      continue;
    }
    mergedOnto.set(host.leaveTypeId, g);
    // Every member that still draws a card of its own, except the host itself, names the ceiling instead.
    for (const id of memberIds) {
      if (!cardIds.has(id) || id === host.leaveTypeId) continue;
      const list = alsoCounts.get(id);
      if (list) list.push(g);
      else alsoCounts.set(id, [g]);
    }
  }
  return { mergedOnto, alsoCounts, standalone };
}
