import { redirect } from 'next/navigation';

/**
 * 3fb1a611 (r299) — REDIRECT STUB. Time off in lieu lives on Leave Config › Leave Credit now.
 *
 * The page that stood here (ADR-0033, then 296fc027's split) held two things: the running replacement-leave
 * LEDGER summary across everyone in scope, and the two settlement sweeps (Process expirations, Close
 * replacement-leave year). Both are on Leave Credit's Credits tab, beside every credit movement they settle —
 * one screen per fact, which is what the approved plan (gap 7) asked for. Its menu row under Attendance left
 * in the same commit.
 *
 * ⚠️ THE WIND-DOWN PROPERTY THIS PAGE EXISTED TO PROTECT IS KEPT, not lost in the move. The sweeps are
 * deliberately NOT entitlement-gated (core/toil.ts runToilExpiry): a tenant whose `toil` module lapses still
 * owes the credits already banked, and for a First-Schedule employee that debt converts to cash. So the Leave
 * Credit screen, gated on `toil` like its menu row, still opens in a read-only WIND-DOWN view — the movements,
 * the ledger summary, the sweeps and Reverse — whenever active credits are outstanding.
 *
 * No guard here — the destination enforces admin access; a stub only redirects, so `/admin/toil` left
 * lib/permissions.ts in the same commit (test/function-access.test.ts fails on a registered route whose page
 * calls no guard). THE QUERY STRING IS FORWARDED so a sweep result already in flight still shows its banner.
 */
export default async function ToilRedirect({
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
  redirect(`/admin/leave-config/leave-credit${qs ? `?${qs}` : ''}`);
}
