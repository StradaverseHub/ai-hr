/**
 * r302 (board 6c9802c9) — My Leave History: the tab vocabulary and the "who is it waiting for" line.
 *
 * A CLIENT-SAFE LEAF (no db, no core imports), because the page (server) and the history island (client) both
 * read it — the same reason lib/leave-approval-kinds.ts exists. Pure data and pure functions only.
 */
import type { LeaveLevelKind } from './leave-approval-kinds';

/** The four tabs, in the plan's order. Each is exactly one leave_request status. */
export const LEAVE_HISTORY_TABS = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveHistoryTab = (typeof LEAVE_HISTORY_TABS)[number];

export function isLeaveHistoryTab(v: unknown): v is LeaveHistoryTab {
  return typeof v === 'string' && (LEAVE_HISTORY_TABS as readonly string[]).includes(v);
}

/**
 * The tab to open. An explicit, valid `?hTab=` wins. Otherwise Pending when anything is pending — the question
 * an employee most often comes with — else the first tab that has any records, else Pending.
 */
export function resolveHistoryTab(raw: string | undefined, counts: Record<LeaveHistoryTab, number>): LeaveHistoryTab {
  if (isLeaveHistoryTab(raw)) return raw;
  return LEAVE_HISTORY_TABS.find((tab) => counts[tab] > 0) ?? 'pending';
}

/**
 * Approver kind → its label key under the `leaveApproval` namespace, which already ships all nine in six
 * locales (the builder and the approval read-out use the same keys). A FULL Record: a kind added to
 * LEVEL_KINDS without a label is a tsc failure here, not a raw `manager_manager` on an employee's screen —
 * and not "HR review" for every step that is not the direct manager, which is what this page printed before.
 */
export const APPROVER_KIND_LABEL_KEY: Record<LeaveLevelKind, string> = {
  direct_manager: 'manager',
  manager_manager: 'managerManager',
  department_head: 'departmentHead',
  business_unit_head: 'businessUnitHead',
  hr_admin: 'hr',
  hr_manager: 'hrManager',
  payroll: 'payroll',
  custom_role: 'customRole',
  specific_employee: 'specificEmployee',
};

/** The label key for a kind, or null for a kind this vocabulary does not know (rendered as nothing, never raw). */
export function approverKindLabelKey(kind: string | null | undefined): string | null {
  return kind ? (APPROVER_KIND_LABEL_KEY as Record<string, string>)[kind] ?? null : null;
}

/** The subset of an approval trail (core/my-leave.ts OwnApprovalTrail) this line reads. */
export type ApprovalTrailInput = {
  status: string;
  singleLevelApproverName: string | null;
  steps: readonly {
    stepIndex: number;
    kind: string;
    approverName: string | null;
    alternateNames: readonly string[];
    status: string;
  }[];
};

export type PendingApprovalLine = {
  /** 1-based position of the level the request is waiting at. */
  level: number;
  /** How many levels the chain has. */
  of: number;
  /** The level's approver kind; null when the chain has no step rows and no manager to name. */
  kind: string | null;
  /** The people it is waiting for (primary first, then any-one alternates). Empty for a role kind. */
  names: string[];
};

/**
 * WHO a pending request is waiting for, and at which level — "Waiting for Marcus · Level 2 of 2".
 *
 * A chain with step rows waits at its lowest pending step. A request with NO step rows is a single-level chain
 * (core/leave.ts generateApprovalSteps writes steps only for a multi-level chain) decided by the direct manager
 * through assertCanDecide, so it is level 1 of 1 and waits for the manager the definer read named — or, with no
 * manager, for approval without a name. Null for anything not pending.
 */
export function pendingApprovalLine(trail: ApprovalTrailInput | null | undefined): PendingApprovalLine | null {
  if (!trail || trail.status !== 'pending') return null;
  const steps = [...trail.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  if (steps.length === 0) {
    const name = trail.singleLevelApproverName;
    return { level: 1, of: 1, kind: name ? 'direct_manager' : null, names: name ? [name] : [] };
  }
  const at = steps.findIndex((s) => s.status === 'pending');
  if (at === -1) return null;
  const current = steps[at];
  const names = [current.approverName, ...current.alternateNames].filter((n): n is string => !!n);
  return { level: at + 1, of: steps.length, kind: current.kind, names };
}
