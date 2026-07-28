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
  // Derived from the pack rather than hardcoded: a row added to the Admin node later is covered
  // automatically. A list copied by hand here would silently stop covering the thing it names.
  const adminNode = attendancePack.navNodes!.find((n) => n.group === 'admin')!;
  const adminRoutes = adminNode.children.map((c) => c.href);

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

  it('the sidebar mounts the admin node inside the adminOnly group, not the day-to-day one', () => {
    const sidebar = read('components/sidebar.tsx');
    const adminGroupStart = sidebar.indexOf("labelKey: 'admin',");
    expect(adminGroupStart, 'admin group exists').toBeGreaterThan(-1);
    expect(sidebar.indexOf('ATTENDANCE_ADMIN_NODE', adminGroupStart), 'admin node is in the admin group').toBeGreaterThan(
      adminGroupStart,
    );
    // …and My Attendance is NOT, or the split achieved nothing.
    expect(sidebar.indexOf('MY_ATTENDANCE_NODE')).toBeLessThan(adminGroupStart);
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
