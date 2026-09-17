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

// ── The pre-translated lines a history row and its View panel print ───────────────────────────────────────────
//
// Kept HERE, as pure functions over an injected translator, rather than inline in app/leave/page.tsx, so they
// can be exercised against the shipping catalogues without a request (test/r302-my-leave-history-lines.test.ts)
// — a FORMATTING_ERROR in a server-assembled string passes tsc, the suite and `next build` otherwise.

/** A translator over the `leave` namespace (next-intl's `t`, or `createTranslator` in a test). */
export type LeaveTranslate = (key: string, values?: Record<string, string | number>) => string;

export type HistoryLineDeps = {
  t: LeaveTranslate;
  /** The approver kind's own label (`leaveApproval.*` via APPROVER_KIND_LABEL_KEY), or null for an unknown kind. */
  kindLabel: (kind: string | null) => string | null;
  /** An instant in the tenant's time zone, or null. */
  fmtInstant: (d: Date | null | undefined) => string | null;
  /** Several names as one phrase ("Sarah or Ahmad"). */
  listNames: (names: string[]) => string;
};

/** The subset of a leave request row these lines read. */
export type HistoryRowInput = { status: string; appliedOn: Date; decidedAt: Date | null };

/** core/my-leave.ts OwnApprovalTrail, structurally. */
export type ApprovalTrailFull = {
  status: string;
  decidedByName: string | null;
  decidedAt: Date | null;
  singleLevelApproverName: string | null;
  steps: readonly {
    stepIndex: number;
    kind: string;
    approverName: string | null;
    alternateNames: readonly string[];
    status: string;
    decidedByName: string | null;
    decidedAt: Date | null;
  }[];
};

/** core/my-leave.ts OwnCancellation, structurally. */
export type CancellationInput = {
  cancelledAt: Date | null;
  cancelledByName: string | null;
  automatic: boolean;
  requestedAt: Date | null;
  reason: string | null;
};

export type ProgressStepLine = {
  label: string;
  detail: string | null;
  state: 'done' | 'current' | 'upcoming' | 'rejected';
};

/**
 * The row's Approver cell. Pending: WHO it waits for and at which level — a person's name when the level names
 * one, the kind's label for a role ("Waiting for HR · Level 2 of 2"), else "Waiting for approval". Decided: who
 * decided it. Cancelled: who cancelled it (or that it was approved automatically). Null when nothing is known.
 */
export function approverLine(
  row: HistoryRowInput,
  trail: ApprovalTrailFull | null | undefined,
  cancellation: CancellationInput | null | undefined,
  { t, kindLabel, listNames }: HistoryLineDeps,
): string | null {
  if (row.status === 'pending') {
    const line = pendingApprovalLine(trail);
    if (!line) return null;
    if (line.names.length > 0) return t('myLeave.waitingForName', { name: listNames(line.names), level: line.level, of: line.of });
    const role = kindLabel(line.kind);
    return role
      ? t('myLeave.waitingForRole', { role, level: line.level, of: line.of })
      : t('myLeave.waitingForApproval', { level: line.level, of: line.of });
  }
  if (row.status === 'cancelled') {
    if (cancellation?.automatic) return t('myLeave.cancelledAutomatically');
    return cancellation?.cancelledByName ? t('myLeave.cancelledBy', { name: cancellation.cancelledByName }) : null;
  }
  const name = trail?.decidedByName;
  if (!name) return null;
  return row.status === 'rejected' ? t('myLeave.rejectedBy', { name }) : t('myLeave.approvedBy', { name });
}

/**
 * The View panel's approval progress: Submitted → each level (its kind, the person, the decision and its time)
 * → the outcome. The level a pending request waits at is `current` — the one the panel highlights.
 */
