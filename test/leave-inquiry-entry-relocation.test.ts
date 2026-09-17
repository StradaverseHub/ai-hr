/**
 * Feedback 388e53c2 — "move the HR admin sections under Team Leave Tracker" — the relocation guard.
 *
 * THE REPORTER'S COMPLAINT, in their own screenshot: they were reading Employee Leave Record, and the
 * sidebar had "My Leave" lit. The three HR sections already existed and already moved between each other
 * through the left-side rail; only their ENTRY POINT was wrong, because the first of the three lived on
 * `/leave`. So this is a NAVIGATION MOVE — no screen was redesigned, no column, filter, width or export
 * changed, and the two screens that had addresses in circulation kept them.
 *
 * A relocation has three failure modes and this file guards all three.
 *
 *   1. THE MOVE IS INCOMPLETE — the listing exists in its new home but something still points at the old
 *      one, or a fragment of it was left behind. The expensive fragment is a FORM: three of them hardcoded
 *      `action="/leave"`, and a string in an action attribute is invisible to tsc, to the suite and to
 *      `next build`. An administrator would have discovered it by pressing Search.
 *
 *   2. THE MOVE QUIETLY REMOVES ACCESS. `/leave/tracker` is the LEAVE CALENDAR and it is deliberately open
 *      to every employee — its own doc comment records that a manager-only screen there would be a silent
 *      removal of access from plain staff, and it is the target of the manager dashboard card and of the
 *      "View Calendar" deep link from a team member's profile. Putting an admin-only surface on that route
 *      makes `adminOnly` on the nav row look reasonable; it is not, and it is asserted absent here as well
 *      as in test/leave-pack.test.ts and test/team-leave-tracker.test.ts.
 *
 *   3. AN ADDRESS BREAKS. Employee Balances and Employee Leave Record keep the exact web addresses they
 *      have today — that promise was made in writing in the approved plan, and saved links plus the export
 *      links already in circulation depend on it.
 *
 *   4. THE SIDEBAR LIGHTS THE WRONG ROW — the reporter's ORIGINAL irritation, and the last thing fixed.
 *      (5ca446db/r269 moved WHICH row owns the two inquiry paths — they are the Leave Config fly-out's
 *      "Employee Leave Inquiry" row now, not Team Leave Tracker — and the truth table below was rewritten
 *      to the new correct table, not relaxed. The invariant is untouched: exactly one row lights, always.)
 *      `isHrefActive` matches a segment PREFIX, which is right for a parent row and wrong here: every
 *      `/leave/*` screen belongs to a different row, so `/leave` lit while an administrator was reading
 *      somebody else's record, and after the entry point moved TWO rows lit on `/leave/tracker`. The fix
 *      is two declarative fields (`exactHref`, `ownedSubpaths`) read by `isNavRowActive`. The truth table
 *      is pinned below, driven through the REAL exported predicate rather than a copy of it — a copied
 *      predicate passes on the day it is written and then drifts.
 *
 * ── A NOTE ON WHAT WAS NOT DONE EARLIER, KEPT ON PURPOSE ─────────────────────────────────────────────
 *
 * An earlier revision of this file recorded the highlight as knowingly UNFIXED, because two of the three
 * files were outside that workstream's lane. It deliberately did NOT pin the then-current wrong behaviour:
 * a guard that freezes a bug is worse than no guard. That was the right call, and it is why the truth
 * table below could be written as the CORRECT table rather than as a description of what happened to
 * exist. Neither flag is a permission — `adminOnly` / `managerUp` remain absent from the tracker row, and
 * adding one to fix highlighting would delete the calendar from every plain employee.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leavePack } from '../packs/leave';
import { CARD_META } from '../lib/dashboard-cards';
import { buildCalendarFocusHref } from '../lib/calendar-focus';
import { isNavRowActive } from '../components/nav-flyout';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const trackerPage = read('app/leave/tracker/page.tsx');
const leavePage = read('app/leave/page.tsx');
const nav = read('components/leave/leave-inquiry-nav.tsx');
const actions = read('app/leave/actions.ts');

/** The admin surface is everything before the calendar banner; the calendar is everything after it. */
const CALENDAR_BANNER = '  // ── The Leave Calendar';
const adminBranch = trackerPage.slice(0, trackerPage.indexOf(CALENDAR_BANNER));
const calendarBranch = trackerPage.slice(trackerPage.indexOf(CALENDAR_BANNER));

