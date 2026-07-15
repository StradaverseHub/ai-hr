/**
 * Item 3a25f5ee — Personnel Contact & Address: Permanent + Correspondence address management.
 *
 * Covers:
 *  - Both address blocks save INDEPENDENTLY on the person row (different Permanent vs Correspondence).
 *  - The audit event (person.updated) records the NEW column NAMES only (PDPA — never any address value),
 *    and carries the optional `via: 'copy-permanent'` provenance marker when the copy convenience was used.
 *  - state/country in BOTH blocks validate against the profile_option catalog (off-catalog value rejected),
 *    with legacy-value tolerance on an unchanged save.
 *  - The delete-in-use guard protects a catalog value referenced by ANY address block (permanent /
 *    correspondence), not just the legacy single address.
 *  - Migration 0213's backfill mapped the pre-existing single address into the Permanent block.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
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
  seedProfileOptions,
  ProfileOptionInUseError,
} from '../core/profile-options';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const readPerson = (personId: string) =>
  owner.db.select().from(schema.person).where(eq(schema.person.id, personId)).limit(1).then((r) => r[0]);

describe('3a25f5ee — permanent + correspondence address', () => {
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

  it('stores permanent and correspondence addresses independently', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const E = await hire(a, base, 'Addr Person');

    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Addr Person',
      primaryEmail: 'addrperson@acme.test',
      permanentAddressLine1: '12 Jalan Permanent',
      permanentPostcode: '50000',
      permanentCity: 'Kuala Lumpur',
      permanentState: 'Selangor',
      permanentCountry: 'Malaysia',
      correspondenceAddressLine1: '99 Jalan Mail',
      correspondencePostcode: '10450',
      correspondenceCity: 'George Town',
      correspondenceState: 'Pulau Pinang',
      correspondenceCountry: 'Malaysia',
    });

    const p = await readPerson(E.personId);
    expect(p.permanentAddressLine1).toBe('12 Jalan Permanent');
    expect(p.permanentState).toBe('Selangor');
    expect(p.correspondenceAddressLine1).toBe('99 Jalan Mail');
    expect(p.correspondenceState).toBe('Pulau Pinang');
    // The two blocks are genuinely independent (different lines + states).
    expect(p.permanentAddressLine1).not.toBe(p.correspondenceAddressLine1);
  });

  it('audits the new address field names only (no values) and records the copy-permanent marker', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const E = await hire(a, base, 'Copy Person');

    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Copy Person',
      primaryEmail: 'copyperson@acme.test',
      via: 'copy-permanent',
      permanentAddressLine1: '5 Jalan Sama',
      permanentCity: 'Ipoh',
      correspondenceAddressLine1: '5 Jalan Sama',
      correspondenceCity: 'Ipoh',
    });

    const payload = await latestEventPayload(base.tenantId, E.personId, 'person.updated');
    expect(payload).not.toBeNull();
    const fields = (payload!.fields ?? []) as string[];
    expect(fields).toContain('permanentAddressLine1');
    expect(fields).toContain('correspondenceAddressLine1');
    expect(payload!.via).toBe('copy-permanent');
    // PDPA — the audit payload must not contain any address VALUE.
    expect(JSON.stringify(payload)).not.toContain('Jalan Sama');
    expect(JSON.stringify(payload)).not.toContain('Ipoh');
  });

  it('validates state/country of BOTH blocks against the catalog (off-catalog rejected)', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const E = await hire(a, base, 'Catalog Person');

    await expect(
      updatePerson(a, {
        personId: E.personId,
        fullName: 'Catalog Person',
        primaryEmail: 'catalogperson@acme.test',
        permanentState: 'Atlantis', // not an active catalog option
      }),
    ).rejects.toThrow();

    await expect(
      updatePerson(a, {
        personId: E.personId,
        fullName: 'Catalog Person',
        primaryEmail: 'catalogperson@acme.test',
        correspondenceCountry: 'Wakanda', // not an active catalog option
      }),
    ).rejects.toThrow();
  });

  it('tolerates a legacy off-catalog permanentState on an unchanged save', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const E = await hire(a, base, 'Legacy Addr');
    // Owner bypasses validation to plant an off-catalog stored value.
    await owner.db.update(schema.person).set({ permanentState: 'Old Territory' }).where(eq(schema.person.id, E.personId));

    // Re-saving with the SAME off-catalog value must not be rejected and must not blank it.
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Legacy Addr',
      primaryEmail: 'legacyaddr@acme.test',
      permanentState: 'Old Territory',
    });
    const p = await readPerson(E.personId);
    expect(p.permanentState).toBe('Old Territory');
  });

  it('delete-in-use guard protects a country used only in the correspondence block', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const { id: optId } = await createProfileOption(a, { category: 'country', value: 'Ruritania', label: 'Ruritania' });
    const E = await hire(a, base, 'Corr Country');
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Corr Country',
      primaryEmail: 'corrcountry@acme.test',
      correspondenceCountry: 'Ruritania',
    });
    await expect(deleteProfileOption(a, optId)).rejects.toThrow(ProfileOptionInUseError);
  });
});
