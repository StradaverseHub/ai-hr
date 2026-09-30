/**
 * 0bb0e303 — Attendance settings moved into Admin, staff get "My Attendance".
 *
 * The menu move is the easy half and is covered by test/attendance-pack.test.ts (every pre-retrofit row
 * survives, gates untouched, managerUp rows kept out of the whole-group-adminOnly Admin section).
 *
 * THIS file covers the half with a real consequence. The reporter's concern was confidentiality, and a
 * menu is not a permission: if the only thing standing between a clerk and Shift Settings were a hidden
 * link, typing the address would still get them in. So the assertion here is that each relocated screen
 * refuses on its OWN, and that a plain employee cannot read a colleague's attendance through the data
 * layer regardless of what the sidebar renders.
 *
 * The route half is source-static rather than executed: requireAdmin()/scopedAdmin() resolve a real
 * session, which the harness has no way to mint — the house idiom for route guards
 * (test/personnel-identity-both-sections.test.ts). The DATA half below is executed for real, through
 * RLS, because that is the claim that actually protects the records.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { attendanceMonthSummary, checkIn, checkOut } from '../core/attendance';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, createAppUser, migrateTestDb, resetDb, seedBase, type Base, harnessSnapshot } from './harness';
import { attendancePack } from '../packs/attendance';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

describe('0bb0e303 — the relocated admin screens guard themselves, not via the menu', () => {
  // Derived from the pack rather than hardcoded: a row added to the merged node later is covered
  // automatically. A list copied by hand here would silently stop covering the thing it names.
  // a324a4b3 rev2 merged the admin node into the single day-to-day Attendance node, so the admin rows
  // are now identified by their own adminOnly FLAG rather than by which node they hang under — which
  // is also exactly the gate that now hides them, so deriving from it is deriving from the protection.
  const adminRoutes = attendancePack
    .navNodes!.flatMap((n) => n.children)
    .filter((c) => c.adminOnly === true)
    .map((c) => c.href);

  it('covers every row that landed in the Admin node', () => {
    // ad52212d ROUND 1 — SEVEN rows now, in the reporter's grouping: their three named settings categories
    // (Shift → Overtime Pattern → Work Schedule) ahead of the four remaining configuration screens. The
    // Work Schedule row is new; its SCREEN is not (af7a8eb4 gave /admin/attendance-policy/schedule its own
    // route), which is exactly why it belongs in this file: a screen that gains a menu row must be proved
    // to guard itself, because the row is not what protects it.
    //
    // 4509d2b8 — SIX rows now: /admin/holidays LEFT this node for System Settings. Its guard coverage did
    // NOT lapse, it MOVED with it (see the note above the it.each below). This file's premise is that a
    // screen is protected by its own guard and never by which menu hides its link, so a screen that
    // changes menus must arrive at the new one with that proof intact.
    //
    // 0bade264 (r209) — SEVEN: Schedule Assignment. A brand-new screen listing EVERY employee's shift
    // arrangement, which is exactly the confidentiality shape this file exists for — it is the row most
    // likely to be assumed safe because it only reads. It is not: it names every employee in the tenant,
    // so it carries its own requireAdmin below like the six beside it.
    //
    // 1c5602cc (r263) — EIGHT: Schedule, the tabbed working-pattern configuration screen. It reads the
    // shift library and every in-scope company's working week, so it names tenant-wide configuration the
    // same way its neighbours do, and it carries its own requireAdmin below rather than trusting the row.
    //
    // r274 (2420718d) — NINE, and the new one is the FIRST EXCEPTION this file has ever carried.
    // `/attendance` is Employee Attendance: an administrator-gated ROW pointing at a screen that is NOT
    // admin-guarded, because it is self-service and scopes rather than refuses. See the exclusion and its
    // replacement assertion below — the premise of this file survives, it is simply met a different way.
    //
    // e4471e3c (r287) — SEVEN. '/admin/attendance-policy' (Schedule Group) and
    // '/admin/attendance-policy/schedule' (Work Schedule) left this list, and NOT because their screens
    // went anywhere: the reporter asked for both to be consolidated into the Schedule sub-menu, so their
    // MENU ROWS were retired and the Schedule screen absorbed their settings. Both pages still exist, both
    // are still requireAdmin, and both are still in the it.each below — see the note above that loop,
    // because a screen with no menu row at all is the case this file's premise matters MOST for.
    expect(adminRoutes).toEqual([
      '/attendance',
      // 22d67223 (r311) — Attendance Breakdown. Unlike '/attendance' above it, this one is NOT an
      // exception to this file's premise: its page calls scopedAdmin in its own body and it is in the
      // loop below. See the note there for why it could not be scopedSession like its neighbour.
      '/attendance/breakdown',
      // r314 (fe2360f9 + 7c80a168) — Roster and Import, as ADMIN entry points beside their unchanged
      // managerUp rows in Manage. They are in this list because a row in the Admin node is not what
      // protects the screen behind it, and both screens must prove they guard themselves — which for
      // these two is the interesting case: they are reachable by managers too, so they cannot simply
      // call requireAdmin. See the exception below.
      '/roster',
      '/attendance/import',
      '/admin/attendance',
      // 44bc1c33 (r306) — Card Assignment. Its page carries its own scopedAdmin guard, which is this file's
      // whole premise: a row in the Admin node is not what protects the screen behind it.
      '/admin/card-assignment',
      '/admin/attendance/schedule',
      '/admin/attendance/schedule-assignment',
      '/admin/attendance-allowance',
      // 639bf4a5 (r336) — '/admin/locations' left this node for the Administration group in
      // components/sidebar.tsx, reading "Physical Work Location" and opening /admin/work-locations.
      // rev 2 (r338) — AND CAME BACK, at that address, reading "Locations": the reporter contested the
      // move after it shipped and asked for the screen under Attendance with a company listing and
      // dedicated screens. So the row is in this list again, and this file's premise holds for it
      // exactly as before — the page calls requireAdmin() in its own BODY, and the row is not what
      // protects it. The old '/admin/locations' address stays a guarded redirect stub with no row.
      '/admin/work-locations',
      // 3fb1a611 (r299) — '/admin/toil' STOOD HERE: the row left with the page, which is a redirect stub to
      // Leave Config › Leave Credit now (see test/r299-leave-credit-screens.test.ts).
    ]);
  });

  // 4509d2b8 — /admin/holidays was the FIRST entry in this list and has been MOVED, not dropped: the
  // identical requireAdmin-in-its-own-page-body case now lives in
  // test/holidays-system-settings-relocation.test.ts, beside the rest of that screen's new-home guards.
  // Losing it entirely would have been the exact failure this file exists to prevent — a screen whose
  // only remaining protection is that a menu happens not to show it.
  //
  // ⚠️ e4471e3c (r287) — '/admin/attendance-policy' AND '/admin/attendance-policy/schedule' STAY IN THIS
  // LOOP THOUGH THEY ARE NO LONGER MENU ROWS, and that is the whole premise of this file rather than an
  // exception to it. Their rows were retired into the Schedule sub-menu at the reporter's request. A screen
  // reachable only by URL is precisely the screen whose own guard is the only thing protecting it, so
  // dropping it from this loop because "it is not in the menu" would retire the coverage at the exact moment
  // it became load-bearing.
  //
  // 6d091cc0 (r301) — and they STAY again. Their content moved onto the Schedule screen's General tab, and
  // both pages became redirects to the matching card — but a redirect that ran BEFORE the guard would tell a
  // non-administrator where the setting lives, and would drop the route out of the function-access matrix
  // (which only counts a page.tsx that calls a guard). So each stub calls requireAdmin() first, and this loop
  // is what keeps it that way.
  it.each([
    // 22d67223 (r311) — THE SECOND ROW IN THIS NODE WHOSE SCREEN IS UNDER '/attendance', and the first one
    // that is admin-guarded. It was written as scopedSession to match its neighbour and that was WRONG:
    // its employee picker is `listEmployees`, tenant-scoped and filtered only by company, so a plain
    // employee reaching the URL would have been offered every colleague and served any one of their full
    // calculation audits. The adminOnly nav row hides the link and protects nothing. It refuses now, which
    // is why it belongs in this loop rather than beside '/attendance' in the exception below.
    '/attendance/breakdown',
    '/admin/attendance',
    '/admin/card-assignment',
    '/admin/attendance-policy',
    '/admin/attendance-policy/schedule',
    '/admin/attendance/schedule',
    '/admin/attendance/schedule-assignment',
    '/admin/attendance-allowance',
    // 639bf4a5 (r336) — '/admin/locations' left this loop the way 4509d2b8's /admin/holidays did: MOVED,
    // never dropped. rev 2 (r338) — the ROW came back to this node, so the case comes back with it, at
    // the address the row carries. The three redirect stubs at the old '/admin/locations' addresses, and
    // the three NEW dedicated screens (/new, /[id], /[id]/edit) and the unlinked-points screen, are
    // covered in test/work-location-organization-relocation.test.ts and by test/function-access.test.ts,
    // which walks every guarded page.tsx on disk against lib/permissions.ts in both directions.
    '/admin/work-locations',
    // 3fb1a611 (r299) — '/admin/toil' left this loop: it is an UNGUARDED redirect stub now (a stub has nothing
    // to guard — the function-access precedent). Its destination, /admin/leave-config/leave-credit, calls
    // requireAdmin in its own page body, pinned by test/r299-leave-credit-screens.test.ts and
    // test/function-access.test.ts.
  ])('%s calls a server-side admin guard in its own page body', (route) => {
    const src = read(`app${route}/page.tsx`);
    // Either helper is fine — both resolve the session server-side and refuse a non-administrator.
    // What must not happen is a page relying on the sidebar having hidden its link.
    expect(src, `${route} must call requireAdmin() or scopedAdmin()`).toMatch(/requireAdmin\(|scopedAdmin\(/);
  });

  /**
   * r314 (fe2360f9 + 7c80a168) — ROSTER AND IMPORT, the two rows that now appear in BOTH menus. They are
   * not in the admin-guard loop above because they are reachable by managers too, so this file's premise
   * — the screen is protected by something of its OWN, never by which menu hides its link — is asserted
   * here in the form that is true for each of them.
   *
   * ⚠️ AND THEY ARE NOT PROTECTED THE SAME WAY, WHICH IS A FINDING RATHER THAN A DETAIL. Roster resolves
   * the caller's scope and shows them what they may see. IMPORT CALLS requireAdmin(), which redirects a
   * non-admin to '/' — so the managerUp Manage row for Import advertises a screen every manager is
   * bounced out of. That is PRE-EXISTING (r314 changed neither the row nor the page) and it is pinned
   * here so it cannot be mistaken for something this round introduced. Whether managers should be able
   * to import attendance, or the row should go, is the reporter's call and is raised separately.
   */
  it('r314: the two paired screens guard themselves, and Import is admin-only despite its manager row', () => {
    const roster = read('app/roster/page.tsx');
    expect(roster, 'Roster resolves the session and its scope server-side').toContain('await scopedSession()');
    expect(roster, 'deliberately NOT admin-guarded — managers use it').not.toMatch(/requireAdmin\(|scopedAdmin\(/);

    const imp = read('app/attendance/import/page.tsx');
    expect(imp, 'Import refuses a non-administrator in its own page body').toMatch(/requireAdmin\(|scopedAdmin\(/);
    // r317 (1661123d) — AND THE CONTRADICTION IS RESOLVED. This assertion used to record that the Manage
    // row still claimed managerUp while the page refused managers. The reporter chose to remove the row,
    // so the menu and the page now agree, and the assertion says that instead of describing the fault.
    expect(
      attendancePack.navLinks!.some((l) => l.href === '/attendance/import'),
      'the menu must not offer what the page refuses',
    ).toBe(false);
  });

  it('/attendance is the exception, and it is protected by SCOPING rather than by refusal', () => {
    /**
     * r274 (2420718d) — the one admin row whose screen is not admin-guarded, stated rather than skipped.
     *
     * `/attendance` is `guard: 'scopedSession'`: one screen that shows each viewer exactly their own
     * scope — a single row to an employee, every employee to an administrator. Adding `requireAdmin` to
     * it would take it away from the staff it primarily exists for, which is the regression this whole
     * file is about, pointing the other way.
     *
     * This file's premise is unchanged: the screen is protected by something of its OWN and never by the
     * sidebar having hidden its link. Here that protection is the scope, so the scope is what gets
     * asserted. The `adminOnly` flag on the ROW is about not OFFERING an administrative entry point to a
     * non-administrator; it was never what protects the data.
     */
    const src = read('app/attendance/page.tsx');
    expect(src, 'it resolves the session and its scope server-side').toContain('await scopedSession()');
    expect(src, 'and the reads are narrowed to that scope').toMatch(/companyIds:\s*scopeIds/);
    expect(src, 'deliberately NOT admin-guarded — see above').not.toMatch(/requireAdmin\(|scopedAdmin\(/);
  });

  it('rev3: the config menu is INSIDE Administration, between Leave config and Claims config — and is the ONLY thing called "Attendance"', () => {
    // The MOUNT-POSITION assertion has now been inverted TWICE, and the reason is worth reading before
    // inverting it a third time. 0bb0e303 put the admin node inside the adminOnly group. a324a4b3 rev2
    // merged everything into ONE menu, which then had to sit in the ungated group or Records/Roster/Import
    // would vanish. rev3 is the reporter's own correction: "just relocate the Attendance button below My
    // Attendance to admin section between Leave Config and Claim Config". That INSTRUCTION is unchanged;
    // its ASSERTION was half-dead and r209's verification caught it. `mountOf('LEAVE_CONFIG_ROW')` named a
    // const 645e67c4 had already renamed to `LEAVE_CONFIG_NODE`, so it returned -1 and "after Leave config"
    // held for the node mounted ANYWHERE — only "before Claims config" was ever live. Both halves are live
    // now, and mountOf refuses to return -1 so the next rename fails loudly instead of certifying nothing.
    //
    // 0bade264 (r209) ADDS THE LABEL HALF, and it is the half that reverses a prior decision. ad52212d
    // round 1 renamed this node's key `attendance` → `attendanceSettings` AND its string to "Attendance
    // settings", on the reasoning that a third menu row reading plain "Attendance" was the duplication the
    // reporter objected to. THE SAME REPORTER HAS NOW ASKED FOR "Attendance" BACK, so:
    //   · the KEY stays `attendanceSettings` — `nav.attendance` is a live, different label and two keys
    //     cannot share a name, which is also why this parent knowingly stops camel-casing its own string
    //     (the child rows still must — test/attendance-pack.test.ts);
    //   · `nav.attendance`, which WAS the word "Attendance", becomes "Attendance Records" — the name of
    //     what that column actually covers (/attendance + /attendance/daily + /attendance/individual).
    // Doing only the first is the failure mode this case now catches: two entries reading "Attendance",
    // which is worse than the state the reporter complained about. Both halves are asserted together
    // BECAUSE they are one decision — a unit test of either file alone passes through the broken state.
    const en = JSON.parse(read('messages/en.json')) as { nav: Record<string, string> };
    expect(en.nav.attendanceSettings, 'the Administration menu reads plain "Attendance"').toBe('Attendance');
    expect(en.nav.attendance, 'the operational Records column is renamed, not left colliding').toBe(
      'Attendance Records',
    );
    expect(en.nav.attendance, 'the two must never read the same').not.toBe(en.nav.attendanceSettings);
    // The node still resolves through the key, whatever the key now spells.
    expect(attendancePack.navNodes!.find((n) => n.group === 'admin')!.labelKey).toBe('attendanceSettings');

    // What survived every inversion is the PROTECTION: an administrative screen is never reachable
    // because the rail happened to hide its link. The it.each above proves that directly, and it has not
    // changed.
    const sidebar = read('components/sidebar.tsx');
    expect(sidebar, 'the pre-merge admin node stays gone').not.toContain('ATTENDANCE_ADMIN_NODE');

    const adminGroupStart = sidebar.indexOf("labelKey: 'admin',");
    const manageGroupStart = sidebar.indexOf("labelKey: 'manage',");
    expect(adminGroupStart).toBeGreaterThan(-1);
    expect(manageGroupStart).toBeGreaterThan(-1);

    // `String.search` answers -1 for no match, and -1 is below every real offset — so a const name that
    // no longer exists turns `toBeGreaterThan(leaveConfigAt)` into a tautology instead of a failure. That
    // is exactly how the "after Leave config" half died silently for the whole life of LEAVE_CONFIG_NODE.
    // Assert the mount INSIDE the helper: a rename now fails here, loudly, at the name that moved.
    const mountOf = (konst: string) => {
      const at = sidebar.search(new RegExp(`^[ \\t]*${konst},$`, 'm'));
      expect(
        at,
        `${konst} must be mounted in components/sidebar.tsx — a renamed const makes every position assertion in this case vacuously true`,
      ).toBeGreaterThan(-1);
      return at;
    };
    const attendanceAt = mountOf('ATTENDANCE_NODE');
    const leaveConfigAt = mountOf('LEAVE_CONFIG_NODE');
    const claimsConfigAt = mountOf('CLAIMS_CONFIG_ROW');

    // Literally between them, inside the admin group.
    expect(attendanceAt, 'ATTENDANCE_NODE is mounted').toBeGreaterThan(-1);
    expect(attendanceAt, 'inside the admin group').toBeGreaterThan(adminGroupStart);
    expect(attendanceAt, 'after Leave config').toBeGreaterThan(leaveConfigAt);
    expect(attendanceAt, 'before Claims config').toBeLessThan(claimsConfigAt);

    // My Attendance stays in the ungated day-to-day group, above Manage.
    expect(mountOf('MY_ATTENDANCE_NODE'), 'My Attendance stays ungated').toBeLessThan(manageGroupStart);
  });

  it('rev3: NOTHING non-admin travelled into the admin group with it', () => {
    // THE WHOLE RISK OF THIS CHANGE, in one test. The admin group gates at GROUP level and the sidebar
    // filters group-first, so any row left inside the moved node would become admin-only regardless of its
    // own flag. Records is self-service and Roster/Import are managerUp; all three had to leave the node.
    // If a future edit puts one back, this fails instead of silently removing it from people's rails.
    const merged = attendancePack.navNodes!.find((n) => n.labelKey === 'attendanceSettings')!;
    expect(merged.group, 'the config menu lives in the admin group').toBe('admin');
    expect(
      merged.children.every((c) => c.adminOnly === true),
      `every child of an admin-group node must be adminOnly; found: ${merged.children
        .filter((c) => !c.adminOnly)
        .map((c) => c.href)
        .join(', ')}`,
    ).toBe(true);
    /**
     * ⚠️ r314 (fe2360f9 + 7c80a168) — THIS ASSERTION USED TO READ "/roster and /attendance/import must
     * NOT be in the admin node", and it is inverted rather than deleted because the RISK it guards is
     * unchanged and now needs pinning from both sides.
     *
     * The reporter asked for both under Admin › Attendance. They were shown, in writing, that moving
     * them there takes both rows away from every non-admin manager — the exact failure rev3 prevented —
     * and they chose to have them in BOTH places. So the node carries adminOnly duplicates AND the
     * managerUp rows stay in Manage. Losing the second half is the thing that would actually hurt
     * somebody, so it is asserted here rather than left to the Manage-rows test alone.
     */
    for (const href of ['/roster', '/attendance/import']) {
      const inNode = merged.children.find((c) => c.href === href);
      expect(inNode, `${href} is an admin entry point (fe2360f9)`).toBeTruthy();
      expect(inNode!.adminOnly, `${href} in this node must be adminOnly — the group gates before rows`).toBe(true);
    }
    /**
     * r314 promised the reporter that managers keep the rows they use. r317 (1661123d) found that the
     * promise was only ever TRUE for Roster — Import's page calls requireAdmin() — and the reporter chose
     * to drop the Import row rather than widen who may write attendance. So the Manage half is asserted
     * per row now, positively in both directions, because "managers keep it" and "managers never had it"
     * are different facts and a single loop could only state one of them.
     */
    const roster = attendancePack.navLinks!.find((l) => l.href === '/roster');
    expect(roster, 'Roster must STILL be a flat Manage row — it works for managers').toBeTruthy();
    expect(roster!.managerUp).toBe(true);
    expect(roster!.group).toBe('manage');
    expect(
      attendancePack.navLinks!.some((l) => l.href === '/attendance/import'),
      'Import must NOT be a Manage row — the page refuses managers (1661123d)',
    ).toBe(false);
    /**
     * r274 (2420718d) — `/attendance` LEFT this list, and what it was defending did not.
     *
     * The risk is an employee losing the screen because a row of theirs ended up behind a group-level
     * gate. That was still forbidden: the ungated Records row had to stay in the self-service node. What
     * r274 allowed beside it was an ADDITIONAL admin-gated row pointing at the same screen — the
     * reporter's Employee Attendance — which took nothing away from anybody.
     *
     * f3e6c36e (r287) — THE SHARED SCREEN WAS SPLIT, AND THE PROTECTION IS UNCHANGED. The reporter asked
     * a second time for the administrative Record function to leave My Attendance and reaffirmed after
     * being told that moving the row would HIDE the screen from staff rather than restrict it. So
     * `/attendance` is the administrator's alone now, and the employee's own record is a different screen
     * at `/attendance/my-records`. The risk this block guards is the same risk and is stated the same way:
     * whatever the employee's row points at, it must be in the self-service node and carry no gate.
     */
    const adminCopy = merged.children.filter((c) => c.href === '/attendance');
    for (const c of adminCopy) {
      expect(c.adminOnly, 'any /attendance row in the admin node must be gated').toBe(true);
    }
    const EMPLOYEE_RECORDS = '/attendance/my-records';
    const selfService = attendancePack.navNodes!.find((n) => n.labelKey === 'myAttendance')!;
    const records = selfService.children.find((c) => c.href === EMPLOYEE_RECORDS);
    expect(records, 'the employee’s own record is still in the self-service node').toBeDefined();
    expect(records?.adminOnly, 'and still ungated, which is the whole protection').toBeUndefined();
    // …and it did NOT travel into the admin group, where an ungated row renders for nobody but admins.
    expect(
      merged.children.some((c) => c.href === EMPLOYEE_RECORDS),
      'the employee’s own record must not be in the admin-gated node',
    ).toBe(false);

    // …and it is still reachable somewhere ungated.
    const mine = attendancePack.navNodes!.find((n) => n.labelKey === 'myAttendance')!;
    expect(mine.children.some((c) => c.href === EMPLOYEE_RECORDS), 'the employee’s own row is self-service').toBe(
      true,
    );
    expect(mine.children.find((c) => c.href === EMPLOYEE_RECORDS)?.adminOnly).toBeUndefined();
    const manageLinks = (attendancePack.navLinks ?? []).filter((l) => l.group === 'manage');
    // r317 (1661123d) — ONE Manage row, not two. Import's was removed: it was managerUp in front of a
    // page that calls requireAdmin(), so it was a menu lying about a permission rather than a gate worth
    // keeping. Roster's page is scopedSession, so its row is a true statement and stays.
    expect(manageLinks.map((l) => l.href).sort()).toEqual(['/roster']);
    expect(manageLinks.every((l) => l.managerUp === true), 'what is left stays managerUp').toBe(true);
  });

  it('rev3: the two relocated rows keep their module gating', () => {
    // MODULE_OF_HREF is built from the nav NODES' children. /roster and /attendance/import left the nodes,
    // so without an explicit navLinks line they would drop out of the map and stop being gated by the
    // attendance module entitlement — an un-gating hidden inside a menu move.
    const sidebar = read('components/sidebar.tsx');
    expect(sidebar).toContain("(modulePackById('attendance')!.navLinks ?? []).map((l) => [l.href, 'attendance'] as const)");
  });

  it('every one of the six config screens is still admin-gated at the row', () => {
    const merged = attendancePack.navNodes!.find((n) => n.labelKey === 'attendanceSettings')!;
    for (const route of adminRoutes) {
      expect(merged.children.find((c) => c.href === route)?.adminOnly, `${route} adminOnly`).toBe(true);
    }
  });
});

/**
 * 0bb0e303 rev2 — the third My Attendance row, Attendance Request.
 *
 * The reporter listed three things staff should reach from the menu: clock in/out, their own record, and
 * an attendance request. The first two shipped with rev1. The third existed as a fold-out on /me, which is
 * why the item came back — a capability nobody can find is, from the reporter's chair, absent.
 *
 * The confidentiality concern this file exists for cuts the OTHER way for this row. The two assertions
 * below are therefore about NOT over-restricting: the row must be ungated and its page must not acquire a
 * page guard, because either would put a self-service request form behind an approval-side gate. The data
 * is already safe without one — every one of the three actions re-resolves the caller server-side
 * (resolveMe) and writes only the caller's own employment, and the lists the page renders are RLS-scoped
 * reads of the caller's own rows, which is the same property the executed test below pins for records.
 */
describe('0bb0e303 rev2 — Attendance Request is self-service, and stays that way', () => {
  const mine = attendancePack.navNodes!.find((n) => n.labelKey === 'myAttendance')!;

  it('adds the row to My Attendance, ungated, in the reporter’s order', () => {
    expect(mine.children.map((c) => c.href)).toEqual([
      '/attendance/clock',
      // f3e6c36e (r287) — the employee's Records row points at its OWN screen now. The reporter asked
      // twice for the administrative Record function to leave this menu and reaffirmed after being told
      // that MOVING the row would hide the screen from staff rather than restrict it (the Administration
      // group gates adminOnly at GROUP level). So the screen was SPLIT: `/attendance` is the
      // administrator's, `/attendance/my-records` is the employee's, and this node's membership rule —
      // six rows, written down, none of them gated — is unchanged.
      '/attendance/my-records',
      '/attendance/requests',
      // 1e9145d4 — Plan OT joined the node as the fourth self-service row when overtime moved off the
      // Attendance Request screen. Ungated for the same reason, and pinned by its own describe below.
      '/attendance/plan-ot',
      // c6bb5f5a — SIX rows, not four, and the case is UPDATED rather than re-typed as a new one: what it
      // has always guarded is that this node's membership is written down and that nothing gated slips in.
      // 2166ef79 had stacked Travel Request and the request history onto /attendance/requests; the
      // reporter has since asked for each function to have its own row and its own screen, and confirmed
      // it. Both new rows are ungated for the same reason as the four above — the caller's own requests.
      //
      // ⚠️ b833a077 (r362) — FIVE ROWS NOW. The line above said "SIX rows, not four" and '/attendance/travel'
      // stood on the line below this one, immediately before request-status. The reporter asked for My
      // Travel to be removed completely, so the row is gone with the screen it opened. The case is updated
      // rather than loosened: this is still an exact set, and travel's own obligations (the address still
      // forwards, the route stays unregistered) are asserted in test/attendance-pack.test.ts REMOVED and
      // in the dedicated case below.
      '/attendance/request-status',
    ]);
    // plan-ot joins the loop this round: until c6bb5f5a it was a one-line redirect with nothing to guard,
    // and it now renders the employee's own overtime plans like the two beside it.
    // f3e6c36e (r287) — `/attendance/my-records` was added to this loop rather than only pinning its nav
    // row, because the employee's own record had become a SCREEN of its own. It has since been EMPTIED
    // (2aef3cd8, r362) and now stands in its own block below the loop; the note there says what changed.
    /**
     * ⚠️ 2aef3cd8 (r362) — '/attendance/my-records' USED TO BE IN THIS LOOP, and the claim it carried was
     *   expect(src, `${href} resolves the caller’s own employment`).toContain('myEmployment(s)');
     * The reporter had everything under that row removed (the row itself is "Attendance Overview" now), so
     * the screen resolves no employment and reads no attendance. It is moved OUT of the loop rather than
     * having the loop's assertion weakened for all four routes — the other three still resolve the
     * caller's own employment and that is exactly what must not silently stop being checked — and it gets
     * its own case below asserting the inverse. The half of the rule that still applies to it (no admin or
     * manager page guard, ungated row) is asserted there too.
     */
    /**
     * ⚠️ b833a077 (r362) — '/attendance/travel' USED TO BE IN THIS LOOP, between plan-ot and
     * request-status, and the claims it carried were
     *   expect(src, `${href} carries no page guard`).not.toMatch(/requireAdmin\(|scopedAdmin\(/);
     *   expect(src, `${href} resolves the caller’s own employment`).toContain('myEmployment(s)');
     * The second one is now FALSE by design: My Travel was removed and that address is a bare redirect,
     * which resolves no employment because it reads nothing at all. It is moved OUT of the loop rather
     * than having the loop's assertion weakened for all three routes — the other two still resolve the
     * caller's own employment and that is exactly what must not silently stop being checked — and it gets
     * its own case below asserting the inverse.
     */
    for (const href of ['/attendance/plan-ot', '/attendance/request-status']) {
      const added = mine.children.find((c) => c.href === href)!;
      expect({ adminOnly: added.adminOnly, managerUp: added.managerUp }, `${href} stays ungated`).toEqual({
        adminOnly: undefined,
        managerUp: undefined,
      });
      // …and their pages must not acquire a page guard either, for the reason this describe exists: a
      // self-service request screen behind an approval-side gate is a capability taken away, not secured.
      const src = read(`app${href}/page.tsx`);
      expect(src, `${href} carries no page guard`).not.toMatch(/requireAdmin\(|scopedAdmin\(/);
      expect(src, `${href} resolves the caller’s own employment`).toContain('myEmployment(s)');
    }
    {
      /**
       * The employee's own row. It is OUT of the loop above rather than back in it, and that is deliberate:
       * the loop pins the COMMENT idiom `myEmployment(s)` on raw source, and this file's page necessarily
       * discusses the calls it makes and does not make in its header, so it is read with comments stripped
       * (the idiom of test/attendance-my-records-split.test.ts, for the same reason). Weakening the loop to
       * suit one member would have stopped checking the other two.
       *
       * ⚠️ 2aef3cd8 (r362) — THE OLD CLAIM WAS:
       *   expect(src, `${href} resolves no employment (2aef3cd8 emptied the screen)`).not.toContain('myEmployment');
       *   expect(src, `${href} reads no attendance`).not.toContain('attendanceForEmploymentRange');
       * with the note that the screen was blank below its title because the reporter asked for everything
       * under the row to be removed.
       *
       * ⚠️ 67268d83 (r367) ROUND ONE PUT THE DAY LIST BACK — the same reporter cleared the page in order to
       * have it rebuilt — so both absences are reversed to the presences they were before r362, and the
       * half of the rule that never changed (ungated row, no admin page guard, still an authenticated page)
       * is asserted alongside exactly as it was. The row's gating is what this file is FOR, and r367 does
       * not touch it: an employee must still reach their own record with no gate at all.
       */
      const href = '/attendance/my-records';
      const added = mine.children.find((c) => c.href === href)!;
      expect({ adminOnly: added.adminOnly, managerUp: added.managerUp }, `${href} stays ungated`).toEqual({
        adminOnly: undefined,
        managerUp: undefined,
      });
      const src = read(`app${href}/page.tsx`)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      expect(src, `${href} carries no page guard`).not.toMatch(/requireAdmin\(|scopedAdmin\(/);
      expect(src, `${href} resolves the caller's own employment (67268d83)`).toMatch(/myEmployment\(\s*s\s*\)/);
      expect(src, `${href} reads that employment's attendance, and only that employment's`).toMatch(
        /attendanceForEmploymentRange\(\s*s,\s*me\.employmentId/,
      );
      expect(src, `${href} is still an authenticated page`).toContain('await scopedSession()');
    }
    {
      // b833a077 (r362) — the INVERSE case for the row that left. My Travel is not a child of this node
      // any more, and its address is a bare redirect. Both halves are asserted positively so "remove the
      // row" can never quietly mean "leave a 404" or "leave the screen reachable by URL".
      const href = '/attendance/travel';
      expect(mine.children.find((c) => c.href === href), `${href} is no longer a row in My Attendance`).toBeUndefined();
      // Comments stripped: the page's header explains what was removed and so necessarily names what it
      // no longer does. Same idiom as the my-records block above, for the same reason.
      const src = read(`app${href}/page.tsx`)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      expect(src, `${href} forwards to Clock in/out`).toContain("redirect('/attendance/clock')");
      expect(src, `${href} resolves no employment — it reads nothing at all`).not.toContain('myEmployment');
      expect(src, `${href} no longer reads the travel service`).not.toContain('travel-request');
      expect(src, `${href} renders no form`).not.toContain('myRequestTravel');
    }
    const row = mine.children.find((c) => c.href === '/attendance/requests')!;
    expect({ adminOnly: row.adminOnly, managerUp: row.managerUp }).toEqual({
      adminOnly: undefined,
      managerUp: undefined,
    });
    expect(row.labelKey).toBe('attendanceRequest');
  });

  it('the page carries NO admin/manager page guard — it is the employee’s own request form', () => {
    // The inverse of the it.each above, and deliberate. requireAdmin/scopedAdmin on this page would lock
    // every employee out of filing their own request; the page resolves the session and the caller's own
    // employment exactly as /me and the clock portal do.
    const src = read('app/attendance/requests/page.tsx');
    expect(src).not.toMatch(/requireAdmin\(|scopedAdmin\(/);
    expect(src, 'resolves the caller’s own employment').toContain('myEmployment(s)');
  });
});

describe('0bb0e303 — a plain employee cannot read a colleague’s attendance', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  const hire = (name: string) =>
    hireEmployee(adminCtx(base), {
      person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 6)}@t.local` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  it('THE GUARD: the month summary returns only the caller’s own row for a plain employee', async () => {
    const mine = await hire('Clerk');
    const theirs = await hire('Colleague');

    // Real worked days for BOTH, so a leak returns rows rather than an empty list — an empty result
    // would pass this test for entirely the wrong reason.
    for (const e of [mine.employmentId, theirs.employmentId]) {
      await checkIn(adminCtx(base), { employmentId: e, date: '2026-03-02', time: '09:00:00' });
      await checkOut(adminCtx(base), { employmentId: e, date: '2026-03-02', time: '18:00:00' });
    }

    // An admin sees both — proving the fixture genuinely has a colleague's data present to leak.
    const asAdmin = await attendanceMonthSummary(adminCtx(base), { month: '2026-03', today: '2026-03-31' });
    expect(asAdmin.map((r) => r.employmentId).sort()).toEqual([mine.employmentId, theirs.employmentId].sort());

    const uid = await createAppUser(base.tenantId, mine.personId, 'employee');
    // r292 — a REAL snapshot: attendanceMonthSummary is module-gated now (core/module-gate.ts), and a
    // context with neither entitlements nor an exemption marker is the EntitlementsUnresolvedError
    // state. The guard below is about RLS scope, not entitlement, so the fixture states the tenant
    // holds Attendance and the assertion keeps testing what it names.
    const clerk = { tenantId: base.tenantId, userId: uid, personId: mine.personId, roles: ['employee'], entitlements: harnessSnapshot(base.tenantId) };

    // The same read, same month, no filter given — the clerk gets themselves and nobody else. This is
    // the property the menu cannot provide: it holds however the page is reached.
    const asClerk = await attendanceMonthSummary(clerk as never, { month: '2026-03', today: '2026-03-31' });
    expect(asClerk.map((r) => r.employmentId)).toEqual([mine.employmentId]);
  });
});
