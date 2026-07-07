import { redirect } from 'next/navigation';

/**
 * 0d147b78 — Leave Settings Reorganization. The standalone Approval-chain page was absorbed into the
 * Leave Settings "Approval Workflow" tab (`/admin/leave/approval`). This route now permanently
 * redirects there so bookmarked links, the sidebar entry, and post-action redirects still resolve.
 * The editor / rule-builder / actions that used to render here are re-used by the new tab page
 * (imported from this same folder), so no approval logic moved — only where it renders.
 */
export default function LeaveApprovalRedirect() {
  redirect('/admin/leave/approval');
}
