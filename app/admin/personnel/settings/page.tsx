import { redirect } from 'next/navigation';

/**
 * Legacy redirect stub (7b5f18c3). Hiring Defaults was a system setup hiding inside the Personnel
 * (Admin) module, reachable only from a button in the top-right corner of the employee list. It now
 * lives in System Settings at /admin/settings/hiring-defaults, as a searchable company list with a page
 * per company. This preserves old bookmarks and deep-links, forwarding to the new canonical route.
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * intentionally NOT a function-access column and was REMOVED from lib/permissions.ts with this change
 * (the fbdeee87 profile-options and 1e4eb8af application-rules stub precedents; test/function-access
 * .test.ts's "no stale routes" check fails if a registered route stops being a guarded page). Query
 * string is preserved so an in-flight ?error= / ?toast= still surfaces at the destination.
 */
export default async function HiringDefaultsRedirect({
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
  redirect(`/admin/settings/hiring-defaults${qs ? `?${qs}` : ''}`);
}
