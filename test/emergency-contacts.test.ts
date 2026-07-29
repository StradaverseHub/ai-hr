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
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

// ─────────────────── Migration 0322 — one home, and a re-runnable carry-over ───────────────────
//
// The FIRST attempt at this item was refuted because it left the old single Emergency Contact field in
// place beside the new list: two writable homes for the same fact. These specs pin the two halves of the
// fix — the old home is gone, and the carry-over that emptied it is safe to run again.

/** The 0322 statements, in file order (the 0296 precedent in dashboard-fixed-row.test.ts). */
const stmts0322 = readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '0322_person_emergency_contact_register.sql'),
  'utf8',
).split('--> statement-breakpoint');

const run0322 = async () => {
  for (const stmt of stmts0322) await owner.db.execute(sql.raw(stmt));
};

/** Rebuild the PRE-0322 shape so the carry-over has something to carry. */
const readdRetiredColumns = () =>
  owner.db.execute(
    sql.raw(`ALTER TABLE person
      ADD COLUMN IF NOT EXISTS emergency_contact_name text,
      ADD COLUMN IF NOT EXISTS emergency_contact_relationship text,
      ADD COLUMN IF NOT EXISTS emergency_contact_phone text,
      ADD COLUMN IF NOT EXISTS emergency_contact_phone2 text,
      ADD COLUMN IF NOT EXISTS emergency_contact_address text`),
  );

const retiredColumnCount = async (): Promise<number> => {
  const rows = (await owner.db.execute(
    sql`SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'person' AND column_name LIKE 'emergency\_contact\_%'`,
  )) as unknown as { n: number }[];
  return Number(rows[0].n);
};

