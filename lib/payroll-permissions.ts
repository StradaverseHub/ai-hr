/**
 * Granular payroll RBAC permission keys (feedback 9bc442bc, reporter expected_function).
 *
 * The reporter asked for four DISTINCT permission keys — rather than the coarse "is this an admin"
 * check — mapped through the RBAC model and configurable per company/tenant:
 *   • payroll.rollback           — revert a Processed run to Draft
 *   • payroll.unlock             — reopen a Closed run (high-risk, single-confirm + mandatory reason)
 *   • payroll.reprocess.selective— reprocess selected employees within a run
 *   • payroll.close              — close a Processed run
 *
 * Enforcement is two-layer: code DEFAULTS below give the shipping behaviour, and a per-company/tenant
 * override table (`payroll_permission_grant`) can widen or narrow any (key, role) pair. The DB resolver
 * (`resolvePayrollPermission` in core/payroll.ts) reads the override rows for a company (falling back to
 * tenant-wide rows, then to these defaults) so an operator can, e.g., narrow payroll.unlock back to
 * super_admin-only for one company without touching code.
 *
 * 5206539f — THIS MODULE IS NO LONGER PAYROLL-ONLY. `leave.apply_on_behalf` (see the tuple below) rides the
 * same two-layer mechanism, because the mechanism is about GRANULAR, CONFIGURABLE authority and nothing in
 * it is payroll-specific. The module name, the tuple name and the override table's name are all now one
 * word too narrow; renaming them is a separate ticket (the table rename needs a migration). Every reader
 * should treat "payroll" in these identifiers as historical.
 */

export const PAYROLL_PERMISSION_KEYS = [
  'payroll.rollback',
  'payroll.unlock',
  'payroll.reprocess.selective',
  'payroll.close',
  // 9066bd6c — remove ONE employee's calculated result from a processed run. Deliberately its OWN key
  // rather than a reuse of payroll.rollback: an operator trusted to take one person off a run is not
  // thereby trusted to zeroize the whole company's month, and the two actions have to be grantable
  // apart. It defaults to the same admin roles rollback does, so nothing widens on the day it ships.
  'payroll.remove.employee',
  // 5206539f — APPLYING FOR LEAVE ON SOMEONE ELSE'S BEHALF, and the first key here that is not about payroll.
  //
  // WHY IT LIVES IN THIS TUPLE. Until now nothing in the system named this power at all: the Leave screen
  // offered an Employee selector to anyone with a direct report, and core/leave.ts requestLeave accepted
  // whatever employmentId was posted without asking who was posting it. Having people report to you is an
  // accident of the org chart, not a permission. This key is the permission, and it is resolved through the
  // same two-layer mechanism the four payroll keys use — code default below, overridable per company/tenant
  // — so a customer can hand it to a particular role without a deploy.
  //
  // THE COST, STATED PLAINLY: the override table this resolves against is named `payroll_permission_grant`,
  // and with a leave key stored in it that name is now a MISNOMER. It is plain text with no enum and no
  // foreign key (db/schema.ts), so it stores this key correctly today and NO migration was needed. Renaming
  // the table (and this module) is its own ticket and its own migration — deliberately not smuggled into a
  // permission fix. The admin screen that grants it (app/admin/payroll-permissions) says out loud that it is
  // not payroll-only, so an operator looking for a LEAVE permission has some reason to open it.
  //
  // ── READ THIS BEFORE GRANTING IT TO A NON-ADMIN ROLE ──────────────────────────────────────────────────
  // The key is honoured EVERYWHERE — core/leave.ts requestLeave refuses any on-behalf submission without it,
  // whatever screen or script sent it — but the SCREEN that offers the power was only ever finished for the
  // roles that hold it by default, and those roles never open it. app/leave/page.tsx renders the Request
  // Leave dialog for `ess = !isAdmin(session)` only, so an hr_admin / super_admin never sees the dialog at
  // all (they file leave from the HR screens). Grant this key to any OTHER role and that role does see it,
  // with two limits nobody would guess from the grant:
  //
  //   · THE LEAVE TYPES ON OFFER ARE THE HOLDER'S OWN, not the selected employee's. `requestLeaveTypeOptions`
  //     is built from listEligibleLeaveTypesFor(me), so a male holder picking a female report finds Maternity
  //     simply ABSENT from the list, and a holder outside a type's service/probation window cannot file that
  //     type for anyone. Nothing is mis-filed — requestLeave still runs assertEligible against the SUBJECT —
  //     the offer is just narrower than the subject's real entitlement.
  //   · A HOLDER WHO QUALIFIES FOR NOTHING THEMSELVES GETS NO TRIGGER. The "+ Request Leave" button is gated
  //     on `requestLeaveTypeOptions.length > 0`, so a holder with an empty own eligible set (a fresh hire
  //     inside every minServiceMonths, say) has no way in even for someone else.
  //
  // Both fall out of ONE decision: 5206539f deleted the per-subject type narrowing rather than adapting it,
  // because it existed to serve a line-manager selector the reporter asked to remove entirely. Making the
  // offer re-draw for the selected employee means rebuilding it — core/read.ts `eligibleLeaveTypeIdsFor` is
  // the (still correct, currently uncalled) read that answers it. That is a deliberate ticket with its own
  // UI, not a line to add here.
  'leave.apply_on_behalf',
  // r292 / readiness 3.2 — RECORD THAT A STATUTORY RETURN HAS BEEN FILED WITH THE AGENCY, and reverse a
  // mark made in error. ONE key covers both directions on purpose: an operator who can enter a state but
  // not leave it is a trap, and the two powers are not separable in kind (both write the system's claim
  // about what was lodged with LHDN / KWSP / PERKESO). That is the opposite of the payroll.remove.employee
  // reasoning above, where the two powers genuinely differ in blast radius.
  //
  // WHY A GRANULAR KEY RATHER THAN isAdmin / canManagePayroll. Filing is a statutory act and this repo
  // cannot know whose act it is: in one customer HR files, in the next an outsourced payroll bureau
  // (`payroll_partner`) does, and in a third only the finance director signs. That is a genuine UNKNOWN,
  // and the two-layer mechanism is exactly how this codebase answers an UNKNOWN about authority — the
  // default below is narrow and the customer widens it per company without a deploy. Every sibling
  // high-risk payroll state transition (rollback, unlock, close, remove) is already gated this way; a
  // hand-rolled isAdmin check here would be the odd one out.
  //
  // ⚠️ THE SHIPPED LIMIT, STATED PLAINLY (same honesty leave.apply_on_behalf documents above): the key is
  // enforced in the SERVICE, so it refuses whatever screen or script calls markReportFiled. But the only
  // screen that OFFERS the control today is app/payroll/reports/page.tsx, which is `requireAdmin()`.
  // Granting this key to payroll_partner therefore authorises the action without yet giving that role a
  // way to reach it. Widening that page is a separate decision about who may read every statutory report
  // for a company, and it was deliberately not smuggled into this one.
  'payroll.statutory_file',
] as const;

