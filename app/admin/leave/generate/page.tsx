import { redirect } from 'next/navigation';

/**
 * a6fe37fc ROUND 5 (cutover) — redirect stub. Generate entitlement lives at
 * `/admin/leave-config/generate` now, and this address exists only so no saved link 404s.
 *
 * The page that stood here (4b0e76ae, grown into the five-step flow by 93249794) mounted `GenerateForm`
 * and the generation-run log. Both are unchanged and unmoved: the new page mounts the SAME client
 * component, driven by the SAME two server actions — `openLeaveYearAction`, which is still the ONE route
 * from a browser to the grant sweep (the r106 lesson, pinned by test/leave-generate-page.test.ts), and
 * `previewLeaveGenerationAction`, which still lives in `./actions.ts` right beside this file.
 *
 * ⚠️ `./export/route.ts` IS NOT MOVED AND IS NOT A STUB. The per-run processing-log CSV stays at
 * `/admin/leave/generate/export?run=…` and the new page links to it there. A route handler has no screen
 * column and was never registered, so nothing about this cutover requires it to move.
 *
 * ⚠️ THIS STUB IS NEVER DELETED (migration order → Round 6).
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/generate` left lib/permissions.ts's
 * leaveConfig `routes` in the SAME commit that emptied this page. The query string is forwarded, so an
 * in-flight `?error=` from a save made before the constant moved still surfaces at the destination.
 */
export default async function LeaveGenerateRedirect({
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
  redirect(`/admin/leave-config/generate${qs ? `?${qs}` : ''}`);
}
