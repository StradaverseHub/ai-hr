import { redirect } from 'next/navigation';

/**
 * Legacy redirect stub (f1b994e3). The Leave Config → Audit tab is retired: there is ONE audit page,
 * /admin/audit, and this destination lands on it with the Leave area already chosen.
 *
 * Nothing was merged or copied to make that true. This page and the central Audit Trail always read the
 * SAME append-only domain_event ledger through the same `auditWhere` predicate and rendered the same
 * <AuditTable>; this one differed only by pre-applying a hardcoded eight-aggregate list, which hid 404
 * real leave rows (holiday calendars, entitlement schemes, shared leave groups, balance recalculations
 * — including the newest leave-config changes on the system) while listing job-grade rows the central
 * page has always chipped Organization. Its better filters (Action / User / Company / Leave type, the
 * Today / Yesterday timeline, CSV / XLSX / PDF export) moved UP to /admin/audit and now work for every
 * area, so nothing is taken away with the page.
 *
 * The ROUTE is kept so no saved bookmark or deep link 404s. Every filter param this page understood is
 * forwarded verbatim — they are the same param names on the destination — with `module=leave` added, so
 * an old filtered link reopens the same view.
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/audit` was removed from lib/permissions.ts's
 * leaveConfig `routes` in the same commit (test/function-access.test.ts fails BOTH ways: a guarded
 * page.tsx with no column, and a registered route with no guarded page). This follows the df00b85f
 * Summary stub and the 1e4eb8af Application Rules stub next door.
 */
export default async function LeaveAuditRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') usp.set(k, v);
    else if (Array.isArray(v) && v[0] != null) usp.set(k, v[0]);
  }
  usp.set('module', 'leave');
  redirect(`/admin/audit?${usp.toString()}`);
}
