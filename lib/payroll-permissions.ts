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
  // the table (and this module, and the admin screen's heading) is its own ticket and its own migration —
  // deliberately not smuggled into a permission fix.
  'leave.apply_on_behalf',
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
  // particular manager (or every manager in one company) to file on behalf grants the key to their role.
  'leave.apply_on_behalf': ['hr_admin', 'super_admin'],
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