describe('388e53c2 · the calendar is still there, for everybody it was there for', () => {
  it('the slices this file reasons about actually exist', () => {
    expect(trackerPage.indexOf(CALENDAR_BANNER), 'calendar branch marker').toBeGreaterThan(0);
    expect(adminBranch.length, 'admin branch').toBeGreaterThan(0);
  });

  it('the nav row carries NO adminOnly and NO managerUp — the access this move must not remove', () => {
    const manage = (leavePack.navLinks ?? []).filter((l) => l.group === 'manage');
    expect(manage).toHaveLength(1);
    expect(manage[0].href).toBe('/leave/tracker');
    // The Manage group gates PER ROW (components/sidebar.tsx canSeeChild), so absent flags = every
    // employee. An admin-only surface now sits behind this row, which makes `adminOnly` LOOK correct —
    // it would delete the calendar from every plain employee and manager instead.
    expect(manage[0].adminOnly, 'an adminOnly row would remove the calendar from staff').toBeUndefined();
    expect(manage[0].managerUp, 'a managerUp row would remove the calendar from staff').toBeUndefined();
  });

  it('the route guard stays scopedSession — not scopedAdmin, for the same reason', () => {
    const screen = SCREENS.find((s) => s.screenKey === 'leaveTracker');
    expect(screen, 'no matrix column for the screen').toBeTruthy();
    expect(screen!.guard).toBe('scopedSession');
    expect(screen!.href).toBe('/leave/tracker');
    expect(REGISTERED_ROUTES.has('/leave/tracker')).toBe(true);
    // The page must not have grown a redirect that fences non-admins out by the back door.
    expect(trackerPage, 'a redirect would be a silent access removal').not.toMatch(/redirect\(/);
    expect(trackerPage).not.toContain('scopedAdmin');
  });

  it('the calendar renders in the NON-admin branch, with the reads that feed it', () => {
    expect(calendarBranch).toContain('<PlannedAbsences');
    expect(calendarBranch).toContain('plannedAbsences(');
    // …and the admin surface does not pay for a read it never renders.
    expect(adminBranch, 'the calendar read must not run for an admin').not.toContain('plannedAbsences(');
  });
});

describe('388e53c2 · every inbound pointer at /leave/tracker still resolves', () => {
  it('the manager dashboard card and its catalogue entry', () => {
    // dashboard_card_config carries live per-tenant rows, so a tenant may hold its own href here. The
    // route SURVIVING is what protects them — this move deliberately did not rename it.
    expect(CARD_META.teamAwayToday.href).toBe('/leave/tracker');
    expect(read('app/page.tsx')).toContain('href="/leave/tracker"');
    expect(read('lib/dashboard-layout.ts')).toContain("href: '/leave/tracker'");
  });

  it("a manager's View Calendar deep link from a team member's profile", () => {
    expect(buildCalendarFocusHref('11111111-2222-3333-4444-555555555555')).toBe(
      '/leave/tracker?view=team&focus=11111111-2222-3333-4444-555555555555',
    );
    // The page still parses that param, in the branch a manager reaches.
    expect(calendarBranch).toContain('parseCalendarFocus(');
  });

  it('the cancel dialog return surface and the revalidations', () => {
    expect(read('components/planned-absences-grid.tsx')).toContain('back="/leave/tracker"');
    // A back whitelist compared by STRING EQUALITY: a miss falls through to /leave silently, and tsc sees
    // nothing. The union type on the dialog is the other half of the same guard.
    expect(actions).toContain("if (backRaw === '/leave/tracker') back = '/leave/tracker';");
    expect(read('components/leave/admin-cancel-leave-dialog.tsx')).toContain(
      "back: '/leave' | '/leave/employee-records' | '/leave/tracker';",
    );
    // The route now also hosts the Employee Details listing, so every leave mutation that already
    // revalidated it keeps that surface fresh too. Three call sites, unchanged by this item.
    expect((actions.match(/revalidatePath\('\/leave\/tracker'\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('388e53c2 · the rail is the way in, and only its FIRST tab moved', () => {
  it('Employee Details points at the tracker; the other two addresses are untouched', () => {
    expect(nav).toContain("{ key: 'details', href: withEmp('/leave/tracker'), label: t('employeeDetails') }");
    expect(nav).toContain("{ key: 'balances', href: withEmp('/leave/employee-balances'), label: t('employeeBalances') }");
    expect(nav).toContain("{ key: 'records', href: withEmp('/leave/employee-records'), label: t('employeeLeaveRecord') }");
    // `?emp=` threading is what makes switching tab keep the employee you are looking at.
    expect(nav).toContain("const withEmp = (href: string) =>");
    expect(nav).toContain('emp=${employmentId}');
  });

  it('all three inquiry surfaces mount the rail, and the tracker opens on details', () => {
    for (const rel of [
      'app/leave/tracker/page.tsx',
      'app/leave/employee-balances/page.tsx',
      'app/leave/employee-records/page.tsx',
    ]) {
      expect(read(rel).includes('<LeaveInquiryNav'), rel).toBe(true);
    }
    expect(adminBranch).toContain('<LeaveInquiryNav active="details"');
  });

  it('THE LISTING FORMS POST BACK TO THE TRACKER — the failure a 200 would not show', () => {
    // Search, Filter and the chip row. Three `action=` strings and one pager base path; miss any one and
    // the administrator is silently thrown onto /leave, which is now a one-sentence page.
    expect((adminBranch.match(/action="\/leave\/tracker"/g) ?? [])).toHaveLength(3);
    expect(adminBranch, 'a form still posting to /leave').not.toMatch(/action="\/leave"/);
    expect(adminBranch).toContain("return q ? `/leave/tracker?${q}` : '/leave/tracker';");
    // Row clicks still open Employee Balances at its unchanged address.
    expect(adminBranch).toContain('`/leave/employee-balances?emp=${employmentId}`');
  });
});

/**
 * r242 — A SECOND DOOR, NOT A SECOND ADDRESS.
 *
 * 388e53c2 moved the entry point to Team Leave Tracker and the reporter still went looking under Leave
 * Config, which is where an HR administrator configures leave and therefore where they expected to look one
 * up. The approved plan answers that with a LINK, deliberately and only a link: the three screens keep the
 * exact addresses the block above pins, because saved links and the export links already in circulation
 * depend on them, and because two routes for one screen is how a surface starts diverging from itself.
 */
describe('r242 → 5ca446db · Leave Config points at the inquiry surface with a ROW, and still moves nothing', () => {
  const leaveConfigLanding = read('app/admin/leave-config/types/page.tsx');
  const CONFIG_NODE = leavePack.navNodes!.find((n) => n.group === 'admin')!;

  it('the way in from Leave Config is the submenu row, at the unchanged address', () => {
    // a6fe37fc ROUND 5 — the landing screen is `/admin/leave-config/types`.
    //
    // 5ca446db (r269) — UPDATED, NOT DELETED. r242's PROPERTY — an HR admin standing in Leave Config can
    // reach the inquiry surface — is what this case is for, and it survives intact. What changed is the
    // FORM: the reporter came back a second time asking for a menu row rather than the single underlined
    // header link r242 shipped, so the link is gone and the Leave Config fly-out's last child carries the
    // way in. THE ADDRESS IS STILL THE POINT and is still unchanged: `/leave/employee-balances` is not a
    // Leave Config screen, no route moved, and every saved link and export link still resolves.
    // r281 (a73d1e14) — UPDATED, NOT LOOSENED. `children.at(-1)` was a spelling of "the inquiry row exists
    // and sits at the bottom", and it held only while that row happened to be last. An unrelated item
    // appended Special Setting below it — the reporter drew it at the very bottom of their own sketch — so
    // the row is resolved BY NAME and its position is asserted as the NEIGHBOUR PAIR it was always about
    // ("at the bottom, AFTER Company rules"). A row inserted between them still fails.
    const inquiry = CONFIG_NODE.children.find((c) => c.labelKey === 'employeeLeaveInquiry');
    expect(inquiry, 'the way in r242 promised is gone from the menu').toBeTruthy();
    expect(inquiry!.href).toBe('/leave/employee-balances');
    expect(CONFIG_NODE.children.map((c) => c.labelKey).slice(-2)).toEqual([
      'employeeLeaveInquiry',
      'leaveSpecialSetting',
    ]);
    expect(REGISTERED_ROUTES.has('/leave/employee-balances')).toBe(true);
    // The link it replaced is gone from the page — both halves asserted, so a half-done change is red.
    expect(leaveConfigLanding).not.toContain('href="/leave/employee-balances"');
    expect(leaveConfigLanding).not.toContain("{t('employeeBalancesAction')}");
  });

  it('the caption the link used is pruned in all six catalogues, with its only reader', () => {
    // 5ca446db — `admin.leave.employeeBalancesAction` had exactly ONE reader (the header link above) and no
    // computed `t(\`…\`)` form in any file reading the `admin.leave` namespace can reach it, so it retires
    // with the link rather than lingering as an untranslatable orphan. The ROW's label is its own key,
    // `nav.employeeLeaveInquiry`, asserted below.
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`)) as Record<string, Record<string, Record<string, string>>>;
      expect(dict.admin.leave.employeeBalancesAction, `${loc} admin.leave.employeeBalancesAction must be pruned`).toBeUndefined();
      const label = dict.nav.employeeLeaveInquiry as unknown as string;
      expect(label, `${loc} nav.employeeLeaveInquiry`).toBeTruthy();
      // Rendered by a bare t() — a {brace} throws FORMATTING_ERROR at render behind a green 200.
      expect(String(label), `${loc}: unexpected ICU argument`).not.toMatch(/[{}]/);
    }
  });

  it('IT IS A LINK AND NOTHING ELSE — the rail is not duplicated onto the config screen', () => {
    // A second mount of the inquiry rail here would give an administrator two Employee Details screens,
    // which is the exact failure the block above ("the move is incomplete") exists to catch, arriving from
    // the other direction. One way in, one screen.
    expect(leaveConfigLanding).not.toContain('LeaveInquiryNav');
    expect(leaveConfigLanding).not.toContain('employeeBalanceRows');
    // …and the rail's own three hrefs are untouched by this item; they are asserted verbatim above.
    expect(nav).toContain("{ key: 'balances', href: withEmp('/leave/employee-balances'), label: t('employeeBalances') }");
  });
});

describe('388e53c2 · My Leave means your own leave again', () => {
  it('it kept no fragment of the inquiry surface', () => {
    for (const gone of [
      'LeaveInquiryNav',
      'leave-inquiry-nav',
      'inquiryPageWindow',
      'listEmployeesPage',
      'listCompanies',
      'listDepartments',
      'deriveEmploymentStatus',
      'EMPLOYMENT_STATUSES',
      'employeeFilterFields',
      'employeeHiddenParams',
      'inquiryEmploymentId',
    ]) {
      expect(leavePage.includes(gone), `still on /leave: ${gone}`).toBe(false);
    }
    // UPDATED BY 5f2e20fb (AGENTS rule 18). `FilterPanel` used to sit in this list, and every other name
    // in it still belongs: what LEFT this page is the HR-admin employee LISTING, and none of it came back.
    // But FilterPanel is a shared, page-agnostic control, not a fragment of that listing — the employee's
    // own My Leave History now uses it for the date/leave-type filter the reporter asked for. So the name
    // is asserted on what it is WIRED TO instead: this page's own history params, never the listing's.
    // (`employeeFilterFields` / `employeeHiddenParams` — the listing's own wiring — are still asserted
    // absent in the loop above, so the panel here can only be serving this page's own history.)
    expect(leavePage).toContain('fields={historyFilterFields}');
  });

  it('an HR admin and an UNLINKED viewer both get the heading and one sentence, before any read runs', () => {
    const guardAt = leavePage.indexOf('if (me == null || admin) {');
    expect(guardAt, 'the short-page guard').toBeGreaterThan(-1);
    expect(leavePage).toContain("{me == null ? tMe('notLinked') : t('inquiryMovedToTracker')}");
    // An EARLY RETURN, so the self-service reads never run for either viewer. `me == null` is checked
    // FIRST and independently of the role, which is what extends the fix to a plain unlinked employee —
    // before this they got empty cards and a "+ Request Leave" button that could not possibly work.
    // 5f2e20fb renamed the history read (the flat scope-wide `listLeaveRequests` became the
    // self-narrowed `listLeaveRequestsPage`). The property is unchanged — no self-service read may run
    // above the early return — so the list follows the read rather than the read being kept for the list.
    // r302 (6c9802c9): the balance read became the per-year dashboard read (core/my-leave.ts calls
    // leaveBalances inside it), so the list follows the read again — the property is unchanged.
    for (const r of ['myLeaveDashboard(session', 'listLeaveRequestsPage(session', 'listEmployees(session']) {
      expect(leavePage.indexOf(r), r).toBeGreaterThan(guardAt);
    }
  });

  it('the not-linked sentence is REUSED, not reworded — one sentence, one meaning, six catalogues', () => {
    // /me has shown this exact string for this exact condition since long before this item. Two wordings
    // for one condition is how a product starts contradicting itself in translation.
    const en = JSON.parse(read('messages/en.json')) as Record<string, Record<string, string>>;
    expect(en.me.notLinked).toContain('isn’t linked to an employee profile');
    for (const loc of LOCALES) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as Record<string, Record<string, string>>;
      expect(m.me.notLinked, `${loc} me.notLinked`).toBeTruthy();
      expect(m.leave.inquiryMovedToTracker, `${loc} leave.inquiryMovedToTracker`).toBeTruthy();
      // Both are rendered by a bare t() with NO arguments: a {brace} throws FORMATTING_ERROR at render,
      // which tsc, the suite and `next build` all pass.
      for (const v of [m.me.notLinked, m.leave.inquiryMovedToTracker]) {
        expect(String(v), `${loc}: unexpected ICU argument`).not.toMatch(/[{}]/);
      }
    }
  });

  it('the self-service half of /leave is untouched — this item moved nothing of the employee\'s', () => {
    for (const kept of [
      '<RequestLeaveDialog',
      // r302 (6c9802c9) — the employee's balances are the dashboard now (the My balances table is gone by the
      // approved plan); what this case defends — the self-service half is still here — is unchanged.
      '<MyLeaveDashboard',
      '<LeaveHistoryCards',
      '<EditLeaveDialog',
      '<CancelLeaveDialog',
      '<CancelDatesDialog',
      'const ess = !admin;',
    ]) {
      expect(leavePage.includes(kept), kept).toBe(true);
    }
    // …and no cancel affordance over SOMEONE ELSE's leave was improvised onto either surface.
    expect(leavePage).not.toContain('<AdminCancelLeaveDialog');
    expect(trackerPage).not.toContain('<AdminCancelLeaveDialog');
  });
});

describe('388e53c2 → 5ca446db · the sidebar lights exactly one row, and it is the right one', () => {
  const leaveRow = leavePack.navLinks!.find((l) => l.href === '/leave')!;
  const trackerRow = leavePack.navLinks!.find((l) => l.href === '/leave/tracker')!;
  /** 5ca446db — the two inquiry paths' owner. r281 — resolved BY NAME: it was the fly-out's last child
   *  until an unrelated item appended Special Setting below it, and what this block is about is which row
   *  owns which path, never which index it sits at. */
  const inquiryRow = leavePack.navNodes!.find((n) => n.group === 'admin')!.children.find(
    (c) => c.labelKey === 'employeeLeaveInquiry',
  )!;

  it('declares the relationship as DATA on the pack, not as behaviour in the sidebar', () => {
    // The sidebar owns the predicate; the pack only says which paths belong to which row.
    expect(leaveRow.exactHref, '/leave must opt out of prefix matching').toBe(true);
    // 5ca446db (r269) — UPDATED, NOT DELETED. The tracker row's
    // `ownedSubpaths: ['/leave/employee-balances', '/leave/employee-records']` was a TRANSFER, not a loss:
    // the reporter asked for a Leave Config menu row that opens Employee Balances, and two rows claiming
    // the same paths would light two rows in two groups at once (activeSectionKey would then resolve to
    // Manage, the earlier group). So ownership moved onto the new row, which keeps the SAME property this
    // case has always held: the paths are declared as data on the pack, and exactly one row answers for
    // each. `/leave/tracker` still answers for itself by the plain prefix rule.
    expect(trackerRow.ownedSubpaths, 'the two inquiry paths transferred to the Leave Config row').toBeUndefined();
    expect(inquiryRow.labelKey).toBe('employeeLeaveInquiry');
    expect(inquiryRow.href).toBe('/leave/employee-balances');
    expect(inquiryRow.ownedSubpaths).toEqual(['/leave/employee-records']);
    // Highlighting flags are NOT gates. The tracker row carrying adminOnly would remove the leave
    // calendar from every plain employee — asserted here as well as in the two sibling guards. The new
    // row is inside the adminOnly Administration GROUP and carries no per-row flag of its own either.
    expect(trackerRow.adminOnly, 'ownedSubpaths must not have become a gate').toBeUndefined();
    expect(trackerRow.managerUp, 'ownedSubpaths must not have become a gate').toBeUndefined();
    expect(inquiryRow.adminOnly, 'ownedSubpaths must not have become a gate').toBeUndefined();
    expect(inquiryRow.managerUp, 'ownedSubpaths must not have become a gate').toBeUndefined();
  });

  // The reporter's screenshot is row 3 of this table: they were on Employee Leave Record and "My Leave"
  // was lit. Every row is driven through the real exported predicate.
  //
  // 5ca446db (r269) — the third column is NEW and the second column's last two rows flip with it. The
  // DISCLOSED CONSEQUENCE of putting the inquiry row in Leave Config is exactly this table: stepping across
  // the inquiry rail's three tabs moves the highlight between Manage (Employee Details, /leave/tracker) and
  // Leave config (Balances, Leave Record). The invariant the table exists for is unchanged and is still
  // asserted below — EXACTLY ONE of the three rows lights on every path.
  const TRUTH: ReadonlyArray<readonly [string, boolean, boolean, boolean]> = [
    // pathname                      My Leave   Team Leave Tracker   Employee Leave Inquiry
    ['/leave', true, false, false],
    ['/leave/tracker', false, true, false],
    ['/leave/employee-balances', false, false, true],
    ['/leave/employee-records', false, false, true],
  ];

  it.each(TRUTH)('on %s the correct single row is lit', (pathname, myLeaveLit, trackerLit, inquiryLit) => {
    expect(isNavRowActive(pathname, '', leaveRow), `My Leave on ${pathname}`).toBe(myLeaveLit);
    expect(isNavRowActive(pathname, '', trackerRow), `Team Leave Tracker on ${pathname}`).toBe(
      trackerLit,
    );
    expect(isNavRowActive(pathname, '', inquiryRow), `Employee Leave Inquiry on ${pathname}`).toBe(
      inquiryLit,
    );
    // Never two rows at once, and never none — that is the property the table exists to hold.
    expect(
      [myLeaveLit, trackerLit, inquiryLit].filter(Boolean).length,
      `exactly one leave row must light on ${pathname}`,
    ).toBe(1);
  });

  it('still lights a genuine child path of the row that owns it', () => {
    // ownedSubpaths matches the path and anything below it, so a future detail screen under one of the
    // inquiry addresses keeps its entry point lit rather than going dark on arrival. 5ca446db moved which
    // row that is; the property is unchanged.
    expect(isNavRowActive('/leave/employee-records/EMP-0003', '', inquiryRow)).toBe(true);
    expect(isNavRowActive('/leave/employee-records/EMP-0003', '', trackerRow)).toBe(false);
    // …and the tracker keeps its own subtree (the calendar's deep links).
    expect(isNavRowActive('/leave/tracker', 'view=team', trackerRow)).toBe(true);
  });

  it('leaves the prefix behaviour alone for rows that did not opt out', () => {
    // The fix must not silently become "exact matching everywhere" — that would darken parent rows all
    // over the sidebar. A row with neither flag still matches its own subtree.
    const plain = { href: '/payroll' };
    expect(isNavRowActive('/payroll/setup', '', plain)).toBe(true);
    expect(isNavRowActive('/payroll', '', plain)).toBe(true);
    expect(isNavRowActive('/leave', '', plain)).toBe(false);
  });
});
