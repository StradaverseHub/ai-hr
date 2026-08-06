/**
 * c002b3c3 — Personnel full-width layout + the "Search Employee" switcher.
 *
 * Three things are pinned, and the first is the one that actually matters:
 *
 *  1. THE REFUSAL. The switcher is a convenience layer over a list the page has already read under the
 *     session's scope. What must stay true is that it cannot become a way around that scope: a company-
 *     scoped admin's list must exclude the other company's people, AND — this is the part a UI change
 *     could quietly break — the id itself, typed straight into the address bar, must still resolve to
 *     nothing, because `employeeDetail` is what the profile route calls before it renders anything. If
 *     someone one day "helpfully" widens the switcher's read, assertion (1a) still passes and (1b) is
 *     what catches them; if someone removes the route's own resolve, (1b) fails on its own.
 *
 *  2. THE MATCHING RULE — partial Employee ID and partial name, best match first. Pure, so it is checked
 *     directly rather than inferred from rendered HTML.
 *
 *  3. THE LAYOUT + WIRING, as a static-source guard: both Personnel screens use the SAME container
 *     (`max-w-[100rem]`, the cap this codebase already uses for its wide screens) and both mount the
 *     switcher; the island stays a client island taking plain data only. That last one is not style
 *     policing — a function prop crossing from these server components returns a 500 on every request
 *     while tsc, this suite and `next build` all stay green (r123).
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { employeeDetail, listEmployees } from '../core/read';
import { matchEmployees, switcherHref } from '../app/admin/personnel/employee-search';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const LISTING = 'app/admin/personnel/page.tsx';
const PROFILE = 'app/admin/personnel/[employmentId]/page.tsx';
const ISLAND = 'app/admin/personnel/employee-switcher.tsx';

// ───────────────────────────── 2. the matching rule (pure) ─────────────────────────────

describe('c002b3c3 · Search Employee matches partial ID and partial name', () => {
  const people = [
    { employmentId: 'e1', name: 'Aisha Rahman', employeeCode: 'EMP-0008' },
    { employmentId: 'e2', name: 'Bala Krishnan', employeeCode: 'EMP-0081' },
    { employmentId: 'e3', name: 'Chan Wei Ming', employeeCode: 'CTR-0002' },
    { employmentId: 'e4', name: 'Rahman Bin Yusof', employeeCode: null },
  ];
  const ids = (q: string, cap?: number) => matchEmployees(people, q, cap).map((p) => p.employmentId);

  it('matches a PARTIAL employee id', () => {
    expect(ids('0008')).toEqual(['e1']);
    expect(ids('EMP-00')).toEqual(['e1', 'e2']);
    // The separator is noise, not data: an ID typed without its dash still finds the person.
    expect(ids('emp0081')).toEqual(['e2']);
  });

  it('matches a PARTIAL name, anywhere in it, case-insensitively', () => {
    expect(ids('rahman')).toEqual(['e4', 'e1']); // starts-with beats contains
    expect(ids('wei')).toEqual(['e3']);
    expect(ids('CHAN')).toEqual(['e3']);
  });

  it('ranks an exact employee id first, and keeps the caller order for ties', () => {
    expect(ids('EMP-0008')[0]).toBe('e1');
    expect(ids('a')).toEqual(['e1', 'e2', 'e3', 'e4']); // all match; input order preserved
  });

  it('shows nothing for an empty query, and caps the list', () => {
    expect(ids('')).toEqual([]);
    expect(ids('   ')).toEqual([]);
    expect(ids('a', 2)).toEqual(['e1', 'e2']);
  });

  it('an employee with no employee code is still findable by name and never crashes the code match', () => {
    expect(ids('yusof')).toEqual(['e4']);
    expect(ids('EMP')).not.toContain('e4');
  });

  it('selection is a URL, and the open tab rides along', () => {
    expect(switcherHref('abc')).toBe('/admin/personnel/abc');
    expect(switcherHref('abc', 'payroll')).toBe('/admin/personnel/abc?tab=payroll');
    expect(switcherHref('a b/c', 'careerMovement')).toBe('/admin/personnel/a%20b%2Fc?tab=careerMovement');
  });
});

// ───────────────────────────── 1. the refusal (against the database) ─────────────────────────────

let b: Base;
let companyB: string;
let deptB: string;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [c2] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  companyB = c2.id;
  const [d2] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: companyB, name: 'Beta Ops' })
    .returning({ id: schema.department.id });
  deptB = d2.id;
});
afterAll(closeAll);

/**
 * An hr_admin scoped to ONE company. RLS reads `ctx.grants` (db/client.ts serialises it into the
 * `app.grants` GUC); a context carrying only `roles` is widened to GROUP-WIDE, which is what the
 * harness's `adminCtx` is — so the grant has to be stated explicitly or every scope assertion below
 * would pass vacuously.
 */
async function scopedAdminCtx(companyId: string): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { ...adminCtx(b), userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}

