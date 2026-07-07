/**
 * Function-access registry — the honest, human-readable map of "which role can REACH which screen".
 *
 * This registry MIRRORS enforced access derived from each route's requireX guard in app/**\/page.tsx
 * as of 2026-07-04; editing this file does NOT change enforcement. Enforcement lives in the route
 * guards (lib/authz.ts + lib/scope.ts) and the database RLS policies (db/migrations/*.sql).
 *
 * Access is COARSE — "can this role open this screen at all" — NOT a View/Create/Edit/Delete/Approve
 * grid: the system does not store or enforce access at per-action granularity, so a five-verb grid
 * would fabricate a precision that does not exist. Per-record rules (an admin cannot approve their own
 * leave; a manager only approves their own reports) live in RLS and vary per record, so they are
 * surfaced as a plain-language `scopeNote`, never as a per-role scalar.
 *
 * How access was derived (per route, from the guard the page actually calls — NOT the sidebar groups,
 * which over-show partner roles nav they get redirected from):
 *   • requireAdmin / scopedAdmin  → { hr_admin, super_admin }
 *       (scopedAdmin calls requireAdmin internally, then narrows the DATA to the company scope.)
 *   • scopedSession               → every authenticated role reaches the page; the DATA is company /
 *       reporting-line scoped by RLS, so an employee opens the page but sees only their own rows.
 *
 * NOTE ON PARTNERS: payroll_partner / performance_comp_partner appear in the admin nav group (they are
 * "admins of their function"), but every payroll/config page is guarded by requireAdmin/scopedAdmin,
 * which redirects them. Their real reach today is exactly the scopedSession pages every role reaches.
 * The grid states that truth rather than the nav's optimistic view.
 */

import { roleEnum } from '../db/schema';

export type Role = (typeof roleEnum.enumValues)[number];

/** The 6 role identities, in a stable display order (rows of the grid). */
export const MATRIX_ROLES: readonly Role[] = [
  'employee',
  'manager',
  'hr_admin',
  'super_admin',
  'payroll_partner',
  'performance_comp_partner',
] as const;

/** The page guard each screen is gated by — the single source of the access truth for that screen. */
export type Guard = 'requireAdmin' | 'scopedAdmin' | 'scopedSession';

/** Roles that can REACH a screen given its guard (coarse page-level access). */
export function rolesForGuard(guard: Guard): ReadonlySet<Role> {
  // requireAdmin & scopedAdmin both gate on isAdmin → hr_admin + super_admin only.
  if (guard === 'requireAdmin' || guard === 'scopedAdmin') {
    return new Set<Role>(['hr_admin', 'super_admin']);
  }
  // scopedSession gates nothing at the page boundary — every authenticated role reaches it; RLS scopes data.
  return new Set<Role>(MATRIX_ROLES);
}

/** One column of the access grid: a screen, the guard that protects it, and the routes it covers. */
export interface ScreenEntry {
  /** Stable machine key (column id, i18n `scopeNote` suffix). */
  screenKey: string;
  /** Primary href the screen links to (the canonical route). */
  href: string;
  /**
   * i18n label key. Reuses an existing `nav.*` key where a screen maps 1:1 to a top-level nav entry;
   * otherwise a NEW `admin.users.screen.<screenKey>` label (translated in all 6 locales).
   */
  labelKey: string;
  /** The guard the page(s) call — the access source of truth. */
  guard: Guard;
  /**
   * Every guarded `app/**\/page.tsx` route this column represents. Parent + child routes that share a
   * guard collapse into one column. The reverse-completeness test asserts EVERY guarded route on disk
   * is listed here, so a new screen shipped without a column fails the build.
   */
  routes: readonly string[];
  /**
   * True when the scopeNote below applies (an i18n key `admin.users.scope.<screenKey>` exists). Kept as
   * an explicit flag so the grid renders the note only where one is authored.
   */
  hasScopeNote?: boolean;
}

/**
 * The screens (grid columns). Ordered roughly by the sidebar: everyday screens first, then the admin /
 * payroll surfaces. `routes` collapses parent+child pages that share one guard into a single column.
 */
