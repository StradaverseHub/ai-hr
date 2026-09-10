import { redirect } from 'next/navigation';

/**
 * a6fe37fc ROUND 5 (cutover) — redirect stub. The Approval chain editor lives at
 * `/admin/leave-config/approval-chains` now, and this address exists only so no saved link 404s.
 *
 * The page that stood here (0d147b78 → 9b0d99f3) was the two-section editor: APPROVAL TEMPLATE CREATION
 * and ASSIGNMENT TEMPLATE, with the per-company escalation disclosure list. None of it was re-typed at
 * the new address — the new page mounts `ApprovalTemplateManager`, `ApprovalAssignmentManager` and
 * `LeaveEscalationEditor` from `app/admin/leave-approval/`, exactly the files this page imported, and
 * posts the same eight actions from `app/admin/leave-approval/actions.ts`.
 *
 * ⚠️ 706d34e8 (r155) STILL STANDS AT THE NEW ADDRESS: the per-rule `WorkflowMatrix` list is GONE and does
 * not come back. It was a SECOND editor over the same `leave_approval_policy` rows the assignment section
 * already maintains. What Round 4 DID add is a READ-ONLY read-out of the org scope and effective chain of
 * the rules that are not built from a template — columns that route live requests and were shown nowhere
 * after that removal (IA §4.1). A read-out is not an editor, and
 * test/leave-approval-page-restructure.test.ts now asserts the absence of the matrix at the new file so
 * nobody re-deletes the read-out as a regression.
 *
 * ⚠️ THE GUARD DID NOT CHANGE AND MUST NOT. The new page keeps the same company-scoped session guard this
 * one used — deliberately NOT the admin-only one the rest of the new module uses — so a company-scoped
 * admin keeps seeing only the companies they manage (IA §6.4). That is why `/admin/leave-config/approval-
 * chains` is registered on the `leaveApproval` screen key rather than on `leaveConfig`.
 *
 * ⚠️ THIS STUB IS NEVER DELETED (migration order → Round 6). `app/admin/leave-approval/page.tsx`, the
 * older stub that 0d147b78 left pointing HERE, was repointed at the new address in the same commit — two
 * stubs in a chain is a bookmark that still works and a hop that does not need to happen.
 *
 * No guard here — the destination page enforces its own access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/approval` left lib/permissions.ts's
 * leaveApproval `routes` in the SAME commit that emptied this page. The query string is forwarded, so an
 * in-flight `?toast=` / `?error=` from one of the eight actions still surfaces at the destination.
 */
export default async function LeaveApprovalChainRedirect({
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
