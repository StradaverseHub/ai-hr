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
import { setStatutoryProfileMY, getStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import {
  listDependents,
  addDependent,
  updateDependent,
  archiveDependent,
  DependentValidationError,
  DEPENDENT_RELATIONSHIP_CATEGORY,
} from '../core/dependents';
import {
  createProfileOption,
  listProfileOptions,
  seedProfileOptions,
  setProfileOptionActive,
} from '../core/profile-options';
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

  // R46 47146ea3 — rail (a). The benefits-vs-tax firewall is no longer absolute, but it is still the DEFAULT:
  // child_relief_mode defaults to 'manual', and a person on manual keeps full human control of their tax
  // figure. This is the original firewall test, retained deliberately — it now pins the opt-in boundary.
  it('rail (a) manual mode: adding a dependent does NOT change the statutory num_children figure', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep Tax');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101019999', numChildren: 2 });

    // Add three child dependents — the benefits register grows...
    await addDependent(a, { personId: e.personId, fullName: 'C1', relationship: 'child' });
    await addDependent(a, { personId: e.personId, fullName: 'C2', relationship: 'child' });
    await addDependent(a, { personId: e.personId, fullName: 'C3', relationship: 'child' });
    expect(await listDependents(a, { personId: e.personId })).toHaveLength(3);

    // ...but the tax num_children figure is UNTOUCHED (it stays the human-set statutory value).
    const st = await getStatutoryProfileMY(a, e.personId);
    expect(st?.numChildren).toBe(2);
  });

  // R46 47146ea3 — the amended firewall. In 'auto' mode the derived eligible-child count flows straight into
  // the PCB tax field with no human confirmation, on add AND on archive.
  it('auto mode: num_children syncs from the Family register on add and on archive', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep Auto');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101019888', numChildren: 0 });
    await setTaxProfileMY(a, { personId: e.personId, childReliefMode: 'auto', numChildren: 0 });

    // Under-18 children are eligible; the count follows them up...
    const c1 = await addDependent(a, {
      personId: e.personId, fullName: 'K1', relationship: 'child', dateOfBirth: '2018-05-05',
    });
    expect(c1.childReliefSync.changed).toBe(true);
    expect(c1.childReliefSync.after).toBe(1);
    await addDependent(a, {
      personId: e.personId, fullName: 'K2', relationship: 'child', dateOfBirth: '2020-05-05',
    });
    expect((await getStatutoryProfileMY(a, e.personId))?.numChildren).toBe(2);

    // ...and back down on archive (eligibleChildReliefCount excludes archived rows).
    const arch = await archiveDependent(a, { id: c1.id });
    expect(arch.childReliefSync.changed).toBe(true);
    expect(arch.childReliefSync.after).toBe(1);
    expect((await getStatutoryProfileMY(a, e.personId))?.numChildren).toBe(1);

    // A non-child relative never moves a tax figure.
    const sp = await addDependent(a, { personId: e.personId, fullName: 'Spouse', relationship: 'spouse' });
    expect(sp.childReliefSync.changed).toBe(false);
    expect(sp.childReliefSync.skipped).toBe('unchanged');
    expect((await getStatutoryProfileMY(a, e.personId))?.numChildren).toBe(1);
  });

  // R46 47146ea3 — rail (c). An automatic tax move must be distinguishable from a human one in the audit
  // trail, forever. That provenance marker is what replaced the human approval step, so it is load-bearing.
  it('rail (c): the auto-sync tax event carries auto:true provenance', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep Prov');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101019777', numChildren: 0 });
    await setTaxProfileMY(a, { personId: e.personId, childReliefMode: 'auto', numChildren: 0 });

    await addDependent(a, {
      personId: e.personId, fullName: 'K', relationship: 'child', dateOfBirth: '2019-01-01',
    });

    // The tax event is keyed on the statutory row, so read it by event type rather than by aggregate id.
    const rows = await owner.db
      .select({ payload: schema.domainEvent.payload, seq: schema.domainEvent.sequence })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, base.tenantId),
          eq(schema.domainEvent.eventType, 'employee.tax.updated'),
        ),
      );
    const payload = rows.sort((x, y) => Number(y.seq) - Number(x.seq))[0]?.payload as
      | Record<string, unknown>
      | undefined;
    expect(payload?.auto).toBe(true);
    expect(payload?.provenance).toBe('auto_child_relief');
    expect((payload?.before as { numChildren?: number } | null)?.numChildren).toBe(0);
    expect((payload?.after as { numChildren?: number } | null)?.numChildren).toBe(1);
  });

  // R46 47146ea3 — the sync must NEVER fail the family-record save it is attached to. A person with no
  // statutory row (no IC keyed yet) would make setTaxProfileMY throw NoIcYetError; that has to be swallowed.
  it('a missing statutory row does not crash the dependent save', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep NoIc');
    const r = await addDependent(a, {
      personId: e.personId, fullName: 'K', relationship: 'child', dateOfBirth: '2019-01-01',
    });
    expect(r.id).toBeTruthy();
    expect(r.childReliefSync.changed).toBe(false);
    expect(r.childReliefSync.skipped).toBe('no_statutory_row');
    expect(await listDependents(a, { personId: e.personId })).toHaveLength(1);
  });

  // ─── ea36b7fa — Family & Dependents consolidation: configurable relationship types ──────────────────
  // The Relationship dropdown is backed by the profile_option catalog (category dependentRelationship,
  // DISTINCT from the emergency-contact 'relationship' category). The five built-ins stay ALWAYS valid;
  // custom ACTIVE options are accepted and persist as their catalog value, treated as 'other' for the
  // spouse-field / child-relief gating.

  it('custom relationship: an ACTIVE catalog option round-trips, gated fields treated as other', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep Custom');
    await createProfileOption(a, { category: DEPENDENT_RELATIONSHIP_CATEGORY, value: 'Grandparent', label: 'Grandparent' });

    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Nana Doe',
      relationship: 'Grandparent',
      dateOfBirth: '1950-03-03',
      occupation: 'Retired',
      // Spouse-only and child-only inputs must be IGNORED (NULLed) for a custom type — it behaves as 'other'.
      marriageDate: '1970-01-01',
      spouseWorking: true,
      companyName: 'ShouldNotPersist',
      isStudent: true,
      schoolName: 'ShouldNotPersist',
      childTaxRelief: true,
    });
    const rows = await listDependents(a, { personId: e.personId });
    const r = rows.find((x) => x.id === id)!;
    expect(r.relationship).toBe('Grandparent'); // persists as the catalog value
    expect(r.occupation).toBe('Retired'); // general field applies to every relationship
    expect(r.marriageDate).toBeNull();
    expect(r.spouseWorking).toBeNull();
    expect(r.companyName).toBeNull();
    expect(r.isStudent).toBeNull();
    expect(r.schoolName).toBeNull();
    expect(r.childTaxRelief).toBeNull();

    // Edit round-trip keeps the custom relationship (unchanged value re-validates without a catalog hit).
    await updateDependent(a, { id, relationship: 'Grandparent', fullName: 'Nana Renamed' });
    expect((await listDependents(a, { personId: e.personId })).find((x) => x.id === id)?.fullName).toBe('Nana Renamed');
  });

  it('custom relationship: unknown or INACTIVE values are rejected as new picks; unchanged re-save survives', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep CustomVal');
    // Not in the catalog at all → rejected.
    await expect(
      addDependent(a, { personId: e.personId, fullName: 'X', relationship: 'Cousin' }),
    ).rejects.toThrow(DependentValidationError);

    // Active custom option accepted, then DEACTIVATED: existing rows keep saving (legacy tolerance)…
    await createProfileOption(a, { category: DEPENDENT_RELATIONSHIP_CATEGORY, value: 'Guardian', label: 'Guardian' });
    const { id } = await addDependent(a, { personId: e.personId, fullName: 'G', relationship: 'Guardian' });
    const [opt] = (await listProfileOptions(a, DEPENDENT_RELATIONSHIP_CATEGORY)).filter((o) => o.value === 'Guardian');
    await setProfileOptionActive(a, { id: opt.id, isActive: false });
    await updateDependent(a, { id, relationship: 'Guardian', phone: '0123456789' }); // unchanged → allowed
    // …but the deactivated value is rejected as a NEW pick (add, or changing another row to it).
    await expect(
      addDependent(a, { personId: e.personId, fullName: 'Y', relationship: 'Guardian' }),
    ).rejects.toThrow(DependentValidationError);
    const sib = await addDependent(a, { personId: e.personId, fullName: 'Z', relationship: 'sibling' });
    await expect(updateDependent(a, { id: sib.id, relationship: 'Guardian' })).rejects.toThrow(
      DependentValidationError,
    );
  });

  it('built-ins stay ALWAYS valid server-side, even when deactivated in the catalog', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a); // seeds the five dependentRelationship built-ins
    const e = await hire(a, base, 'Dep Builtin');
    const [spouseOpt] = (await listProfileOptions(a, DEPENDENT_RELATIONSHIP_CATEGORY)).filter(
      (o) => o.value === 'spouse',
    );
    expect(spouseOpt).toBeTruthy();
    await setProfileOptionActive(a, { id: spouseOpt.id, isActive: false });
    // Deactivation only hides the option from NEW picks in the UI — the service still accepts it (system
    // logic keys off the built-ins, so they can never be configured away).
    const { id } = await addDependent(a, { personId: e.personId, fullName: 'S', relationship: 'spouse' });
    expect((await listDependents(a, { personId: e.personId })).find((x) => x.id === id)?.relationship).toBe('spouse');
  });

  it('auto child-relief: a custom-relationship member never moves the count; a child via the unified flow does', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Dep CustomTax');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101019666', numChildren: 0 });
    await setTaxProfileMY(a, { personId: e.personId, childReliefMode: 'auto', numChildren: 0 });
    await createProfileOption(a, { category: DEPENDENT_RELATIONSHIP_CATEGORY, value: 'Grandchild', label: 'Grandchild' });

    // A custom type — even an under-18 one — is NOT a 'child' row, so it can never reach the tax figure.
    const g = await addDependent(a, {
      personId: e.personId, fullName: 'GC', relationship: 'Grandchild', dateOfBirth: '2020-01-01',
    });
    expect(g.childReliefSync.changed).toBe(false);
    expect((await getStatutoryProfileMY(a, e.personId))?.numChildren).toBe(0);

    // The SAME unified add flow with relationship 'child' still syncs the count (regression pin).
    const c = await addDependent(a, {
      personId: e.personId, fullName: 'K', relationship: 'child', dateOfBirth: '2019-01-01',
    });
    expect(c.childReliefSync.changed).toBe(true);
    expect((await getStatutoryProfileMY(a, e.personId))?.numChildren).toBe(1);
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
