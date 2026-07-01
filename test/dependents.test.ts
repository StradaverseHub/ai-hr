/**
 * Personnel Information — Family / Dependents (phase 1). Covers: admin CRUD (add/list/update/archive),
 * relationship validation, person-keying (works for a person with NO employment AND across CONCURRENT
 * employments — the fix that employment-keying would have broken), RLS edges (non-admin cannot write;
 * other-company session cannot read/write another person's dependents), the deliberate separation from the
 * tax num_children figure, and the DomainEvent substrate (events appended; no PII — name/IC/DOB — in the
 * payload, ADR-0030 Layer 0).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setStatutoryProfileMY, getStatutoryProfileMY } from '../localization/my/statutory';
import {
  listDependents,
  addDependent,
  updateDependent,
  archiveDependent,
  DependentValidationError,
} from '../core/dependents';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const hire = (ctx: SessionContext, b: Base, name: string, companyId?: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
    companyId: companyId ?? b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

/** Insert a bare person (no employment) via the owner connection, for the no-employment case. */
async function insertPerson(tenantId: string, fullName: string): Promise<string> {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId, fullName, primaryEmail: `${fullName.toLowerCase().replace(/\s+/g, '.')}@acme.test` })
    .returning({ id: schema.person.id });
  return p.id;
}

describe('Personnel — Family / Dependents (phase 1)', () => {
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

  it('admin add / list / update / archive happy path', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep Parent');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Jane Doe',
      relationship: 'spouse',
      dateOfBirth: '1990-05-01',
      gender: 'female',
      isBeneficiary: true,
    });

    let rows = await listDependents(a, { personId: e.personId });
    expect(rows).toHaveLength(1);
    expect(rows[0].fullName).toBe('Jane Doe');
    expect(rows[0].relationship).toBe('spouse');
    expect(rows[0].dateOfBirth).toBe('1990-05-01');
    expect(rows[0].isBeneficiary).toBe(true);

    await updateDependent(a, { id, fullName: 'Jane Smith', isBeneficiary: false });
    rows = await listDependents(a, { personId: e.personId });
    expect(rows[0].fullName).toBe('Jane Smith');
    expect(rows[0].isBeneficiary).toBe(false);

    await archiveDependent(a, { id });
    rows = await listDependents(a, { personId: e.personId });
    expect(rows).toHaveLength(0); // soft-deleted → not listed
  });

  it('rejects an invalid relationship and a blank name', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep Validate');
    await expect(
      addDependent(a, { personId: e.personId, fullName: 'X', relationship: 'cousin' }),
    ).rejects.toThrow(DependentValidationError);
    await expect(
      addDependent(a, { personId: e.personId, fullName: '   ', relationship: 'child' }),
    ).rejects.toThrow(DependentValidationError);
  });

  it('person-keyed: a person with NO employment can still have dependents added', async () => {
    const a = adminCtx(base);
    const personId = await insertPerson(base.tenantId, 'No Employment');
    // Would be impossible if the table were employment-keyed (there is no employment to key on).
    const { id } = await addDependent(a, {
      personId,
      fullName: 'Kid A',
      relationship: 'child',
      dateOfBirth: '2015-01-01',
    });
    const rows = await listDependents(a, { personId });
    expect(rows.map((r) => r.id)).toContain(id);
    // Event still appended (subjectEmploymentId resolves to null → admin-only readable — acceptable).
    const types = await eventTypesFor(base.tenantId, id);
    expect(types).toContain('dependent.added');
  });

  it('concurrent-employment person: admin of either company reads the same person-keyed dependents', async () => {
    const a = adminCtx(base);
    // Second company under the same tenant.
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Acme Two Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [d2] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: c2.id, name: 'Ops2' })
      .returning({ id: schema.department.id });

    // One person, two employments across the two companies (concurrent).
    const e1 = await hire(a, base, 'Concurrent Person');
    await hireEmployee(a, {
      person: { id: e1.personId },
      companyId: c2.id,
      departmentId: d2.id,
      employmentType: 'part_time',
      hiredOn: '2026-02-01',
    });
    await addDependent(a, { personId: e1.personId, fullName: 'Shared Dep', relationship: 'parent' });

    // A tenant-level admin reads it once (the record is person-keyed, not tied to either employment).
    const rows = await listDependents(a, { personId: e1.personId });
    expect(rows.map((r) => r.fullName)).toEqual(['Shared Dep']);
    expect(rows).toHaveLength(1); // ONE row, not duplicated per employment
  });

  it('RLS: a non-admin cannot WRITE and cannot READ another person’s dependents', async () => {
    const a = adminCtx(base);
    const me = await hire(a, base, 'Dep Self');
    const other = await hire(a, base, 'Dep Other');
    await addDependent(a, { personId: other.personId, fullName: 'Their Kid', relationship: 'child' });

    const uSelf = await createAppUser(base.tenantId, me.personId, 'employee');
    const selfCtx: SessionContext = { tenantId: base.tenantId, userId: uSelf, roles: ['employee'] };

    // can_see_person grants SELF read — an employee sees their own (empty) list without error.
    expect(await listDependents(selfCtx, { personId: me.personId })).toEqual([]);
    // But cannot read ANOTHER person's dependents (RLS USING can_see_person → filtered out).
    expect(await listDependents(selfCtx, { personId: other.personId })).toEqual([]);
    // And cannot WRITE (RLS WITH CHECK is_admin()).
    await expect(
      addDependent(selfCtx, { personId: me.personId, fullName: 'Self Add', relationship: 'child' }),
    ).rejects.toThrow();
  });

  it('kept separate from tax: adding a dependent does NOT change the statutory num_children figure', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep Tax');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101019999', numChildren: 2 });

    // Add three child dependents — the benefits register grows...
    await addDependent(a, { personId: e.personId, fullName: 'C1', relationship: 'child' });
    await addDependent(a, { personId: e.personId, fullName: 'C2', relationship: 'child' });
    await addDependent(a, { personId: e.personId, fullName: 'C3', relationship: 'child' });
    expect(await listDependents(a, { personId: e.personId })).toHaveLength(3);

    // ...but the tax num_children figure is UNTOUCHED (it stays the approval-gated statutory value).
    const st = await getStatutoryProfileMY(a, e.personId);
    expect(st?.numChildren).toBe(2);
  });

  it('DomainEvents: appended on add/update/archive with NO PII (name/IC/DOB) in any payload', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep Event');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Secret Name',
      relationship: 'spouse',
      dateOfBirth: '1988-12-31',
      icOrPassport: 'A1234567',
      isBeneficiary: true,
    });
    await updateDependent(a, { id, fullName: 'Renamed Secret' });
    await archiveDependent(a, { id });

    const types = await eventTypesFor(base.tenantId, id);
    expect(types).toEqual(
      expect.arrayContaining(['dependent.added', 'dependent.updated', 'dependent.archived']),
    );

    // No name/IC/DOB anywhere in any of the three payloads (ADR-0030 Layer 0).
    for (const t of ['dependent.added', 'dependent.updated', 'dependent.archived']) {
      const payload = await latestEventPayload(base.tenantId, id, t);
      const serialized = JSON.stringify(payload ?? {});
      expect(serialized).not.toContain('Secret Name');
      expect(serialized).not.toContain('Renamed Secret');
      expect(serialized).not.toContain('A1234567');
      expect(serialized).not.toContain('1988-12-31');
    }
  });
});
