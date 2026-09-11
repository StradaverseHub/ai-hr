import { redirect } from 'next/navigation';

/**
 * 7f69bd71 — redirect stub. The Configuration record is the first sub-tab of the Reset records
 * sub-screen now (`/admin/leave-config/records?record=configuration`, reached from the foot of Leave
 * Adjustments), and this address exists only so no saved link 404s.
 *
 * The page that stood here (a6fe37fc Round 5, then 10b59703's third tab of Entitlements) was the read-only
 * listing four approved plans promised the reporter: "you read the old figures off it while you retype
 * them rather than working from memory. It feeds nothing and changes no number." The new sub-tab IS that
 * sentence — the same intro, the same capture picker, the same nine columns, the same CSV — moved into
 * components/leave/reset-record-configuration.tsx. Nothing in the record was deleted or altered.
 *
 * ⚠️ THE CSV DOWNLOAD IS NOT HERE AND HAS NOT MOVED. It stays at `/admin/leave/entitlements/archive/export`
 * (a route handler, never a page, never a function-access column) and the sub-tab still links to it, so
 * every download link an administrator has saved still downloads.
 *
 * `record` is set FIRST and then `?capture=` (and anything else) is forwarded, so a link to ONE capture
 * still opens on that capture, on the right sub-tab. The older stub at `/admin/leave/entitlements/archive`
 * points straight at the sub-screen too — one hop, never a chain.
 *
 * ⚠️ THIS STUB IS NEVER DELETED: the reporter's saved links are the entire reason it exists.
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave-config/records/entitlement` left
 * lib/permissions.ts's leaveConfig `routes` in the SAME commit that emptied this page
 * (test/function-access.test.ts fails both ways otherwise).
 */
export default async function LeaveConfigEntitlementRecordRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const usp = new URLSearchParams({ record: 'configuration' });
  for (const [k, v] of Object.entries(sp)) {
    // `record` is THIS stub's own identity: a saved link that carries one must not be able to send the
    // bookmark to the other record. Everything else (notably `capture`) rides along unchanged.
    if (k === 'record') continue;
    if (typeof v === 'string') usp.set(k, v);
    else if (Array.isArray(v) && v[0] != null) usp.set(k, v[0]);
  }
  const qs = usp.toString();
  redirect(`/admin/leave-config/records${qs ? `?${qs}` : ''}`);
}
