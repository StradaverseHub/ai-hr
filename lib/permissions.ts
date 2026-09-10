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
  {
    // a00c4f64 — the Leave Calendar's own screen, off the Dashboard. scopedSession, NOT manager-gated:
    // every employee saw this calendar on their dashboard, and the sidebar row is ungated for the same
    // reason. The data is the viewer's own person + direct reports, which is what the scope note says.
    //
    // 388e53c2 widened what this ONE screen key covers without changing its guard: an HR administrator
    // opening the row now gets the leave-inquiry surface (Employee Details) instead of the calendar, via
    // an in-page role branch. The guard stays `scopedSession` deliberately — a scopedAdmin guard here
    // would take the calendar away from every plain employee, which is the regression the ungated nav row
    // exists to prevent. The two inquiry screens below keep their own scopedAdmin columns, so revoking
    // this one still leaves an administrator without the lookups.
    screenKey: 'leaveTracker',
    href: '/leave/tracker',
    labelKey: 'nav.teamLeaveTracker',
    guard: 'scopedSession',
    routes: ['/leave/tracker'],
    hasScopeNote: true,
  },
  // 20c699f8 / 953be4b0 — the two HR-admin leave inquiry screens. They are scopedAdmin-guarded pages, so
  // without a matrix column an administrator could reach them but Security & Permissions could neither
  // grant nor revoke them: the reverse-completeness guard in test/function-access.test.ts is what caught
  // it. Labels live under admin.users.screen.* rather than nav.* because neither screen is a sidebar row —
  // both are reached from the leave-inquiry rail, whose first tab moved from My Absence to Team Leave
  // Tracker in 388e53c2. Their own hrefs are UNCHANGED by that move, so these two rows are untouched.
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
    // 0bade264 (r209) — `nav.attendance` now reads "Attendance Records", not "Attendance". The
    // Administration menu next door took the plain word back at the reporter's request, and this column
    // held the identical string, so the matrix and the rail would have shown the same name for two
    // different things. "Attendance Records" is also what this column actually covers — the three routes
    // below. The KEY is untouched (it may key stored role configs, the same label-only split a324a4b3
    // established for the rows further down this file).
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
    // defd4644 — ONE screen with three routes: the company listing, the create screen, and one
    // company's maintenance page. All three call scopedAdmin(), so all three are guarded pages on
    // disk and test/function-access.test.ts requires them here (reverse completeness). They are NOT
    // separate function-access rights: browsing, creating and maintaining a company are the same
    // administrative capability, which is why they share one column — the /admin/notice-board and
    // /admin/personnel entries below collapse their own new/detail routes for the same reason.
    routes: ['/admin/organization', '/admin/organization/new', '/admin/organization/[companyId]'],
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
    // df00b85f — the canonical href is ENTITLEMENTS now. `/admin/leave` retired its Summary listing and
    // is an unguarded redirect stub pointing here, and a stub is not a screen this grid can describe.
    href: '/admin/leave/entitlements',
    labelKey: 'nav.leaveConfig',
    guard: 'requireAdmin',
    // R13 0d147b78: leave config split into route-based tabs (approval tab is scopedSession → own screen below).
    // 1e4eb8af retired the Application Rules tab; /admin/leave/application-rules is now an unguarded redirect
    // stub, so it is deliberately NOT listed here (a stub has nothing to guard — the fbdeee87 precedent).
    // df00b85f retired the Summary listing the SAME way: `/admin/leave` is now a redirect stub to
    // /admin/leave/entitlements, so it left `routes` in the same commit that emptied the page. This is not
    // optional bookkeeping — test/function-access.test.ts fails BOTH ways, and the direction that bites
    // here is "no stale routes": a registered route whose page no longer calls a guard.
    // 645e67c4 added /admin/leave/replacement, and 296fc027 made it the HOME of replacement-leave
    // CONFIGURATION (the policy editor moved onto it from /admin/toil, which keeps the balance ledger and
    // the two settlement sweeps). Still a ROUTE rather than a new screenKey — same admin surface behind
    // the same requireAdmin guard, the /admin/personnel precedent above. `toilPolicy` stays registered
    // separately below: the two screens are gated differently ON PURPOSE, because the sweeps must stay
    // reachable when the `toil` entitlement lapses and configuration must not.
    routes: [
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/import'` STOOD HERE and is DELIBERATELY GONE.
      // Import leave data is `/admin/leave-config/import` now; the old address is an unguarded redirect
      // stub (app/admin/leave/import/page.tsx), and a stub is not a screen this grid can describe, so it
      // left `routes` in the SAME commit that emptied the page — the /admin/leave (df00b85f) and
      // /admin/leave/audit (f1b994e3) precedent. test/function-access.test.ts fails BOTH ways.
      '/admin/leave/entitlements',
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/entitlements/archive'` (6e9a126e, the read-only record
      // of the entitlement configuration release three clears) STOOD HERE and is DELIBERATELY GONE. The
      // record is `/admin/leave-config/records/entitlement` now and the old address is an unguarded
      // redirect stub, so it left `routes` in the SAME commit that emptied the page. Its `/export` route
      // handler is UNMOVED and was never listed here — the reverse-completeness scan reads page.tsx files
      // only, and a route handler has no screen column to describe.
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/entitlements/ledger-archive'` (c8052ae3, the read-only
      // BALANCE record of what the Medical/Hospitalization ledger correction archived before deleting it)
      // STOOD HERE and is DELIBERATELY GONE. The record is `/admin/leave-config/records/balances` now and
      // the old address is an unguarded redirect stub, so it left `routes` in the SAME commit that emptied
      // the page. Its `/export` sibling was never listed and has not moved.
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/entitlements/templates'` (6e9a126e release two, the
      // Entitlement Tables + Employee Eligibility editor) STOOD HERE and is DELIBERATELY GONE. The screen
      // is `/admin/leave-config/entitlement-tables` now; the old address is an unguarded redirect stub,
      // and a stub is not a screen this grid can describe, so it left `routes` in the SAME commit that
      // emptied the page — test/function-access.test.ts fails BOTH ways.
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/adjustments'` (491c499f) STOOD HERE and is
      // DELIBERATELY GONE. Adjustments is `/admin/leave-config/adjustments` now and the old address is an
      // unguarded redirect stub, so it left `routes` in the SAME commit that emptied the page.
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/generate'` (4b0e76ae) STOOD HERE and is DELIBERATELY
      // GONE. Generate Entitlement is `/admin/leave-config/generate` now — and it is still the ONLY way to
      // open a leave year, which is why the new route was registered (two lines up) in the round that
      // built it and this one leaves in the round that empties the page. The old address is an unguarded
      // redirect stub; test/function-access.test.ts fails BOTH ways, so the two halves land together.
      // `/admin/leave/generate/export` (the per-run CSV) is a route handler, was never listed, and stays.
      '/admin/leave/payroll',
      '/admin/leave/replacement',
      // a6fe37fc ROUND 2 — the NEW Leave types screen, built alongside `/admin/leave/entitlements`
      // rather than replacing it (docs/design/a6fe37fc-migration-order.md). Same admin surface, same
      // `requireAdmin` guard, so it is a ROUTE on this screenKey rather than a new one — the
      // `/admin/leave/generate` precedent above, and what the migration order specifies for the whole
      // new module: only `href` and `routes` ever move, never the screen key (a key "may key stored role
      // configs", so renaming one would silently drop every tenant's grant for the area).
      // REGISTERING IT IS NOT PAPERWORK: test/function-access.test.ts fails BOTH ways — a guarded
      // page.tsx absent from REGISTERED_ROUTES, and a registered route with no page on disk.
      // IT IS DELIBERATELY **NOT** ON THE LEAVE CONFIG MAP. The map is the customer's menu for this area
      // and the menu moves in Round 5, not now; test/leave-config-map.test.ts carries that exemption by
      // name, and test/leave-config-types-tabs.test.ts pins the absence so it cannot happen by accident.
      '/admin/leave-config/types',
      // a6fe37fc ROUND 3 — the rest of the new module, SEVEN routes, all built alongside the screens
      // they will replace and none of them replacing anything yet. They attach to THIS screen key for
      // the same reason `/admin/leave-config/types` does one line up: same admin surface, same
      // `requireAdmin` guard, so they are ROUTES rather than a new screenKey — the `/admin/leave/generate`
      // precedent. THE SCREEN KEY IS NEVER RENAMED (see the note at the head of this file: a key "may key
      // stored role configs", so renaming `leaveConfig` would silently drop every tenant's existing grant
      // for the whole area). Only `href` moves, and not until Round 5.
      //
      // THE ROUTES AND THE PAGES LAND IN ONE COMMIT OR NEITHER: test/function-access.test.ts fails BOTH
      // ways — a guarded page.tsx absent from REGISTERED_ROUTES, and a registered route with no page on
      // disk — so a page nobody can grant or revoke cannot ship.
      //
      // ALL SEVEN ARE DELIBERATELY **OFF** THE LEAVE CONFIG MAP. The map is the customer's menu for this
      // area and the menu moves at the Round 5 cutover; test/leave-config-map.test.ts carries the
      // `/admin/leave-config/` prefix exemption by name and test/leave-config-round3.test.ts pins the
      // absence so it cannot happen by accident.
      '/admin/leave-config/company-rules',
      '/admin/leave-config/entitlement-tables',
      '/admin/leave-config/generate',
      '/admin/leave-config/adjustments',
      '/admin/leave-config/import',
      // The two read-only registers. Their `/export` route handlers are deliberately NOT listed and stay
      // at their old addresses this round: the reverse-completeness scan reads page.tsx files only, and a
      // route handler has no screen column to describe — the same reasoning as
      // `/admin/leave/entitlements/ledger-archive`'s sibling above.
      '/admin/leave-config/records/entitlement',
      '/admin/leave-config/records/balances',
      // f1b994e3 — `/admin/leave/audit` STOOD HERE and is DELIBERATELY GONE. The Leave Config Audit tab
      // is retired into the one central Audit Trail (/admin/audit, screenKey `auditTrail` below, also
      // requireAdmin — so nobody who could open the leave page loses access). The route survives as an
      // unguarded redirect stub carrying ?module=leave, and a stub is not a screen this grid can
      // describe, so it leaves `routes` in the SAME change that empties the page: test/function-access
      // .test.ts fails BOTH ways, and the direction that bites here is "no stale routes" — a registered
      // route whose page no longer calls a guard. Same precedent as `/admin/leave` (df00b85f) above.
    ],
  },
  {
    screenKey: 'leaveApproval',
    href: '/admin/leave/approval',
    labelKey: 'nav.leaveApproval',
    guard: 'scopedSession',
    // R13 0d147b78: absorbed the standalone /admin/leave-approval into the leave tabs (old route now redirects).
    //
    // a6fe37fc ROUND 4 — `/admin/leave-config/approval-chains` IS THE ONE SCREEN OF THE NEW LEAVE
    // CONFIGURATION MODULE THAT DOES **NOT** HANG OFF `leaveConfig`, AND THE EXCEPTION IS THE POINT.
    // Every other `/admin/leave-config/` route above is `requireAdmin` on the `leaveConfig` key. This
    // screen keeps `scopedSession` because a COMPANY-SCOPED ADMIN MUST KEEP SEEING ONLY THEIR OWN
    // COMPANIES (IA §6.4; docs/design/a6fe37fc-migration-order.md → Round 3's permission note names it
    // as Round 4's exception). Registering it on `leaveConfig` would put a requireAdmin column in front
    // of a scopedSession page — test/function-access.test.ts derives access from the guard the page
    // actually calls, so the two must agree, and "no merging of screens that are gated differently"
    // (IA §6.4) exists precisely so a rebuild cannot misreport one of the two guards.
    //
    // THE ROUTE AND THE PAGE LAND IN ONE COMMIT OR NEITHER: test/function-access.test.ts fails BOTH ways
    // — a guarded page.tsx absent from REGISTERED_ROUTES, and a registered route with no page on disk.
    // THE SCREEN KEY IS NOT RENAMED (see this file's head: a key "may key stored role configs"), and the
    // `href` does not move until Round 5 — the menu still points at `/admin/leave/approval`, which is
    // still a full screen. The new route is deliberately OFF the leave config map for the same reason
    // Round 2's and Round 3's are (test/leave-config-map.test.ts carries the `/admin/leave-config/`
    // prefix exemption; test/leave-config-round4.test.ts pins the absence so it cannot happen by
    // accident).
    routes: ['/admin/leave/approval', '/admin/leave-config/approval-chains'],
    hasScopeNote: true,
  },
  {
    // 6e122302 — Notice Board. ONE screen with three routes: the listing, the setup form for a new notice,
    // and one notice's detail/edit page. All three call requireAdmin(), so they are all guarded routes and
    // test/function-access.test.ts fails BOTH ways if this list and the files on disk disagree — a guarded
    // page.tsx absent from REGISTERED_ROUTES, and a registered route with no page. The two employee-facing
    // routes (/notices and /notices/[id]) are deliberately absent: they carry no page guard (a plain
    // session; the audience snapshot and RLS decide what the viewer sees), so they have nothing to report
    // in a guard matrix and listing them would fail the no-stale-routes check.
    screenKey: 'noticeBoard',
    href: '/admin/notice-board',
    labelKey: 'nav.noticeBoard',
    guard: 'requireAdmin',
    routes: ['/admin/notice-board', '/admin/notice-board/new', '/admin/notice-board/[id]'],
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
    // ad52212d round 1: the row is now simply "Shift" under the Attendance settings menu (nav.shiftSettings
    // → nav.shift). The matrix FOLLOWS the nav label and KEEPS its screenKey, as above.
    screenKey: 'attendancePolicy',
    href: '/admin/attendance',
    labelKey: 'nav.shift',
    guard: 'requireAdmin',
    // '/roster/import' (23390097) and '/attendance/recompute' (1c1b321a) BOTH call requireAdmin, so both
    // are guarded pages and test/function-access.test.ts asserts reverse completeness over every one on
    // disk. They ride THIS screen rather than getting their own: same admin surface, same guard — the
    // '/attendance/import' precedent already on this line.
    // They must NOT ride the '/roster' column: that one's guard is scopedSession, and function-access
    // checks guard-derived access in BOTH directions, so registering them there swaps one failure for
    // another. And the entry cannot land before the page does — the test fails both ways — which is why
    // the two builders were told to declare these rather than edit this file.
    // af7a8eb4 (r186): the add/edit shift form moved off this page into its own routes, so the shift
    // library is now a list + two sub-pages, matching the notice-board / pay-components shape above.
    // Both call requireAdmin, the same guard as their parent, so they ride THIS screen.
    // 0bade264 (r209): '/admin/attendance/schedule-assignment' — every employee's current shift
    // arrangement in one list, with View / Edit opening the per-employee card on the personnel profile.
    // requireAdmin, same guard and same admin surface as the shift library it sits beside, so it rides
    // THIS column rather than minting one. It is a STATIC segment declared before '[shiftId]' here for
    // readability only — on disk Next resolves app/admin/attendance/schedule-assignment/page.tsx ahead
    // of the dynamic sibling either way, exactly as '/admin/attendance/new' already does.
    routes: [
      '/admin/attendance',
      '/admin/attendance/new',
      '/admin/attendance/schedule-assignment',
      '/admin/attendance/[shiftId]',
      '/attendance/import',
      '/roster/import',
      '/attendance/recompute',
    ],
  },
  {
    // R33 f21d6eee: the per-company working-hours + overtime-rates config relocated off the shift library
    // to its own screen. requireAdmin (same guard the settings had when they lived on /admin/attendance).
    // a324a4b3: nav.attendancePolicyConfig → nav.attendancePolicy, the string it already resolved to.
    // screenKey stays 'attendancePolicyConfig' (label-only, as above).
    // ad52212d round 1: the row now reads "Overtime Pattern" (nav.attendancePolicy → nav.overtimePattern) —
    // the rule library IS an overtime pattern in substance. Label-only again; screenKey untouched.
    screenKey: 'attendancePolicyConfig',
    href: '/admin/attendance-policy',
    labelKey: 'nav.overtimePattern',
    guard: 'requireAdmin',
    // af7a8eb4 (r186): the working-hours schedule block moved off the policy page onto its own route.
    // requireAdmin, same guard as its parent, so it rides this screen rather than getting a column.
    // ad52212d round 1 gave '/admin/attendance-policy/schedule' its own nav row ("Work Schedule"). It keeps
    // riding THIS column: same guard, same admin surface, and the reverse-completeness case only asks that
    // every guarded route on disk be covered — a second nav row does not make it a second screen.
    routes: [
      '/admin/attendance-policy',
      '/admin/attendance-policy/schedule',
      '/admin/attendance-policy/rules/new',
      '/admin/attendance-policy/rules/[ruleId]',
    ],
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
    routes: ['/admin/claims', '/admin/claims/limits', '/admin/claims/reimbursements', '/admin/claims/mileage', '/admin/claims/forms'],
  },
  {
    screenKey: 'loans',
    href: '/admin/loans',
    labelKey: 'admin.users.screen.loans',
    guard: 'requireAdmin',
    // 6d72816e: the Add page and the loan's own View/Edit page, split out of the list so the new-loan
    // form stops sitting permanently open and the five lifecycle actions stop living inside a table
    // cell. Same requireAdmin guard as the list — same data, one loan at a time. The gate was NOT
    // swapped to scopedAdmin during the redesign; that would be a privilege change dressed as a UI one.
    routes: ['/admin/loans', '/admin/loans/new', '/admin/loans/[id]'],
  },
  // ── Payroll (scopedAdmin/requireAdmin → hr_admin + super_admin; partners are redirected today) ──
  {
    screenKey: 'payroll',
    href: '/payroll',
    labelKey: 'nav.payroll',
    guard: 'scopedAdmin',
    routes: [
      '/payroll',
      '/payroll/[batchId]',
      // e440991b — the dedicated Reprocess Selected Employees screen. Same requireAdmin guard as the run
      // page it is reached from. Registered here because test/function-access.test.ts checks reverse
      // completeness: a guarded page with no matrix column fails the suite rather than silently
      // becoming a screen nobody can grant or revoke.
      '/payroll/[batchId]/reprocess',
      // 9066bd6c — Remove Employee Payroll, the per-employee counterpart to the whole-run Reset. Same
      // requireAdmin guard as the run page it is reached from, and registered here for the same reason
      // its Reprocess sibling above is: test/function-access.test.ts checks reverse completeness, so a
      // guarded page with no matrix column fails the suite rather than silently becoming a screen
      // nobody can grant or revoke. (The per-action authority is the payroll.remove.employee granular
      // key — this registry is coarse "can the role open the screen at all" by design.)
      '/payroll/[batchId]/remove',
      // 9f8cd608 — Reset Payroll, moved out of a confirmation dialog inside the row menu and onto a screen
      // of its own (the dialog was owned by the menu subtree and unmounted with it, so the button appeared
      // to do nothing). Same requireAdmin guard as the run page it is reached from, and registered here for
      // the same reason its two siblings above are: test/function-access.test.ts checks reverse
      // completeness, so a guarded page with no matrix column fails the suite rather than silently becoming
      // a screen nobody can grant or revoke. (The per-action authority is still the payroll.rollback
      // granular key asserted inside resetProcessedBatch — this registry is coarse "can the role open the
      // screen at all" by design.)
      '/payroll/[batchId]/reset',
      // ADR-0076 — the payroll exceptions queue. Same requireAdmin guard as the run page it hangs off,
      // and registered here for the same reason the reprocess screen above is: a guarded page with no
      // matrix column fails the suite rather than silently becoming a screen nobody can grant or revoke.
      // (It did fail here first, on the gate immediately after the page was written, which is the guard
      // working exactly as intended.)
      '/payroll/[batchId]/anomalies',
      // ADR-0083 r233 — the Control Tower MOVED to its own top-level section, /control-tower, and gained
      // an explainer beside it. Both carry requireAdmin, so both need a column here or
      // test/function-access.test.ts fails rather than letting a guarded screen become one nobody can
      // grant or revoke. `/payroll/control-tower` is now a redirect with no guard of its own and is
      // deliberately NOT listed — the matrix tracks guarded screens, not forwards.
      '/control-tower',
      '/control-tower/how-it-works',
      '/control-tower/readiness',
      '/control-tower/actions',
      // ADR-0084 r243 — the switchboard for the three unattended agents. Same requireAdmin guard as its
      // siblings, so it needs a column here or test/function-access.test.ts fails rather than letting a
      // guarded screen become one nobody can grant or revoke. (The WRITE it performs is gated harder
      // still, on isGroupAdmin, mirroring 0313's tenant_setting_write — this registry is the coarse
      // "may the role open the screen at all", by design.)
      '/control-tower/agents',
      // ADR-0074 r245 — the cross-run exceptions queue. Same requireAdmin guard as its siblings and the
      // per-run queue it complements, so it needs a column here or test/function-access.test.ts fails.
      '/control-tower/exceptions',
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
      // efe1d230: the payroll guide route (R24 5db3ae48's guided end-to-end view) is RETIRED — the route is
      // deleted and its eight-check readiness report moved to /payroll/setup?readiness=full, which is
      // already covered by the '/payroll/setup' entry below under this same scopedAdmin key. The entry
      // must go with the page: test/function-access.test.ts fails a registered route with no file.
      // 2ef69d1e: Back Pay (Arrears). ONE route — the detection list, the verification grid and the run
      // history are three states of the same page (`?run=`), the same single-pager convention
      // /payroll/transaction-view uses for `?tab=`. Its `export` sibling is a route handler, not a
      // guarded page, so it is not listed here (the reverse-completeness check walks page.tsx files).
      // Same scopedAdmin key as the rest of the hub: the screen shows per-employee salary differences.
      '/payroll/back-pay',
      '/payroll/history-import',
      // 169e3c24: the pre-release Individual Payslip viewer. Registered on the SAME scopedAdmin key as
      // the rest of the hub, because it is the admin's review of a payslip before it is released — it
      // reads through `payslipForReview`, never the ESS gate, so it must be admin-scoped exactly like
      // Transaction View beside it. Its `[payslipId]/pdf` route is a route handler, not a guarded page,
      // and so is not listed here (the reverse-completeness check walks page.tsx files).
      '/payroll/individual-payslip',
      // 45df860a: the shared PCB / MTD calculation detail. Registered on the SAME scopedAdmin key as the
      // two screens that link to it (Transaction View and Individual Payslip above) — it shows one
      // employee's tax working, read through the same `payslipForReview` fence, so it is admin-scoped
      // exactly like them and grants/revokes with them. Registered here because
      // test/function-access.test.ts checks reverse completeness: a guarded page with no matrix column
      // fails the suite rather than silently becoming a screen nobody can grant or revoke.
      '/payroll/pcb-detail',
      // 6b4ca488: the Statutory Explanation — the wage base, rule, working and employee/employer amounts
      // behind EPF, SOCSO, EIS, SKBBK, HRDF and PCB for one payslip. Registered on the SAME scopedAdmin
      // key as its two doors (Individual Payslip links to it; Transaction View mounts the same display
      // under ?tab=statutory) — it shows one employee's statutory working, read through the same
      // `payslipForReview` fence, so it is admin-scoped exactly like them and grants/revokes with them.
      // Registered here because test/function-access.test.ts checks reverse completeness: a guarded page
      // with no matrix column fails the suite rather than silently becoming a screen nobody can grant or
      // revoke. Its `export` sibling is a route handler, not a guarded page, so it is not listed (the
      // check walks page.tsx files). The TAB needs no entry of its own — it is a sub-tab of
      // /payroll/transaction-view below and inherits that route's guard, the same way `grid` and
      // `outstanding` do.
      '/payroll/statutory-detail',
      '/payroll/process',
      '/payroll/process/result',
      '/payroll/reports',
      // bdf7d248 (r209): the ADR-0024 §7 Multi-Cycle Statutory Worksheet. Registered on the SAME
      // scopedAdmin key as the Reports screen that links to it — it lists per-employee EPF/SOCSO/EIS/PCB
      // figures for months that had more than one payroll run, so it is admin-scoped exactly like Reports
      // and Transaction View, and grants/revokes with them. READ-ONLY: it has no server action and writes
      // nothing, but that is not why it is registered — test/function-access.test.ts checks reverse
      // completeness, so a guarded page with no matrix column fails the suite rather than silently
      // becoming a screen nobody can grant or revoke.
      '/payroll/multi-cycle-worksheet',
      // 956cec85: the statutory-form directory. Same guard as the rest of the Payroll hub — it exposes
      // which submissions are due and links to their figures, so it is admin-scoped like Reports.
      '/payroll/statutory-forms',
      // 6babf4f6: ONE generation screen serving every form on the shelf, addressed by report id. Same
      // scopedAdmin key as the directory it is reached from — it shows per-employee statutory numbers
      // (name, IC, EPF/SOCSO/tax number and the contribution split), so it is admin-scoped like Reports.
      // Registered here because test/function-access.test.ts checks reverse completeness: a guarded
      // page with no matrix column fails the suite rather than silently becoming a screen nobody can
      // grant or revoke. Its `export` sibling is a route handler, not a guarded page, so it is not
      // listed (the reverse-completeness check walks page.tsx files).
      '/payroll/statutory-forms/[formId]',
      // r256 858a1128: the per-form CRITERIA step, between the directory and the figures. Same scopedAdmin
      // key as the directory that links to it and as the [formId] screen it submits to — access is
      // UNCHANGED by that item, so it deliberately does NOT get a screen key of its own: a separate column
      // would let an administrator grant Statutory Forms while revoking the only way into a form on it.
      // It reads the pack catalog and the admin's own company list and generates nothing. Registered here
      // because test/function-access.test.ts checks reverse completeness: a guarded page with no matrix
      // column fails the suite rather than silently becoming a screen nobody can grant or revoke.
      '/payroll/statutory-forms/open',
      // r256 858a1128: the C.P.8A (EA) employee selection — step two of the EA's own two-step flow (company
      // + year on the criteria step above, then the people here). Same scopedAdmin key for the same reason
      // as its two siblings, and it needs one on its own account too: it lists the year's paid population
      // by name, employee ID, department and status. Its `download` sibling is a route handler, not a
      // guarded page, so it is not listed — the reverse-completeness check walks page.tsx files.
      '/payroll/statutory-forms/ea',
      // 88076362: the CP22 review step, between the joiner list on the statutory-form directory and the
      // download. Same scopedAdmin key as the directory that links to it (statutory-forms/page.tsx builds
      // the href twice, for the due list and the watchlist) — it shows one joiner's full particulars, name,
      // IC, address and commencement terms, so it is admin-scoped exactly like the [formId] screen above.
      // Registered here because test/function-access.test.ts checks reverse completeness: a guarded page
      // with no matrix column fails the suite rather than silently becoming a screen nobody can grant or
      // revoke. Its FOUR siblings under /payroll/cp22 (the [employmentId] pdf and text downloads, batch and
      // blank) are route handlers, not guarded pages, so they are not listed — the check walks page.tsx.
      '/payroll/cp22/[employmentId]/preview',
      // 8ca344bf: the Borang 8A review step, between the PERKESO shelf's figures screen and the two
      // downloads. Same scopedAdmin key as the directory that links to it and as the [formId] screen above
      // — it lists every employee's name, IC and SOCSO contribution for the month, so it is admin-scoped
      // exactly like them. Registered here because test/function-access.test.ts checks reverse
      // completeness: a guarded page with no matrix column fails the suite rather than silently becoming a
      // screen nobody can grant or revoke. Its THREE siblings under /payroll/borang-8a (the pdf and text
      // downloads, and shared.ts) are route handlers and a plain module, not guarded pages, so they are not
      // listed — the check walks page.tsx.
      '/payroll/borang-8a/preview',
      // 9c8dad7a: the Borang A review step, between the EPF shelf's figures screen and the THREE downloads
      // (the drawn form, its readable text twin and the i-Akaun upload file). Same scopedAdmin key as the
      // directory that links to it and as the [formId] screen above — it lists every employee's name,
      // identity card number, EPF member number, EPF-liable wage and contributions, so it is admin-scoped
      // exactly like them. Registered here because test/function-access.test.ts checks reverse
      // completeness: a guarded page with no matrix column fails the suite rather than silently becoming a
      // screen nobody can grant or revoke. Its FOUR siblings under /payroll/borang-a (the pdf, text and
      // file downloads, and shared.ts) are route handlers and a plain module, not guarded pages, so they
      // are not listed — the check walks page.tsx.
      '/payroll/borang-a/preview',
      // e0cd4583: the CP39 review step, between the LHDN shelf's figures screen and the two downloads
      // (the drawn monthly PCB statement and its readable text twin). Same scopedAdmin key as the
      // directory that links to it and as the [formId] screen above — it lists every employee's name,
      // identity card number, income tax reference number, employee number, passport number and monthly
      // PCB/CP38 deduction, so it is admin-scoped exactly like them. Registered here because
      // test/function-access.test.ts checks reverse completeness: a guarded page with no matrix column
      // fails the suite rather than silently becoming a screen nobody can grant or revoke. Its THREE
      // siblings under /payroll/cp39 (the pdf and text downloads, and shared.ts) are route handlers and a
      // plain module, not guarded pages, so they are not listed — the check walks page.tsx.
      '/payroll/cp39/preview',
      // 2961a7ae: Statutory Adjustment — the manual override of a computed statutory figure on a run that
      // is processed and not yet closed. Same scopedAdmin key as the rest of the Payroll hub: it shows
      // and CHANGES per-employee EPF/SOCSO/EIS/PCB figures, so it is admin-scoped exactly like Reports
      // and Transaction View. Registered here because test/function-access.test.ts checks reverse
      // completeness: a guarded page with no matrix column fails the suite rather than silently becoming
      // a screen nobody can grant or revoke. ONE route — pick a run, pick an employee, edit, review and
      // apply are states of the same page (`?batch=` / `?employment=`), the single-pager convention
      // /payroll/transaction-view uses for `?tab=`.
      '/payroll/statutory-adjustment',
      '/payroll/setup',
      // R17 59178702: Transaction View promoted to a top-level Payroll tab (scopedAdmin, same guard
      // as the hub). The old /payroll/transactions/view path is now a guard-free redirect stub.
      '/payroll/transaction-view',
      '/payroll/transactions',
      // 7076f8af: the two functions that came OFF the run screen. `adjustments` renders the draft run's
      // consolidation bridges + input grid (its primary home is the run flow's Review step, which is not a
      // route of its own); `import-components` is the pay-component CSV import. Both are requireAdmin, the
      // same guard as the hub they hang off, and neither is a nav row — they are reached from the hub's
      // cards, so the exact-set guard on PAYROLL_ADMIN_NAV is untouched.
      '/payroll/transactions/adjustments',
      '/payroll/transactions/import-components',
      '/payroll/transactions/fixed',
      // f3ae3245: the dedicated View/Edit page for ONE recurring fixed item, replacing the form that
      // unfolded inside a table cell. Same scopedAdmin guard as its list — it is the same data, one row
      // at a time. (This list is EXACT by design: the reverse-completeness test in
      // test/function-access.test.ts fails the build for a guarded page.tsx with no column, which is how
      // a new screen is stopped from being invisible on the access grid.)
      '/payroll/transactions/fixed/[id]',
      '/payroll/transactions/individual',
      '/payroll/transactions/tp1',
      // 3e3d3fb2: the dedicated Add / View / Edit page for ONE employee's TP1 declaration for ONE
      // assessment year, replacing the form that opened by itself the moment somebody was selected.
      // Same scopedAdmin guard as its list — it is the same data, one year at a time.
      '/payroll/transactions/tp1/[year]',
      // 7ad37961: the LHDN TP1 (1/2026) form has a DEDUCTION MONTH box, so the declaration's grain moved
      // from the year to the month and the Add / View / Edit page moved with it. `[year]` above stayed as
      // a redirect so shipped links keep working, and BOTH are listed because this set is EXACT — the
      // reverse-completeness case in test/function-access.test.ts fails the build for a guarded page.tsx
      // with no column, which is how a new screen is stopped from being invisible on the access grid.
      // Same scopedAdmin guard as the list: it is the same data, one month at a time. (The PDF route
      // beside it is a route.ts, not a page, and route handlers are deliberately not on this matrix.)
      '/payroll/transactions/tp1/[year]/[month]',
      '/payroll/transactions/zakat',
      // 6a1f2bd6: the dedicated Add/Edit page for ONE employee's zakat setup, replacing the editor that
      // opened by itself the moment somebody was selected. Same scopedAdmin guard as its list.
      '/payroll/transactions/zakat/election',
    ],
  },
  {
    screenKey: 'payrollCycleConfig',
    href: '/admin/payroll-cycle',
    labelKey: 'nav.payrollCycleConfig',
    guard: 'scopedAdmin',
    // 6df24751 — the screen became company-first (listing → one company's catalog → one cycle), the
    // pay-components shape. SAME screen key on purpose: these are the same data behind the same
    // scopedAdmin guard, one company (then one cycle) at a time, so the access answer must not change.
    routes: [
      '/admin/payroll-cycle',
      '/admin/payroll-cycle/[companyId]',
      '/admin/payroll-cycle/[companyId]/new',
      '/admin/payroll-cycle/[companyId]/[cycleId]',
    ],
  },
  {
    screenKey: 'payrollConfig',
    href: '/admin/payroll-config',
    labelKey: 'admin.users.screen.payrollConfig',
    guard: 'scopedSession',
    // 6df24751 — as above: the company listing, one company's pay schedule, and its edit form. No new
    // screen key, so no new access surface.
    routes: ['/admin/payroll-config', '/admin/payroll-config/[companyId]', '/admin/payroll-config/[companyId]/edit'],
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
