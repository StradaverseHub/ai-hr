import type { SessionContext } from '@/db/client';
import { leaveBalances, leaveEntitlementBreakdown } from '@/core/read';
import { deriveBalanceRow } from '@/components/leave/leave-balance-row';
// r242 — TYPE ONLY. The import is erased at compile time, so this server module pulls in no client runtime
// (the same reason `leave-cards.tsx` names this type rather than the component). It is the side-sheet's
// structural mirror of the breakdown `leaveEntitlementBreakdown` returns, and naming it here is what lets a
// row CARRY the breakdown it was derived from instead of the screen fetching one for itself.
import type { EntitlementBreakdownData } from '@/components/leave/EntitlementBreakdown';
import type { EntitlementStatus } from '@/lib/entitlement-status';
import { balanceStoryTypeId, isPoolBorrower, type SharedLeaveBalanceInfo } from '@/lib/shared-leave-balance';

/**
 * The Employee Balances table body (feedback 20c699f8), shared by the screen and its export so a
 * downloaded file can never disagree with what was on screen when it was downloaded.
 *
 * Sources are the employee's OWN two reads (`leaveBalances` + `leaveEntitlementBreakdown`) mapped through
 * the same pure `deriveBalanceRow` — a second derivation for HR would drift from the employee's screen and
 * the figure HR quotes would be the wrong one. The one deliberate difference: `essView` is emptied, because
 * per-component ESS hiding is a rule about SELF-SERVICE, not about what HR may look at.
 *
 * r242 — THE EXPLAIN BUTTON RIDES ON THAT SAME PAIR OF READS. Each row now carries the breakdown object it
 * was derived from (plus the balance row's `available` and per-type visual), which the screen hands to the
 * existing read-only side-sheet. Nothing here is recomputed and nothing is read twice: the button explains
 * the row beside it because it is literally holding the row's own working. If you ever need another figure
 * in that panel, take it off `b` or off `bd` — the moment it comes from anywhere else, HR's explanation and
 * HR's grid start answering as of two different instants.
 */
