/**
 * r423 (83c0d3c8) — WHAT MIGRATION 0517 DOES TO WHAT IS ALREADY SAVED, and the RLS it creates.
 *
 * The plan told the reporter, under "What happens to what is already saved":
 *   1. every existing location's companies = the companies of the employees assigned to it today, plus the
 *      company of the work location it is attached to; a location nobody is assigned to (and attached to
 *      nothing) is given EVERY company, so it stays selectable exactly as today;
 *   2. every employee with at least one assigned location gets the switch ON, whatever the old box said;
 *   3. employees with no assigned location get the switch OFF (left as they were);
 *   4. an employee whose old box was ticked but who has no location stays ON (and is still refused).
 * So the file is READ OFF DISK and its two DO blocks are executed against rows shaped like those cases (the
 * schedule-group-split-migration idiom): if somebody edits the SQL, this test runs the edited SQL. The DDL is
 * not re-run — `migrateTestDb` already applied the whole journal, 0517 included.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { createCompany, createDepartment } from '../core/admin';
import { createLocation } from '../core/location';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const MIGRATION = readFileSync(root + 'db/migrations/0517_clocking_location_companies.sql', 'utf8');
const dataBlocks = (): string[] =>
  MIGRATION.split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DO $$'));

let b: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

const hire = async (companyId: string, departmentId: string, name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${randomUUID()}@test.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
/** A pre-0517 clocking location: written straight to the table, with NO company rows — as production has. */
const legacySite = async (name: string, locationId: string | null = null) => {
  const [row] = await owner.db
    .insert(schema.clockingLocation)
    .values({ tenantId: b.tenantId, name, lat: 3.1, lng: 101.6, radiusM: 100, locationId })
    .returning({ id: schema.clockingLocation.id });
  return row.id;
};
const assignRaw = (employmentId: string, clockingLocationId: string) =>
  owner.db.insert(schema.employeeClockingLocation).values({ tenantId: b.tenantId, employmentId, clockingLocationId });
const companiesOf = async (clockingLocationId: string) =>
  (
    await owner.db
      .select({ c: schema.clockingLocationCompany.companyId })
      .from(schema.clockingLocationCompany)
      .where(eq(schema.clockingLocationCompany.clockingLocationId, clockingLocationId))
  )
    .map((r) => r.c)
    .sort();
const switchOf = async (employmentId: string) =>
  (await owner.db.select({ on: schema.employment.geofencingEnabled }).from(schema.employment).where(eq(schema.employment.id, employmentId)))[0].on;

describe('r423 — 0517’s two data blocks, run against the shapes the plan named', () => {
  it('the file carries exactly the two DO blocks this test runs (non-vacuity of the harness)', () => {
    expect(dataBlocks()).toHaveLength(2);
    expect(dataBlocks()[0]).toContain('INSERT INTO clocking_location_company');
    expect(dataBlocks()[1]).toContain('UPDATE employment e SET geofencing_enabled = true');
  });

  it('companies backfill: used-by ∪ linked work location; a site with neither gets EVERY company; archived included; idempotent', async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'Backfill B' });
    const { id: coC } = await createCompany(a, { legalName: 'Backfill C' });
    const deptB = await createDepartment(a, { companyId: coB, name: 'B' });
    const { id: locC } = await createLocation(a, { companyId: coC, code: 'CLOC', name: 'C site' });

    const usedByAB = await legacySite('Used by A and B');
    const linkedToC = await legacySite('Linked to C, used by A', locC);
    const unused = await legacySite('Unused');
    const archived = await legacySite('Archived, used by B');
    await owner.db.update(schema.clockingLocation).set({ archivedAt: new Date() }).where(eq(schema.clockingLocation.id, archived));

    const eA = await hire(b.companyId, b.deptA, 'A one');
    const eA2 = await hire(b.companyId, b.deptA, 'A two');
    const eB = await hire(coB, deptB.id, 'B one');
    await assignRaw(eA.employmentId, usedByAB);
    await assignRaw(eA2.employmentId, usedByAB);
    await assignRaw(eB.employmentId, usedByAB);
    await assignRaw(eA.employmentId, linkedToC);
    await assignRaw(eB.employmentId, archived);

    const [backfill] = dataBlocks();
    await owner.db.execute(sql.raw(backfill));

    expect(await companiesOf(usedByAB), 'the distinct companies of the assigned employees').toEqual([b.companyId, coB].sort());
    expect(await companiesOf(linkedToC), 'plus the linked work location’s company').toEqual([b.companyId, coC].sort());
    expect(await companiesOf(unused), 'nobody assigned, nothing linked → every company of the tenant').toEqual([b.companyId, coB, coC].sort());
    expect(await companiesOf(archived), 'archived locations are backfilled too').toEqual([coB]);

    // Every existing assignment stays usable: its employee's company is on the location.
    const rows = (await owner.db.execute(sql`
      select count(*)::int as n from employee_clocking_location ecl
      join employment e on e.id = ecl.employment_id
      where not exists (select 1 from clocking_location_company c
                        where c.clocking_location_id = ecl.clocking_location_id and c.company_id = e.company_id)`)) as unknown as { n: number }[];
    expect(rows[0].n, 'no assignment left unusable by the backfill').toBe(0);

    // Re-running changes nothing (ON CONFLICT DO NOTHING; "every company" only for sites still holding none).
    const before = (await owner.db.select().from(schema.clockingLocationCompany)).length;
    await owner.db.execute(sql.raw(backfill));
    expect((await owner.db.select().from(schema.clockingLocationCompany)).length).toBe(before);
  });

  it('the switch: assigned → ON whatever the old box said; unassigned stays as it was (OFF stays OFF, ticked stays ON)', async () => {
    const site = await legacySite('Switch site');
    const assignedOff = await hire(b.companyId, b.deptA, 'Assigned, box off');
    const assignedOn = await hire(b.companyId, b.deptA, 'Assigned, box on');
    const unassignedOff = await hire(b.companyId, b.deptA, 'Nothing, box off');
    const unassignedOn = await hire(b.companyId, b.deptA, 'Nothing, box on');
    await assignRaw(assignedOff.employmentId, site);
    await assignRaw(assignedOn.employmentId, site);
    for (const e of [assignedOn, unassignedOn]) {
      await owner.db.update(schema.employment).set({ geofencingEnabled: true, geofenceRadiusM: 250 }).where(eq(schema.employment.id, e.employmentId));
    }

    const [, flip] = dataBlocks();
    await owner.db.execute(sql.raw(flip));

    expect(await switchOf(assignedOff.employmentId), 'plan point 2: assigned → ON').toBe(true);
    expect(await switchOf(assignedOn.employmentId)).toBe(true);
    expect(await switchOf(unassignedOff.employmentId), 'plan point 3: no location → OFF').toBe(false);
    expect(await switchOf(unassignedOn.employmentId), 'plan point 4: ticked with no location stays ON').toBe(true);
    // Plan point 5: the override is kept, not destroyed (and never read again — see clocking-geofence).
    const [kept] = await owner.db.select({ r: schema.employment.geofenceRadiusM }).from(schema.employment).where(eq(schema.employment.id, assignedOn.employmentId));
    expect(kept.r).toBe(250);
  });

  it('the three capture columns accept NULL together (a switch-OFF clocking), and their CHECKs still hold when present', async () => {
    const cols = (await owner.db.execute(sql`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'attendance_clock_capture' and column_name in ('clocking_location_id','distance_m','radius_m')
      order by column_name`)) as unknown as { column_name: string; is_nullable: string }[];
    expect(cols.map((c) => [c.column_name, c.is_nullable])).toEqual([
      ['clocking_location_id', 'YES'],
      ['distance_m', 'YES'],
      ['radius_m', 'YES'],
    ]);
  });
});

