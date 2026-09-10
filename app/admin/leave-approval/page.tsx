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
 */
export default function LeaveApprovalRedirect() {
  redirect('/admin/leave-config/approval-chains');
}
