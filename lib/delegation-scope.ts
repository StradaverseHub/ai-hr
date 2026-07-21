/**
 * R44 delegation (Phase 2) — the single registry of what a delegation can be SCOPED to. Shared by the
 * enforcement layer (core/approvals.ts → app.can_decide_via_delegation) and the UI (command bar +
 * /delegations forms + the list's Module column) so both agree on the exact module/task vocabulary.
 *
 * v1 wires ONLY task types that map to a REAL request→decide approval flow (per the approved plan):
 *   • Leave    — application, cancellation
 *   • Attendance — correction (OT is folded here; it is stamped during a correction, not its own flow)
 *   • Claims   — claim
 * "Payroll approval" is intentionally absent (batch close is an admin state transition, not a decision).
 *
 * A delegation with NO scope rows = whole-scope (all approvals) — the back-compat default. A scope row with
 * a NULL task_type covers the WHOLE module; with a task_type, just that task.
 */

export type DelegationModule = 'leave' | 'attendance' | 'claims';

export type DelegationTaskType =
  | 'leave.application'
  | 'leave.cancellation'
  // R51 (20f09fc3) — request-side leave duties. These record & limit what was handed over; they map to NO
  // decide flow (the SQL matcher requires exact task_type equality, so they grant zero approval authority).
  | 'leave.request.creation'
  | 'leave.request.amendment'
  | 'leave.cancellation_request.creation'
  | 'attendance.correction'
  | 'claims.claim';

export const DELEGATION_SCOPE: { module: DelegationModule; tasks: DelegationTaskType[] }[] = [
  { module: 'leave', tasks: ['leave.application', 'leave.cancellation'] },
  { module: 'attendance', tasks: ['attendance.correction'] },
  { module: 'claims', tasks: ['claims.claim'] },
];

export const moduleOfTask: Record<DelegationTaskType, DelegationModule> = {
  'leave.application': 'leave',
  'leave.cancellation': 'leave',
  'leave.request.creation': 'leave',
  'leave.request.amendment': 'leave',
  'leave.cancellation_request.creation': 'leave',
  'attendance.correction': 'attendance',
  'claims.claim': 'claims',
};

const TASK_SET = new Set<string>(Object.keys(moduleOfTask));
const MODULE_SET = new Set<string>(DELEGATION_SCOPE.map((m) => m.module));

export function isDelegationModule(v: string): v is DelegationModule {
  return MODULE_SET.has(v);
}
export function isDelegationTaskType(v: string): v is DelegationTaskType {
  return TASK_SET.has(v);
}

// i18n key suffixes. next-intl reads '.' as a nesting separator, so the dotted taskType values can't be
// message keys directly — map each to a flat camelCase key under the `delegations.taskLabel` namespace.
export const taskLabelKey: Record<DelegationTaskType, string> = {
  'leave.application': 'leaveApplication',
  'leave.cancellation': 'leaveCancellation',
  'leave.request.creation': 'leaveRequestCreation',
  'leave.request.amendment': 'leaveAmendmentRequest',
  'leave.cancellation_request.creation': 'leaveCancellationRequest',
  'attendance.correction': 'attendanceCorrection',
  'claims.claim': 'claimsClaim',
};

// ── R51 (20f09fc3) — expandable task GROUPS in the scope picker ─────────────────────────────────────
// A group is a TRANSIENT form value only: the picker submits `scopeGroup` checkboxes, and the parse step
// expands each group to its LEAF task rows at save time (expandScopeTasks). Group ids are NEVER written to
// reporting_line_scope — storage stays leaf-only, so isDelegationTaskType keeps rejecting them and every
// stored row renders with a leaf label. That is why groups live in their own structure (NOT DelegationTaskType).
export type DelegationScopeGroupId = 'leave.request' | 'leave.cancellation_request';

export type DelegationScopeGroup = {
  id: DelegationScopeGroupId;
  /** flat key under `delegations.groupLabel` (dots can't be message keys — same rule as taskLabelKey). */
  labelKey: string;
  leaves: DelegationTaskType[];
};

export const DELEGATION_SCOPE_GROUPS: Partial<Record<DelegationModule, DelegationScopeGroup[]>> = {
  leave: [
    { id: 'leave.request', labelKey: 'leaveRequest', leaves: ['leave.request.creation', 'leave.request.amendment'] },
    { id: 'leave.cancellation_request', labelKey: 'leaveCancellation', leaves: ['leave.cancellation_request.creation'] },
  ],
};

const GROUP_BY_ID = new Map<string, DelegationScopeGroup>(
  Object.values(DELEGATION_SCOPE_GROUPS).flatMap((gs) => (gs ?? []).map((g) => [g.id, g] as const)),
);

export function isDelegationScopeGroup(v: string): v is DelegationScopeGroupId {
  return GROUP_BY_ID.has(v);
}

/**
 * Expand submitted (groups, leaf tasks) into the EFFECTIVE leaf list. Per group: when NONE of that group's
 * OWN leaves were submitted, the bare group covers ALL of its leaves (the same "a tick with nothing ticked
 * underneath covers everything underneath" rule a module checkbox follows); when some of its leaves were
 * submitted, only those count. Flat leaves of other groups/modules pass through untouched, so a bare group
 * plus an unrelated flat leaf loses nothing. De-duped, leaf-only output.
 */
export function expandScopeTasks(
  groupIds: DelegationScopeGroupId[],
  taskIds: DelegationTaskType[],
): DelegationTaskType[] {
  const out = new Set<DelegationTaskType>(taskIds.filter((t) => TASK_SET.has(t)));
  for (const gid of new Set(groupIds)) {
    const group = GROUP_BY_ID.get(gid);
    if (!group) continue;
    const ownSubmitted = group.leaves.some((leaf) => out.has(leaf));
    if (!ownSubmitted) for (const leaf of group.leaves) out.add(leaf);
  }
  return [...out];
}

/** The (module, taskType) pair passed to the scope-aware decision guard for a given approval flow. */
export function scopeOf(taskType: DelegationTaskType): { module: DelegationModule; taskType: DelegationTaskType } {
  return { module: moduleOfTask[taskType], taskType };
}
