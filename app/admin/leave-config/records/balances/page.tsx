import { redirect } from 'next/navigation';

/**
 * 7f69bd71 — redirect stub. The Balance record is the second sub-tab of the Reset records sub-screen
 * now (`/admin/leave-config/records?record=balances`, reached from the foot of Leave Adjustments), and
 * this address exists only so no saved link 404s.
 *
 * The page that stood here (a6fe37fc Round 5, then 10b59703's second tab of Leave Adjustments) was the
 * "read on screen" half of the c8052ae3 promise: "copy every affected record into a permanent written
 * record you can read on screen and download, so the old figures are never lost." It records grants to
 * named employees taken out of a ledger documented as APPEND-ONLY — the August Medical / Hospitalisation
 * reset and, since fe9c73bc ran on 2026-09-11, the clearing of every generated balance. The new sub-tab
 * carries the same picker, counts, eight columns and CSV, moved into
 * components/leave/reset-record-balances.tsx, and it still offers NO re-capture button: a re-capture
 * could only ever run after the rows are gone and would write an empty snapshot over the only copy.
 *
 * ⚠️ THE CSV DOWNLOAD IS NOT HERE AND HAS NOT MOVED. It stays at
 * `/admin/leave/entitlements/ledger-archive/export` and the sub-tab still links to it.
 *
 * `record` is set FIRST and then `?capture=` (and anything else) is forwarded, so a link to ONE capture
 * still opens on that capture, on the right sub-tab. The older stub at
 * `/admin/leave/entitlements/ledger-archive` points straight at the sub-screen too — one hop, never a chain.
 *
 * ⚠️ THIS STUB IS NEVER DELETED: the reporter's saved links are the entire reason it exists.
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave-config/records/balances` left
 * lib/permissions.ts's leaveConfig `routes` in the SAME commit that emptied this page.
 */
export default async function LeaveConfigBalanceRecordRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const usp = new URLSearchParams({ record: 'balances' });
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
