import type { SessionContext } from '@/db/client';
import { leaveBalances, leaveEntitlementBreakdown } from '@/core/read';
import { deriveBalanceRow } from '@/components/leave/leave-balance-row';
// r242 — TYPE ONLY. The import is erased at compile time, so this server module pulls in no client runtime
// (the same reason `leave-cards.tsx` names this type rather than the component). It is the side-sheet's
// structural mirror of the breakdown `leaveEntitlementBreakdown` returns, and naming it here is what lets a
// row CARRY the breakdown it was derived from instead of the screen fetching one for itself.
import type { EntitlementBreakdownData } from '@/components/leave/EntitlementBreakdown';
import type { EntitlementStatus } from '@/lib/entitlement-status';
import { balanceStoryTypeId, type SharedLeaveBalanceInfo } from '@/lib/shared-leave-balance';

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
  /** 31e39d74 — why YTD Entitled reads what it reads. Same value the employee's own screen shows, through
   *  the same `deriveBalanceRow`, so HR and the employee are never told two different stories about a 0.00. */
  entitlementStatus: EntitlementStatus;
  /** r209 — WHICH entitlement table this employee actually resolved to, so HR can confirm the right one was
   *  chosen instead of inferring it from the day count. Already computed by the breakdown (the winning
   *  template's name); it simply had no reader on this screen. null ⇒ nothing resolved, which the status
   *  beside it now explains in words. */
  entitlementTemplateName: string | null;
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
  const balances = await leaveBalances(ctx, employmentId, locale, { includeHidden: true, includeArchived: true, asOf });
  const breakdowns = await Promise.all(
    balances.map((b) => leaveEntitlementBreakdown(ctx, employmentId, b.leaveTypeId, asOf, locale)),
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
      return {
        leaveTypeId: b.leaveTypeId,
        leaveType: row.leaveType,
        code: b.code ?? '',
        entitlementYear: bd ? bd.cycleStart.slice(0, 4) : null,
        ytdEntitled: row.ytdEntitled,
        fullEntitlement: row.fullEntitlement,
        entitlementStatus: row.entitlementStatus,
        entitlementTemplateName: bd?.entitlementTemplateName ?? null,
        sharedBalance: row.sharedBalance,
        broughtForward: row.broughtForward,
        taken: row.taken,
        pending: b.pending,
        adjustment: row.adjustment,
        overutilized: row.overutilized,
        forfeitedBf: bd ? bd.forfeited : null,
        balance: row.balance,
        // r242 — the SAME `bd` that produced every figure above, handed on rather than re-read.
        breakdown: bd,
        available: b.available,
        visual: { color: b.color, icon: b.icon, code: b.code },
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
