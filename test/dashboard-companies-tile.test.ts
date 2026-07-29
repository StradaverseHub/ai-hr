/**
 * Dashboard → Companies tile: a company COUNT, scoped to what the viewer can administer (11355c08).
 *
 * WHAT THE TILE USED TO BE. `dashboardStats` computed it as
 *     scopeIds ? scopeIds.length : count(*) from company
 * which is two different wrong answers depending on the company switcher:
 *
 *   • With a selection it reported the SWITCHER SELECTION SIZE. One company ticked out of eight and the
 *     tile read "1" — while app/page.tsx links that same tile to /admin/organization, which ignores the
 *     switcher entirely (0f1802bf) and listed all eight. A figure that disagrees with its own
 *     destination is what sent a whole round chasing a bug on the Organization screen.
 *   • With NO selection it fell through to count(*) over `company` — so the person who could reach
 *     NOTHING was the one shown the tenant-wide total. That is the disclosure feedback ab77dc1f closed
 *     on the page header, still open on the tile beneath it.
 *
 * WHAT IT IS NOW. The count of companies the signed-in person can administer: the database's own
 * `app.is_admin_for` (migration 0016) — the same predicate `listCompanies({ adminOnly })` applies for the
 * Organization card (r77 913202b), and the same one the company table's WITH CHECK uses. No fallback: an
 * empty reachable set is legitimately zero.
 *
 * THE TWO CASES THAT MATTER, and why NEITHER alone is enough:
 *
 *   1. GROUP-WIDE admin with the switcher narrowed to ONE company → the tile must read every company
 *      (6 here), not 1. This catches the `scopeIds.length` fault. Alone it also passes for a tile that
 *      is still count(*), because a group admin reaches everything.
 *   2. A viewer who can administer NO company → the tile must read 0, not 6. This is the case that
 *      proves the disclosure is closed, and it is the ONLY one that fails against count(*). Without it
 *      the suite goes green for the wrong reason.
 *
 * A third case (company-scoped admin, empty switcher) pins the middle of the range: subtree semantics,
 * which is the answer that is neither "all" nor "none".
 *
 * Each case also asserts the tile equals `listCompanies(ctx, { includeArchived: true, adminOnly: true })`
 * — the exact read the Organization card makes. dashboardStats counts with the same predicate rather
 * than calling listCompanies (that would nest a second transaction inside withTenant), so this equality
 * is what stops the two drifting apart.
 *
 * SCOPE NOTE: every OTHER figure on the dashboard is switcher-scoped on purpose and stays that way, so
 * `headcount` is asserted alongside in case 1 — a "fix" that unscoped the whole read would break it.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { dashboardStats, listCompanies } from '../core/read';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
/** name → id for every company the fixture seeds. */
const ids: Record<string, string> = {};

async function addCompany(name: string, parentId: string | null = null): Promise<string> {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: base.tenantId, legalName: name, parentCompanyId: parentId })
    .returning({ id: schema.company.id });
  ids[name] = c.id;
  return c.id;
}

/** A REAL session: the role_assignment row exists AND the grant is on the session, so the DB's
 *  app.current_grants() (which reads the app.grants GUC) and the tenant's rows agree. */
async function ctxFor(role: 'hr_admin' | 'manager', companyId: string | null): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: base.tenantId, appUserId: u.id, companyId, role });
  return { ...adminCtx(base), userId: u.id, roles: [role], grants: [{ role, companyId }] };
}

/** The number the Organization screen's Companies card shows — the tile's own destination. */
async function organizationCardCount(s: SessionContext): Promise<number> {
  return (await listCompanies(s, { includeArchived: true, adminOnly: true })).length;
}

describe('dashboard Companies tile: a reachable-company count, never the switcher and never count(*)', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    for (const k of Object.keys(ids)) delete ids[k];
    ids['Acme Sdn Bhd'] = base.companyId;
    // Six companies in the tenant: a parent/subsidiary pair, three unrelated, one archived. The
    // archived one is counted, because the Organization card lists it (includeArchived: true).
    await addCompany('Beta Sdn Bhd');
    await addCompany('Beta East Sdn Bhd', ids['Beta Sdn Bhd']);
    await addCompany('Gamma Sdn Bhd');
    await addCompany('Delta Sdn Bhd');
    const zeta = await addCompany('Zeta Sdn Bhd');
    await owner.db.update(schema.company).set({ archivedAt: new Date() }).where(eq(schema.company.id, zeta));
  });
  afterAll(async () => {
    await closeAll();
  });

  it('CASE 1 — group-wide admin, switcher pinned to ONE company: the tile counts ALL six, not the selection', async () => {
    const s = await ctxFor('hr_admin', null);

    const stats = await dashboardStats(s, [base.companyId]);

    // The fault this catches: `scopeIds.length` would be 1 — the number of ticks in the switcher.
    expect(stats.companies).toBe(6);
    expect(stats.companies).not.toBe(1);
    // …and it equals what /admin/organization, the tile's own link target, lists.
    expect(stats.companies).toBe(await organizationCardCount(s));

    // THE SCOPE GUARD: only this tile changed. Headcount is still switcher-scoped, so seeding an
    // employee OUTSIDE the selected company must not move it.
    const deptOut = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: ids['Gamma Sdn Bhd'], name: 'G' })
      .returning({ id: schema.department.id });
    await hireEmployee(s, {
      person: { fullName: 'Gamma One', primaryEmail: `g1-${randomUUID()}@x.test` },
      companyId: ids['Gamma Sdn Bhd'],
      departmentId: deptOut[0].id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const after = await dashboardStats(s, [base.companyId]);
    expect(after.headcount, 'headcount stays scoped to the switcher selection').toBe(0);
    expect(after.companies, 'the companies tile does not').toBe(6);
  });

  it('CASE 2 — a viewer who can administer NO company sees 0, not the tenant-wide total', async () => {
    // A manager holds no admin grant, so app.is_admin_for is false for every company. This is the
    // person the old count(*) fallback told exactly how many companies the group has.
    const s = await ctxFor('manager', null);

    // Empty switcher selection is the branch that used to reach count(*).
    const stats = await dashboardStats(s, []);

    expect(stats.companies).toBe(0);
    expect(stats.companies, 'must not disclose the tenant-wide total (ab77dc1f)').not.toBe(6);
    expect(stats.companies).toBe(await organizationCardCount(s));

    // `undefined` (no selection at all) is the same branch and must answer the same.
    expect((await dashboardStats(s)).companies).toBe(0);
  });

  it('CASE 3 — company-scoped admin sees their company and its subtree, with the switcher empty', async () => {
    const s = await ctxFor('hr_admin', ids['Beta Sdn Bhd']);

    const stats = await dashboardStats(s, []);

    // Beta + Beta East. Not 6 (count(*)), not 0, not 1 (the grant is one company but covers a subtree).
    expect(stats.companies).toBe(2);
    expect(stats.companies).toBe(await organizationCardCount(s));
  });
});