export function approvalProgress(
  row: HistoryRowInput,
  trail: ApprovalTrailFull | null | undefined,
  cancellation: CancellationInput | null | undefined,
  { t, kindLabel, fmtInstant, listNames }: HistoryLineDeps,
): ProgressStepLine[] {
  const out: ProgressStepLine[] = [{ label: t('myLeave.progressSubmitted'), detail: fmtInstant(row.appliedOn), state: 'done' }];
  const levelLabel = (level: number, kind: string | null, names: string[]) => {
    const role = kindLabel(kind);
    if (role && names.length > 0) return t('myLeave.progressLevelNamed', { level, role, name: listNames(names) });
    if (role) return t('myLeave.progressLevel', { level, role });
    if (names.length > 0) return t('myLeave.progressLevelPerson', { level, name: listNames(names) });
    return t('myLeave.progressLevelOnly', { level });
  };
  const decidedAt = (key: 'myLeave.progressApprovedAt' | 'myLeave.progressRejectedAt', d: Date | null) => {
    const date = fmtInstant(d);
    return date ? t(key, { date }) : null;
  };
  const steps = [...(trail?.steps ?? [])].sort((a, b) => a.stepIndex - b.stepIndex);
  const firstPending = row.status === 'pending' ? steps.findIndex((st) => st.status === 'pending') : -1;
  if (steps.length > 0) {
    steps.forEach((st, i) => {
      if (st.status === 'approved') {
        out.push({ label: levelLabel(i + 1, st.kind, st.decidedByName ? [st.decidedByName] : []), detail: decidedAt('myLeave.progressApprovedAt', st.decidedAt), state: 'done' });
      } else if (st.status === 'rejected') {
        out.push({ label: levelLabel(i + 1, st.kind, st.decidedByName ? [st.decidedByName] : []), detail: decidedAt('myLeave.progressRejectedAt', st.decidedAt), state: 'rejected' });
      } else {
        const current = i === firstPending;
        out.push({
          label: levelLabel(i + 1, st.kind, [st.approverName, ...st.alternateNames].filter((n): n is string => !!n)),
          detail: current ? t('myLeave.progressWaiting') : row.status === 'pending' ? t('myLeave.progressNotReached') : null,
          state: current ? 'current' : 'upcoming',
        });
      }
    });
  } else if (row.status === 'pending') {
    // A single-level chain has no step rows (core/leave.ts generateApprovalSteps): level 1 of 1.
    const line = pendingApprovalLine(trail);
    out.push({ label: levelLabel(1, line?.kind ?? null, line?.names ?? []), detail: t('myLeave.progressWaiting'), state: 'current' });
  } else if (trail?.decidedAt) {
    out.push({
      label: levelLabel(1, null, trail.decidedByName ? [trail.decidedByName] : []),
      detail: decidedAt(row.status === 'rejected' ? 'myLeave.progressRejectedAt' : 'myLeave.progressApprovedAt', trail.decidedAt),
      state: row.status === 'rejected' ? 'rejected' : 'done',
    });
  }
  if (row.status === 'pending') out.push({ label: t('myLeave.progressOutcomeApproved'), detail: null, state: 'upcoming' });
  else if (row.status === 'approved') out.push({ label: t('myLeave.progressOutcomeApproved'), detail: fmtInstant(row.decidedAt), state: 'done' });
  else if (row.status === 'rejected') out.push({ label: t('myLeave.progressOutcomeRejected'), detail: fmtInstant(row.decidedAt), state: 'rejected' });
  else if (row.status === 'cancelled') out.push({ label: t('myLeave.progressOutcomeCancelled'), detail: fmtInstant(cancellation?.cancelledAt), state: 'done' });
  return out;
}

/** A cancelled request's who and when, when it was asked for, and the reason on record. Null when unknown. */
export function cancellationLines(
  row: { status: string },
  cancellation: CancellationInput | null | undefined,
  { t, fmtInstant }: HistoryLineDeps,
): { lines: string[]; reason: string | null } | null {
  const c = row.status === 'cancelled' ? cancellation : undefined;
  if (!c) return null;
  const lines: string[] = [];
  const at = fmtInstant(c.cancelledAt);
  if (at) {
    lines.push(
      c.automatic
        ? t('myLeave.cancelledAutomaticallyAt', { date: at })
        : c.cancelledByName
          ? t('myLeave.cancelledByAt', { name: c.cancelledByName, date: at })
          : t('myLeave.cancelledAt', { date: at }),
    );
  }
  const requested = fmtInstant(c.requestedAt);
  if (requested) lines.push(t('myLeave.cancellationRequestedAt', { date: requested }));
  return lines.length > 0 || c.reason ? { lines, reason: c.reason } : null;
}
