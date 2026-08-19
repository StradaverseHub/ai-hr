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
    for (const r of ['leaveBalances(session', 'listLeaveRequestsPage(session', 'listEmployees(session']) {
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
      '<LeaveBalanceTable',
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

describe('388e53c2 · the sidebar lights exactly one row, and it is the right one', () => {
  const leaveRow = leavePack.navLinks!.find((l) => l.href === '/leave')!;
  const trackerRow = leavePack.navLinks!.find((l) => l.href === '/leave/tracker')!;

  it('declares the relationship as DATA on the pack, not as behaviour in the sidebar', () => {
    // The sidebar owns the predicate; the pack only says which paths belong to which row.
    expect(leaveRow.exactHref, '/leave must opt out of prefix matching').toBe(true);
    expect(trackerRow.ownedSubpaths, 'the tracker row must claim the two inquiry screens').toEqual([
      '/leave/employee-balances',
      '/leave/employee-records',
    ]);
    // Highlighting flags are NOT gates. The tracker row carrying adminOnly would remove the leave
    // calendar from every plain employee — asserted here as well as in the two sibling guards.
    expect(trackerRow.adminOnly, 'ownedSubpaths must not have become a gate').toBeUndefined();
    expect(trackerRow.managerUp, 'ownedSubpaths must not have become a gate').toBeUndefined();
  });

  // The reporter's screenshot is row 3 of this table: they were on Employee Leave Record and "My Leave"
  // was lit. Every row is driven through the real exported predicate.
  const TRUTH: ReadonlyArray<readonly [string, boolean, boolean]> = [
    // pathname                      My Leave lit   Team Leave Tracker lit
    ['/leave', true, false],
    ['/leave/tracker', false, true],
    ['/leave/employee-balances', false, true],
    ['/leave/employee-records', false, true],
  ];

  it.each(TRUTH)('on %s the correct single row is lit', (pathname, myLeaveLit, trackerLit) => {
    expect(isNavRowActive(pathname, '', leaveRow), `My Leave on ${pathname}`).toBe(myLeaveLit);
    expect(isNavRowActive(pathname, '', trackerRow), `Team Leave Tracker on ${pathname}`).toBe(
      trackerLit,
    );
    // Never two rows at once, and never none — that is the property the table exists to hold.
    expect(
      [myLeaveLit, trackerLit].filter(Boolean).length,
      `exactly one leave row must light on ${pathname}`,
    ).toBe(1);
  });

  it('still lights a genuine child path of the tracker row', () => {
    // ownedSubpaths matches the path and anything below it, so a future detail screen under one of the
    // inquiry addresses keeps its entry point lit rather than going dark on arrival.
    expect(isNavRowActive('/leave/employee-records/EMP-0003', '', trackerRow)).toBe(true);
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
