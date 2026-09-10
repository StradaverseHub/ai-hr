import { redirect } from 'next/navigation';

/**
 * a6fe37fc ROUND 5 (cutover) — redirect stub. Leave adjustments live at
 * `/admin/leave-config/adjustments` now, and this address exists only so no saved link 404s.
 *
 * The page that stood here (491c499f) mounted `AdjustmentForm` and the recent-batches list. Neither is
 * re-implemented at the new address: the new page mounts the SAME client component, posts the SAME
 * actions from `./actions.ts` — which stays right here beside this file — and builds its criteria from
 * `buildOrgCriteriaSections`, the shared builder this screen's own four sections were extracted into
 * (18103ba4), so Adjustments and Generate cannot offer different axes.
 *
 * F43 came across whole, including the part that is easy to lose: reversing a batch as a UNIT rather
 * than row by row.
 *
 * ⚠️ THIS STUB IS NEVER DELETED (migration order → Round 6).
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/adjustments` left lib/permissions.ts's
 * leaveConfig `routes` in the SAME commit that emptied this page. The query string is forwarded, so an
 * in-flight `?toast=` carrying the two counts still surfaces at the destination.
 */
export default async function LeaveAdjustmentsRedirect({
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
  redirect(`/admin/leave-config/adjustments${qs ? `?${qs}` : ''}`);
}
