/**
 * 5054 — the point-read marker (0691) now also answers for a payroll partner who is not a company administrator,
 * the case the payroll processing job's units left on the full predicate. Proved on the real policy: with the marker
 * on, a partner's employment read returns exactly the rows the original predicate returns (with the marker off),
 * for the partner's own company and for one it has no grant on, while the visible-employment array is never built;
 * with the marker off it still is (non-vacuity). An unrecognised marker keeps the original predicate.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

type PlanNode = { 'Actual Loops'?: number; Output?: string[]; Plans?: PlanNode[] };
const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];
/** How many times each node that builds the visible-employment array ran. */
async function arrayLoops(tx: Tx, query: string) {
  const [row] = await tx.execute<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(sql.raw(`explain (analyze, verbose, costs off, timing off, format json) ${query}`));
  return nodes(row['QUERY PLAN'][0].Plan).filter((n) => (n.Output ?? []).some((o) => o.includes('app.visible_employment_ids()'))).map((n) => n['Actual Loops'] ?? 0);
}

describe('payroll partner point read', () => {
  let b: Base;
  let partner: SessionContext;
  let otherCompany: string;
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Fictional Other Employer' }).returning({ id: schema.company.id });
    otherCompany = other.id;
    for (const [i, companyId] of [b.companyId, b.companyId, otherCompany].entries()) {
      const personId = randomUUID();
      await owner.db.insert(schema.person).values({ id: personId, tenantId: b.tenantId, fullName: `Fictional ${i}`, primaryEmail: `${personId}@example.invalid` });
      await owner.db.insert(schema.employment).values({ tenantId: b.tenantId, personId, companyId, hiredOn: '2020-01-01' });
    }
    const userId = await createAppUser(b.tenantId, null, 'hr_admin');
    await owner.db.update(schema.roleAssignment).set({ role: 'payroll_partner', companyId: b.companyId }).where(eq(schema.roleAssignment.appUserId, userId));
    partner = { tenantId: b.tenantId, userId, grants: [{ role: 'payroll_partner', companyId: b.companyId }] };
  });
  afterAll(closeAll);

  const read = (ctx: SessionContext, marker: string | null, companyId: string) => withTenant(ctx, async (tx) => {
    if (marker !== null) await tx.execute(sql`select set_config('app.bank_import_point_read',${marker},true)`);
    const ids = (await tx.select({ id: schema.employment.id }).from(schema.employment).where(eq(schema.employment.companyId, companyId)).orderBy(schema.employment.id)).map((r) => r.id);
    const loops = await arrayLoops(tx, `select id from employment where company_id='${companyId}'`);
    return { ids, loops };
  });

  it('returns the original rows without building the visible-employment array', async () => {
    const original = await read(partner, null, b.companyId);
    expect(original.ids.length).toBeGreaterThanOrEqual(2);
    // Non-vacuity: without the marker the partner's read builds the array.
    expect(original.loops.some((n) => n > 0)).toBe(true);
    const marked = await read(partner, 'on', b.companyId);
    expect(marked.ids).toEqual(original.ids);
    expect(marked.loops.length).toBeGreaterThan(0);
    expect(marked.loops.every((n) => n === 0)).toBe(true);
    // An unrecognised marker is the original predicate.
    const forged = await read(partner, 'garbage', b.companyId);
    expect(forged.ids).toEqual(original.ids);
    expect(forged.loops.some((n) => n > 0)).toBe(true);
  });

  it('adds no authority: a company the partner has no grant on stays hidden, and an administrator is unchanged', async () => {
    expect((await read(partner, null, otherCompany)).ids).toEqual([]);
    expect((await read(partner, 'on', otherCompany)).ids).toEqual([]);
    const admin = adminCtx(b);
    for (const companyId of [b.companyId, otherCompany]) expect((await read(admin, 'on', companyId)).ids).toEqual((await read(admin, null, companyId)).ids);
  });
});
