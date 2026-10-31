/** Pure role/grant predicates shared by request guards and isolated service consumers. */
import type {SessionContext} from '../db/client';


const ADMIN_ROLES = new Set(['hr_admin', 'super_admin']);

export function isAdmin(s: SessionContext): boolean {
  return !!s.roles?.some((r) => ADMIN_ROLES.has(r));
}

/** My Team is a manager job; approval delegation alone never grants team browsing. */
export function hasTeamAccess(s: SessionContext): boolean {
  return !!s.roles?.some(role => role === 'manager' || ADMIN_ROLES.has(role));
}

/** Group-level admin: super_admin (any scope) or a group-wide hr_admin. Mirrors app.is_group_admin(). */
export function isGroupAdmin(s: SessionContext): boolean {
  return !!s.grants?.some((g) => g.role === 'super_admin' || (g.role === 'hr_admin' && g.companyId == null));
}

/**
 * Operator tier (0294/0295) — the INSTALLATION-level identity that provisions new customers. Mirrors
 * app.is_operator(), which is the authoritative gate (RLS on tenant_provision_request + the
 * app.claim_activation_url definer function both call it). This TS mirror is the fail-fast UX gate.
 *
 * Read `s.grants` directly rather than `s.roles`: unlike every other predicate here, operator is NOT a
 * customer role, so it must never be inferred from the flattened role list of a tenant session.
 *
 * NOTE what this deliberately does NOT do: it does not imply isAdmin() or isGroupAdmin(). An operator
 * reaches the provisioning console and nothing else — no customer admin screen, no customer data. That
 * separation is the point of a separate tier, and app/(app)/operator/page.tsx is its only consumer.
 */
export function isOperator(s: SessionContext): boolean {
  return !!s.grants?.some((g) => g.role === 'operator');
}

/**
 * Company-scoped grant predicate (ADR-0049). True if the session holds `role` via a grant that
 * covers `companyId`: group-wide (grant.companyId == null) OR the exact company. NOTE: this resolves
 * against `s.grants` (which carries companyId), NOT the flattened `s.roles` (which drops it) — gating
 * a company-scoped decision on `s.roles` would grant cross-company access (the cross-company bug this
 * slice guards against). Subtree-descendant matching is the DB's authoritative job (app.has_role_for);
 * this service-layer guard is a UX gate — when no companyId is supplied it matches any grant of that
 * role, and the DB RLS backstops the precise scope.
 */
export function hasGrantFor(s: SessionContext, role: string, companyId?: string | null): boolean {
  return !!s.grants?.some(
    (g) => g.role === role && (companyId == null || g.companyId == null || g.companyId === companyId),
  );
}

// Capability role-sets (ADR-0049): a partner is an admin-of-its-function. Admin roles are unioned in
// so a user who is BOTH hr_admin and a partner is never narrower than a plain admin.
const PAYROLL_ROLES = new Set([...ADMIN_ROLES, 'payroll_partner']);
const PERFCOMP_ROLES = new Set([...ADMIN_ROLES, 'performance_comp_partner']);

/** Can manage the payroll function for `companyId` (admin OR company-scoped payroll partner). */
export function canManagePayroll(s: SessionContext, companyId?: string | null): boolean {
  return !!s.grants?.some(
    (g) => PAYROLL_ROLES.has(g.role) && (companyId == null || g.companyId == null || g.companyId === companyId),
  );
}

/** Can manage the performance+comp function for `companyId` (admin OR company-scoped perfcomp partner). */
export function canManagePerfComp(s: SessionContext, companyId?: string | null): boolean {
  return !!s.grants?.some(
    (g) => PERFCOMP_ROLES.has(g.role) && (companyId == null || g.companyId == null || g.companyId === companyId),
  );
}

export function isPayrollPartner(s: SessionContext, companyId?: string | null): boolean {
  return hasGrantFor(s, 'payroll_partner', companyId);
}

/**
 * Festive-grant re-plan (ADR-0066 round 5): back-compat shim shared by `grantAdHocLeave` and
 * `grantAdHocLeaveMulti`. A roles-only session (no `grants`, e.g. `withTenant`'s treatment of a bare
 * `roles` array, or test `adminCtx`) is treated as group-wide — flatten `roles` into group-wide grants
 * (companyId null) so `isGroupAdmin` / `hasGrantFor` see it correctly. A session that already carries
 * `grants` passes through unchanged. Pure extraction of the logic formerly inlined in
 * `grantAdHocLeave` (core/leave.ts) — zero behavior change.
 */
export function withEffectiveGrants(s: SessionContext): SessionContext {
  return s.grants != null
    ? s
    : { ...s, grants: (s.roles ?? []).map((role) => ({ role, companyId: null as string | null })) };
}

export function isPerfCompPartner(s: SessionContext, companyId?: string | null): boolean {
  return hasGrantFor(s, 'performance_comp_partner', companyId);
}

/**
 * ADR-0142 — who administers OneHR-NATIVE assessment cycles: the admin roles, the perf-comp partner and the
 * OneHR performance partner. The TS mirror of app.assessment_admin_for (0611); the DB predicate is the
 * authoritative backstop (live grants, subtree descendants). Deliberately a SEPARATE set: the performance
 * partner is NOT in PERFCOMP_ROLES / PAYROLL_ROLES / ADMIN_ROLES, so canManagePerfComp, requirePerfCompAccess,
 * canManagePayroll and isAdmin keep refusing it — generic cycles, merit, compensation, payroll and HR stay
 * out of its reach. Resolved against `s.grants` (companyId-bearing), never the flattened `s.roles`.
 */
const ONEHR_ADMIN_ROLES = new Set([...PERFCOMP_ROLES, 'performance_partner']);

/** Can administer OneHR-native assessment cycles for `companyId` (no companyId = any grant of the set). */
export function canAdminOnehr(s: SessionContext, companyId?: string | null): boolean {
  return !!s.grants?.some(
    (g) => ONEHR_ADMIN_ROLES.has(g.role) && (companyId == null || g.companyId == null || g.companyId === companyId),
  );
}

/**
 * True when the session's ONLY route to performance administration is the OneHR performance partner: it
 * can administer OneHR-native cycles but must not see generic cycles, merit, pending pay or the new-cycle
 * form. A user who is also an admin or a perf-comp partner is never narrowed by this (union rule, ADR-0049).
 */
export function isOnehrOnlyPerformanceAdmin(s: SessionContext): boolean {
  return hasGrantFor(s, 'performance_partner') && !isAdmin(s) && !canManagePerfComp(s);
}
