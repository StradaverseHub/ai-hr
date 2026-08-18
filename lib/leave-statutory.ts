// The statutory right to APPLY, asked once — client-safe (464b58e6).
//
// WHY THIS MODULE EXISTS. Whether an employee's right to apply for a leave type is statutory (EA 1955
// s.60E annual, s.60F sick + hospitalisation, s.37 maternity, s.60FA paternity) is decided by
// `isStatutoryApplyType` in core/leave.ts, and `updateLeaveType` (core/admin.ts) REFUSES to switch
// employee_can_apply off on such a type — an employee must always be able to exercise a lawful
// entitlement.
//
// The admin screen has to ask the SAME question, to show the switch locked instead of letting HR turn it
// off and refusing afterwards. It could not: components/leave-type-panel.tsx is a client component and
// core/leave.ts imports db/client → postgres. So the panel carried its own literal list of the five codes
// the pack SEEDS — and production's statutory types are coded MTL / PTL / EL (see core/admin.ts), so on a
// real tenant the panel and the service disagreed: the box looked editable, the refusal arrived only after
// Save, and it arrived worded for an engineer. That is the failed save 464b58e6 reported.
//
// ROLE FIRST, SEEDED CODES AS THE FALLBACK — the identical precedence core/leave.ts uses, because
// `leave_type.role` (65f466e2) is the tenant-independent answer to "what IS this type" and the code is not.
// An UNCLASSIFIED row (role null/empty) falls back to the code set, so a tenant the backfill could not
// classify behaves exactly as it does today.
//
// THE LITERALS ARE A MIRROR, NOT A SECOND OPINION. They are spelled out here rather than imported for the
// same reason (and with the same remedy) as lib/leave-groups.ts's PRIMARY_ROLES and db/schema.ts's
// LeaveTypeRoleValue: a client component cannot reach the server module, so the copy is PINNED against the
// real STATUTORY_APPLY_ROLES / STATUTORY_APPLY_CODES by test/leave-employee-visibility-form.test.ts — which
// also pins the ANSWER against core's `isStatutoryApplyType` over a table of cases, so the two cannot drift
// silently in either their inputs or their verdict.
//
// GUARDRAIL: this decides exactly one thing — whether "Employees can apply" may be switched OFF. It is
// never consulted for entitlement, accrual, approval, payroll, or visibility. In particular it is NOT the
// Code-field lock (a7194511 / 65f466e2): that lock covers a WIDER set (these five plus Emergency) and is a
// separate decision, deliberately left where it is.

/** The `leave_type.role` values whose right to apply is statutory. Mirrors STATUTORY_APPLY_ROLES in
 *  core/leave.ts. Emergency is deliberately absent there and here: it is locked against editing, not
 *  statutorily applicable. */
export const STATUTORY_APPLY_ROLE_NAMES = [
  'annual',
  'sick',
  'hospitalization',
  'maternity',
  'paternity',
] as const;

/** The codes the pack SEEDS for those roles. Mirrors STATUTORY_APPLY_CODES in core/leave.ts. Only reached
 *  for an unclassified row — a tenant whose types carry a role is judged by the role alone. */
export const STATUTORY_APPLY_SEEDED_CODES = [
  'ANNUAL',
  'SICK',
  'HOSPITALIZATION',
  'MATERNITY',
  'PATERNITY',
] as const;

/**
 * Is this leave type one whose right to apply is statutory — i.e. one whose "Employees can apply" switch
 * may never be turned off?
 *
 * Role wins; an unclassified row falls back to the seeded code. Case/whitespace are normalised on both
 * sides: `leave_type.role` is CHECK-constrained to the canonical lowercase set (migration 0387) and codes
 * are canonical uppercase, so the normalisation can never make this answer differ from the service's — it
 * only stops a hand-edited row from producing a screen that disagrees with the refusal.
 */
export function isStatutoryApplyLeaveType(
  lt: { role?: string | null; code?: string | null } | null | undefined,
): boolean {
  if (lt == null) return false;
  const role = (lt.role ?? '').trim().toLowerCase();
  if (role !== '') return (STATUTORY_APPLY_ROLE_NAMES as readonly string[]).includes(role);
  return (STATUTORY_APPLY_SEEDED_CODES as readonly string[]).includes((lt.code ?? '').trim().toUpperCase());
}
