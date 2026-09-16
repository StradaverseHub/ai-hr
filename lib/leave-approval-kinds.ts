/**
 * r293 — THE APPROVER VOCABULARY, in a CLIENT-SAFE leaf.
 *
 * These constants were born in `core/leave-approval-policy.ts` and still read as if they live there: that
 * module re-exports every symbol below, so no existing import changed and the kernel remains their public
 * server-side door. They moved because the Approval Workflow BUILDER is a 'use client' component and needs
 * the same vocabulary the engine routes on — and `core/leave-approval-policy.ts` imports `db/client`,
 * `db/events` and `db/schema`, so importing it from a client component would drag the database kernel into
 * the browser bundle. The alternative, a second hand-maintained list inside the editor, is what this file
 * exists to delete: `app/admin/leave-approval/step-list-editor.tsx` carried exactly such a copy, and
 * nothing failed when the two disagreed — a kind the engine accepts but the picker never offers is
 * invisible until somebody hand-writes a template row.
 *
 * Same pattern as `lib/completed-years.ts` and `lib/payroll-permissions.ts`: pure data and pure functions,
 * no I/O, no imports.
 */

// 6fadb036 (R17 gap-close) — the reporter's full approver-step vocabulary (list C). Ordered as the
// request lists them; `hr_admin` is the internal id for the "HR" label. Each kind has a concrete
// decision-time resolver in core/leave.ts (assertCanDecideLeaveStep) and a generation-time drop rule:
//   direct_manager      → the subject's active administrative manager         (dropped when none)
//   manager_manager     → a SECOND hop up the same administrative line: the direct manager's own
//                         manager. r293 phase 2. Dropped when either hop is missing, and also when the
//                         second hop resolves back to the subject (a two-person reporting cycle would
//                         otherwise route a request to the person who raised it)                   (dropped when none)
//   department_head     → department.head_employment_id of the subject's dept (dropped when unset)
//   business_unit_head  → business_unit.head_employment_id of the subject's BU (dropped when unset)
//   hr_admin ("HR")     → hr_admin / super_admin role                          (never dropped)
//   hr_manager          → HR-tier authority (hr_admin / super_admin) — a distinct gate; a ranked
//                         hr_manager sub-role is a documented follow-up (ADR-0071 §i)                (never dropped)
//   payroll             → payroll_partner (subject's company) / super_admin    (never dropped)
//   custom_role         → an admin gate (hr_admin / super_admin); binding a specific named role per
//                         step is a documented follow-up (ADR-0071 §i custom_position guard)         (never dropped)
export const LEVEL_KINDS = [
  'direct_manager',
  'manager_manager',
  'department_head',
  'business_unit_head',
  'hr_admin',
  'hr_manager',
  'payroll',
  'custom_role',
] as const;
export type LeaveLevelKind = (typeof LEVEL_KINDS)[number];

/** Kinds that route to an org-chart HEAD (department / business unit). A step of these kinds is generated
 *  only when the subject's dept/BU actually has a head set — otherwise dropped (no dead step). */
export const HEAD_LEVEL_KINDS: readonly LeaveLevelKind[] = ['department_head', 'business_unit_head'];

/**
 * r293 — DYNAMIC vs FIXED, the distinction the builder puts a badge on.
 *
 * A DYNAMIC kind names a RELATIONSHIP that core/leave.ts resolves at step-generation time against the org
 * chart as it stands that moment: change an employee's manager or department and the chain follows without
 * anyone editing the template. A FIXED kind names a PERSON (an employment id stored on the level itself)
 * and follows nothing.
 *
 * That asymmetry is not cosmetic, and it is the reason the badge exists: a dynamic level that resolves to
 * nobody is DROPPED (see DROPPABLE_LEVEL_KINDS) and the request carries on down the chain, whereas a fixed
 * level has nothing to resolve and so can never be dropped — if the named person leaves, every request at
 * that level stalls until a human edits the template.
 *
 * Empty until r293 phase 3 introduces `specific_employee`; `test/r293-approval-builder.test.ts` pins BOTH
 * arms (every current kind is dynamic; a fixed kind is flagged) so adding a fixed kind without wiring the
 * badge, the drop rule and the departed-approver warning fails rather than passing silently.
 */
export const FIXED_LEVEL_KINDS: readonly LeaveLevelKind[] = [];

/** True when the kind names a specific PERSON rather than a relationship. The single owner of the
 *  Dynamic/Fixed classification — the builder badge, the preview and the drop rule all read this. */
export function isFixedLevelKind(kind: string): boolean {
  return (FIXED_LEVEL_KINDS as readonly string[]).includes(kind);
}

/**
 * r293 — the kinds whose step is DROPPED when the subject has nobody in that relationship.
 *
 * This set was previously spelled out only inside `generateApprovalSteps`'s filter in core/leave.ts, so the
 * builder had no way to tell the administrator which levels can be skipped and which always run — and r285
 * is what that costs: `department_head` and `business_unit_head` silently skipped for every request on the
 * customer's tenant because no department or BU had a head set, and no screen said so. Naming the set here
 * gives the filter and the UI one owner; `test/r293-approval-builder.test.ts` pins that this set is exactly
 * the set `applyChainDropRules` can drop, across both files.
 *
 * Role-based kinds (hr_admin / hr_manager / payroll / custom_role) are NEVER dropped: they resolve to role
 * authority at decision time, and an HR admin can clear any step, so they always have a decider.
 */
export const DROPPABLE_LEVEL_KINDS: readonly LeaveLevelKind[] = [
  'direct_manager',
  // r293 phase 2 — a second hop that does not exist is dropped for the same reason the first one is:
  // a step nobody can clear stalls the request forever.
  'manager_manager',
  ...HEAD_LEVEL_KINDS,
];

/** True when a level of this kind is skipped (rather than stalling) when it resolves to nobody. */
export function isDroppableLevelKind(kind: string): boolean {
  return (DROPPABLE_LEVEL_KINDS as readonly string[]).includes(kind);
}

/** Keep only values the engine knows. Unknown entries in stored jsonb are dropped rather than trusted. */
export function sanitizeLevels(raw: unknown): LeaveLevelKind[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is LeaveLevelKind => (LEVEL_KINDS as readonly string[]).includes(x as string));
}
