import { redirect } from 'next/navigation';

/**
 * a6fe37fc ROUND 5 (cutover) — redirect stub. The Medical / Hospitalisation balance record lives at
 * `/admin/leave-config/records/balances` now (IA §2 → RECORDS), and this address exists only so no saved
 * link 404s.
 *
 * The page that stood here (c8052ae3) was the "read on screen" half of the promise the approved plan made
 * the reporter: "copy every affected record into a permanent written record you can read on screen and
 * download, so the old figures are never lost." It records 147 grants to named employees taken out of a
 * ledger documented as APPEND-ONLY, which is why it is the one screen in this cutover whose ABSENCE of a
 * control is a feature: there is no re-capture button, because a re-capture could only ever run after the
 * rows are gone and would write an empty snapshot over the only copy. The new page carries that absence
 * with it, and test/leave-config-round3.test.ts asserts it by name.
 *
 * ⚠️ `./export/route.ts` IS NOT MOVED AND IS NOT A STUB, for the reason its sibling record's is not: a
 * route handler has no screen column, was never in lib/permissions.ts, and re-addressing it would break
 * every saved download link for nothing. The new page links to it where it is.
 *
 * `?capture=` is forwarded, so a link to ONE capture still opens on that capture.
 *
 * ⚠️ THIS STUB IS NEVER DELETED (migration order → Round 6).
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/entitlements/ledger-archive` left
 * lib/permissions.ts's leaveConfig `routes` in the SAME commit that emptied this page.
 */
export default async function LeaveLedgerArchiveRedirect({
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
  redirect(`/admin/leave-config/records/balances${qs ? `?${qs}` : ''}`);
}
