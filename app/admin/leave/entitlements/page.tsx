import { redirect } from 'next/navigation';

/**
 * a6fe37fc ROUND 5 (cutover) — redirect stub. THE LEAVE TYPE SCREEN IS `/admin/leave-config/types` NOW,
 * and this address exists only so no saved link 404s. This is the screen the reporter opens most and the
 * one the whole item is about, so what went where is written out rather than left to be reconstructed.
 *
 * ══ WHAT STOOD HERE, AND WHERE EACH PART IS ══════════════════════════════════════════════════════════
 *
 * A 731-line page mounting `components/leave-type-panel.tsx` (3,367 lines) — the four STEPS
 * (General · Condition · Entitlement · Custom Setting), two `SubStepBar` mountings and six sub-step keys
 * that IA §1.2 identifies as the real subject of the complaint: settings arranged by how the code grew.
 * BOTH FILES ARE DELETED. They are replaced, not re-addressed:
 *
 *   · the four steps and six sub-steps are FIVE TABS on the leave type itself, in the order the decisions
 *     are made — what it is · who is eligible · what they are entitled to · how it is applied for · who
 *     approves it (IA §2). `app/admin/leave-config/types/`.
 *   · the company-wide Half-Day Deduction card and Shared Leave Groups are on Company rules
 *     (`/admin/leave-config/company-rules`). They are a COMPANY and a TENANT rule respectively, not
 *     properties of one leave type, which is why one of them was being drawn twenty-five times.
 *   · the embedded Entitlement Tables block, Run Earned Accrual, the health card, the left rail, the Add
 *     Leave Type dialog, the header's four links and the negative-balance list are all on the new screen,
 *     MOUNTED from the same components (IA §2.3) rather than re-typed.
 *
 * Nothing about the ENGINE moved or changed: `core/leave.ts`, `core/leave-compute.ts`,
 * `core/entitlement-template.ts` and `core/leave-approval-policy.ts` are untouched by every round of this
 * item, and the 297 balance records they produced are reconciled against them (IA §0).
 *
 * ══ WHY THE REDIRECT IS SAFE, AND WHAT IT CARRIES ════════════════════════════════════════════════════
 *
 * `editTemplate` / `editRule` — the embedded Entitlement Tables' edit state — are forwarded with the rest
 * of the query string, and the new screen reads the same two params on the same shared block.
 *
 * ⚠️ THE `#type-<id>` FRAGMENT IS NOT AND CANNOT BE FORWARDED, and that is a property of the web, not an
 * omission: a fragment is never sent to the server. `okEntitlements` / `failEntitlements`
 * (app/admin/_redirects.ts) build that anchor, and BOTH now name `/admin/leave-config/types` directly, so
 * a save keeps its anchor by never passing through this stub. What reaches here is a human's saved
 * bookmark, which lands on the leave type screen with no type pre-selected — the same thing the old
 * `/admin/leave` stub has always done.
 *
 * ⚠️ THIS STUB IS NEVER DELETED (migration order → Round 6). It is the single most-bookmarked address in
 * the area, and "no address ever 404s" is rule 4 of the whole sequence.
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/entitlements` left lib/permissions.ts's
 * leaveConfig `routes` in the SAME commit that emptied this page. The screen key's canonical `href` moved
 * with it; the KEY itself is untouched, because a key "may key stored role configs" and renaming one
 * would silently drop every tenant's grant for the whole area.
 */
export default async function LeaveEntitlementsRedirect({
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
