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
] as const;

export type PayrollPermissionKey = (typeof PAYROLL_PERMISSION_KEYS)[number];

/** Default role→keys map (used when no override row exists). All four keys default to admin roles. */
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
