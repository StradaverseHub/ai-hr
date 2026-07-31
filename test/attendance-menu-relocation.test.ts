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
    expect(adminRoutes).toEqual([
      '/admin/holidays',
      '/admin/attendance',
      '/admin/attendance-policy',
      '/admin/attendance-allowance',
      '/admin/locations',
      '/admin/toil',
    ]);
  });

  it.each([
    '/admin/holidays',
    '/admin/attendance',
    '/admin/attendance-policy',
    '/admin/attendance-allowance',
    '/admin/locations',
    '/admin/toil',
  ])('%s calls a server-side admin guard in its own page body', (route) => {
    const src = read(`app${route}/page.tsx`);
    // Either helper is fine — both resolve the session server-side and refuse a non-administrator.
    // What must not happen is a page relying on the sidebar having hidden its link.
    expect(src, `${route} must call requireAdmin() or scopedAdmin()`).toMatch(/requireAdmin\(|scopedAdmin\(/);
  });

  it('THE INVERTED GUARD: the merged node sits in the day-to-day group, so every admin row carries its OWN gate', () => {
    // 0bb0e303 asserted the opposite placement — the admin node INSIDE the adminOnly group. a324a4b3
    // rev2 merged that node into the single Attendance menu, which must live in the ungated day-to-day
    // group or Records disappears for plain employees and Roster/Import for non-admin managers.
    //
    // The assertion is inverted rather than deleted because the PROTECTION it stood for is unchanged:
    // an administrative screen must not be reachable by a non-administrator. What used to supply that
    // in the rail was the group gate; now it is the per-row adminOnly flag, so that is what is pinned
    // here — together with the it.each above, which proves the rail was never the real protection.
    const sidebar = read('components/sidebar.tsx');
    const adminGroupStart = sidebar.indexOf("labelKey: 'admin',");
    expect(adminGroupStart, 'admin group exists').toBeGreaterThan(-1);
    expect(sidebar, 'the admin-only attendance node is gone').not.toContain('ATTENDANCE_ADMIN_NODE');
    // Both attendance nodes mount ABOVE the Manage and Admin headings (the screenshot's upper section).
    const manageGroupStart = sidebar.indexOf("labelKey: 'manage',");
    expect(manageGroupStart, 'manage group exists').toBeGreaterThan(-1);
    // Matched as a whole line (`^\s*NAME,$`) so the mount point is found rather than the declaration,
    // and so MY_ATTENDANCE_NODE cannot satisfy the ATTENDANCE_NODE search by being a superstring.
    for (const konst of ['MY_ATTENDANCE_NODE', 'ATTENDANCE_NODE']) {
      const at = sidebar.search(new RegExp(`^[ \\t]*${konst},$`, 'm'));
      expect(at, `${konst} is mounted in a group`).toBeGreaterThan(-1);
      expect(at, `${konst} sits above the MANAGE heading`).toBeLessThan(manageGroupStart);
    }
    // Every one of the six relocated screens is still admin-gated, now per row rather than per group.
    const merged = attendancePack.navNodes!.find((n) => n.labelKey === 'attendance')!;
    for (const route of adminRoutes) {
      expect(merged.children.find((c) => c.href === route)?.adminOnly, `${route} adminOnly`).toBe(true);
    }
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