const hire = (companyId: string, departmentId: string, fullName: string, employeeCode: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName, primaryEmail: `${employeeCode.toLowerCase()}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
    employeeCode,
  });

describe('c002b3c3 · the search is not a way around scope', () => {
  it('1a. the list the switcher searches EXCLUDES an out-of-scope employee', async () => {
    const mine = await hire(b.companyId, b.deptA, 'Aisha Rahman', 'EMP-9001');
    const theirs = await hire(companyB, deptB, 'Bala Krishnan', 'EMP-9002');
    const ctx = await scopedAdminCtx(b.companyId);

    const rows = await listEmployees(ctx);
    const seen = rows.map((r) => r.employmentId);
    expect(seen).toContain(mine.employmentId);
    expect(seen).not.toContain(theirs.employmentId);

    // …and the matcher cannot invent them: searching their exact Employee ID finds nobody.
    expect(matchEmployees(rows, 'EMP-9002')).toEqual([]);
    expect(matchEmployees(rows, 'Bala')).toEqual([]);
  });

  it('1b. the out-of-scope employmentId still resolves to NOTHING when reached directly', async () => {
    const theirs = await hire(companyB, deptB, 'Bala Krishnan', 'EMP-9002');
    const ctx = await scopedAdminCtx(b.companyId);

    // This is the exact call the profile route makes before it renders anything; null is what makes it
    // notFound(). Whether the id arrived via the switcher, a bookmark or the address bar is irrelevant.
    expect(await employeeDetail(ctx, theirs.employmentId)).toBeFalsy();

    // Control: the guard refuses the other company, not everything.
    const mine = await hire(b.companyId, b.deptA, 'Aisha Rahman', 'EMP-9001');
    expect((await employeeDetail(ctx, mine.employmentId))?.name).toBe('Aisha Rahman');
  });

  it('1c. a group-wide admin sees both — so 1a/1b are the scope, not an empty database', async () => {
    const mine = await hire(b.companyId, b.deptA, 'Aisha Rahman', 'EMP-9001');
    const theirs = await hire(companyB, deptB, 'Bala Krishnan', 'EMP-9002');
    const rows = await listEmployees(adminCtx(b));
    const seen = rows.map((r) => r.employmentId);
    expect(seen).toContain(mine.employmentId);
    expect(seen).toContain(theirs.employmentId);
    expect(matchEmployees(rows, 'EMP-9002').map((r) => r.employmentId)).toEqual([theirs.employmentId]);
  });
});

// ───────────────────────────── 3. layout + wiring (static source) ─────────────────────────────

describe('c002b3c3 · the module is full width, once, in one place', () => {
  it('both Personnel screens use the SAME container cap', () => {
    for (const f of [LISTING, PROFILE]) {
      const src = read(f);
      expect(src, `${f} should use the shared wide container`).toContain('mx-auto max-w-[100rem]');
    }
    // The two narrow caps this item was raised about are gone from these screens' root containers.
    expect(read(LISTING)).not.toContain('mx-auto max-w-5xl');
    expect(read(PROFILE)).not.toContain('mx-auto max-w-4xl');
  });

  it('the value is the one the codebase already uses for wide screens (not a fourth number)', () => {
    // If this ever fails, the fix is to converge — not to add another cap.
    expect(read('app/payroll/transactions/fixed/page.tsx')).toContain('mx-auto max-w-[100rem]');
  });
});

describe('c002b3c3 · the switcher is mounted on both screens and stays an RSC-safe island', () => {
  it('the listing mounts it beside the Filter button, without replacing the filter', () => {
    const src = read(LISTING);
    expect(src).toContain('<EmployeeSwitcher');
    expect(src).toContain("from './employee-switcher'");
    // The filter panel is a different control answering a different question; both stay.
    expect(src).toContain('<FilterPanel');
    expect(src).toContain('dataTour="people-search"');
    // It searches the whole reachable set, narrowed by the active company context — not the page.
    expect(src).toContain('listEmployees(session, scopeIds)');
  });

  it('the profile mounts it and keeps the open tab across the jump', () => {
    const src = read(PROFILE);
    expect(src).toContain('<EmployeeSwitcher');
    expect(src).toContain("from '../employee-switcher'");
    expect(src).toContain('tab={tab ?? null}');
    // NO NEW READ: the switcher list is the already-loaded listEmployees set, narrowed by scope.
    expect(src).toContain('scopeIds.includes(e.companyId)');
    // …and the route's own guard is untouched: this is what refuses an out-of-scope id.
    expect(src).toContain('const emp = await employeeDetail(s, employmentId);');
    expect(src).toContain('if (!emp) notFound();');
  });

  it('a MALFORMED employmentId 404s instead of 500ing, and the shape check never replaces the scope check', () => {
    const src = read(PROFILE);
    // Reproduced on a dev server: `/admin/personnel/not-a-uuid` used to reach the query verbatim and
    // return a Postgres "invalid input syntax for type uuid" 500. A page whose new search box exists to
    // hand this route ids should answer "no such employee" for every id it cannot resolve, not crash
    // for one shape of them.
    expect(src).toContain('if (!UUID_RE.test(employmentId)) notFound();');
    // ORDER MATTERS: the shape check is a pre-filter, not the guard. `employeeDetail` must still run
    // for every well-formed id — that is what refuses one belonging to another company.
    expect(src.indexOf('UUID_RE.test(employmentId)')).toBeLessThan(
      src.indexOf('const emp = await employeeDetail(s, employmentId);'),
    );
  });

  it('the island is a client island whose props are plain data only', () => {
    const src = read(ISLAND);
    expect(src.startsWith("'use client'")).toBe(true);
    // r123: a function crossing the server→client boundary is a 500 that every green check misses.
    // The switcher navigates by URL instead, so there is no callback prop to pass.
    expect(src).not.toMatch(/on[A-Z]\w*\??:\s*\(/);
    expect(src).toContain('router.push(switcherHref(');
  });

  it('every user-visible string is a key, and the key exists in ALL six catalogs', () => {
    const src = read(ISLAND);
    const keys = [...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const cat = JSON.parse(read(`messages/${loc}.json`));
      for (const k of keys) {
        const v = cat?.people?.switcher?.[k];
        expect(typeof v, `messages/${loc}.json people.switcher.${k}`).toBe('string');
        expect(v, `messages/${loc}.json people.switcher.${k}`).not.toBe('');
      }
    }
  });
});
