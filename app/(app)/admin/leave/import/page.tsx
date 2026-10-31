import { redirect } from 'next/navigation';

/**
 * a6fe37fc ROUND 5 (cutover) — redirect stub. Import leave data lives at
 * `/admin/leave-config/import` now, and this address exists only so no saved link 404s.
 *
 * The page that stood here mounted `LeaveLedgerImport` (F44 — validate, then commit) behind the
 * trusted-HR-admin page guard. The new page mounts THE SAME client component from the same file: the
 * importer was never re-implemented (IA §2.3), only the page around it is new. Nothing about the
 * two-phase contract, the authority check inside `analyze()` or the templates changed.
 *
 * ⚠️ THIS STUB IS NEVER DELETED (migration order → Round 6). The reporter's bookmarks are the entire
 * reason it exists; ten of these are created at the cutover and none of them comes out later.
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/import` left lib/permissions.ts's
 * leaveConfig `routes` in the SAME commit that emptied this page (test/function-access.test.ts fails
 * BOTH ways: a guarded page.tsx with no column, and a registered route with no guarded page). This
 * follows the df00b85f Summary stub and the f1b994e3 Audit stub next door.
 *
 * The query string is forwarded verbatim so an in-flight `?error=` / `?toast=` still surfaces at the
 * destination, exactly as the four older stubs do.
 */
export default async function LeaveImportRedirect({
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
  redirect(`/admin/leave-config/import${qs ? `?${qs}` : ''}`);
}