describe('r423 — clocking_location_company RLS (0517)', () => {
  async function adminFor(companyId: string | null): Promise<SessionContext> {
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
    return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
  }
  const read = (ctx: SessionContext) =>
    withTenant(ctx, (tx) => tx.select({ companyId: schema.clockingLocationCompany.companyId }).from(schema.clockingLocationCompany));

  it('a company admin reads only their company’s rows; an employee reads their own company’s; nobody but a group admin writes', async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'RLS B' });
    const site = await legacySite('RLS site');
    await owner.db.insert(schema.clockingLocationCompany).values([
      { tenantId: b.tenantId, clockingLocationId: site, companyId: b.companyId },
      { tenantId: b.tenantId, clockingLocationId: site, companyId: coB },
    ]);

    const companyAdmin = await adminFor(b.companyId);
    expect((await read(companyAdmin)).map((r) => r.companyId), 'only the company they administer').toEqual([b.companyId]);

    const e = await hire(b.companyId, b.deptA, 'RLS employee');
    const userId = await createAppUser(b.tenantId, e.personId, 'employee');
    const self: SessionContext = { tenantId: b.tenantId, userId, personId: e.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    expect((await read(self)).map((r) => r.companyId), 'an employee sees their own company’s row (their Clock screen needs it)').toEqual([b.companyId]);

    const group = await adminFor(null);
    expect((await read(group)).map((r) => r.companyId).sort()).toEqual([b.companyId, coB].sort());

    // Writes: a company admin's INSERT is refused by the database; their DELETE touches no row.
    // (Their OWN company, on a fresh site, so the only thing that can refuse it is the policy — not the FK
    // and not the unique index.)
    const fresh = await legacySite('RLS fresh');
    const insert = await withTenant(companyAdmin, (tx) =>
      tx.insert(schema.clockingLocationCompany).values({ tenantId: b.tenantId, clockingLocationId: fresh, companyId: b.companyId }),
    ).then(() => null, (x: unknown) => x);
    expect(insert, 'company admin INSERT refused').toBeTruthy();
    const cause = (insert as { cause?: { code?: string } }).cause;
    expect(cause?.code ?? (insert as { code?: string }).code, 'refused by RLS (42501)').toBe('42501');
    expect(await companiesOf(fresh)).toEqual([]);
    await withTenant(companyAdmin, (tx) =>
      tx.delete(schema.clockingLocationCompany).where(and(eq(schema.clockingLocationCompany.clockingLocationId, site), eq(schema.clockingLocationCompany.companyId, b.companyId))),
    );
    expect(await companiesOf(site), 'the DELETE policy filtered the row out').toEqual([b.companyId, coB].sort());
  });
});
