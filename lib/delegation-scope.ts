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

/** The (module, taskType) pair passed to the scope-aware decision guard for a given approval flow. */
export function scopeOf(taskType: DelegationTaskType): { module: DelegationModule; taskType: DelegationTaskType } {
  return { module: moduleOfTask[taskType], taskType };
}
