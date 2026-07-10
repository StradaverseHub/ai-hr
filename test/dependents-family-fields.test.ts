/**
 * 4535b733 — Family Information enhancement. Covers the NEW fields on employee_dependent: full-field
 * add + edit round-trips, the relationship-gating of spouse-only (marriage / spouse employment) and
 * child-only (student / school) columns, marriage-status validation, the tri-state boolean columns,
 * DomainEvent diff carrying only field NAMES (no PII values, ADR-0030 Layer 0), and the PDPA erasure of
 * the new dependent PII (contact + identity scopes) added to core/pdpa.ts.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  listDependents,
  addDependent,
  updateDependent,
  DependentValidationError,
  type DependentRow,
} from '../core/dependents';
import { erasePersonPii } from '../core/pdpa';
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
import type { SessionContext } from '../db/client';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const only = (rows: DependentRow[], id: string) => rows.find((r) => r.id === id)!;

describe('Personnel — Family Information enhancement (4535b733)', () => {
  let base: Base;
  beforeAll(async () => {
    process.env.AI_CONFIG_SECRET = 'test-pii-master-passphrase-0123456789';
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    delete process.env.AI_CONFIG_SECRET;
    await closeAll();
  });

  it('spouse: add + edit persists all new spouse fields', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Fam Spouse');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Aisha',
      relationship: 'spouse',
      gender: 'female',
      phone: '+60123334444',
      icOrPassport: '900101015555',
      passportNumber: 'A9876543',
      residentialAddress: '10 Jln Melati',
      marriageDate: '2018-06-06',
      marriageStatus: 'married',
      spouseWorking: true,
      occupation: 'Engineer',
      companyName: 'Acme Eng',
      employerAddress: '1 Tech Park',
      isBeneficiary: true,
    });
    let d = only(await listDependents(a, { personId: e.personId }), id);
    expect(d.passportNumber).toBe('A9876543');
    expect(d.residentialAddress).toBe('10 Jln Melati');
    expect(d.marriageDate).toBe('2018-06-06');
    expect(d.marriageStatus).toBe('married');
    expect(d.spouseWorking).toBe(true);
    expect(d.occupation).toBe('Engineer');
    expect(d.companyName).toBe('Acme Eng');
    expect(d.employerAddress).toBe('1 Tech Park');
    expect(d.isDeceased).toBe(false);

    // Full-field edit (the reporter's #1: edit in place, all fields).
    await updateDependent(a, {
      id,
      marriageStatus: 'separated',
      spouseWorking: false,
      companyName: null,
      passportNumber: 'B1112223',
    });
    d = only(await listDependents(a, { personId: e.personId }), id);
    expect(d.marriageStatus).toBe('separated');
    expect(d.spouseWorking).toBe(false);
    expect(d.companyName).toBeNull();
    expect(d.passportNumber).toBe('B1112223');
  });

  it('child: student/school persist; spouse-only fields are ignored for a child', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Fam Child');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Junior',
      relationship: 'child',
      isStudent: true,
      schoolName: 'SK Damansara',
      // spouse-only fields sent for a child → validate-or-IGNORE (stored NULL).
      marriageStatus: 'married',
      companyName: 'ShouldNotStick',
    });
    const d = only(await listDependents(a, { personId: e.personId }), id);
    expect(d.isStudent).toBe(true);
    expect(d.schoolName).toBe('SK Damansara');
    expect(d.marriageStatus).toBeNull();
    expect(d.companyName).toBeNull();
  });

  it('deceased status is a tri-state boolean, defaulting false and settable', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Fam Deceased');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Grandpa',
      relationship: 'parent',
      isDeceased: true,
      deceasedOn: '2024-03-03',
      occupation: 'Retired',
    });
    const d = only(await listDependents(a, { personId: e.personId }), id);
    expect(d.isDeceased).toBe(true);
    expect(d.deceasedOn).toBe('2024-03-03');
    expect(d.occupation).toBe('Retired');
  });

  it('rejects an invalid marriage status for a spouse', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Fam BadMarr');
    await expect(
      addDependent(a, {
        personId: e.personId,
        fullName: 'X',
        relationship: 'spouse',
        marriageStatus: 'engaged',
      }),
    ).rejects.toThrow(DependentValidationError);
  });

  it('changing relationship away from spouse clears the now-irrelevant spouse fields', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Fam Reassign');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Was Spouse',
      relationship: 'spouse',
      marriageStatus: 'married',
      companyName: 'Acme',
      spouseWorking: true,
    });
    await updateDependent(a, { id, relationship: 'other' });
    const d = only(await listDependents(a, { personId: e.personId }), id);
    expect(d.relationship).toBe('other');
    expect(d.marriageStatus).toBeNull();
    expect(d.companyName).toBeNull();
    expect(d.spouseWorking).toBeNull();
  });

  it('DomainEvent update diff lists new field NAMES only — never the PII values', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Fam Event');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Priya',
      relationship: 'spouse',
    });
    await updateDependent(a, {
      id,
      passportNumber: 'SECRET-PP-001',
      residentialAddress: 'SECRET-ADDR',
      marriageStatus: 'married',
    });
    const payload = await latestEventPayload(base.tenantId, id, 'dependent.updated');
    const blob = JSON.stringify(payload ?? {});
    expect(blob).toContain('passportNumber');
    expect(blob).toContain('residentialAddress');
    expect(blob).toContain('marriageStatus');
    expect(blob).not.toContain('SECRET-PP-001');
    expect(blob).not.toContain('SECRET-ADDR');
  });

  it('PDPA: erases the new dependent PII across the person’s rows (contact + identity scopes)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Fam Erase');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Spouse PII',
      relationship: 'spouse',
      phone: '+60177778888',
      icOrPassport: '880808085555',
      passportNumber: 'Z1234567',
      residentialAddress: '5 Jln Erase',
      companyName: 'EraseCo',
      employerAddress: '9 Erase Rd',
    });
    const emp = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(eq(schema.employment.personId, e.personId))
      .limit(1);

    const r = await erasePersonPii(a, {
      subjectEmploymentId: emp[0].id,
      scope: 'all',
      reason: 'subject request',
      requestRef: 'DPO-DEP',
    });
    expect(r.erased).toEqual(
      expect.arrayContaining([
        'dependent.phone',
        'dependent.residentialAddress',
        'dependent.companyName',
        'dependent.employerAddress',
        'dependent.icOrPassport',
        'dependent.passportNumber',
      ]),
    );
    const d = only(await listDependents(a, { personId: e.personId }), id);
    expect(d.phone).toBeNull();
    expect(d.residentialAddress).toBeNull();
    expect(d.companyName).toBeNull();
    expect(d.employerAddress).toBeNull();
    expect(d.icOrPassport).toBeNull();
    expect(d.passportNumber).toBeNull();
    // Non-PII fields (name/relationship) are retained.
    expect(d.fullName).toBe('Spouse PII');
    expect(d.relationship).toBe('spouse');
  });
});
