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
import { adminCtx, closeAll, createAppUser, migrateTestDb, resetDb, seedBase, type Base } from './harness';
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
    expect(adminRoutes).toEqual([
      '/admin/attendance',
      '/admin/attendance-policy',
      '/admin/attendance-policy/schedule',
      '/admin/attendance/schedule-assignment',
      '/admin/attendance-allowance',
      '/admin/locations',
      '/admin/toil',
    ]);
  });

  // 4509d2b8 — /admin/holidays was the FIRST entry in this list and has been MOVED, not dropped: the
  // identical requireAdmin-in-its-own-page-body case now lives in
  // test/holidays-system-settings-relocation.test.ts, beside the rest of that screen's new-home guards.
  // Losing it entirely would have been the exact failure this file exists to prevent — a screen whose
  // only remaining protection is that a menu happens not to show it.
  it.each([
    '/admin/attendance',
    '/admin/attendance-policy',
    '/admin/attendance-policy/schedule',
    '/admin/attendance/schedule-assignment',
    '/admin/attendance-allowance',
    '/admin/locations',
    '/admin/toil',
  ])('%s calls a server-side admin guard in its own page body', (route) => {
    const src = read(`app${route}/page.tsx`);
    // Either helper is fine — both resolve the session server-side and refuse a non-administrator.
    // What must not happen is a page relying on the sidebar having hidden its link.
    expect(src, `${route} must call requireAdmin() or scopedAdmin()`).toMatch(/requireAdmin\(|scopedAdmin\(/);
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
    for (const gone of ['/attendance', '/roster', '/attendance/import']) {
      expect(merged.children.some((c) => c.href === gone), `${gone} must NOT be in the admin node`).toBe(false);
    }

    // …and they are still reachable somewhere ungated.
    const mine = attendancePack.navNodes!.find((n) => n.labelKey === 'myAttendance')!;
    expect(mine.children.some((c) => c.href === '/attendance'), 'Records is self-service').toBe(true);
    expect(mine.children.find((c) => c.href === '/attendance')?.adminOnly).toBeUndefined();
    const manageLinks = (attendancePack.navLinks ?? []).filter((l) => l.group === 'manage');
    expect(manageLinks.map((l) => l.href).sort()).toEqual(['/attendance/import', '/roster']);
    expect(manageLinks.every((l) => l.managerUp === true), 'both stay managerUp').toBe(true);
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
      '/attendance',
      '/attendance/requests',
      // 1e9145d4 — Plan OT joined the node as the fourth self-service row when overtime moved off the
      // Attendance Request screen. Ungated for the same reason, and pinned by its own describe below.
      '/attendance/plan-ot',
    ]);
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
    const clerk = { tenantId: base.tenantId, userId: uid, personId: mine.personId, roles: ['employee'] };

    // The same read, same month, no filter given — the clerk gets themselves and nobody else. This is
    // the property the menu cannot provide: it holds however the page is reached.
    const asClerk = await attendanceMonthSummary(clerk as never, { month: '2026-03', today: '2026-03-31' });
    expect(asClerk.map((r) => r.employmentId)).toEqual([mine.employmentId]);
  });
});
