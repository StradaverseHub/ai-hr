import type { SessionContext } from '@/db/client';
import { leaveBalances, leaveEntitlementBreakdown } from '@/core/read';
import { deriveBalanceRow } from '@/components/leave/leave-balance-row';
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
 */
export type EmployeeBalanceRow = {
  leaveTypeId: string;
  leaveType: string;
  code: string;
  /** Leave-year/cycle the breakdown reconstructed against; null when no breakdown resolved. */
  entitlementYear: string | null;
  ytdEntitled: number | null;
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
  const balances = await leaveBalances(ctx, employmentId, locale, { includeHidden: true, asOf });
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
