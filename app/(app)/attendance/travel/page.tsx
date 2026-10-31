import { redirect } from 'next/navigation';

/**
 * b833a077 (r362) — MY TRAVEL IS REMOVED. This address is a redirect and nothing else.
 *
 * WHAT STOOD HERE. My Attendance > My Travel: a Travel Request form (From / To / Reason / Submit) and the
 * employee's own list of the requests they had filed. The reporter asked for the feature to be removed
 * completely — the menu row, the page, the form, the approvals section, the bell's travel task and the
 * travel lines in the bulk-approve tools — and the approved plan takes all of them.
 *
 * WHAT IS KEPT, AND WHY IT IS KEPT RATHER THAN DROPPED. The `travel_request` table, every row in it, its
 * RLS policy, its grant and migration 0146 are UNTOUCHED, at the reporter's explicit instruction: the
 * records stay for audit, the feature is simply no longer reachable. Two pieces of wiring stay with them
 * and must not be "cleaned up" as dead code on a later pass:
 *   • `core/read.ts` employmentCompanyBlockedTx still reads the table. Because the rows are kept, deleting
 *     that line would let HR silently re-company an employment that still carries travel history.
 *     test/employee-company-change.test.ts pins it with a real INSERT.
 *   • `lib/approval-history.ts` still maps the `travel-request` aggregate to a module label. Historic
 *     `travel-request.approved|rejected` events are named in a hard-coded allowlist inside IMMUTABLE
 *     migrations (0288, 0320), so dropping the mapping would leave every historic travel row in the
 *     History tab with no module. That mapping is what makes "keep it for audit" mean something.
 *
 * A REQUEST STILL AWAITING A DECISION STAYS AS IT IS — recorded, but no longer decidable. The approved
 * plan says so in as many words, and no data fix-up ships with this change.
 *
 * WHY THE FILE SURVIVES AS A REDIRECT INSTEAD OF BEING DELETED. Travel bookmarks and old links are in the
 * wild, and a 404 on a shipped URL is a worse answer than a useful screen. `/attendance/clock` — the first
 * row under My Attendance — is DELIBERATELY the destination, and `/attendance/my-records` deliberately is
 * not: the separate approved item 2aef3cd8 empties Attendance Overview, so an old travel bookmark would
 * land on a blank page.
 *
 * NO SESSION IS READ HERE, and none is needed: this issues a redirect and touches no data. The route is
 * not in lib/permissions.ts REGISTERED_ROUTES and must not be added there — it never was registered (the
 * old page was ungated self-service), so test/function-access.test.ts's exact-set redirect-only list does
 * not cover it and adding it would make that assertion fail. See the note on REDIRECT_ONLY_ROUTES.
 */
export default async function MyTravelRemovedPage() {
  redirect('/attendance/clock');
}
