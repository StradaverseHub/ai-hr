import { redirect } from 'next/navigation';

/**
 * a6fe37fc ROUND 5 (cutover) — redirect stub. Entitlement tables live at
 * `/admin/leave-config/entitlement-tables` now, and this address exists only so no saved link 404s.
 *
 * The page that stood here (6e9a126e release two) mounted two things and re-implemented neither: the
 * shared `EntitlementTablesBlock` UNFILTERED — every leave type's day tables side by side, the one thing
 * this screen does that a single leave type's Entitlement tab cannot — and r212's (`8ebf77ae`)
 * `EligibilityExplainPanel`, the named-employee answer to "no eligibility rule reaches you". BOTH files
 * stay exactly where they are (`./entitlement-tables-block.tsx`, `./eligibility-explain.tsx`): the new
 * page mounts them from here, the leave type screen mounts the block filtered, and a second create form
 * writing the same effective-dated lineage is the defect this whole item exists to remove.
 *
 * The explain panel's four GET parameters (`explainQ`, `explainEmployment`, `explainLeaveType`,
 * `explainAsOf`) are forwarded with everything else, so an answer that was sent as a link still opens
 * on the same employee at the new address.
 *
 * ⚠️ THIS STUB IS NEVER DELETED (migration order → Round 6). Bookmarks are the entire reason it exists.
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/entitlements/templates` left
 * lib/permissions.ts's leaveConfig `routes` in the SAME commit that emptied this page
 * (test/function-access.test.ts fails BOTH ways). The df00b85f / f1b994e3 stub precedent.
 */
export default async function EntitlementTemplatesRedirect({
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
  const qs = usp.toString();
  redirect(`/admin/leave-config/entitlement-tables${qs ? `?${qs}` : ''}`);
}
