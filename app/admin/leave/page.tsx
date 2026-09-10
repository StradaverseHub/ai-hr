import { redirect } from 'next/navigation';

/**
 * Legacy redirect stub (df00b85f). The Leave config "Summary" entry is retired.
 *
 * This route used to render a read-only leave-type master listing — code / name / description / paid /
 * status, an Edit link that jumped INTO Entitlements, and a delete. Entitlements already renders the full
 * per-type panel carrying the same rename / archive / delete controls, so the listing was a second door
 * onto settings that live one click away, which is the duplication complaint 26e76a9f (the Entitlement
 * rules card) and e4238594 (the embedded Approval Workflow sub-step) each answered once already here.
 *
 * The ROUTE is kept because several things still point at it and none of them should 404:
 *   - saved bookmarks and deep links;
 *   - `ok(LEAVE)` / `fail(LEAVE)` in app/admin/actions.ts — the post-action targets of the leave TYPE
 *     master actions (archive / delete / …). Their `?toast=` / `?error=` is forwarded below, so the
 *     globally mounted ToastFromQuery still shows the outcome at the destination;
 *   - the Leave Import page's back link.
 *
 * a6fe37fc ROUND 5 (cutover) — REPOINTED at `/admin/leave-config/types`. `/admin/leave/entitlements` is
 * itself a redirect stub now, and a stub whose destination is another stub delivers the bookmark through
 * a hop that need not happen and is one edit away from a loop.
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave` was removed from lib/permissions.ts's
 * leaveConfig `routes` in the same commit (test/function-access.test.ts fails BOTH ways: a guarded
 * page.tsx with no column, and a registered route with no guarded page). This follows the 1e4eb8af
 * Application Rules stub and the fbdeee87 profile-options stub next door.
 */
export default async function LeaveSummaryRedirect({
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
  redirect(`/admin/leave-config/types${qs ? `?${qs}` : ''}`);
}
