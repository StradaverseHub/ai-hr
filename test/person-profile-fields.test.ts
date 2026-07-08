/**
 * b4682879 — Personnel Profile redesign: the new personal / contact / structured-address / emergency
 * fields on `person`. Pins:
 *  - updatePerson writes the new profile fields + the person.updated event lists them by NAME only
 *    (never the religion/race VALUES — PDPA / ADR-0030 append-only log);
 *  - setPersonComplianceFields now also sets date of birth (admin path) + rejects a non-admin;
 *  - updateOwnContact writes the structured home address + extended emergency contact for the caller's
 *    own row (self path) and no longer touches the legacy `address` column.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, updatePerson } from '../core/org';
import { setPersonComplianceFields, updateOwnContact } from '../core/profile';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';

let b: Base;

async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}
async function personRow(personId: string) {
  const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, personId));
  return p;
}

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

describe('b4682879 — person profile fields', () => {
  it('updatePerson writes the new profile fields and keeps fullName/primaryEmail intact', async () => {
    const E = await hire('Profiler');
    await updatePerson(adminCtx(b), {
      personId: E.personId,
      fullName: 'Profiler Full',
      primaryEmail: 'profiler@work.test',
      phone: '0111111111',
      firstName: 'Pro',
      lastName: 'Filer',
      preferredName: 'Prof',
      religion: 'Buddhist',
      race: 'Chinese',
      nationality: 'Malaysian',
      personalEmail: 'prof@home.test',
      addressLine1: '1 Jalan Satu',
      addressLine2: 'Taman Dua',
      postcode: '50000',
      city: 'Kuala Lumpur',
      state: 'WP Kuala Lumpur',
      country: 'Malaysia',
      emergencyContactName: 'Kin',
      emergencyContactRelationship: 'Spouse',
      emergencyContactPhone: '0122222222',
      emergencyContactPhone2: '0133333333',
      emergencyContactAddress: '2 Jalan Dua',
    });
    const p = await personRow(E.personId);
    expect(p.fullName).toBe('Profiler Full');
    expect(p.firstName).toBe('Pro');
    expect(p.lastName).toBe('Filer');
    expect(p.preferredName).toBe('Prof');
    expect(p.religion).toBe('Buddhist');
    expect(p.race).toBe('Chinese');
    expect(p.nationality).toBe('Malaysian');
    expect(p.personalEmail).toBe('prof@home.test');
    expect(p.addressLine1).toBe('1 Jalan Satu');
    expect(p.addressLine2).toBe('Taman Dua');
    expect(p.postcode).toBe('50000');
    expect(p.city).toBe('Kuala Lumpur');
    expect(p.state).toBe('WP Kuala Lumpur');
    expect(p.country).toBe('Malaysia');
    expect(p.emergencyContactRelationship).toBe('Spouse');
    expect(p.emergencyContactPhone2).toBe('0133333333');
    expect(p.emergencyContactAddress).toBe('2 Jalan Dua');
  });

  it('the person.updated event lists the profile fields by NAME and never leaks the religion/race VALUE', async () => {
    const E = await hire('Auditee');
    await updatePerson(adminCtx(b), {
      personId: E.personId,
      fullName: 'Auditee Full',
      primaryEmail: 'aud@work.test',
      religion: 'Hindu',
      race: 'Indian',
    });
    const payload = await latestEventPayload(b.tenantId, E.personId, 'person.updated');
    expect(payload).toBeTruthy();
    // Field names present…
    expect((payload as { fields?: string[] }).fields).toEqual(expect.arrayContaining(['religion', 'race']));
    // …but the sensitive VALUES never appear anywhere in the serialized payload.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('Hindu');
    expect(serialized).not.toContain('Indian');
  });

  it('setPersonComplianceFields sets date of birth (admin), and rejects a non-admin', async () => {
    const E = await hire('DobSetter');
    await setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, dateOfBirth: '1990-04-15' });
    expect((await personRow(E.personId)).dateOfBirth).toBe('1990-04-15');

    // A malformed DOB is dropped (never persisted) rather than corrupting the age-band math.
    await expect(
      setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, dateOfBirth: '15/04/1990' }),
    ).rejects.toThrow(/nothing to change/i);

    const uid = await createAppUser(b.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uid, personId: E.personId, roles: ['employee'] };
    await expect(
      setPersonComplianceFields(empCtx, { employmentId: E.employmentId, dateOfBirth: '1990-04-15' }),
    ).rejects.toThrow(/admin/i);
  });

  it('updateOwnContact writes structured address + extended emergency contact for the caller (self path)', async () => {
    const E = await hire('SelfContact');
    const uid = await createAppUser(b.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uid, personId: E.personId, roles: ['employee'] };
    await updateOwnContact(empCtx, {
      phone: '0199999999',
      personalEmail: 'self@home.test',
      addressLine1: '9 Jalan Sembilan',
      postcode: '43000',
      city: 'Kajang',
      state: 'Selangor',
      country: 'Malaysia',
      emergencyContactName: 'My Kin',
      emergencyContactRelationship: 'Parent',
      emergencyContactPhone2: '0188888888',
      emergencyContactAddress: '9 Jalan Sembilan',
    });
    const p = await personRow(E.personId);
    expect(p.addressLine1).toBe('9 Jalan Sembilan');
    expect(p.city).toBe('Kajang');
    expect(p.state).toBe('Selangor');
    expect(p.personalEmail).toBe('self@home.test');
    expect(p.emergencyContactRelationship).toBe('Parent');
    expect(p.emergencyContactPhone2).toBe('0188888888');
    // Legacy single-line `address` is no longer written by the self path.
    expect(p.address).toBeNull();
  });
});
