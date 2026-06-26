/**
 * Holiday grouping — group CRUD, integrity, RLS, and the DomainEvent substrate.
 *
 * A holiday group is a NAMED bundle of states, assigned per employee over the EXISTING state engine.
 * These tests cover the service contract: create/list/update/delete, case-insensitive name uniqueness,
 * the delete-in-use guard + the ON DELETE SET NULL FK backstop, tenant isolation, the non-admin RLS write
 * rejection (run as a real ai_hr_app non-admin, NOT owner.db which bypasses RLS), and a DomainEvent
 * assertion for each write.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  DuplicateError,
  InUseError,
  createHolidayGroup,
  deleteHolidayGroup,
  listHolidayGroups,
  updateHolidayGroup,
} from '../core/admin';
import { hireEmployee, setEmploymentHolidayCalendar } from '../core/org';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { withTenant, type SessionContext } from '../db/client';

let b: Base;

const hire = async () => {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'HG', primaryEmail: `hg_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('holiday-group CRUD + integrity', () => {
  it('creates, lists, updates and deletes a group, appending a DomainEvent for each write', async () => {
    const created = await createHolidayGroup(adminCtx(b), { name: 'East Malaysia', states: ['Sabah', 'Sarawak'] });
    let groups = await listHolidayGroups(adminCtx(b));
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('East Malaysia');
    expect(groups[0].states).toEqual(['Sabah', 'Sarawak']);

    await updateHolidayGroup(adminCtx(b), { id: created.id, name: 'East MY', states: ['Sabah', 'Sarawak', 'Labuan'] });
    groups = await listHolidayGroups(adminCtx(b));
    expect(groups[0].name).toBe('East MY');
    expect(groups[0].states).toEqual(['Sabah', 'Sarawak', 'Labuan']);

    await deleteHolidayGroup(adminCtx(b), { id: created.id });
    expect(await listHolidayGroups(adminCtx(b))).toHaveLength(0);

    expect(await eventTypesFor(b.tenantId, created.id)).toEqual(
      expect.arrayContaining(['holiday-group.created', 'holiday-group.updated', 'holiday-group.deleted']),
    );
  });

  it('rejects an empty state list and an unknown state', async () => {
    await expect(createHolidayGroup(adminCtx(b), { name: 'Empty', states: [] })).rejects.toThrow();
    await expect(createHolidayGroup(adminCtx(b), { name: 'Bad', states: ['Atlantis'] })).rejects.toThrow();
  });

  it('enforces case-insensitive name uniqueness per tenant → DuplicateError', async () => {
    await createHolidayGroup(adminCtx(b), { name: 'Peninsular', states: ['Selangor'] });
    await expect(
      createHolidayGroup(adminCtx(b), { name: 'peninsular', states: ['Johor'] }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('blocks delete while an employment references the group → InUseError', async () => {
    const g = await createHolidayGroup(adminCtx(b), { name: 'East', states: ['Sabah', 'Sarawak'] });
    const emp = await hire();
    await setEmploymentHolidayCalendar(adminCtx(b), { employmentId: emp, selection: { kind: 'group', groupId: g.id } });
    await expect(deleteHolidayGroup(adminCtx(b), { id: g.id })).rejects.toBeInstanceOf(InUseError);
    // The group is still there (the guard rolled back).
    expect(await listHolidayGroups(adminCtx(b))).toHaveLength(1);
  });

  it('ON DELETE SET NULL backstop: a forced owner.db delete of a referenced group nulls the FK, never orphans', async () => {
    const g = await createHolidayGroup(adminCtx(b), { name: 'East', states: ['Sabah'] });
    const emp = await hire();
    await setEmploymentHolidayCalendar(adminCtx(b), { employmentId: emp, selection: { kind: 'group', groupId: g.id } });
    // Force a delete via the owner (bypasses the in-tx guard) — the FK must SET NULL, not error/orphan.
    await owner.db.delete(schema.holidayGroup).where(eq(schema.holidayGroup.id, g.id));
    const [row] = await owner.db
      .select({ hg: schema.employment.holidayGroupId })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp));
    expect(row.hg).toBeNull();
  });
});

describe('holiday-group tenant isolation + RLS', () => {
  it("does not list another tenant's groups", async () => {
    await createHolidayGroup(adminCtx(b), { name: 'Tenant A group', states: ['Sabah'] });
    const b2 = await seedBase();
    expect(await listHolidayGroups(adminCtx(b2))).toHaveLength(0);
  });

  it('rejects a non-admin write under RLS (run as a real ai_hr_app non-admin, NOT owner.db)', async () => {
    // A real employee principal: app_user + role_assignment 'employee', connecting as ai_hr_app so RLS
    // fails the WITH CHECK (app.is_admin() is false). owner.db would bypass RLS and prove nothing.
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Emp', primaryEmail: `emp_${randomUUID().slice(0, 8)}@t.local` })
      .returning({ id: schema.person.id });
    const empUserId = await createAppUser(b.tenantId, p.id, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: empUserId, roles: ['employee'] };
    await expect(createHolidayGroup(empCtx, { name: 'Sneaky', states: ['Sabah'] })).rejects.toThrow();
    // Confirm nothing landed (admin sees an empty list).
    expect(await listHolidayGroups(adminCtx(b))).toHaveLength(0);
  });

  it('allows a non-admin tenant member to READ groups (the leave resolver path)', async () => {
    await createHolidayGroup(adminCtx(b), { name: 'Readable', states: ['Sabah'] });
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Emp', primaryEmail: `emp_${randomUUID().slice(0, 8)}@t.local` })
      .returning({ id: schema.person.id });
    const empUserId = await createAppUser(b.tenantId, p.id, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: empUserId, roles: ['employee'] };
    const visible = await withTenant(empCtx, (tx) =>
      tx.select({ id: schema.holidayGroup.id }).from(schema.holidayGroup),
    );
    expect(visible).toHaveLength(1);
  });
});
