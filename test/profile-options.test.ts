/**
 * 7d309da7 — Personnel-profile configurable dropdown catalogs (profile_option).
 *
 * Covers: RLS (member read / admin write / cross-tenant deny); catalog CRUD + in-use delete guard; the
 * legacy-value tolerance on updatePerson (an out-of-catalog stored value survives an unchanged save but a
 * new off-catalog value is rejected); and seed idempotency.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee, updatePerson } from '../core/org';
import {
  createProfileOption,
  deleteProfileOption,
  listProfileOptions,
  seedProfileOptions,
  setProfileOptionActive,
  updateProfileOption,
  ProfileOptionInUseError,
  DEFAULT_PROFILE_OPTIONS,
} from '../core/profile-options';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('7d309da7 — profile_option catalog', () => {
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

  // ── RLS ──────────────────────────────────────────────────────────────────
  it('RLS: members read the catalog, only admins write it', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const E = await hire(a, base, 'Emp');
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'] };

    // Member CAN read.
    const seen = await listProfileOptions(empCtx, 'religion');
    expect(seen.map((r) => r.value)).toContain('Islam');

    // Member CANNOT write (RLS WITH CHECK app.is_admin()).
    await expect(
      withTenant(empCtx, (tx) =>
        tx.insert(schema.profileOption).values({ tenantId: base.tenantId, category: 'religion', value: 'Jedi', label: 'Jedi' }),
      ),
    ).rejects.toThrow();

    // Admin CAN write via the service.
    const { id } = await createProfileOption(a, { category: 'religion', value: 'Bahai' });
    expect(id).toBeTruthy();
  });

  it('RLS: a tenant cannot see another tenant’s options', async () => {
    const a = adminCtx(base);
    await createProfileOption(a, { category: 'race', value: 'TenantA-Only' });

    const other = await seedBase();
    const seen = await listProfileOptions(adminCtx(other), 'race');
    expect(seen.map((r) => r.value)).not.toContain('TenantA-Only');
  });

  // ── CRUD + in-use guard ───────────────────────────────────────────────────
  it('create / update / activate / deactivate, and rejects duplicate values', async () => {
    const a = adminCtx(base);
    const { id } = await createProfileOption(a, { category: 'country', value: 'Japan', label: 'Japan', sortOrder: 3 });

    // duplicate value in the same category → rejected.
    await expect(createProfileOption(a, { category: 'country', value: 'Japan' })).rejects.toThrow();

    await updateProfileOption(a, { id, label: 'Nippon', sortOrder: 9 });
    let rows = await listProfileOptions(a, 'country', { activeOnly: false });
    expect(rows.find((r) => r.id === id)?.label).toBe('Nippon');

    await setProfileOptionActive(a, { id, isActive: false });
    rows = await listProfileOptions(a, 'country', { activeOnly: true });
    expect(rows.find((r) => r.id === id)).toBeUndefined(); // hidden from the picker
    rows = await listProfileOptions(a, 'country', { activeOnly: false });
    expect(rows.find((r) => r.id === id)?.isActive).toBe(false);

    // each write appended a substrate event.
    const events = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.aggregateType, 'profile-option')));
    const types = events.map((e) => e.eventType);
    expect(types).toContain('profile-option.created');
    expect(types).toContain('profile-option.updated');
    expect(types).toContain('profile-option.deactivated');
  });

  it('delete: allowed when unused, blocked when a person references the value', async () => {
    const a = adminCtx(base);
    const { id: unusedId } = await createProfileOption(a, { category: 'race', value: 'Unused' });
    // unused → deletes fine.
    await deleteProfileOption(a, unusedId);
    expect((await listProfileOptions(a, 'race', { activeOnly: false })).find((r) => r.id === unusedId)).toBeUndefined();

    // in-use → blocked.
    const { id: usedId } = await createProfileOption(a, { category: 'race', value: 'Bugis' });
    const E = await hire(a, base, 'RaceUser');
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'RaceUser',
      primaryEmail: 'raceuser@acme.test',
      race: 'Bugis',
    });
    await expect(deleteProfileOption(a, usedId)).rejects.toThrow(ProfileOptionInUseError);
  });

  // ── legacy-value tolerance on updatePerson ────────────────────────────────
  it('legacy tolerance: an out-of-catalog stored value survives an unchanged save', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const E = await hire(a, base, 'Legacy Person');

    // Simulate a pre-existing free-text value that is NOT in the catalog (owner bypasses validation).
    await owner.db.update(schema.person).set({ religion: 'Zoroastrian', state: 'Johor' }).where(eq(schema.person.id, E.personId));

    // Re-save the profile leaving religion UNCHANGED (still 'Zoroastrian') + a name edit → must NOT blank it.
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Legacy Person (edited)',
      primaryEmail: 'legacyperson@acme.test',
      religion: 'Zoroastrian',
      nationality: 'Malaysian', // a valid active catalog value
    });
    const [after] = await owner.db.select().from(schema.person).where(eq(schema.person.id, E.personId));
    expect(after.religion).toBe('Zoroastrian');
    expect(after.nationality).toBe('Malaysian');
  });

  it('validation: a NEW off-catalog value is rejected; clearing to null is allowed', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const E = await hire(a, base, 'Valid Person');

    // A brand-new value not in the catalog → rejected.
    await expect(
      updatePerson(a, {
        personId: E.personId,
        fullName: 'Valid Person',
        primaryEmail: 'validperson@acme.test',
        religion: 'Pastafarian',
      }),
    ).rejects.toThrow();

    // An active catalog value → accepted.
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Valid Person',
      primaryEmail: 'validperson@acme.test',
      religion: 'Islam',
    });
    // Clearing to null → accepted.
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Valid Person',
      primaryEmail: 'validperson@acme.test',
      religion: null,
    });
    const [after] = await owner.db.select().from(schema.person).where(eq(schema.person.id, E.personId));
    expect(after.religion).toBeNull();
  });

  it('deactivated catalog value is rejected as a NEW pick', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const E = await hire(a, base, 'Deact Person');
    const rows = await listProfileOptions(a, 'country', { activeOnly: false });
    const malaysia = rows.find((r) => r.value === 'Malaysia')!;
    await setProfileOptionActive(a, { id: malaysia.id, isActive: false });

    await expect(
      updatePerson(a, {
        personId: E.personId,
        fullName: 'Deact Person',
        primaryEmail: 'deactperson@acme.test',
        country: 'Malaysia', // now inactive
      }),
    ).rejects.toThrow();
  });

  // ── seed idempotency ──────────────────────────────────────────────────────
  it('seed is idempotent: re-running inserts nothing new', async () => {
    const a = adminCtx(base);
    const first = await seedProfileOptions(a);
    expect(first.created).toBe(DEFAULT_PROFILE_OPTIONS.length);

    const second = await seedProfileOptions(a);
    expect(second.created).toBe(0);

    // Row count equals the default set exactly (no duplicates).
    const all = await owner.db
      .select()
      .from(schema.profileOption)
      .where(eq(schema.profileOption.tenantId, base.tenantId));
    expect(all.length).toBe(DEFAULT_PROFILE_OPTIONS.length);
  });
});