describe('23ad620e — migration 0322 leaves exactly one home for an emergency contact', () => {
  // These specs re-add the retired columns on purpose. A test that throws between the ADD and the
  // migration's DROP would leak them into the next FILE on this worker's database, so the teardown is
  // unconditional rather than trusting the happy path.
  afterEach(async () => {
    await owner.db.execute(
      sql.raw(`ALTER TABLE person
        DROP COLUMN IF EXISTS emergency_contact_name,
        DROP COLUMN IF EXISTS emergency_contact_relationship,
        DROP COLUMN IF EXISTS emergency_contact_phone,
        DROP COLUMN IF EXISTS emergency_contact_phone2,
        DROP COLUMN IF EXISTS emergency_contact_address`),
    );
  });

  it('the five retired person.emergency_contact_* columns no longer exist', async () => {
    // The refute in one assertion: a column that is still there is a column something can still write.
    expect(await retiredColumnCount()).toBe(0);
  });

  it('carries an existing single contact across as the FIRST entry, and never duplicates it on a re-run', async () => {
    const E = await hire('Carried Over');
    expect(await listEmergencyContacts(adminCtx(b), { personId: E.personId })).toEqual([]);

    // Put the person back in the pre-0322 world: the five columns exist and hold their one contact.
    await readdRetiredColumns();
    await owner.db.execute(sql`
      UPDATE person SET emergency_contact_name = '  Carried Kin  ',
                        emergency_contact_relationship = 'Spouse',
                        emergency_contact_phone = '012-7777777',
                        emergency_contact_phone2 = '03-7777777',
                        emergency_contact_address = '7 Jalan Tujuh'
      WHERE id = ${E.personId}
    `);

    await run0322();

    const carried = await listEmergencyContacts(adminCtx(b), { personId: E.personId });
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({
      fullName: 'Carried Kin', // btrim'd
      relationship: 'Spouse',
      mobilePhone: '012-7777777',
      homePhone: '03-7777777',
      address: '7 Jalan Tujuh',
      priority: 'primary', // the FIRST entry of the new list
    });
    // …and the migration took the old home away with it.
    expect(await retiredColumnCount()).toBe(0);

    // RE-RUN. The mechanism under test is the carry-over's
    //   WHERE NOT EXISTS (SELECT 1 FROM person_emergency_contact ec WHERE ec.person_id = p.id)
    // so a person who already holds ANY register row is skipped rather than given a second copy. Restoring
    // the columns with a DIFFERENT value makes the assertion sharp: a duplicate would be visible as a second
    // row, and a blind overwrite as a changed name. Neither is allowed.
    await readdRetiredColumns();
    await owner.db.execute(
      sql`UPDATE person SET emergency_contact_name = 'Stale Ghost' WHERE id = ${E.personId}`,
    );
    await run0322();

    const after = await listEmergencyContacts(adminCtx(b), { personId: E.personId });
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(carried[0].id);
    expect(after[0].fullName).toBe('Carried Kin');
  });

  it('re-running the file with the columns already dropped is a clean no-op', async () => {
    // The pg_attribute guard around the carry-over: without it the INSERT ... SELECT would fail to PARSE
    // against a person table that no longer has the source columns, and the whole migration would abort.
    const E = await hire('No Op');
    await addEmergencyContact(adminCtx(b), { personId: E.personId, fullName: 'Only Kin', priority: 'primary' });
    await run0322();
    await run0322();
    const rows = await listEmergencyContacts(adminCtx(b), { personId: E.personId });
    expect(rows.map((r) => r.fullName)).toEqual(['Only Kin']);
  });

  it('a person with nothing recorded gets an EMPTY register, not a blank contact', async () => {
    const E = await hire('Nothing Recorded');
    await readdRetiredColumns();
    await run0322();
    expect(await listEmergencyContacts(adminCtx(b), { personId: E.personId })).toEqual([]);
  });

  it('a contact recorded as a phone number with no name survives under a placeholder name', async () => {
    // full_name is NOT NULL. Dropping these rows would be silent data loss for exactly the people whose
    // record is thinnest, so the carry-over names them rather than skipping them.
    const E = await hire('Phone Only');
    await readdRetiredColumns();
    await owner.db.execute(
      sql`UPDATE person SET emergency_contact_phone = '012-8888888' WHERE id = ${E.personId}`,
    );
    await run0322();
    const rows = await listEmergencyContacts(adminCtx(b), { personId: E.personId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fullName: 'Emergency contact', mobilePhone: '012-8888888', priority: 'primary' });
  });

  it('the one-Primary rule is a DB constraint, not just a service convention', async () => {
    // Asserted BY INDEX NAME: a bare rejects.toThrow() here would pass on any error at all, including a
    // NOT NULL violation from a bad fixture, and prove nothing about the constraint under test.
    const E = await hire('Index Backstop');
    const values = (name: string) => ({
      tenantId: b.tenantId,
      personId: E.personId,
      fullName: name,
      priority: 'primary',
    });
    await owner.db.insert(schema.personEmergencyContact).values(values('First'));
    const err = await owner.db
      .insert(schema.personEmergencyContact)
      .values(values('Second'))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).not.toBeNull();
    // Drizzle wraps the driver error as `Failed query: …`, so walk the cause chain for the real one.
    let cause: unknown = err;
    const seen: string[] = [];
    while (cause) {
      seen.push(String((cause as Error).message ?? ''));
      cause = (cause as { cause?: unknown }).cause;
    }
    expect(seen.join('\n')).toContain('person_emergency_contact_one_primary_uq');
  });

  it('priority is constrained by name — an unknown value cannot reach the column', async () => {
    const E = await hire('Priority Check');
    const err = await owner.db
      .insert(schema.personEmergencyContact)
      .values({ tenantId: b.tenantId, personId: E.personId, fullName: 'Bad Priority', priority: 'urgent' })
      .then(() => null)
      .catch((e: unknown) => e);
    let cause: unknown = err;
    const seen: string[] = [];
    while (cause) {
      seen.push(String((cause as Error).message ?? ''));
      cause = (cause as { cause?: unknown }).cause;
    }
    expect(seen.join('\n')).toContain('person_emergency_contact_priority_ck');
  });
});