export type EmployeeBalanceRow = {
  leaveTypeId: string;
  leaveType: string;
  code: string;
  /** Leave-year/cycle the breakdown reconstructed against; null when no breakdown resolved. */
  entitlementYear: string | null;
  /** r279 — the EARNED TO DATE column. Field name unchanged (it is a stored ESS component key); only the
   *  label moved, and the carry it used to include came out. See components/leave/leave-balance-row.ts. */
  ytdEntitled: number | null;
  /** r279 — the FULL ENTITLEMENT column: `bd.eligibleDays`, the same figure the Explain button beside this
   *  row already shows as Eligible. Carried off the SAME `bd` as every other figure here, so the grid and
   *  the panel cannot quote two different full-year allowances. */
  fullEntitlement: number | null;
  /** 39136455 — the pooled TRANSFER, between Adjustment and Balance. Carried off the same
   *  `deriveBalanceRow` the employee's own grid uses, so HR's column and the employee's cannot disagree
   *  about how many days moved.
   *  2a57a007 — POSITIVE ON BOTH HALVES now (the pool's row used to carry a minus); the sign, and why the
   *  pooled-balance invariant is unaffected by it, are decided and explained in core/read.ts. */
  share: number | null;
  pendingShare: number | null;
  /** 31e39d74 — why YTD Entitled reads what it reads. Same value the employee's own screen shows, through
   *  the same `deriveBalanceRow`, so HR and the employee are never told two different stories about a 0.00. */
  entitlementStatus: EntitlementStatus;
  /** r209 — WHICH entitlement table this employee actually resolved to, so HR can confirm the right one was
   *  chosen instead of inferring it from the day count. Already computed by the breakdown (the winning
   *  template's name); it simply had no reader on this screen. null ⇒ nothing resolved, which the status
   *  beside it now explains in words. */
  entitlementTemplateName: string | null;
  /** 2a57a007 (r340) — THE POOL THIS ROW'S DAYS COME FROM, on a BORROWER's row only (null on the pool's own
   *  row and on every unpooled type). It is what the Entitlement caption names INSTEAD of an entitlement
   *  table, and it is also the fact that suppresses r209's red "no entitlement table" diagnostic for this one
   *  row — see `entitlementStatusCaption` (lib/shared-leave-balance.ts), which both the screen and the export
   *  read so the two cannot tell the same row apart differently. */
  entitlementFromPool: string | null;
  /** r209 — set when this row's figures are another leave type's pool (`balance_source_type_id`). HR's grid
   *  needs it for the same reason the employee's does: two rows carrying one balance read as two. */
  sharedBalance: SharedLeaveBalanceInfo | null;
  broughtForward: number | null;
  taken: number | null;
  pending: number;
  adjustment: number | null;
  overutilized: number | null;
  /** Brought-forward days lost this cycle: cap excess at year open + any expiry lapse realised by `asOf`. */
  forfeitedBf: number | null;
  balance: number | null;
  /** r242 — THE EXPLANATION PANEL'S DATA, AND IT IS THE VERY BREAKDOWN THIS ROW WAS DERIVED FROM.
   *
   *  The Explain button on HR's grid opens the same read-only side-sheet (`EntitlementBreakdown`) that /me
   *  and the personnel record already open. It is fed from `bd` below — the object `deriveBalanceRow` was
   *  handed one line earlier — so the panel and the row it sits on cannot describe different arithmetic.
   *  A second `leaveEntitlementBreakdown` call for the panel would be a THIRD source in the sense this
   *  file's header forbids: it would answer at a different instant, and HR would quote whichever of the
   *  two happened to be on screen. null ⇒ nothing resolved for the type, and the button is not offered. */
  breakdown: EntitlementBreakdownData | null;
  /** r242 — `PanelSummary.available`: leaveBalances' own `available` (ledger balance − pending), the one
   *  panel line that is NOT taken from the breakdown. Carried off the same `b` the figures above came
   *  from, exactly as /leave and /admin/personnel pass it. */
  available: number;
  /** r242 — display-only per-type theming (639fdf77) for the panel header. Already on the balance row. */
  visual: { color: string | null; icon: string | null; code: string | null };
  /** r303 (31492f74) — the HR explanation switch for the Explain panel, carrying whose pool the row's figures
   *  are (`sharedBalance` off the same balance row). Always set: this screen is HR's.
   *  2a57a007 (r340) — and `entitlementFromPool`, the one fact the panel cannot derive for itself: for a
   *  borrower the breakdown it is handed IS the pool's, so the borrower's row and the pool's own row look
   *  identical from inside the panel. Structural mirror of `HrLeaveSummaryExplanation`
   *  (components/leave/EntitlementBreakdown.tsx), which is where the consequence is documented. */
  hrExplanation: { sharedBalance: SharedLeaveBalanceInfo | null; entitlementFromPool: string | null };
};