export const SCREENS: readonly ScreenEntry[] = [
  // ── Everyday screens (scopedSession: every role reaches, data is scoped) ──
  { screenKey: 'dashboard', href: '/', labelKey: 'nav.dashboard', guard: 'scopedSession', routes: ['/'] },
  {
    screenKey: 'people',
    href: '/personnel',
    labelKey: 'nav.people',
    guard: 'scopedSession',
    routes: ['/personnel'],
    hasScopeNote: true,
  },
  { screenKey: 'orgChart', href: '/org', labelKey: 'nav.orgChart', guard: 'scopedSession', routes: ['/org'] },
  {
    screenKey: 'leave',
    href: '/leave',
    labelKey: 'nav.leave',
    guard: 'scopedSession',
    routes: ['/leave'],
    hasScopeNote: true,
  },
  {
    screenKey: 'attendance',
    href: '/attendance',
    labelKey: 'nav.attendance',
    guard: 'scopedSession',
    routes: ['/attendance'],
    hasScopeNote: true,
  },
  // ── Manage screens (scopedSession, but nav-shown to managers up; visibility follows reporting lines) ──
  {
    screenKey: 'approvals',
    href: '/approvals',
    labelKey: 'nav.approvals',
    guard: 'scopedSession',
    routes: ['/approvals'],
    hasScopeNote: true,
  },
  {
    screenKey: 'roster',
    href: '/roster',
    labelKey: 'nav.roster',
    guard: 'scopedSession',
    routes: ['/roster'],
    hasScopeNote: true,
  },
  {
    screenKey: 'performance',
    href: '/performance',
    labelKey: 'nav.performance',
    guard: 'scopedSession',
    routes: ['/performance', '/performance/[cycleId]'],
    hasScopeNote: true,
  },
  // ── Admin org / people (requireAdmin → hr_admin + super_admin) ──
  {
    screenKey: 'organization',
    href: '/admin/organization',
    labelKey: 'nav.organization',
    guard: 'scopedAdmin',
    routes: ['/admin/organization'],
  },
  {
    screenKey: 'personnelAdmin',
    href: '/admin/personnel',
    labelKey: 'nav.personnelAdmin',
    guard: 'requireAdmin',
    routes: ['/admin/personnel', '/admin/personnel/[employmentId]', '/admin/personnel/import'],
  },
  {
    screenKey: 'systemLabels',
    href: '/admin/settings/system-labels',
    labelKey: 'nav.systemLabels',
    guard: 'scopedAdmin',
    routes: ['/admin/settings/system-labels'],
  },
  // ── Admin leave / attendance / claims config (requireAdmin) ──
  {
    screenKey: 'leaveConfig',
    href: '/admin/leave',
    labelKey: 'nav.leaveConfig',
    guard: 'requireAdmin',
    // R13 0d147b78: leave config split into route-based tabs (approval tab is scopedSession → own screen below).
    routes: [
      '/admin/leave',
      '/admin/leave/import',
      '/admin/leave/entitlements',
      '/admin/leave/application-rules',
      '/admin/leave/payroll',
      '/admin/leave/audit',
    ],
  },
  {
    screenKey: 'leaveApproval',
    href: '/admin/leave/approval',
    labelKey: 'nav.leaveApproval',
    guard: 'scopedSession',
    // R13 0d147b78: absorbed the standalone /admin/leave-approval into the leave tabs (old route now redirects).
    routes: ['/admin/leave/approval'],
    hasScopeNote: true,
  },
  { screenKey: 'holidays', href: '/admin/holidays', labelKey: 'nav.holidays', guard: 'requireAdmin', routes: ['/admin/holidays'] },
  {
    screenKey: 'attendancePolicy',
    href: '/admin/attendance',
    labelKey: 'nav.attendancePolicy',
    guard: 'requireAdmin',
    routes: ['/admin/attendance', '/attendance/import'],
  },
  {
    screenKey: 'attendanceAllowance',
    href: '/admin/attendance-allowance',
    labelKey: 'nav.attendanceAllowance',
    guard: 'scopedAdmin',
    routes: ['/admin/attendance-allowance'],
  },
  { screenKey: 'locations', href: '/admin/locations', labelKey: 'nav.locations', guard: 'requireAdmin', routes: ['/admin/locations'] },
  { screenKey: 'toilPolicy', href: '/admin/toil', labelKey: 'nav.toilPolicy', guard: 'requireAdmin', routes: ['/admin/toil'] },
  {
    screenKey: 'claimsConfig',
    href: '/admin/claims',
    labelKey: 'nav.claimsConfig',
    guard: 'requireAdmin',
    routes: ['/admin/claims', '/admin/claims/reimbursements'],
  },
  { screenKey: 'loans', href: '/admin/loans', labelKey: 'admin.users.screen.loans', guard: 'requireAdmin', routes: ['/admin/loans'] },
  // ── Payroll (scopedAdmin/requireAdmin → hr_admin + super_admin; partners are redirected today) ──
  {
    screenKey: 'payroll',
    href: '/payroll',
    labelKey: 'nav.payroll',
    guard: 'scopedAdmin',
    routes: [
      '/payroll',
      '/payroll/[batchId]',
      '/payroll/configuration',
      '/payroll/history-import',
      '/payroll/process',
      '/payroll/process/result',
      '/payroll/reports',
      '/payroll/setup',
      '/payroll/transactions',
      '/payroll/transactions/fixed',
      '/payroll/transactions/individual',
      '/payroll/transactions/tp1',
      // R13 a4a05174: centralized read-only Transaction View (scopedAdmin, same guard as the hub).
      '/payroll/transactions/view',
      '/payroll/transactions/zakat',
    ],
  },
  {
    screenKey: 'payrollCycleConfig',
    href: '/admin/payroll-cycle',
    labelKey: 'nav.payrollCycleConfig',
    guard: 'scopedAdmin',
    routes: ['/admin/payroll-cycle'],
  },
  {
    screenKey: 'payrollConfig',
    href: '/admin/payroll-config',
    labelKey: 'admin.users.screen.payrollConfig',
    guard: 'scopedSession',
    routes: ['/admin/payroll-config'],
    hasScopeNote: true,
  },
  {
    screenKey: 'payrollPolicy',
    href: '/admin/payroll-policy',
    labelKey: 'admin.users.screen.payrollPolicy',
    guard: 'scopedAdmin',
    routes: ['/admin/payroll-policy'],
  },
  {
    screenKey: 'payComponents',
    href: '/admin/pay-components',
    labelKey: 'admin.users.screen.payComponents',
    guard: 'requireAdmin',
    routes: ['/admin/pay-components'],
  },
  // ── Analytics / audit / governance (requireAdmin/scopedAdmin) ──
  { screenKey: 'analytics', href: '/analytics', labelKey: 'nav.analytics', guard: 'scopedAdmin', routes: ['/analytics'] },
  { screenKey: 'auditTrail', href: '/admin/audit', labelKey: 'nav.auditTrail', guard: 'requireAdmin', routes: ['/admin/audit'] },
  { screenKey: 'dataPrivacy', href: '/admin/privacy', labelKey: 'nav.dataPrivacy', guard: 'requireAdmin', routes: ['/admin/privacy'] },
  { screenKey: 'aiConfig', href: '/admin/ai', labelKey: 'nav.aiConfig', guard: 'requireAdmin', routes: ['/admin/ai'] },
  { screenKey: 'usersRoles', href: '/admin/users', labelKey: 'nav.usersRoles', guard: 'requireAdmin', routes: ['/admin/users'] },
] as const;

/**
 * Every guarded route enumerated across all columns — the set the reverse-completeness test compares
 * against the filesystem glob. A route present on disk but missing here fails the test.
 */
export const REGISTERED_ROUTES: ReadonlySet<string> = new Set(SCREENS.flatMap((s) => s.routes));

/** A single grid cell: can `role` reach `screen`. */
export function canReach(role: Role, screen: ScreenEntry): boolean {
  return rolesForGuard(screen.guard).has(role);
}
