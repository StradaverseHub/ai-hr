import { redirect } from 'next/navigation';

/**
 * 0d147b78 — Leave Settings Reorganization. The standalone Approval-chain page was absorbed into the
 * Leave Settings "Approval Workflow" tab. This route permanently redirects to it so bookmarked links,
 * the sidebar entry, and post-action redirects still resolve. The editor / rule-builder / actions that
 * used to render here are re-used by the destination page (imported from this same folder), so no
 * approval logic moved — only where it renders.
 *
 * a6fe37fc ROUND 5 (cutover) — REPOINTED at `/admin/leave-config/approval-chains`, in the same commit
 * that turned `/admin/leave/approval` into a stub of its own. Two stubs in a chain still deliver the
 * bookmark, but through a hop that does not need to happen, and a stub whose destination is another
 * stub is one edit away from a loop.
 *
 * ⚠️ THE QUERY STRING IS FORWARDED, like all eleven of the other leave stubs. It was NOT, until r261's
 * verify pass: this was the single leave address that stripped everything, so
 * `/admin/leave-approval?toast=Saved&company=c1` arrived at Approval chains with no toast and on the
 * wrong company. Harmless the day it was found — nothing links here WITH a query today — but it is the
 * address 0d147b78's sidebar entry used, so it is a live bookmark, and `ToastFromQuery` in
 * app/layout.tsx renders confirmations from the query string alone. Forwarding costs one loop and
 * removes a whole class of silent drop; the contract is now the same at every leave address rather than
 * true at ten of eleven. test/leave-config-round4.test.ts pins it.
 */
export default async function LeaveApprovalRedirect({
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
  redirect(`/admin/leave-config/approval-chains${qs ? `?${qs}` : ''}`);
}
