import { redirect } from 'next/navigation';

/**
 * Legacy redirect stub (1e4eb8af). The Application Rules tab is retired: Leave Year Configuration moved
 * into each leave type's Custom Settings step (Leave Config → Leave Type → Custom Settings), beside that
 * type's Leave Year Type override, and the per-company Leave Cycle card was removed as a second way to
 * decide what that override already decides. This preserves old bookmarks and deep-links, forwarding to
 * the new canonical route — `/admin/leave-config/types` since the a6fe37fc Round 5 cutover, repointed in
 * the same commit that made `/admin/leave/entitlements` a stub, so this bookmark still arrives in one hop. No guard here — the destination page enforces admin access; this stub only
 * redirects (so it is intentionally NOT a function-access column, the fbdeee87 stub precedent). Query
 * string is preserved so an in-flight ?error= / ?toast= still surfaces at the destination.
 */
export default async function LeaveApplicationRulesRedirect({
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
