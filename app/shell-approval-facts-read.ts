import 'server-only';
import type { SessionContext } from '@/db/client';
import { withBackgroundReadWork } from '@/db/client';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { pendingTaskSummary } from '@/core/approvals-inbox';
import { isAdmin } from '@/lib/authz';
import { companyContextForPage } from '@/lib/scope';
import type { ShellApprovalResult } from '@/components/shell-approval-facts';
import { EMPTY_LIFECYCLE_MODULE_INBOX, lifecycleModuleInbox, type LifecycleModuleInbox } from './lifecycle/module-inbox';
import { lifecycleModuleNavigation } from './lifecycle/workflow-availability';

/** Whether the viewer approves by role (administrator or manager), as the shell decides it. */
export function shellCanApprove(session: SessionContext): boolean {
  return isAdmin(session) || (session.roles ?? []).includes('manager');
}

/** The task sources the shell's badge and bell ask for. One rule for the layout and the refresh action. */
export function shellPendingTaskSources(session: SessionContext) {
  return {
    attendance: isModuleEnabledOrFalse(session, 'attendance'),
    claims: isModuleEnabledOrFalse(session, 'claims'),
    performance: isModuleEnabledOrFalse(session, 'performance'),
    rewards: isModuleEnabledOrFalse(session, 'rewards'),
    // Recruitment slice 9: the bell (and the sidebar's My tasks badge, which is this total) asks for the recruitment
    // to-dos — live, under the viewer's own access; nothing for a viewer with no recruitment role, and no call at all
    // while the module is off. The AI Centre launcher's count leaves them out: it opens Home, which does not list them (D-034).
    recruitment: isModuleEnabledOrFalse(session, 'recruitment'),
    probation: isModuleEnabledOrFalse(session, 'lifecycle') || !!session.entitlements?.scopedModules.lifecycle?.length,
  };
}

/** The shell's approval facts from the pending task summary and the lifecycle module inbox. */
export function shellApprovalResult(
  approvalSummary: Awaited<ReturnType<typeof pendingTaskSummary>>,
  lifecycle: LifecycleModuleInbox,
  canApprove: boolean,
): ShellApprovalResult {
  return {
    state: 'ready',
    items: approvalSummary.items,
    total: approvalSummary.total,
    approvalCount: approvalSummary.approvalCount + lifecycle.approvalCount,
    claimTotal: approvalSummary.claimTotal,
    // The lifecycle inbox's My tasks share of the rail badge (it streams with these facts, package 1.3).
    lifecycleTaskCount: lifecycle.myTasksCount,
    // Ordinary employees keep their native assignment eligibility without acquiring manager authority.
    hasAssignedAttendanceApproval: !canApprove && approvalSummary.items.some(task => task.kind === 'attendance'),
    hasAssignedApproval: !canApprove && (approvalSummary.approvalCount + lifecycle.approvalCount) > 0,
  };
}

/**
 * The shell's approval facts read on their own, for a save that keeps the app frame (ADR 0181 decision 4): the
 * Approval Items and My tasks badges and the bell's Task tab update without the frame's menus and access checks being
 * read again. Same owners, sources and composition as app/layout.tsx; a failure is 'unavailable', as there.
 */
export async function readShellApprovalFacts(session: SessionContext): Promise<ShellApprovalResult> {
  try {
    const [{ scopeIds }, navigation] = await Promise.all([companyContextForPage(session), lifecycleModuleNavigation(session)]);
    const [approvalSummary, lifecycle] = await Promise.all([
      withBackgroundReadWork(session.tenantId, () =>
        pendingTaskSummary(session, scopeIds, shellPendingTaskSources(session), { deferClaimPreview: true })),
      lifecycleModuleInbox(session, navigation).catch((error): LifecycleModuleInbox => {
        console.error('Lifecycle module inbox unavailable', error);
        return EMPTY_LIFECYCLE_MODULE_INBOX;
      }),
    ]);
    return shellApprovalResult(approvalSummary, lifecycle, shellCanApprove(session));
  } catch (error) {
    console.error('Shell approval facts refresh unavailable', error);
    return { state: 'unavailable' };
  }
}