export async function employeeBalanceRows(
  ctx: SessionContext,
  employmentId: string,
  asOf: string,
  locale: string,
  filter: { q?: string; typeIds?: string[]; dir?: 'asc' | 'desc' } = {},
): Promise<EmployeeBalanceRow[]> {
  // 994a5287: `includeHidden` — this is HR's own screen, so a leave type HR has hidden from EMPLOYEE
  // self-service must still be listed here. Without it the reporter's "some Leave Types may not appear"
  // reproduced exactly: a visible_to_employee=false type was absent from these rows. The eligible-but-
  // inactive types (0.00, no ledger entry) were already handled inside leaveBalances since R18.
  //
  // 3ddae357: `asOf` — the SAME date the breakdown below already took. It was threaded into one read and
  // not the other, so five columns moved with the As-at date and four (Taken, Pending Approval,
  // Overutilized, Balance) answered for the whole record whatever date was typed. Passing it here is the
  // whole of the fix on this side: `deriveBalanceRow` maps whatever it is handed and needs no change,
  // which is exactly the property to preserve — HR's screen and the employee's own screen keep ONE
  // derivation.
  //
  // ec991c2a: `includeArchived` for the SAME reason and with the same boundary. Archiving a leave type
  // retires it from the employee's own list; it does not delete the balance sitting under it, and this is
  // the screen HR opens to answer "what does this person hold". Production has ANNUAL archived with 759
  // days across 55 employments — an admin screen that stopped showing those days would be a worse defect
  // than the one this item fixes.
  // d272834b — `includeIneligible: true` joins `includeHidden` / `includeArchived`, same call, same asOf.
  // This is the HR screen the item's remediation is read from: the 55 employments holding a net 98-day
  // Maternity balance they were never eligible for are findable here and nowhere the employee can see.
  const balances = await leaveBalances(ctx, employmentId, locale, { includeHidden: true, includeArchived: true, includeIneligible: true, asOf });
  // r303 (31492f74): `derivation: true` — this is an HR screen, and its Explain panel prints the per-line working.
  // Same read, same date; the working rides on the very `bd` every figure in the row comes from.
  const breakdowns = await Promise.all(
    balances.map((b) => leaveEntitlementBreakdown(ctx, employmentId, b.leaveTypeId, asOf, locale, { derivation: true })),
  );
  const byType = new Map(breakdowns.filter((x) => x != null).map((x) => [x!.leaveTypeId, x!]));

  const typeIds = filter.typeIds ?? [];
  const needle = filter.q?.trim().toLowerCase();
  const rows = balances
    .map((b): EmployeeBalanceRow => {
      // r209 — a BORROWER's figures are the pool's, so its entitlement story must be the pool's too
      // (`balanceStoryTypeId`). Reading its own empty breakdown here printed "YTD Entitled 0.00" and a red
      // "create an entitlement table for it" beside a balance the employee can spend — on this screen, in
      // its export, and in the side-sheet. Identity for every type that is not in a pool.
      const bd = byType.get(balanceStoryTypeId(b)) ?? null;
      const row = deriveBalanceRow({ ...b, essView: {} }, bd);
      /**
       * 2a57a007 — A BORROWER'S DAYS ARE REPORTED UNDER SHARE, AND THEREFORE NOT ALSO UNDER TAKEN.
       *
       * 690d4400 and 39136455 between them made `taken` the days FILED UNDER THIS CODE, which was right and
       * must not be reverted: before it, the Emergency Leave row printed the POOL's taken figure. But a
       * borrower's `share` is the very same days seen from the pool's side, so the row printed one day twice —
       * Taken 1.00 AND Share 1.00 — and a reader adding the columns found two days of Emergency Leave where
       * one was taken. Pending Approval and Pending Share are the identical pair, one decision earlier.
       *
       * ⚠️ WHICH LAYER, AND WHY THIS ONE. The zero happens HERE, in the Employee Balances row builder, which
       * is a DISPLAY layer shared by the screen and its export (so the downloaded file cannot disagree with
       * the screen it exports — this file's header states that invariant). It deliberately does NOT happen in
       * core/read.ts: `leaveBalances(...).taken` is `takenFiledBy`, still the honest answer to "how many days
       * of Emergency Leave did this person take", and it is what the /me grid, the Explain panel's Taken line
       * and every future consumer must keep reading. Nor in `deriveBalanceRow`, which is the pure mapping the
       * employee's own grid shares: this is a decision about ONE screen's two adjacent columns, not about what
       * a leave-balance row means.
       *
       * The POOL's row is untouched — its Taken is its own applications, and its Share is what it lent out.
       */
      const borrower = isPoolBorrower({ leaveTypeId: b.leaveTypeId, sharedBalance: row.sharedBalance });
      /**
       * 2a57a007 (r340) — THE POOL THIS ROW BORROWS FROM, NAMED ONCE AND READ THREE TIMES: the Entitlement
       * caption on the grid, the same caption in the export, and the Explain panel's statement of whose
       * figures it is showing (`hrExplanation` below). Null on the pool's own row and on every unpooled type.
       */
      const fromPool = borrower ? (row.sharedBalance?.sourceLeaveTypeName ?? null) : null;
      return {
        leaveTypeId: b.leaveTypeId,
        leaveType: row.leaveType,
        code: b.code ?? '',
        entitlementYear: bd ? bd.cycleStart.slice(0, 4) : null,
        /**
         * 2a57a007 (r340) — A BORROWER'S ENTITLEMENT IS ITS OWN, AND IT IS NOTHING.
         *
         * `bd` above is the POOL's breakdown, deliberately (see `balanceStoryTypeId`, and read the r209 note
         * it carries before touching that). But Entitlement and Earned to Date are statements about THIS
         * leave type, and taking them off the pool's breakdown printed the reporter's screen: Emergency
         * Leave 7.00 / 2.50, beside a Balance of 0.00, naming Annual Leave's entitlement table as if it were
         * its own. Both of those cannot be true and the false one is the entitlement — `core/read.ts` already
         * sets a borrower's `accrued` and `balance` to 0.00 for exactly this reason ("it has no entitlement
         * and no balance of its own, which is the honest statement").
         *
         * r279's PROPERTY IS UNCHANGED AND IS WHY THE NON-BORROWER HALF READS `row.` AND NOTHING ELSE: one
         * breakdown, one `deriveBalanceRow`, never a second resolver
         * (test/r279-earned-and-full-entitlement.test.ts pins both halves of each expression by name — it was
         * UPDATED for this item, because the decision it pinned is the one this item reverses).
         *
         * UNCONDITIONAL, not `row.x == null ? null : 0` like `taken` below, and the difference is deliberate:
         * `taken`'s null is an ESS-HIDDEN figure, which must never become a 0.00 claim, whereas these two
         * read null only when NO breakdown resolved — and a borrower's own entitlement is 0.00 whether or
         * not the POOL resolved one. This builder empties `essView` (see the file header), so no ESS gate
         * reaches here; if it ever gains an ESS-gated caller, gate these the way `taken` is gated.
         */
        ytdEntitled: borrower ? 0 : row.ytdEntitled,
        fullEntitlement: borrower ? 0 : row.fullEntitlement,
        share: row.share,
        pendingShare: row.pendingShare,
        entitlementStatus: row.entitlementStatus,
        // 2a57a007 (r340) — and it does NOT name the pool's table. "Entitlement table: Executive Annual
        // Leave" on the Emergency row claimed a table this type does not have and must never have; the
        // caption `entitlementFromPool` drives says where the days actually come from instead.
        entitlementTemplateName: borrower ? null : (bd?.entitlementTemplateName ?? null),
        // 2a57a007 (r340) — the pool's NAME, which is the whole of what a borrower has to say about its own
        // entitlement. Off `row.sharedBalance` (the descriptor `leaveBalances` attached), never re-derived.
        entitlementFromPool: fromPool,
        sharedBalance: row.sharedBalance,
        broughtForward: row.broughtForward,
        // 2a57a007 — see `borrower` above: a borrower's days print under Share / Pending Share only.
        // `row.taken` (null) stays null — an ESS-hidden figure must not become a 0.00 claim.
        taken: borrower ? (row.taken == null ? null : 0) : row.taken,
        pending: borrower ? 0 : b.pending,
        adjustment: row.adjustment,
        overutilized: row.overutilized,
        forfeitedBf: bd ? bd.forfeited : null,
        balance: row.balance,
        // r242 — the SAME `bd` that produced every figure above, handed on rather than re-read.
        breakdown: bd,
        available: b.available,
        visual: { color: b.color, icon: b.icon, code: b.code },
        // 2a57a007 (r340) — AND THE PANEL IS TOLD THE SAME FACT, off the same local, because the panel is the
        // plan's THIRD surface and it was reading the pool's Entitlement under a grid row that reads 0.00.
        // See components/leave/LeaveDetailsPanel.tsx: the figures below the statement stay the POOL's whole
        // closing column (zeroing them there would break the identity §1 adds up to and trip the explain
        // module's sum-guards); what the panel gains is the borrower's own fact, said before they are read.
        hrExplanation: { sharedBalance: row.sharedBalance, entitlementFromPool: fromPool },
      };
    })
    .filter((r) => (typeIds.length ? typeIds.includes(r.leaveTypeId) : true))
    // Search is on the leave CODE, with the type name folded in so searching "Annual" also works — a
    // code-only match would strand anyone who knows the type by name and not by its three letters.
    .filter((r) => (needle ? `${r.code} ${r.leaveType}`.toLowerCase().includes(needle) : true));

  // Default A→Z by leave code; rows with no code fall back to the type name so they do not clump under ''.
  const key = (r: EmployeeBalanceRow) => r.code || r.leaveType;
  const mul = filter.dir === 'desc' ? -1 : 1;
  return rows.sort((a, b) => mul * key(a).localeCompare(key(b), locale, { sensitivity: 'base' }));
}
