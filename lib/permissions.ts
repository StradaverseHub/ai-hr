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

/**
 * The role identities, in a stable display order (rows of the grid). Must stay EXACTLY the roleEnum set
 * — test/function-access.test.ts pins that, so a new role forces a new grid row rather than silently
 * vanishing from a screen whose whole job is transparency.
 */
export const MATRIX_ROLES: readonly Role[] = [
  'employee',
  'manager',
  'hr_admin',
  'super_admin',
  'payroll_partner',
  'performance_comp_partner',
  // Operator (0294) — the installation tier, listed here for completeness of the transparency grid.
  // It reaches no requireAdmin/scopedAdmin screen (it is not an admin role), and the only screen it
  // DOES reach — /operator — is gated in-page and therefore not a matrix column, exactly like
  // /admin/scheduled-actions.
  'operator',
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
    // a7cbd895: the /leave screen is now labelled "My Absence" in the sidebar — the matrix column
    // follows the nav label. screenKey stays 'leave' (it may key stored role configs); label-only.
    screenKey: 'leave',
    href: '/leave',
    labelKey: 'nav.myAbsence',
    guard: 'scopedSession',
    routes: ['/leave'],
    hasScopeNote: true,
  },
  // 20c699f8 / 953be4b0 — the two HR-admin leave inquiry screens. They are scopedAdmin-guarded pages, so
  // without a matrix column an administrator could reach them but Security & Permissions could neither
  // grant nor revoke them: the reverse-completeness guard in test/function-access.test.ts is what caught
  // it. Labels live under admin.users.screen.* rather than nav.* because neither screen is a sidebar row —
  // both are reached from My Absence.
  {
    screenKey: 'leaveEmployeeBalances',
    href: '/leave/employee-balances',
    labelKey: 'admin.users.screen.leaveEmployeeBalances',
    guard: 'scopedAdmin',
    routes: ['/leave/employee-balances'],
    hasScopeNote: false,
  },
  {
    screenKey: 'leaveEmployeeRecords',
    href: '/leave/employee-records',
    labelKey: 'admin.users.screen.leaveEmployeeRecords',
    guard: 'scopedAdmin',
    routes: ['/leave/employee-records'],
    hasScopeNote: false,
  },
  {
    screenKey: 'attendance',
    href: '/attendance',
    labelKey: 'nav.attendance',
    guard: 'scopedSession',
    // Attendance>Records tabs (314ea061): Overview (/attendance) · Daily · Individual.
    routes: ['/attendance', '/attendance/daily', '/attendance/individual'],
    hasScopeNote: true,
  },
  // Design-preview surface (ca2f2fef): a purely presentational mobile-app mock. scopedSession-guarded so
  // every role reaches the showcase; it fetches no data, so there is no scope note.
  {
    screenKey: 'mobilePreview',
    href: '/mobile-preview',
    labelKey: 'nav.mobilePreview',
    guard: 'scopedSession',
    routes: ['/mobile-preview'],
  },
  // ── Manage screens (scopedSession, but nav-shown to managers up; visibility follows reporting lines) ──
  {
    screenKey: 'approvals',
    href: '/approvals',
    labelKey: 'nav.approvals',
    guard: 'scopedSession',
    // /approvals/history (44a89810) is the same surface and audience — the full-page approval activity
    // history the bell's History tab links to — so it rides the approvals column rather than minting one.
    routes: ['/approvals', '/approvals/history'],
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
    // Global Delegation (Phase 1). scopedSession — every authenticated role reaches the screen; the DATA is
    // scoped in the read (HR/super_admin see the whole tenant, a self-service user only rows where they are
    // delegator or delegate). Deliberately NO sidebar entry (per the request), so it is nav-less but guarded.
    screenKey: 'delegations',
    href: '/delegations',
    labelKey: 'nav.delegations',
    guard: 'scopedSession',
    routes: ['/delegations'],
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
    // 6d671f44: /admin/personnel/new is the Create New Employee wizard, registered here because it is the
    // same admin surface behind the same requireAdmin guard, and creating an employee is not a separate
    // function-access right from managing them.
    // 7b5f18c3: /admin/personnel/settings (Hiring Defaults) is GONE from this list. The screen moved to
    // System Settings (own column below) and the old address is now an unguarded redirect stub — so it is
    // no longer a guarded page on disk, and leaving it here would fail the "no stale routes" check.
    routes: [
      '/admin/personnel',
      '/admin/personnel/[employmentId]',
      '/admin/personnel/import',
      '/admin/personnel/new',
    ],
  },
  {
    screenKey: 'systemLabels',
    href: '/admin/settings/system-labels',
    labelKey: 'nav.systemLabels',
    guard: 'scopedAdmin',
    routes: ['/admin/settings/system-labels'],
  },
  {
    // 476f23ed (r88b) — Movement Settings, the tenant's overlay on the built-in career-event catalogue.
    // ADDED AT INTEGRATION, not by the building agent: the page shipped with its own requireAdmin() guard,
    // so it was never reachable without admin — but it was missing from THIS registry, which is what drives
    // the users/roles matrix. test/function-access.test.ts's reverse-completeness check is exactly the guard
    // that caught it, and it is the same omission class the integration gate caught in r74 and r75. The
    // guard here MUST match the page's own (requireAdmin), or the matrix misreports who can reach it.
    screenKey: 'movementSettings',
    href: '/admin/settings/movement',
    labelKey: 'nav.movementSettings',
    guard: 'requireAdmin',
    routes: ['/admin/settings/movement'],
  },
  {
    // 7b5f18c3 — Hiring Defaults, relocated out of Personnel (Admin) into System Settings as a company
    // list plus a page per company. Its OWN column, not a route on personnelAdmin any more: it is no
    // longer part of the personnel surface, and the transparency grid should say where a screen actually
    // lives. This registration is the other half of the SYSTEM_SETTINGS_NODE row in components/sidebar.tsx
    // — a nav row whose route is unregistered is refused by our own access check, and a registered route
    // with no row cannot be found. test/hiring-defaults-system-settings.test.ts asserts both together.
    // scopedAdmin matches the page's own guard and its four System Settings siblings; access is unchanged
    // from the old requireAdmin screen (scopedAdmin calls requireAdmin internally → the same two roles).
    screenKey: 'hiringDefaults',
    href: '/admin/settings/hiring-defaults',
    labelKey: 'nav.hiringDefaults',
    guard: 'scopedAdmin',
    routes: ['/admin/settings/hiring-defaults', '/admin/settings/hiring-defaults/[companyId]'],
  },
  {
    // R22 7d309da7: Personnel profile dropdown catalog (religion/race/nationality/state/country/relationship).
    // fbdeee87: relocated INTO the System Labels surface as a tab — the catalog is unchanged (flat tenant-wide
    // table, requireAdmin), only its route moved under /admin/settings/system-labels/. The old standalone route
    // is now an unguarded redirect stub (so it is not a guarded route needing a column). Kept as its own column
    // (not merged into systemLabels) so the guard stays HONEST: profile options are requireAdmin tenant-wide,
    // whereas the org-label grid is scopedAdmin — folding them would misreport one of the two guards.
    screenKey: 'profileOptions',
    href: '/admin/settings/system-labels/profile-options',
    labelKey: 'nav.profileOptions',
    guard: 'requireAdmin',
    routes: ['/admin/settings/system-labels/profile-options'],
  },
  // ── Admin leave / attendance / claims config (requireAdmin) ──
  {
    screenKey: 'leaveConfig',
    href: '/admin/leave',
    labelKey: 'nav.leaveConfig',
    guard: 'requireAdmin',
    // R13 0d147b78: leave config split into route-based tabs (approval tab is scopedSession → own screen below).
    // 1e4eb8af retired the Application Rules tab; /admin/leave/application-rules is now an unguarded redirect
    // stub, so it is deliberately NOT listed here (a stub has nothing to guard — the fbdeee87 precedent).
    // 645e67c4 added /admin/leave/replacement, and 296fc027 made it the HOME of replacement-leave
    // CONFIGURATION (the policy editor moved onto it from /admin/toil, which keeps the balance ledger and
    // the two settlement sweeps). Still a ROUTE rather than a new screenKey — same admin surface behind
    // the same requireAdmin guard, the /admin/personnel precedent above. `toilPolicy` stays registered
    // separately below: the two screens are gated differently ON PURPOSE, because the sweeps must stay
    // reachable when the `toil` entitlement lapses and configuration must not.
    routes: [
      '/admin/leave',
      '/admin/leave/import',
      '/admin/leave/entitlements',
      // 491c499f — same admin surface, same requireAdmin guard, so it is a ROUTE rather than a new
      // screenKey (the /admin/personnel precedent above).
      '/admin/leave/adjustments',
      // 4b0e76ae — Generate Entitlement. Same admin surface, same requireAdmin guard the leaveConfig screen
      // declares above, so it is a ROUTE on this screenKey rather than a new one (the /admin/leave/replacement
      // precedent two lines up). REGISTERING IT IS NOT OPTIONAL AND IS NOT COSMETIC: this page is the ONLY
      // way left to open a leave year after the Leave Year Configuration block was removed, and
      // test/function-access.test.ts fails BOTH ways — a guarded page.tsx absent from REGISTERED_ROUTES, and
      // a registered route with no page on disk — so the route and the page land in one commit or neither.
      '/admin/leave/generate',
      '/admin/leave/payroll',
      '/admin/leave/replacement',
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
  {
    screenKey: 'holidays',
    href: '/admin/holidays',
    labelKey: 'nav.holidays',
    guard: 'requireAdmin',
    // 66b8f5a8: Holiday split into two tabs — Holiday master (/admin/holidays) + Holiday Group
    // (/admin/holidays/groups) with dedicated add/edit pages. All requireAdmin (same guard as before).
    routes: ['/admin/holidays', '/admin/holidays/groups', '/admin/holidays/groups/new', '/admin/holidays/groups/[id]'],
  },
  {
    // R33 f21d6eee: /admin/attendance is now the shared shift library ("Shift settings").
    // a324a4b3 renamed the nav KEY to match the string it already resolved to (nav.attendancePolicy →
    // nav.shiftSettings). screenKey stays 'attendancePolicy' — it may key stored role configs, the same
    // label-only split test/my-absence-nav.test.ts pins for the /leave column.
    screenKey: 'attendancePolicy',
    href: '/admin/attendance',
    labelKey: 'nav.shiftSettings',
    guard: 'requireAdmin',
    routes: ['/admin/attendance', '/attendance/import'],
  },
  {
    // R33 f21d6eee: the per-company working-hours + overtime-rates config relocated off the shift library
    // to its own screen. requireAdmin (same guard the settings had when they lived on /admin/attendance).
    // a324a4b3: nav.attendancePolicyConfig → nav.attendancePolicy, the string it already resolved to.
    // screenKey stays 'attendancePolicyConfig' (label-only, as above).
    screenKey: 'attendancePolicyConfig',
    href: '/admin/attendance-policy',
    labelKey: 'nav.attendancePolicy',
    guard: 'requireAdmin',
    routes: ['/admin/attendance-policy', '/admin/attendance-policy/rules/new', '/admin/attendance-policy/rules/[ruleId]'],
  },
  {
    screenKey: 'attendanceAllowance',
    href: '/admin/attendance-allowance',
    labelKey: 'nav.attendanceAllowance',
    guard: 'scopedAdmin',
    routes: ['/admin/attendance-allowance'],
  },
  { screenKey: 'locations', href: '/admin/locations', labelKey: 'nav.locations', guard: 'requireAdmin', routes: ['/admin/locations'] },
  // a324a4b3: nav.toilPolicy → nav.timeOffInLieu ("Time off in lieu", the page's own title). screenKey unchanged.
  { screenKey: 'toilPolicy', href: '/admin/toil', labelKey: 'nav.timeOffInLieu', guard: 'requireAdmin', routes: ['/admin/toil'] },
  {
    screenKey: 'claimsConfig',
    href: '/admin/claims',
    labelKey: 'nav.claimsConfig',
    guard: 'requireAdmin',
    // ccbd0508: Claim config split into route-based tabs — Types (/admin/claims), Limits (per Job-Grade),
    // Reimbursements. All requireAdmin (the same guard the single page used before).
    routes: ['/admin/claims', '/admin/claims/limits', '/admin/claims/reimbursements'],
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
      // R17 31646c85: Statutory Configuration split into per-body sub-menus (EPF/SOCSO/EIS/PCB/HRDF),
      // each a real sub-route under the same scopedAdmin guard as the index.
      '/payroll/configuration/epf',
      '/payroll/configuration/socso',
      // R37 674ff6a5: SKBBK (Lindung 24 Jam) surfaced in its own tab — reads the skbbk column carried on
      // the SOCSO bands; edits round-trip into the SOCSO override. Same scopedAdmin guard as its siblings.
      '/payroll/configuration/skbbk',
      '/payroll/configuration/eis',
      '/payroll/configuration/pcb',
      '/payroll/configuration/hrdf',
      // R24 5db3ae48: guided end-to-end payroll process view (scopedAdmin, same guard as the hub).
      '/payroll/guide',
      '/payroll/history-import',
      '/payroll/process',
      '/payroll/process/result',
      '/payroll/reports',
      // 956cec85: the statutory-form directory. Same guard as the rest of the Payroll hub — it exposes
      // which submissions are due and links to their figures, so it is admin-scoped like Reports.
      '/payroll/statutory-forms',
      '/payroll/setup',
      // R17 59178702: Transaction View promoted to a top-level Payroll tab (scopedAdmin, same guard
      // as the hub). The old /payroll/transactions/view path is now a guard-free redirect stub.
      '/payroll/transaction-view',
      '/payroll/transactions',
      '/payroll/transactions/fixed',
      '/payroll/transactions/individual',
      '/payroll/transactions/tp1',
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
    // Employee ID Auto Running Number Setup (feedback 3d0031e6) — the personnel-admin config for auto-numbered
    // employee codes. scopedAdmin like its siblings (a company admin manages their own company's sequence;
    // a group admin owns the global one).
    screenKey: 'employeeIdConfig',
    href: '/admin/settings/employee-id',
    labelKey: 'nav.employeeIdConfig',
    guard: 'scopedAdmin',
    routes: ['/admin/settings/employee-id'],
  },
  {
    // HR-Admin Dashboard Card Master (feedback 1586d2f5) — the tenant-scoped catalog of dashboard cards HR
    // maintains (foundation for the employee dashboard customizer 578a2fcf). scopedAdmin like its siblings.
    screenKey: 'dashboardCardConfig',
    href: '/admin/settings/dashboard',
    labelKey: 'nav.dashboardCardConfig',
    guard: 'scopedAdmin',
    routes: ['/admin/settings/dashboard'],
  },
  {
    screenKey: 'payComponents',
    href: '/admin/pay-components',
    labelKey: 'admin.users.screen.payComponents',
    guard: 'requireAdmin',
    // 911b2886 — the Create/Edit maintenance form moved to dedicated routes (attendance-rule shape).
    routes: ['/admin/pay-components', '/admin/pay-components/new', '/admin/pay-components/[code]'],
  },
  {
    // Granular payroll permission overrides (feedback 9bc442bc) — configurable per company/tenant RBAC.
    screenKey: 'payrollPermissions',
    href: '/admin/payroll-permissions',
    labelKey: 'admin.users.screen.payrollPermissions',
    guard: 'requireAdmin',
    routes: ['/admin/payroll-permissions'],
  },
  // ── Analytics / audit / governance (requireAdmin/scopedAdmin) ──
  { screenKey: 'analytics', href: '/analytics', labelKey: 'nav.analytics', guard: 'scopedAdmin', routes: ['/analytics'] },
  { screenKey: 'auditTrail', href: '/admin/audit', labelKey: 'nav.auditTrail', guard: 'requireAdmin', routes: ['/admin/audit'] },
  { screenKey: 'dataPrivacy', href: '/admin/privacy', labelKey: 'nav.dataPrivacy', guard: 'requireAdmin', routes: ['/admin/privacy'] },
  { screenKey: 'aiConfig', href: '/admin/ai', labelKey: 'nav.aiConfig', guard: 'requireAdmin', routes: ['/admin/ai'] },
  { screenKey: 'usersRoles', href: '/admin/users', labelKey: 'nav.usersRoles', guard: 'requireAdmin', routes: ['/admin/users'] },
  {
    // System Analysis & Dependency Explorer (deec1691) — the record-relationship reference, moved from
    // the operator plane to Admin at the reporter's instruction and sold as the `system_explorer`
    // module (default OFF). The ENTITLEMENT is a second, orthogonal axis this grid does not model: a
    // column says which ROLES can reach a screen, and a tenant without the module has no such screen
    // for any role. requireAdmin is still the right and honest answer for the tenants that do have it.
    screenKey: 'systemExplorer',
    href: '/admin/system-explorer',
    labelKey: 'nav.systemExplorer',
    guard: 'requireAdmin',
    routes: ['/admin/system-explorer'],
  },
  // Reports hub + custom report builder (c440b365). scopedAdmin — every report surface is admin-gated.
  { screenKey: 'reports', href: '/reports', labelKey: 'nav.reports', guard: 'scopedAdmin', routes: ['/reports', '/reports/builder/[id]'] },
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
