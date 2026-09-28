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
  childAgeYears,
  isChildReliefEligible,
  DependentValidationError,
  type ChildReliefEligibilityRow,
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

  // Item 5988053a — the two additive education fields (study level + study country, migration 0293).
  it('child: studyLevel/studyCountry round-trip on add and edit, child-gated like schoolName', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Fam Edu');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Scholar',
      relationship: 'child',
      isStudent: true,
      schoolName: 'Sunway University',
      studyLevel: 'Degree',
      studyCountry: 'Malaysia',
    });
    let d = only(await listDependents(a, { personId: e.personId }), id);
    expect(d.studyLevel).toBe('Degree');
    expect(d.studyCountry).toBe('Malaysia');

    // Edit round-trip: change one, clear the other (blank ⇒ null via trimOrNull).
    await updateDependent(a, { id, studyLevel: 'Masters', studyCountry: '  ' });
    d = only(await listDependents(a, { personId: e.personId }), id);
    expect(d.studyLevel).toBe('Masters');
    expect(d.studyCountry).toBeNull();

    // Child-gated on ADD: for a non-child the values are validate-or-IGNOREd (stored NULL).
    const p2 = await addDependent(a, {
      personId: e.personId,
      fullName: 'Parent NotStudent',
      relationship: 'parent',
      studyLevel: 'ShouldNotStick',
      studyCountry: 'Nowhere',
    });
    const dp = only(await listDependents(a, { personId: e.personId }), p2.id);
    expect(dp.studyLevel).toBeNull();
    expect(dp.studyCountry).toBeNull();
  });

  it('changing a child’s relationship to other nulls both education columns', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Fam EduRel');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Was Child',
      relationship: 'child',
      schoolName: 'SMK Subang',
      studyLevel: 'SPM',
      studyCountry: 'Malaysia',
    });
    await updateDependent(a, { id, relationship: 'other' });
    const d = only(await listDependents(a, { personId: e.personId }), id);
    expect(d.relationship).toBe('other');
    expect(d.schoolName).toBeNull();
    expect(d.studyLevel).toBeNull();
    expect(d.studyCountry).toBeNull();
  });

  it('dependent.updated diff carries the education field NAMES only — never the values', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Fam EduEvent');
    const { id } = await addDependent(a, {
      personId: e.personId,
      fullName: 'Edu Event',
      relationship: 'child',
    });
    await updateDependent(a, { id, studyLevel: 'SECRET-LEVEL', studyCountry: 'SECRET-COUNTRY' });
    const payload = await latestEventPayload(base.tenantId, id, 'dependent.updated');
    const blob = JSON.stringify(payload ?? {});
    expect(blob).toContain('studyLevel');
    expect(blob).toContain('studyCountry');
    expect(blob).not.toContain('SECRET-LEVEL');
    expect(blob).not.toContain('SECRET-COUNTRY');
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

// Item 5988053a — the per-row eligibility predicate extracted from eligibleChildReliefCount (pure, DB-free).
// These pin the shared rule the Family tab's "Counts toward tax relief" column AND the payroll head count
// both read; test/dependents.test.ts must keep passing UNCHANGED as proof the extraction is
// behaviour-preserving for the aggregate count.
describe('isChildReliefEligible / childAgeYears (5988053a, pure)', () => {
  const asOf = new Date('2026-07-21T00:00:00Z');
  const child = (over: Partial<ChildReliefEligibilityRow>): ChildReliefEligibilityRow => ({
    relationship: 'child',
    dateOfBirth: null,
    isStudent: null,
    isDeceased: false,
    archivedAt: null,
    childTaxRelief: null,
    ...over,
  });

  it('under 18 (by DOB) is eligible', () => {
    expect(isChildReliefEligible(child({ dateOfBirth: '2015-01-01' }), asOf)).toBe(true);
  });

  it('18-plus student is eligible; 18-plus non-student is not', () => {
    expect(isChildReliefEligible(child({ dateOfBirth: '2005-01-01', isStudent: true }), asOf)).toBe(true);
    expect(isChildReliefEligible(child({ dateOfBirth: '2005-01-01', isStudent: false }), asOf)).toBe(false);
  });

  // ⚠️ r355 (77e882f5) — THIS CASE IS HALF REVERSED, BY THE OWNER, AND THE OLD CLAIM IS QUOTED HERE
  // RATHER THAN DELETED.
  //
  // It read: "an explicit childTaxRelief decision overrides the inference in BOTH directions", and it
  // asserted that a ticked 18-plus non-student "still counts". That was item 6c635212's rule and it was
  // load-bearing — the tick was the only way to claim a disabled or studying child over 18.
  //
  // The owner reversed the TRUE direction: "The Claim tax relief checkbox should indicate the user's
  // intention to claim the relief, but it must not override the statutory eligibility validation."
  // A tick is now consent; the record must justify it. The over-18 cases the old rule protected are
  // carried by `childReliefCategory` instead, which is asserted in the case below this one.
  //
  // THE FALSE DIRECTION IS UNCHANGED and is still asserted: an explicit no refuses at any age.
  it('an explicit NO still refuses at any age; an explicit YES is now consent, not an override', () => {
    // REVERSED: a ticked 18-plus non-student with no qualifying category NO LONGER counts.
    expect(
      isChildReliefEligible(child({ dateOfBirth: '2000-01-01', isStudent: false, childTaxRelief: true }), asOf),
      'was true before r355 — the tick used to win outright',
    ).toBe(false);
    // UNCHANGED: an under-18 child is explicitly opted out.
    expect(
      isChildReliefEligible(child({ dateOfBirth: '2020-01-01', childTaxRelief: false }), asOf),
    ).toBe(false);
  });

  it('a ticked 18-plus child counts when a relief category justifies it — the route the old override served', () => {
    for (const childReliefCategory of ['disabled', 'disabled_study', 'study_tertiary', 'study_preu']) {
      expect(
        isChildReliefEligible(
          child({ dateOfBirth: '2000-01-01', isStudent: false, childTaxRelief: true, childReliefCategory }),
          asOf,
        ),
        `${childReliefCategory} justifies a claim past 18`,
      ).toBe(true);
    }
    // `under_18` is the one category that cannot justify an over-18 claim — it asserts the opposite.
    expect(
      isChildReliefEligible(
        child({ dateOfBirth: '2000-01-01', isStudent: false, childTaxRelief: true, childReliefCategory: 'under_18' }),
        asOf,
      ),
    ).toBe(false);
  });

  it('a NEVER-TICKED child keeps the pre-r355 inference — legacy rows do not drop out', () => {
    // null is most legacy rows; reading it as "not claimed" would remove every one of them from relief
    // in a single nightly resync. Deliberately left alone.
    expect(isChildReliefEligible(child({ dateOfBirth: '2020-01-01', childTaxRelief: null }), asOf)).toBe(true);
    expect(isChildReliefEligible(child({ dateOfBirth: '2000-01-01', childTaxRelief: null }), asOf)).toBe(false);
    expect(
      isChildReliefEligible(child({ dateOfBirth: '2000-01-01', isStudent: true, childTaxRelief: null }), asOf),
    ).toBe(true);
  });

  it('deceased and archived children are excluded, and only child rows count at all', () => {
    expect(isChildReliefEligible(child({ dateOfBirth: '2020-01-01', isDeceased: true }), asOf)).toBe(false);
    expect(
      isChildReliefEligible(child({ dateOfBirth: '2020-01-01', archivedAt: new Date('2025-01-01') }), asOf),
    ).toBe(false);
    expect(
      isChildReliefEligible(child({ relationship: 'spouse', dateOfBirth: '2020-01-01' }), asOf),
    ).toBe(false);
  });

  it('missing or invalid DOB cannot confirm the age, so it is not auto-counted', () => {
    expect(isChildReliefEligible(child({ dateOfBirth: null }), asOf)).toBe(false);
    expect(isChildReliefEligible(child({ dateOfBirth: 'not-a-date' }), asOf)).toBe(false);
    // ...but a student without a DOB still counts (the 18+ in-education case needs no age).
    expect(isChildReliefEligible(child({ dateOfBirth: null, isStudent: true }), asOf)).toBe(true);
  });

  it('childAgeYears floors to whole years and is null for no/invalid DOB', () => {
    expect(childAgeYears('2015-07-22', asOf)).toBe(10); // 11th birthday is tomorrow as of asOf
    expect(childAgeYears('2008-07-01', asOf)).toBe(18);
    expect(childAgeYears(null, asOf)).toBeNull();
    expect(childAgeYears(undefined, asOf)).toBeNull();
    expect(childAgeYears('nonsense', asOf)).toBeNull();
  });
});
