/**
 * Feedback 23ad620e — Personnel (Admin) Emergency Contact: several contacts per employee, not one.
 *
 * Pins the four things that could silently break:
 *  1. the register genuinely holds MANY contacts per person, each independently editable/removable;
 *  2. only ONE can be Primary — promoting a second demotes the first to Secondary (the request's rule 4),
 *     and the partial unique index backstops it;
 *  3. every screen that still shows "the" emergency contact (employeeDetail for the profile card, myProfile
 *     for /me) resolves to the SAME highest-priority record — the carry-forward guarantee the plan promised,
 *     in the same spirit as test/transfer-preserves-business-unit.test.ts pinning a column that must not be
 *     dropped: here it is a READ that must not fall back to the retired person.emergency_contact_* columns;
 *  4. the compatibility writers (admin updatePerson, self-service updateOwnContact) keep speaking the five
 *     old field names and land on the highest-priority record instead of the retired columns.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, updatePerson } from '../core/org';
import { updateOwnContact, myProfile } from '../core/profile';
import { employeeDetail } from '../core/read';
import {
  addEmergencyContact,
  archiveEmergencyContact,
  listEmergencyContacts,
  updateEmergencyContact,
  EmergencyContactValidationError,
} from '../core/emergency-contacts';
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
import type { SessionContext } from '../db/client';

let b: Base;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.replace(/\s+/g, '').toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

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

describe('23ad620e — emergency contact register', () => {
  it('holds several contacts per person, ordered Primary → Secondary → Other', async () => {
    const E = await hire('Multi Contact');
    await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'Mary Tan',
      relationship: 'Mother',
      mobilePhone: '019-9876543',
      priority: 'secondary',
    });
    await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'Ah Seng',
      relationship: 'Friend',
      priority: 'other',
    });
    await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'John Tan',
      relationship: 'Spouse',
      mobilePhone: '012-3456789',
      homePhone: '03-12345678',
      priority: 'primary',
    });

    const rows = await listEmergencyContacts(adminCtx(b), { personId: E.personId });
    expect(rows.map((r) => r.fullName)).toEqual(['John Tan', 'Mary Tan', 'Ah Seng']);
    expect(rows.map((r) => r.priority)).toEqual(['primary', 'secondary', 'other']);
  });

  it('only one contact can be Primary — promoting a second demotes the first to Secondary', async () => {
    const E = await hire('Primary Rule');
    const first = await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'First Primary',
      priority: 'primary',
    });
    const second = await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'Second Primary',
      priority: 'primary',
    });
    const byId = new Map(
      (await listEmergencyContacts(adminCtx(b), { personId: E.personId })).map((r) => [r.id, r]),
    );
    expect(byId.get(second.id)!.priority).toBe('primary');
    expect(byId.get(first.id)!.priority).toBe('secondary');

    // Promoting the demoted one back flips them again — never two primaries.
    await updateEmergencyContact(adminCtx(b), { id: first.id, priority: 'primary' });
    const after = await listEmergencyContacts(adminCtx(b), { personId: E.personId });
    expect(after.filter((r) => r.priority === 'primary').map((r) => r.id)).toEqual([first.id]);
  });

  it('edits and deletes one record without touching the others', async () => {
    const E = await hire('Independent Records');
    const keep = await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'Keep Me',
      mobilePhone: '011-1111111',
      priority: 'primary',
    });
    const drop = await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'Drop Me',
      mobilePhone: '011-2222222',
      priority: 'other',
    });
    await updateEmergencyContact(adminCtx(b), { id: drop.id, mobilePhone: '011-3333333' });
    await archiveEmergencyContact(adminCtx(b), { id: drop.id });

    const rows = await listEmergencyContacts(adminCtx(b), { personId: E.personId });
    expect(rows.map((r) => r.id)).toEqual([keep.id]);
    expect(rows[0].mobilePhone).toBe('011-1111111');
    // A record can only be archived once — the second attempt is a clear error, not a silent no-op.
    await expect(archiveEmergencyContact(adminCtx(b), { id: drop.id })).rejects.toBeInstanceOf(
      EmergencyContactValidationError,
    );
  });

  it('rejects a nameless contact', async () => {
    const E = await hire('Nameless');
    await expect(
      addEmergencyContact(adminCtx(b), { personId: E.personId, fullName: '   ', mobilePhone: '012-0000000' }),
    ).rejects.toBeInstanceOf(EmergencyContactValidationError);
  });

  it('every single-contact reader resolves to the SAME highest-priority record', async () => {
    const E = await hire('One Truth');
    await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'Backup Contact',
      mobilePhone: '019-0000002',
      priority: 'secondary',
    });
    await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'Call Me First',
      relationship: 'Spouse',
      mobilePhone: '019-0000001',
      homePhone: '03-0000001',
      address: '1 Jalan Satu',
      priority: 'primary',
    });

    const detail = await employeeDetail(adminCtx(b), E.employmentId);
    expect(detail!.emergencyContactName).toBe('Call Me First');
    expect(detail!.emergencyContactRelationship).toBe('Spouse');
    expect(detail!.emergencyContactPhone).toBe('019-0000001');
    expect(detail!.emergencyContactPhone2).toBe('03-0000001');
    expect(detail!.emergencyContactAddress).toBe('1 Jalan Satu');

    const uid = await createAppUser(b.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uid, personId: E.personId, roles: ['employee'] };
    const mine = await myProfile(empCtx);
    expect(mine!.person!.emergencyContactName).toBe(detail!.emergencyContactName);
    expect(mine!.person!.emergencyContactPhone).toBe(detail!.emergencyContactPhone);
    expect(mine!.person!.emergencyContactPhone2).toBe(detail!.emergencyContactPhone2);
    expect(mine!.person!.emergencyContactAddress).toBe(detail!.emergencyContactAddress);
  });

  it('the compatibility writers create then patch the highest-priority record, never the retired columns', async () => {
    const E = await hire('Compat Writer');
    // Admin path: the five old field names still work and CREATE the register's first (primary) record.
    await updatePerson(adminCtx(b), {
      personId: E.personId,
      fullName: 'Compat Writer',
      primaryEmail: 'compat@t.local',
      emergencyContactName: 'Original Kin',
      emergencyContactPhone: '012-1111111',
    });
    let rows = await listEmergencyContacts(adminCtx(b), { personId: E.personId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fullName: 'Original Kin', mobilePhone: '012-1111111', priority: 'primary' });

    // A second contact HR adds through the register must not be disturbed by the compatibility path.
    const other = await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'Second Kin',
      priority: 'other',
    });

    // Self-service path: the employee updates their own contact — it patches the SAME primary record.
    const uid = await createAppUser(b.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uid, personId: E.personId, roles: ['employee'] };
    await updateOwnContact(empCtx, {
      emergencyContactName: 'Renamed Kin',
      emergencyContactPhone: '012-9999999',
      emergencyContactRelationship: 'Spouse',
    });
    rows = await listEmergencyContacts(adminCtx(b), { personId: E.personId });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: rows[0].id,
      fullName: 'Renamed Kin',
      mobilePhone: '012-9999999',
      relationship: 'Spouse',
      priority: 'primary',
    });
    expect(rows.find((r) => r.id === other.id)!.fullName).toBe('Second Kin');

    // The retired person columns stay untouched by every one of those writes.
    const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, E.personId));
    expect(p.emergencyContactName).toBeNull();
    expect(p.emergencyContactPhone).toBeNull();
  });

  it('clearing every field through the single-contact form removes the record rather than leaving a ghost', async () => {
    const E = await hire('Clear Contact');
    await updatePerson(adminCtx(b), {
      personId: E.personId,
      fullName: 'Clear Contact',
      primaryEmail: 'clear@t.local',
      emergencyContactName: 'Temporary Kin',
      emergencyContactPhone: '012-5555555',
    });
    expect(await listEmergencyContacts(adminCtx(b), { personId: E.personId })).toHaveLength(1);

    await updatePerson(adminCtx(b), {
      personId: E.personId,
      fullName: 'Clear Contact',
      primaryEmail: 'clear@t.local',
      emergencyContactName: null,
      emergencyContactRelationship: null,
      emergencyContactPhone: null,
      emergencyContactPhone2: null,
      emergencyContactAddress: null,
    });
    expect(await listEmergencyContacts(adminCtx(b), { personId: E.personId })).toEqual([]);
    const detail = await employeeDetail(adminCtx(b), E.employmentId);
    expect(detail!.emergencyContactName).toBeNull();
  });

  it('a save that carries no emergency field leaves the register alone', async () => {
    const E = await hire('Untouched Contact');
    await addEmergencyContact(adminCtx(b), {
      personId: E.personId,
      fullName: 'Stay Put',
      priority: 'primary',
    });
    // The Personal Details card posts the core trio only — it must never wipe another card's data.
    await updatePerson(adminCtx(b), {
      personId: E.personId,
      fullName: 'Untouched Contact',
      primaryEmail: 'untouched@t.local',
      firstName: 'Untouched',
    });
    const rows = await listEmergencyContacts(adminCtx(b), { personId: E.personId });
    expect(rows.map((r) => r.fullName)).toEqual(['Stay Put']);
  });
});
