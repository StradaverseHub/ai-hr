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
 *       reporting-line scoped by RLS. NOT "only their own rows" — app.can_see_employment grants a row
 *       when the caller owns it, administers the company, is an administrative manager of it
 *       (is_admin_report_of, direct OR indirect), or heads its department (heads_department_of). The
 *       last two are ORG-STRUCTURE facts and are INDEPENDENT OF THE ROLE LIST: an employment carrying
 *       only the `employee` role still sees its whole tree if it is a line manager or an HOD. r287
 *       verified this on the seed — EMP-0004 holds `employee` alone and can see three other
 *       employments, two via heads_department_of and one via is_admin_report_of. That is CORRECT, and
 *       the sentence this replaces read as a leak to someone checking the screen against it.
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
export type Guard = 'requireAdmin' | 'scopedAdmin' | 'scopedSession' | 'requireTeamAccess';

/** Roles that can REACH a screen given its guard (coarse page-level access). */
export function rolesForGuard(guard: Guard): ReadonlySet<Role> {
  if (guard === 'requireTeamAccess') return new Set<Role>(['manager', 'hr_admin', 'super_admin']);
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
  { screenKey: 'identityEmail', href: '/admin/settings/email', labelKey: 'nav.identityEmail', guard: 'scopedSession', routes: ['/admin/settings/email'], hasScopeNote: true },
  { screenKey: 'rewards', href: '/rewards', labelKey: 'nav.rewards', guard: 'scopedSession', routes: ['/rewards', '/rewards/[unitId]', '/rewards/[unitId]/people/[entryId]'] },
  { screenKey: 'rewardsAdmin', href: '/admin/rewards', labelKey: 'rewards.adminTitle', guard: 'scopedAdmin', routes: ['/admin/rewards'] },
  { screenKey: 'rewardsPolicy', href: '/admin/rewards/[unitId]', labelKey: 'rewards.configuration', guard: 'scopedSession', routes: ['/admin/rewards/[unitId]'] },
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
    // ⚠️ r355 (8d3a7bff) — '/leave/shared/[groupId]' IS GONE FROM THIS LIST BECAUSE THE PAGE IS GONE, and
    // the removal is not optional. test/function-access.test.ts is bidirectional: "reverse completeness"
    // fails a guarded page.tsx with no column, and "no stale routes" fails a registered route with no file.
    // Deleting the page without deleting this entry trips the second. r318 (76dbcaa1) added it when the
    // employee's pooled Special Leave figure had a screen of its own, opened from the card on /leave; r355
    // removed that screen at the reporter's request — it read as a configuration page, and after r341 folded
    // the group's tile onto the leave-type card the only figure it still held alone (`usedThisYear`) moved
    // onto that card. Nothing in the employee flow reaches a route under /leave/shared any more.
    //
    // THE PRECEDENT ITSELF SURVIVES ITS FIRST USER, and '/leave/credit' below still rests on it: a
    // sub-route with the same audience, the same scope and the same guard rides the parent's column rather
    // than minting a second one, because a second column would carry the SAME label — two rows reading
    // "My Absence" in the access grid describe one function as if it were two (570fd56e).
    // r343 (cbfa8b0b) — '/leave/credit' rides THIS column on exactly that argument. r389 (bc3e203d): the
    // address is now My Leave › Leave Credit History — the employee's own Leave Credit requests and what
    // became of each credit — reached from the My Leave menu rather than a link on this screen; the form
    // copy it used to carry is gone (ba039150). Same audience, same scope, same guard, so still this column.
    // r404 (42e55e2b) — '/leave/details' (My Leave › Leave Details) rides this column on the same argument:
    // the employee's own leave balances, same audience, same guard (`scopedSession`), self-scoped in the page
    // by `myEmployment(session)`. A second column would repeat the "My Absence" label.
    routes: ['/leave', '/leave/history', '/leave/credit', '/leave/details'],
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

  {
    screenKey: 'myTeam', href: '/manage/my-team', labelKey: 'nav.myTeam',
    guard: 'requireTeamAccess', routes: ['/manage/my-team'], hasScopeNote: true,
  },
  // 20c699f8 / 953be4b0 — the two HR-admin leave inquiry screens. They are scopedAdmin-guarded pages, so
  // without a matrix column an administrator could reach them but Security & Permissions could neither
  // grant nor revoke them: the reverse-completeness guard in test/function-access.test.ts is what caught
  // it. Labels live under admin.users.screen.* rather than nav.* because neither screen is a sidebar row —
  // both are reached from the leave-inquiry rail, whose first tab moved from My Absence to Team Leave
  // Tracker in 388e53c2. Their own hrefs are UNCHANGED by that move, so these two rows are untouched.
  //
  // ⚠️ 5ca446db (r269) — THAT SENTENCE IS NOW HALF TRUE, and it is updated rather than deleted because the
  // REASON still holds for the labels. Employee Balances IS a sidebar row now: the Leave Config fly-out's
  // sixth child ("Employee Leave Inquiry", packs/leave/index.ts LEAVE_ADMIN_NAV) opens
  // `/leave/employee-balances`, and that row also owns `/leave/employee-records` for highlighting. Employee
  // Leave Record is still reached only from the rail.
  //
  // THE TWO `labelKey`s BELOW DO NOT MOVE TO `nav.*`. The menu ROW is called "Employee Leave Inquiry" (the
  // area) while these matrix COLUMNS are called "Employee Balances" and "Employee Leave Record" (the
  // screens) — the reporter's own point 7, and the same two-surfaces-two-names rule as
  // nav.leaveApprovalWorkflow vs nav.leaveApproval (645e67c4, re-affirmed by r266's gate). Pointing this
  // column at the row's key would silently rename an administrator's permission column.
  //
  // KNOWN, DISCLOSED EXPOSURE — and the verify pass CORRECTED how it was first written here. There is no
  // per-screen grant to revoke: `canReach` is derived from the guard (see rolesForGuard below) and the
  // Function Access grid is presentational, so "an admin whose leaveEmployeeBalances is revoked" cannot
  // happen. The REAL exposure, which predates this row: app/layout.tsx passes
  // `isAdmin={isAdmin(session) || canManagePayroll(session) || canManagePerfComp(session)}`, wider than
  // requireAdmin's `isAdmin(s)`, so a payroll or perf-comp partner who is NOT an admin sees the whole
  // adminOnly group — every Leave Config row, this one included — and is redirected at each page. Sixth
  // instance of a five-instance class; the page guard below is the real one and is unchanged.
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
    //
    // f3e6c36e (r287) — `/attendance/my-records` is NOT on this line, deliberately. It is a different
    // SCREEN with a different audience (the column below), not a fourth tab of this one: the split is the
    // whole item, and collapsing the two back into one column here would tell a reader of the access grid
    // that the employee's own record and the administrator's reading of everybody are the same surface.
    // 570fd56e — the per-day detail screen the eight calculation columns moved onto. Same audience and
    // same scope as the list it opens from (it resolves the employee through the caller's own scope), so it
    // belongs to THIS column rather than becoming a screen of its own.
    routes: ['/attendance', '/attendance/daily', '/attendance/individual', '/attendance/individual/[date]'],
    hasScopeNote: true,
  },
  /**
   * 22d67223 (r311) — ATTENDANCE BREAKDOWN: the audit view, one employee's every recorded figure across a
   * range. It reads the same data as the column above and is deliberately NOT a route on it.
   *
   * The column above is `scopedSession` — every role reaches it and the reading is narrowed to them. This
   * screen is `scopedAdmin`, because its employee picker is `listEmployees`, which is tenant-scoped and
   * filtered only by company: under scopedSession an employee could read any colleague's full calculation
   * audit. Listing it on the column above would have been worse than a wrong guard — it would tell every
   * reader of the access grid that ordinary staff reach this screen, when they are refused at the door.
   *
   * The precedent is '/attendance/my-records' below: a different audience is a different SCREEN, not
   * another route on an existing one.
   */
  {
    screenKey: 'attendanceBreakdown',
    href: '/attendance/breakdown',
    labelKey: 'nav.attendanceBreakdown',
    guard: 'scopedAdmin',
    routes: ['/attendance/breakdown'],
  },
  /**
   * f3e6c36e (r287) — the employee's own attendance, and the employee half of the split that took the
   * administrative Record function out of My Attendance.
   *
   * `scopedSession`, so every authenticated role reaches it — which is the honest coarse answer, because
   * the screen refuses nobody.
   *
   * ⚠️ 2aef3cd8 (r362) — THE OLD CLAIM WAS: "what it shows is narrower than the guard implies and narrower
   * than every other scopedSession row in this file: the page resolves the CALLER'S OWN employment and
   * keys its single attendance read on that employment id, so an administrator opening this screen sees
   * their own record and nobody else's. That is what the scope note says." The reporter has since had the
   * screen EMPTIED and the row renamed "Attendance Overview": the page reads nothing at all and is blank
   * below its title. So the sentence above was true and is now moot, and the SCOPE NOTE has been reworded
   * in all six locales to match — it used to read "Everyone can open this; whoever you are, it shows only
   * your own attendance", which stopped being true the moment the table went.
   *
   * `hasScopeNote` stays TRUE rather than flipping to false. A column on the access grid with nothing
   * beside it reads as "we did not say", where the honest answer is "everyone, and it shows nothing yet";
   * and test/function-access.test.ts asserts the note resolves whenever the flag is set, so keeping the
   * flag keeps the note under guard for whatever content arrives here later.
   *
   * The route, the column and the `scopedSession` guard all STAY. The page still calls `scopedSession()`
   * in its body — that is both the authentication boundary and what keeps "no stale routes" in
   * test/function-access.test.ts satisfied for this registered route.
   *
   * A NEW screenKey rather than a route added to the `attendance` column above: they are two screens for
   * two audiences, which is the point of the r287 round. The key is new, so it revokes nothing — no stored
   * role config can reference a column that did not exist.
   */
  {
    screenKey: 'myAttendanceRecords',
    href: '/attendance/my-records',
    labelKey: 'nav.myRecords',
    guard: 'scopedSession',
    routes: ['/attendance/my-records', '/attendance/my-records/[date]'],
    hasScopeNote: true,
  },
  /**
   * 6948727a (r369) — MY ROSTER: the employee's own roster, read only. The employee half of the pair
   * whose administrative half is the `roster` column further down.
   *
   * A SCREEN OF ITS OWN, not a route added to `roster`, and the precedent is the column directly above:
   * a different audience is a different screen. `/roster` is the operator's grid of everybody, gated by
   * `scopedAdmin`; putting this route on that column would tell every reader of the access grid that
   * ordinary staff reach the administrative roster, when they are refused at its door — the exact
   * under-reporting failure test/function-access.test.ts exists to prevent, and worse than a wrong guard
   * because it reads as a deliberate statement.
   *
   * `scopedSession`, so every authenticated role reaches it — the honest coarse answer, because the
   * screen refuses nobody. What it SHOWS is narrower than the guard implies, and narrower than RLS would
   * allow: `roster_assignment`'s policy is `app.can_see_employment`, which admits the recursive
   * administrative manager chain and the HOD department tree, so the database would hand a supervisor a
   * subordinate's roster. The page never asks — `myRosterWindow` (core/roster.ts) takes no employment id
   * and resolves the caller's own from the session — so an administrator opening this screen sees their
   * own roster and nobody else's. That is what the scope note says.
   *
   * A NEW screenKey, so it revokes nothing: no stored role config can reference a column that did not
   * exist.
   */
  {
    screenKey: 'myRoster',
    href: '/attendance/my-roster',
    labelKey: 'nav.myRoster',
    guard: 'scopedSession',
    routes: ['/attendance/my-roster'],
    hasScopeNote: true,
  },
  // Mobile App: group administrators build a tenant design; other viewers see the published live app.
  // scopedSession and existing data services retain each viewer's authorization.
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
    // a57f0584 (r328): '/roster/exceptions' — the "rostered shifts that did not go to plan" listing,
    // lifted off the foot of /roster onto its own screen. It RIDES this column: scopedSession, the same
    // guard and the same audience as the roster (a supervisor who may read the month may read what went
    // wrong on it), and `rosterVariance` is RLS-fenced either way. A second screen key would claim it is
    // a different surface, which it is not — the same precedent as '/approvals/history' above.
    // Its sibling '/roster/edit/[employmentId]' is deliberately NOT here: that one is admin-only and is
    // registered on the requireAdmin column beside '/roster/import'. Registering an admin page on a
    // scopedSession column makes test/function-access.test.ts report access this session does not have.
    routes: ['/roster', '/roster/exceptions'],
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
    //
    // 15e5bd93 rev 2 (r353) — FOUR routes. The reporter contested r352's in-tab redesign and asked
    // for the statutory bodies on "a dedicated full-width screen", so
    // /admin/organization/[companyId]/statutory exists and calls the same scopedAdmin() the company's
    // maintenance page does. It joins this column rather than getting one of its own for the reason above:
    // maintaining a company's statutory payment setup is not a different administrative capability from
    // maintaining the company, and splitting it would mean a tenant could grant one without the other and
    // reach a Back link to a screen it may not see.
    //
    // 15e5bd93 rev 3 (r355) — FIVE, briefly. That round added
    // /admin/organization/[companyId]/statutory/[authority], a screen holding ONE body, reached by a View
    // or Edit link on a table of rows.
    //
    // 15e5bd93 rev 4 (r372) — BACK TO FOUR, and the removal is the change this round shipped. The reporter
    // contested the drill-in as "an unnecessary intermediate page"; every statutory body is now a card on
    // /admin/organization/[companyId]/statutory itself, with one Save. The per-body route and its page.tsx
    // are DELETED, so its entry is REMOVED from this exact set rather than left behind: REGISTERED_ROUTES
    // is compared against the guarded page.tsx files actually on disk, in both directions, so a stale
    // entry fails test/function-access.test.ts exactly as a missing one does — and that is a
    // FULL-GATE-only failure, easy to ship and hard to notice.
    //
    // 7a595a02 (r403) — FIVE again: /admin/organization/[companyId]/view, the company as text with an
    // Edit button into the maintenance page. Same scopedAdmin() and the same adminOnly 404 as that page,
    // and the same column for the reason above — viewing a company is not a capability separate from
    // maintaining it, and no permission changes.
    routes: [
      '/admin/organization',
      '/admin/organization/new',
      '/admin/organization/[companyId]',
      '/admin/organization/[companyId]/statutory',
      '/admin/organization/[companyId]/view',
    ],
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
    // 05d2709a — Possible duplicate employee records. Its OWN column, deliberately NOT a fifth route on
    // personnelAdmin above: managing an employee and reviewing a cross-company list of people who may be
    // the same person are not the same capability to describe, and the whole value of this grid is that it
    // says where a screen actually lives. The guard MATCHES the page's own `requireAdmin()` — a column
    // claiming a different guard from the page misreports who can reach it, which is the one thing a
    // transparency screen must not do.
    //
    // The scope note is worth authoring rather than omitting: this screen is company-scoped by RLS like
    // every other, and the CONSEQUENCE here is unusual — half of a pair spanning two companies can be
    // invisible to a company-scoped administrator, so the list they see is shorter than the tenant's.
    // It also states in the reader's own words that nothing on the screen can change a record.
    screenKey: 'duplicatePersonRecords',
    href: '/admin/personnel/duplicates',
    labelKey: 'admin.users.screen.duplicatePersonRecords',
    guard: 'requireAdmin',
    routes: ['/admin/personnel/duplicates'],
    hasScopeNote: true,
  },
  {
    // 99b2d6c0 (r336) — Child relief review (PCB). Its OWN column, for the same reason the duplicates
    // grid above has one: reading a tax position across the whole payroll population is not the same
    // capability as managing one employee, and the value of this grid is that it says where a screen
    // actually lives. The guard MATCHES the page's own `requireAdmin()` — a column claiming a different
    // guard from the page misreports who can reach it.
    //
    // The scope note is worth authoring rather than omitting. This screen prints RINGGIT TOTALS, and RLS
    // makes them the totals of the companies the reader administers — a company-scoped administrator and
    // a group administrator will read different numbers off the same page, correctly. It also says in the
    // reader's own words that nothing on the screen can change a tax setting, because a report about a
    // money migration must never be mistaken for the migration.
    screenKey: 'childReliefReview',
    href: '/admin/personnel/child-relief',
    labelKey: 'admin.users.screen.childReliefReview',
    guard: 'requireAdmin',
    routes: ['/admin/personnel/child-relief'],
    hasScopeNote: true,
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
    // r261 (board item 9583deac, stage three) — Employee Change Requests. TENANT-WIDE configuration, so
    // `requireAdmin` and not `scopedAdmin`: the two values it holds are `tenant_setting` rows, and 0313's
    // write policy admits a GROUP admin only. A company-scoped admin therefore REACHES the screen (which
    // is what this column reports) and is told on it that the write is not theirs — the same split the
    // agent switchboard makes, and the reason the guard here is the page's own and not the writer's.
    screenKey: 'profileRequestSettings',
    href: '/admin/settings/profile-requests',
    labelKey: 'nav.profileRequestSettings',
    guard: 'requireAdmin',
    routes: ['/admin/settings/profile-requests'],
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
    // df00b85f — the canonical href moved off `/admin/leave` when that retired its Summary listing.
    // a6fe37fc ROUND 5 (cutover) — it moves once more, to the leave type screen's new address. BOTH
    // `/admin/leave` and `/admin/leave/entitlements` are unguarded redirect stubs pointing here now, and
    // a stub is not a screen this grid can describe. THE SCREEN KEY IS NOT RENAMED: a key "may key stored
    // role configs" (see this file's head), so renaming `leaveConfig` would silently drop every tenant's
    // existing grant for the whole area. Only `href` and `routes` ever move.
    href: '/admin/leave-config/types',
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
    // the same requireAdmin guard, the /admin/personnel precedent above. `toilPolicy` stayed registered
    // separately below until 3fb1a611 (r299) folded /admin/toil into Leave Config › Leave Credit — which keeps
    // the sweeps reachable when the `toil` entitlement lapses (a wind-down view), so the gating difference
    // this note defended is preserved on the one screen rather than by two.
    routes: [
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/import'` STOOD HERE and is DELIBERATELY GONE.
      // Import leave data is `/admin/leave-config/import` now; the old address is an unguarded redirect
      // stub (app/admin/leave/import/page.tsx), and a stub is not a screen this grid can describe, so it
      // left `routes` in the SAME commit that emptied the page — the /admin/leave (df00b85f) and
      // /admin/leave/audit (f1b994e3) precedent. test/function-access.test.ts fails BOTH ways.
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/entitlements'` STOOD HERE and is DELIBERATELY GONE.
      // The leave type screen is `/admin/leave-config/types`; the old address is an unguarded redirect
      // stub and `components/leave-type-panel.tsx` was deleted with the page that mounted it, so the
      // route left `routes` in the SAME commit — test/function-access.test.ts fails BOTH ways.
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/entitlements/archive'` (6e9a126e, the read-only record
      // of the entitlement configuration release three clears) STOOD HERE and is DELIBERATELY GONE. The
      // record is the Configuration sub-tab of `/admin/leave-config/records` now (7f69bd71; it was
      // `/admin/leave-config/records/entitlement` in between, itself a stub today) and the old address is
      // an unguarded redirect stub, so it left `routes` in the SAME commit that emptied the page. Its `/export` route
      // handler is UNMOVED and was never listed here — the reverse-completeness scan reads page.tsx files
      // only, and a route handler has no screen column to describe.
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/entitlements/ledger-archive'` (c8052ae3, the read-only
      // BALANCE record of what the Medical/Hospitalization ledger correction archived before deleting it)
      // STOOD HERE and is DELIBERATELY GONE. The record is the Balances sub-tab of
      // `/admin/leave-config/records` now (7f69bd71; `/admin/leave-config/records/balances` in between,
      // itself a stub today) and the old address is an unguarded redirect stub, so it left `routes` in
      // the SAME commit that emptied the page. Its `/export` sibling was never listed and has not moved.
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
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/payroll'` STOOD HERE and is DELIBERATELY GONE. The
      // screen is absorbed: F39 (send to payroll module) is on the leave TYPE screen's tab 1 and F40 (the
      // encashment policy) is on Company rules. The old address is an unguarded redirect stub, so it left
      // `routes` in the SAME commit that emptied the page.
      // a6fe37fc ROUND 5 (cutover) — `'/admin/leave/replacement'` (645e67c4 / 296fc027) STOOD HERE and is
      // DELIBERATELY GONE. Replacement-leave CONFIGURATION is on Company rules
      // (`/admin/leave-config/company-rules`) now and the old address is an unguarded redirect stub, so it
      // left `routes` in the SAME commit that emptied the page. `toilPolicy` (/admin/toil) is untouched
      // and stays registered separately: 296fc027 split that route in two ON PURPOSE — the ledger and the
      // two settlement sweeps must stay reachable when the `toil` entitlement lapses, and configuration
      // must not.
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
      // r279 (3fbf7a02) — LEAVE BALANCE HEALTH's own address. The traffic-light listing was drawn at
      // page level on the Leave types tab and named nowhere in the menu; it has a fly-out row and a page
      // of its own now (packs/leave/index.ts, second child). Same admin surface behind the same
      // `requireAdmin` guard as every other `/admin/leave-config/` screen, so it is a ROUTE on this
      // screen key rather than a new one — the precedent every route below it set, and the rule this
      // file's head states: a key "may key stored role configs", so `leaveConfig` is never renamed and
      // only `href` and `routes` ever move. No new permission is created: anyone who could open the
      // Leave types tab could already read this listing, because it WAS the Leave types tab.
      // REGISTERING IT IS NOT PAPERWORK: test/function-access.test.ts fails BOTH ways — a guarded
      // page.tsx absent from REGISTERED_ROUTES, and a registered route with no page on disk.
      // IT IS DELIBERATELY OFF components/leave-config-map.tsx: it is a sibling ROW, not a tab of the
      // Entitlements group, and the map's groups are rows-and-their-tabs. test/leave-config-map.test.ts
      // names it as a mapless row and asserts the fly-out reaches it instead, so "a screen nobody can
      // find" — the defect a6fe37fc exists to fix — is still asserted, against the menu that is real.
      '/admin/leave-config/balance-health',
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
      // r281 (09386e29) — RUN EARNED ACCRUAL's own address. It was a card filed underneath the generation
      // wizard on `/admin/leave-config/generate`, which is the one operation it must not be confused with
      // (that one CREATES a leave year's entitlement; this tops up what was already earned). It has a
      // fly-out row and a page of its own now. Same admin surface behind the same `requireAdmin` guard as
      // every other `/admin/leave-config/` screen, so it is a ROUTE on this screen key rather than a new
      // one, and NO new permission is created: anybody who could open Generate Entitlement could already
      // run it, because it WAS a section of Generate Entitlement.
      // REGISTERING IT IS NOT PAPERWORK: test/function-access.test.ts fails BOTH ways — a guarded
      // page.tsx absent from REGISTERED_ROUTES, and a registered route with no page on disk.
      '/admin/leave-config/earned-accrual',
      '/admin/leave-config/adjustments',
      // 3fb1a611 (r299) — LEAVE CREDIT's own address: every Replacement Leave credit movement, + Add Leave
      // Credit, Reverse, the settlement sweeps and the Rules tab. Same admin surface behind the same
      // `requireAdmin` guard as every other `/admin/leave-config/` screen, so it is a ROUTE on this screen key
      // (test/leave-config-map.test.ts requires every map href to be declared here). It REPLACES the
      // `toilPolicy` column below, whose only route (/admin/toil) is a redirect stub to this page now — no
      // role loses access: both were requireAdmin, and screen keys are not persisted anywhere.
      '/admin/leave-config/leave-credit',
      // …and its Rules tab, the replacement-leave policy form that left Company rules (same guard, same key).
      '/admin/leave-config/leave-credit/rules',
      '/admin/leave-config/import',
      // 3f15ffdb (r362) — LEAVE HISTORY DATA IMPORT, the RECORD half of a migration (the line above is
      // the BALANCE half, which is why that tab is renamed "Leave Balance Import" in the same round —
      // two near-identical names for two tools that do opposite things is what the rename ends).
      //
      // A ROUTE on the EXISTING `leaveConfig` key, NOT a new screenKey, and that is deliberate: a key
      // "may key stored role configs" (see this file's head), and every other `/admin/leave-config/`
      // screen is a route on this one. Minting a second key for a sibling screen would create a
      // permission nobody has been granted and split one area's access in two. The guard is the same
      // `requireAdmin` the rest of Leave Config carries, which is ticket point 11 (HR/Admin only) —
      // and the run log is admin-only at the ROW level too, by the RLS policy in migration 0490.
      // REGISTERING IT IS NOT PAPERWORK: test/function-access.test.ts fails BOTH ways — a guarded
      // page.tsx absent from REGISTERED_ROUTES, and a registered route with no guarded page on disk.
      '/admin/leave-config/history-import',
      '/admin/leave-config/data-import',
      // db55d08a (r369) — LEAVE B/F DATA IMPORT, the opening-figure third of a migration.
      //
      // A ROUTE on the EXISTING `leaveConfig` key, NOT a new screenKey, for the reason the note above
      // gives in full: a key "may key stored role configs" (see this file's head), every other
      // `/admin/leave-config/` screen is a route on this one, and minting a second key for a sibling
      // screen would create a permission NOBODY HAS BEEN GRANTED and split one area's access in two.
      // The guard is the same `requireAdmin` both sibling importers carry, and the run log is
      // admin-only at the ROW level too, by the RLS policy in migration 0497.
      // REGISTERING IT IS NOT PAPERWORK: test/function-access.test.ts fails BOTH ways — a guarded
      // page.tsx absent from REGISTERED_ROUTES, and a registered route with no guarded page on disk.
      '/admin/leave-config/bf-import',
      // 7f69bd71 — THE RESET RECORDS SUB-SCREEN: the two read-only registers as sub-tabs of one page
      // (`?record=configuration` / `?record=balances`), reached from the foot of Leave Adjustments. Same
      // requireAdmin guard, same key — no separate permission exists for the records and none is added.
      // `'/admin/leave-config/records/entitlement'` and `'/admin/leave-config/records/balances'` STOOD
      // HERE and are DELIBERATELY GONE: both are unguarded redirect stubs to the sub-screen now, and a
      // stub is not a screen this grid can describe, so they left `routes` in the SAME commit that
      // emptied their pages — test/function-access.test.ts fails BOTH ways. Their `/export` route
      // handlers were never listed and have not moved: the reverse-completeness scan reads page.tsx
      // files only, and a route handler has no screen column to describe.
      '/admin/leave-config/records',
      // r281 (a73d1e14) — SPECIAL SETTING's own address, the last row of the fly-out, holding Half Day
      // Deduction. The card is a COMPANY-wide rule that was drawn on Company rules with three other
      // settings; the reporter asked for it under a heading of its own that a second setting of the same
      // kind can later join. Same admin surface behind the same `requireAdmin` guard as every other
      // `/admin/leave-config/` screen, so it is a ROUTE on this screen key rather than a new one, and no
      // new permission is created: anybody who could open Company rules could already edit this card.
      // REGISTERING IT IS NOT PAPERWORK: test/function-access.test.ts fails BOTH ways — a guarded
      // page.tsx absent from REGISTERED_ROUTES, and a registered route with no page on disk.
      '/admin/leave-config/special-setting',
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
    // a6fe37fc ROUND 5 (cutover) — the canonical href is `/admin/leave-config/approval-chains` now.
    // `/admin/leave/approval` is an unguarded redirect stub pointing there, and a stub is not a screen
    // this grid can describe. THE SCREEN KEY IS NOT RENAMED (see this file's head: a key "may key stored
    // role configs"), so every tenant's existing grant for this screen is untouched — only `href` and
    // `routes` moved.
    href: '/admin/leave-config/approval-chains',
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
    // `'/admin/leave/approval'` STOOD HERE and is DELIBERATELY GONE (a6fe37fc Round 5): its page is now a
    // redirect stub with no guard, so it left `routes` in the SAME commit that emptied it —
    // test/function-access.test.ts fails BOTH ways, and the direction that bites here is "no stale
    // routes". The df00b85f / f1b994e3 precedent.
    routes: ['/admin/leave-config/approval-chains'],
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
    // arrangement in one list. View / Edit went to the personnel card in r209, to an inline panel on the
    // list in r263 (a485afa1), and since r265 (a485afa1 rev 2) opens the row's OWN page,
    // '/admin/attendance/schedule-assignment/[employmentId]' — registered on this same line set, in the
    // SAME commit as its page.tsx (test/function-access.test.ts fails in both directions), because it is
    // the same guard (requireAdmin) and the same admin surface as the list that links to it: a sub-page
    // of a screen is not a second screen, exactly as '[shiftId]' rides the shift library below.
    // requireAdmin, same guard and same admin surface as the shift library it sits beside, so it rides
    // THIS column rather than minting one. It is a STATIC segment declared before '[shiftId]' here for
    // readability only — on disk Next resolves app/admin/attendance/schedule-assignment/page.tsx ahead
    // of the dynamic sibling either way, exactly as '/admin/attendance/new' already does; and a
    // '[employmentId]' nested UNDER that static segment does not collide with '[shiftId]' beside it.
    // 1c5602cc (r263): '/admin/attendance/schedule' — the tabbed Schedule configuration screen (General
    // built; the other five tabs named and empty). requireAdmin, the same guard and the same admin
    // surface as the shift library it reads from, so it RIDES this column rather than minting a screen
    // key: a second nav row does not make it a second screen, exactly as '/admin/attendance-policy/
    // schedule' rides `attendancePolicyConfig` below. Registered in the SAME commit as the page —
    // test/function-access.test.ts fails in BOTH directions, so neither half may land alone. Another
    // STATIC segment declared ahead of '[shiftId]' for readability only; on disk Next resolves
    // app/admin/attendance/schedule/page.tsx ahead of the dynamic sibling either way.
    // a57f0584 (r328): '/roster/edit/[employmentId]' — one employee's month on a screen of its own,
    // replacing the panel that opened at the foot of the roster. It calls `scopedAdmin()`, which is
    // `requireAdmin` plus the active company scope and derives the SAME two admin roles this column's
    // guard does, so it rides HERE with '/roster/import' rather than on the '/roster' column, whose
    // guard is scopedSession — function-access checks guard-derived access in both directions, and
    // registering an admin-only page under scopedSession would tell every role it can reach it.
    // Registered in the SAME commit as its page.tsx; the test fails in both directions.
    // 665de026 (r331): '/admin/attendance/schedule/new', '/admin/attendance/schedule/[ruleId]' and
    // '/admin/attendance/schedule/[ruleId]/edit' — Add Schedule, View Schedule and Edit Schedule. The
    // reporter contested r301's shape (one page carrying every Schedule Group's settings at once), so
    // Schedule is list + detail now, exactly as schedule-assignment became in r265 after its own panel was
    // contested. All three call requireAdmin, the same guard and the same admin surface as the list they
    // hang off, so they RIDE this column rather than minting a screen key — a record's own page is not a
    // second screen, exactly as '[employmentId]' rides here and '[shiftId]' does below. 'new' is a STATIC
    // segment and Next resolves it ahead of the '[ruleId]' sibling either way. Registered in the SAME
    // commit as the three page.tsx files: test/function-access.test.ts fails in BOTH directions, so
    // neither half may land alone.
    //
    // The four '/admin/attendance-policy/...' routes stay on `attendancePolicyConfig` below, still as
    // requireAdmin() redirect stubs — repointed at these three addresses, not deleted. A screenKey is a
    // permission identity and removing one silently revokes every grant that names it.
    // 8cd601d0 (r329): '/admin/attendance/schedule-assignment/bulk' — putting MANY employments in a
    // Schedule Group in one action, which is what makes r277's allowed-shift refusal bite (1 of 75
    // production employments was in a group; the guard is a no-op on an employment that is in none).
    // requireAdmin, the same guard and the same admin surface as the list it hangs off, so it RIDES this
    // column rather than minting a screen key — a bulk view of a screen is not a second screen. A STATIC
    // segment, so Next resolves it ahead of the '[employmentId]' sibling either way. Registered in the
    // SAME commit as its page.tsx: test/function-access.test.ts fails in BOTH directions.
    // 44bc1c33 (r306): '/admin/card-assignment' — the employee↔Card/Clocking ID mapping a physical
    // terminal needs. requireAdmin, the same guard and the same admin device-configuration surface as the
    // shift library beside it, so it RIDES this column rather than minting a screen key. Registered in the
    // SAME commit as its page.tsx — test/function-access.test.ts fails in BOTH directions.
    // r424 (50ed39e1): File Structure Mapping (list / new / view / edit) and the Import Clocking Data
    // logs (list / one log). All requireAdmin — the same guard and the same admin surface as Card
    // Assignment and '/attendance/import' already on this column — so they RIDE it rather than minting a
    // screen key. Registered in the SAME commit as the page.tsx files (test/function-access.test.ts).
    routes: [
      '/admin/attendance',
      // r431 (bdfe4968): the Attendance Settings card page. requireAdmin, the same guard as the five screens
      // it links to, so it RIDES this column rather than minting a screen key.
      '/admin/attendance/settings',
      '/admin/card-assignment',
      '/admin/attendance/file-mappings',
      '/admin/attendance/file-mappings/new',
      '/admin/attendance/file-mappings/[mappingId]',
      '/admin/attendance/file-mappings/[mappingId]/edit',
      '/attendance/import/logs',
      '/attendance/import/logs/[runId]',
      '/admin/attendance/new',
      '/admin/attendance/schedule',
      '/admin/attendance/schedule/new',
      '/admin/attendance/schedule/[ruleId]',
      '/admin/attendance/schedule/[ruleId]/edit',
      '/admin/attendance/schedule-assignment',
      '/admin/attendance/schedule-assignment/bulk',
      '/admin/attendance/schedule-assignment/[employmentId]',
      '/admin/attendance/[shiftId]',
      '/attendance/import',
      '/roster/import',
      '/roster/edit/[employmentId]',
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
    // 870b79e2 (r277): "Overtime Pattern" → "Schedule Group" (nav.overtimePattern → nav.scheduleGroup).
    // Label-only for the THIRD time, and the screenKey is STILL 'attendancePolicyConfig' on purpose — a
    // screenKey is a permission identity, and renaming it would silently revoke every grant that names it.
    // The reason for this rename is in packs/attendance/index.ts beside the row: the rail said OVERTIME
    // over a screen that also owns every lateness and early-out rule, so the reporter kept asking us to
    // build the thing they already had. The routes below are untouched.
    screenKey: 'attendancePolicyConfig',
    href: '/admin/attendance-policy',
    labelKey: 'nav.scheduleGroup',
    guard: 'requireAdmin',
    // af7a8eb4 (r186): the working-hours schedule block moved off the policy page onto its own route.
    // requireAdmin, same guard as its parent, so it rides this screen rather than getting a column.
    // ad52212d round 1 gave '/admin/attendance-policy/schedule' its own nav row ("Work Schedule"). It keeps
    // riding THIS column: same guard, same admin surface, and the reverse-completeness case only asks that
    // every guarded route on disk be covered — a second nav row does not make it a second screen.
    // 6d091cc0 (r301): all four routes below are requireAdmin() REDIRECT STUBS now — their content is the Schedule
    // Group, Company Policy Settings and Work Schedule & Overtime Rates cards (and the editor panels) on
    // '/admin/attendance/schedule'. They stay registered here because this screenKey is a permission identity and
    // each stub still calls the guard before it redirects; removing them would silently revoke grants that name it.
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
  {
    // 639bf4a5 (r336) — the SCREEN moved (Attendance › Clocking Location, /admin/locations) and its
    // address moved with it; the screenKey did NOT, because a screenKey is a permission identity that
    // stored role configs may name, and renaming it would silently revoke every grant that does.
    //
    // 639bf4a5 rev 2 (r338) — AND NOW THE MENU HAS MOVED BACK, to Attendance › Locations, on the
    // reporter's instruction. THREE things deliberately did not move with it: the `screenKey` (same
    // argument as above, and it is why this column is the one thing in the whole item that has never
    // changed), the `href` (they asked to rename the function, not the URL — a second move in two days
    // would churn every bookmark and re-point three redirect stubs for nothing), and the guard. Only the
    // `labelKey` follows, to `nav.locations` — the key that has read "Locations" in all six catalogues
    // since ADR-0054, which r336 orphaned when it minted `nav.physicalWorkLocation`. That newer key is
    // deleted in the same commit: a live-looking nav key nothing renders is how a retired row comes back.
    screenKey: 'locations',
    // r423 (83c0d3c8) — the href follows the "Locations" function to the CLOCKING location list. The work
    // location listing ('/admin/work-locations') is a second menu row, "Work Locations", but it gets no
    // screen column of its own: both are the same permission identity they have always been, so no stored grant changes
    // meaning and nobody gains or loses either screen. Its routes stay on this column below.
    href: '/admin/work-locations/clocking',
    labelKey: 'nav.locations',
    guard: 'requireAdmin',
    // f9afd1ce rev 2 (r267): a clocking location is added and edited on a page of its own (the loans
    // list + new + [id] shape below) — same requireAdmin guard as the list, same screen column, no new
    // grant. The page renders read-only for a company-scoped admin exactly as the list does; write
    // authority is the group administrator's (core/clocking-location.ts assertGroupAdmin + RLS).
    //
    // THE THREE OLD ADDRESSES STAY REGISTERED because they still exist as requireAdmin() REDIRECT STUBS
    // (app/admin/locations/**), exactly as the four /admin/attendance-policy stubs above do: each calls
    // the guard before it redirects, so test/function-access.test.ts counts it, a non-administrator
    // following an old bookmark is refused rather than told where the screen went, and a stale link
    // lands on the register instead of a 404. Both halves are pinned — a route registered here with no
    // guarded page on disk, or a guarded page with no route here, fails that test in either direction.
    //
    // 639bf4a5 rev 2 (r338) — FOUR NEW ROUTES, ALL ON THIS SAME COLUMN. The register is a COMPANY
    // LISTING now and Add / View / Edit each open a screen of their own (/new, /[id], /[id]/edit), plus
    // /clocking for the points that hang off no location — which used to render on the register and
    // would otherwise have become unreachable. Every one is requireAdmin, every one is the same screen
    // in permission terms, so they ride this column rather than minting screenKeys nobody has granted.
    routes: [
      '/admin/work-locations',
      '/admin/work-locations/new',
      '/admin/work-locations/[id]',
      '/admin/work-locations/[id]/edit',
      '/admin/work-locations/clocking',
      '/admin/work-locations/clocking/new',
      '/admin/work-locations/clocking/[id]',
      // r423 — View (above) is read-only now; the form is its own route.
      '/admin/work-locations/clocking/[id]/edit',
      '/admin/locations',
      '/admin/locations/clocking/new',
      '/admin/locations/clocking/[id]',
    ],
  },
  // 3fb1a611 (r299) — `{ screenKey: 'toilPolicy', href: '/admin/toil', … }` STOOD HERE and is DELIBERATELY
  // GONE. /admin/toil is an unguarded redirect stub to Leave Config › Leave Credit, which holds its ledger
  // summary and settlement sweeps, and a stub is not a screen this grid can describe — the route left in the
  // SAME commit that emptied the page (test/function-access.test.ts fails BOTH ways). The destination is
  // registered on `leaveConfig` above, behind the same requireAdmin guard, so nobody who could open the old
  // page loses access. (a324a4b3 had renamed its label nav.toilPolicy → nav.timeOffInLieu.)
  {
    // ADR-0095 — the Lifecycle module's Module Config. requireAdmin; the module's own staff screens under
    // /lifecycle carry no matrix guard of their own (their level check is the module's staff table, which
    // is not a role), exactly like /claims.
    screenKey: 'lifecycleConfig',
    href: '/admin/lifecycle',
    labelKey: 'nav.lifecycleConfig',
    guard: 'requireAdmin',
    routes: ['/admin/lifecycle'],
  },
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
      '/payroll/[batchId]/tax-configuration/[employmentId]',
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
      // 20f6c6a8: Payment Submission — the shelf of machine-readable files a month is filed with (KWSP
      // i-Akaun, PERKESO ASSIST, LHDN e-Data PCB). SAME `scopedAdmin` KEY AS THE REST OF THE PAYROLL HUB
      // AND DELIBERATELY NOT A COLUMN OF ITS OWN: every file it hands over is built from figures already
      // reachable on Reports and Statutory Forms by anyone holding this key, so a separate column would
      // suggest a boundary that does not exist — and revoking it while leaving Statutory Forms granted
      // would hide the upload file while still offering the same month's printed form.
      //
      // It rides PAYROLL'S module entitlement (ADR-0077) rather than taking one of its own: `packs/
      // catalog.ts` is the source of truth for what a customer BUYS, and this sells nothing Payroll does
      // not already sell. Its nav row lives inside the payroll pack's node, so `visibleModuleCodes`
      // hides it for a tenant without Payroll, and its data path sits behind service files already bound
      // to the `payroll` module by core/module-gate.ts. See the screen's header.
      //
      // Its `download` sibling is a route handler, not a guarded page, so it is not listed — the
      // reverse-completeness check walks page.tsx files. Registered here because that check would
      // otherwise fail the suite rather than let this become a screen nobody can grant or revoke.
      '/payroll/payment-submission',
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
      // r402 f3cf2444: the in-app VIEWER for the EA the picker above ticked — the existing inline preview
      // route in a full-width frame, with Version, Download and Back. Same scopedAdmin key as the picker
      // and DELIBERATELY not a column of its own: it shows nothing the preview route did not already serve
      // to this key, and that route still runs its own gate inside the frame. Registered because
      // test/function-access.test.ts checks reverse completeness for every guarded page.tsx.
      '/payroll/statutory-forms/ea/view',
      // 72b100cd (r323): PCB 2(II)'s employee selection — step two of the SAME two-step flow the EA above
      // uses, for the same reason: this form is one statement PER EMPLOYEE for a year, not one document
      // for a company and a period. Same scopedAdmin key as its siblings, and it needs one on its own
      // account too — it lists the year's paid population by name, employee ID, department and status,
      // and the document behind it carries tax numbers and identity card numbers. Its `download` sibling
      // is a route handler, not a guarded page, so it is not listed; the reverse-completeness check in
      // test/function-access.test.ts walks page.tsx files.
      '/payroll/statutory-forms/pcb2ii',
      // r402 f3cf2444: PCB 2(II)'s in-app viewer — the same viewer as the EA's above, over this form's
      // existing inline preview route. Same key, same reason, same reverse-completeness registration.
      '/payroll/statutory-forms/pcb2ii/view',
      // 72b100cd (r331): the PCB 2(II) Receipt / Transaction Details screen — a whole year of the
      // employer's own PCB payments (receipt number and payment date, MTD and CP38 apart) maintained on
      // one page instead of one month at a time at the bottom of CP39. Same scopedAdmin key as the
      // pcb2ii screen above and DELIBERATELY not a column of its own: a separate column would let an
      // administrator grant PCB 2(II) while revoking the only sensible place to maintain what section 2
      // of it prints — and the CP39 screen, which writes the identical record through the identical
      // action, already sits on this key. It needs a line here on its own account too: it names a
      // company and shows what that company paid a tax authority. Registered because
      // test/function-access.test.ts checks reverse completeness — a guarded page with no matrix column
      // fails the suite rather than silently becoming a screen nobody can grant or revoke.
      '/payroll/statutory-forms/pcb2ii/receipts',
      // 88076362: the CP22 review step, between the joiner list on the statutory-form directory and the
      // download. Same scopedAdmin key as the directory that links to it (statutory-forms/page.tsx builds
      // the href twice, for the due list and the watchlist) — it shows one joiner's full particulars, name,
      // IC, address and commencement terms, so it is admin-scoped exactly like the [formId] screen above.
      // Registered here because test/function-access.test.ts checks reverse completeness: a guarded page
      // with no matrix column fails the suite rather than silently becoming a screen nobody can grant or
      // revoke. Its FOUR siblings under /payroll/cp22 (the [employmentId] pdf and text downloads, batch and
      // blank) are route handlers, not guarded pages, so they are not listed — the check walks page.tsx.
      '/payroll/cp22/[employmentId]/preview',
      // r413 (item 79f3f64d, step 2): the CP22A viewer — one leaver's notice on LHDN's own page, framed, with
      // the four boxes only the operator can answer. Same scopedAdmin key as the CP22 review screen above
      // and for the same reason: it shows one named person's IC, TIN, address and year's pay. Its `pdf`
      // sibling is a route handler, not a guarded page. Registered for test/function-access.test.ts.
      '/payroll/cp22a/[employmentId]/preview',
      // r415 (item 79f3f64d, step 3): the CP21 viewer — one employee's notice of leaving Malaysia on LHDN's own
      // page, framed, with the five departure boxes only the operator can answer. Same scopedAdmin key as the
      // CP22A viewer above and for the same reason: one named person's IC, TIN, address and year's pay. Its
      // `pdf` sibling is a route handler, not a guarded page. Registered for test/function-access.test.ts.
      '/payroll/cp21/[employmentId]/preview',
      // r413 (item 79f3f64d, step 2): the event-selection screen for forms about one person (CP22, CP22A; CP21 since r415) —
      // Company, then the people the event happened to, with a name search. Same scopedAdmin key as the
      // directory that links to it: it lists names with joining or leaving dates. Its `continue` sibling is
      // a route handler (a redirect), not a guarded page. Registered for test/function-access.test.ts.
      '/payroll/statutory-forms/event',
      // 8ca344bf: the Borang 8A review step, between the PERKESO shelf's figures screen and the two
      // downloads. Same scopedAdmin key as the directory that links to it and as the [formId] screen above
      // — it lists every employee's name, IC and SOCSO contribution for the month, so it is admin-scoped
      // exactly like them. Registered here because test/function-access.test.ts checks reverse
      // completeness: a guarded page with no matrix column fails the suite rather than silently becoming a
      // screen nobody can grant or revoke. Its THREE siblings under /payroll/borang-8a (the pdf and text
      // downloads, and shared.ts) are route handlers and a plain module, not guarded pages, so they are not
      // listed — the check walks page.tsx.
      '/payroll/borang-8a/preview',
      // r412 (item e74af58c, step 2): the EIS (SIP) contribution schedule and Borang 8B previews — each the
      // form in the shared viewer and its download. Same scopedAdmin key as the Borang 8A preview above: the
      // SIP schedule lists every employee's name, IC and EIS contribution, and the 8B names the company's
      // PERKESO signatory. Registered here because test/function-access.test.ts checks reverse completeness;
      // their `pdf` siblings are route handlers, and `shared.ts` / `query.ts` plain modules, so not listed.
      '/payroll/sip-contribution/preview',
      '/payroll/borang-8b/preview',
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
      // r411 (item 4f45f9b0): the BBCD preview — Borang A's payment cover, from the same Open Form path and
      // the same payroll read. Same scopedAdmin key as the Borang A preview beside it: it frames the
      // company's EPF reference, its month's contribution total and its signatory's name and IC. Its
      // sibling /payroll/borang-bbcd/pdf is a route handler, not a guarded page.
      '/payroll/borang-bbcd/preview',
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
      // r409 (item 79f3f64d): the Form E / CP8D preview — Company and Year, then the annual return in the
      // shared viewer and its three downloads. Same scopedAdmin key as the [formId] figures screen it sits
      // beside: it lists every employee's name and identifier gaps and frames their annual remuneration.
      // Registered here because test/function-access.test.ts checks reverse completeness.
      '/payroll/cp8d/preview',
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
      '/payroll/payslip-information',
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
      // 27605faa rev 2: Add New TP1's first step — which assessment year and which deduction month. Same
      // scopedAdmin key as the three routes above, and it needs one on its own account: it names the
      // selected employee in its header. It WRITES NOTHING (it redirects to the declaration form above),
      // but the reverse-completeness check in test/function-access.test.ts walks page.tsx files and a
      // guarded page with no matrix column fails the suite rather than becoming a screen nobody can
      // grant or revoke.
      '/payroll/transactions/tp1/new',
      // df35d60d: Form TP3 — ONE employee's PREVIOUS-employment record for ONE assessment year, in the
      // official form's own five sections. Same `scopedAdmin` guard as the TP1 routes above and the same
      // reason for its own line: this set is EXACT, and the reverse-completeness case in
      // test/function-access.test.ts fails the build for a guarded page.tsx with no column rather than
      // letting a screen exist that nobody can grant or revoke. (The PDF route beside it is a route.ts,
      // and route handlers are deliberately not on this matrix.)
      '/payroll/transactions/tp3',
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
  {
    // System Testing (e6be5a3b, r330) — the test-case library and its execution record, sold as the
    // `system_testing` module (default OFF). Same shape as systemExplorer directly above, and the same
    // caveat applies: the ENTITLEMENT is a second, orthogonal axis this grid does not model. A column
    // says which ROLES can reach a screen; a tenant without the module has no such screen for any role.
    // requireAdmin is the right and honest answer for the tenants that do have it, and it is also what
    // makes the three routes visible to test/function-access.test.ts's guard scan — a screen with no
    // permission-matrix column is a screen Security & Permissions cannot describe.
    //
    // ONE COLUMN, THREE ROUTES: the list, the create form and the case detail share a guard, which is
    // exactly the parent+child collapse this field documents.
    screenKey: 'systemTesting',
    href: '/admin/system-testing',
    labelKey: 'nav.systemTesting',
    guard: 'requireAdmin',
    routes: ['/admin/system-testing', '/admin/system-testing/new', '/admin/system-testing/[id]'],
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
