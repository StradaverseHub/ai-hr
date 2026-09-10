import { redirect } from 'next/navigation';

/**
 * a6fe37fc ROUND 5 (cutover) — redirect stub. The Entitlement configuration record lives at
 * `/admin/leave-config/records/entitlement` now (IA §2 → RECORDS), and this address exists only so no
 * saved link 404s.
 *
 * The page that stood here (6e9a126e release one) was the read-only listing the approved plan promised
 * the reporter: "you read the old figures off it while you retype them rather than working from memory.
 * It feeds nothing and changes no number." The new page IS that sentence — same capture picker, same
 * nine columns, same "this is not an undo" line, same CSV. F45 in full.
 *
 * ⚠️ `./export/route.ts` IS NOT MOVED AND IS NOT A STUB. The CSV download stays at
 * `/admin/leave/entitlements/archive/export` and the new page still links to it. A route handler has no
 * screen to describe, so it was never a function-access column and never needed to move; moving it would
 * have broken every download link an administrator has saved for the sake of tidiness.
 *
 * `?capture=` is forwarded with the rest of the query string, so a link to ONE capture still opens on
 * that capture at the new address.
 *
 * ⚠️ THIS STUB IS NEVER DELETED (migration order → Round 6).
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/entitlements/archive` left
 * lib/permissions.ts's leaveConfig `routes` in the SAME commit that emptied this page.
 */
export default async function EntitlementArchiveRedirect({
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
  redirect(`/admin/leave-config/records/entitlement${qs ? `?${qs}` : ''}`);
}
