import { redirect } from 'next/navigation';

/**
 * a6fe37fc ROUND 5 (cutover) — redirect stub. Replacement-leave CONFIGURATION lives on Company rules
 * (`/admin/leave-config/company-rules`) now, and this address exists only so no saved link 404s.
 *
 * The page that stood here (645e67c4 → 296fc027) was the per-company replacement-leave policy editor:
 * what a credit is earned from, how long it lasts, what happens when it expires, and the eligibility
 * criteria for who may submit a request at all. Every one of those controls is on Company rules, posting
 * the SAME `setToilPolicyAction` with the same absolute-set form and the same `?company=` filter — which
 * is forwarded below, so a link to ONE company's policy still opens on that company.
 *
 * ⚠️ IT DID NOT MOVE BECAUSE SOMEBODY PREFERRED THE NEW ADDRESS. A replacement-leave policy is a COMPANY
 * rule, not a property of any one leave type, and IA §2.0.3 groups the four settings that are company- or
 * tenant-wide onto one screen instead of leaving them on four different surfaces.
 *
 * ⚠️ `/admin/toil` IS NOT THIS SCREEN AND WAS NOT MOVED. 296fc027 split one route in two deliberately:
 * /admin/toil keeps the balance LEDGER and the two settlement sweeps, which are gated differently ON
 * PURPOSE (they must stay reachable when the `toil` entitlement lapses; configuration must not). Its
 * "configuration moved" link was repointed at Company rules in this same commit — an admin who lands on
 * the legacy page still has to be told where configuration went, which is the half that stops a move
 * reading as a deletion.
 *
 * ⚠️ THIS STUB IS NEVER DELETED (migration order → Round 6).
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/replacement` left lib/permissions.ts's
 * leaveConfig `routes` in the SAME commit that emptied this page.
 *
 * ⚠️ THE QUERY STRING IS FORWARDED, AND FOR THIS SCREEN THAT IS LOAD-BEARING RATHER THAN TIDY.
 * `setToilPolicyAction` returned here with `?saved=`, `?warning=` or `?error=`, and `warning=` carries the
 * Phase-B #14 premium-equivalent BANKING-RISK warning. The redirect constant moved in this same commit so
 * it now arrives at Company rules directly; forwarding is what covers a request already in flight.
 */
export default async function ReplacementLeaveConfigRedirect({
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
  redirect(`/admin/leave-config/company-rules${qs ? `?${qs}` : ''}`);
}