export type PayrollPermissionKey = (typeof PAYROLL_PERMISSION_KEYS)[number];

/** Default role→keys map (used when no override row exists). EVERY key defaults to admin roles only. */
export const PAYROLL_PERMISSION_DEFAULTS: Record<PayrollPermissionKey, readonly string[]> = {
  'payroll.rollback': ['hr_admin', 'super_admin'],
  'payroll.reprocess.selective': ['hr_admin', 'super_admin'],
  'payroll.close': ['hr_admin', 'super_admin'],
  // Reopens a legally-frozen closed run — restricted to admins. hr_admin is the operator meant to run
  // unlock, so it defaults in line with its rollback/reprocess/close siblings; narrow back to
  // super_admin-only per company via an allowed=false hr_admin override when a tenant needs it.
  'payroll.unlock': ['hr_admin', 'super_admin'],
  // 9066bd6c — same default allow-list as payroll.rollback. Removal is narrower in blast radius (one
  // employee, run stays Processed) but identical in kind: it destroys a calculated result and unwinds
  // the money that result set in motion. A tenant that wants a payroll clerk to remove without being
  // able to reset grants this key to their role and leaves payroll.rollback alone.
  'payroll.remove.employee': ['hr_admin', 'super_admin'],
  // 5206539f — the roles that ALREADY hold HR authority over someone else's leave, and nobody else. This is
  // exactly the allow-list adminCancelLeave enforces in code (isAdmin ⇒ hr_admin | super_admin) for the
  // cancel-on-behalf power, so submitting and cancelling on an employee's behalf default to the same hands.
  // A line manager is deliberately ABSENT: nothing widens on the day this ships, and a customer who wants a
  // particular manager (or every manager in one company) to file on behalf grants the key to their role —
  // after reading the two shipped limits recorded against the key above, which bite ONLY once a non-admin
  // role holds it.
  'leave.apply_on_behalf': ['hr_admin', 'super_admin'],
  // r292 — the same narrow default every other key here starts from: nothing widens on the day it ships.
  // A customer whose returns are lodged by an outsourced bureau grants the key to `payroll_partner` for
  // that company (after reading the shipped limit recorded against the key above).
  'payroll.statutory_file': ['hr_admin', 'super_admin'],
} as const;

export function isPayrollPermissionKey(v: string): v is PayrollPermissionKey {
  return (PAYROLL_PERMISSION_KEYS as readonly string[]).includes(v);
}

/**
 * Pure resolver: given the caller's roles, the code default, and any override rows for the key, decide
 * whether the caller holds the permission. Override rows (company-specific preferred over tenant-wide)
 * REPLACE the default allow-list for that key: the set of roles with an `allowed=true` override, minus
 * any `allowed=false` override. When no override rows exist for the key, the code default applies.
 */
export function decidePayrollPermission(args: {
  key: PayrollPermissionKey;
  callerRoles: readonly string[];
  overrides: readonly { role: string; allowed: boolean; companyScoped: boolean }[];
}): boolean {
  const { key, callerRoles, overrides } = args;
  const roleSet = new Set(callerRoles);
  // Prefer company-scoped overrides when present; else tenant-wide overrides; else code defaults.
  const companyOverrides = overrides.filter((o) => o.companyScoped);
  const tenantOverrides = overrides.filter((o) => !o.companyScoped);
  const effective = companyOverrides.length ? companyOverrides : tenantOverrides;
  if (effective.length === 0) {
    return PAYROLL_PERMISSION_DEFAULTS[key].some((r) => roleSet.has(r));
  }
  const allow = new Set(effective.filter((o) => o.allowed).map((o) => o.role));
  const deny = new Set(effective.filter((o) => !o.allowed).map((o) => o.role));
  return [...roleSet].some((r) => allow.has(r) && !deny.has(r));
}
