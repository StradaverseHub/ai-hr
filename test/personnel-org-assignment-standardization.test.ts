/**
 * Personnel Organisation Assignment standardization (feedback 1001ff61).
 *
 * Two threads:
 *  (A) Business Unit is now a dimension of the effective-dated assignment: setEmploymentAssignment accepts a
 *      businessUnitId, persists it, carries it forward on unrelated edits, includes it in the
 *      employment.assignment.changed before/after payload, surfaces it in assignmentHistory, and rejects a BU
 *      that is archived or belongs to another company (referential integrity + company scope).
 *  (B) The eight org/job fields (division/branch/region/line/section/team/base + employment category) are
 *      System-Labels dropdowns backed by profile_option categories: setEmploymentInfo validates a changed
 *      value against the ACTIVE catalog (rejecting inactive/unknown), tolerates the unchanged legacy value,
 *      keeps free-text behaviour while the catalog is empty, and the in-use delete guard protects a value
 *      still stored on an employment column.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee, setEmploymentAssignment, setEmploymentInfo } from '../core/org';
import { createBusinessUnit, archiveBusinessUnit, setCompanySharedLabels } from '../core/admin';
import { assignLabelToCompanies } from '../core/system-labels';
import { assignmentHistory } from '../core/read';
import {
  PROFILE_OPTION_CATEGORIES,
  EMPLOYMENT_PROFILE_CATEGORIES,
  createProfileOption,
  setProfileOptionActive,
  deleteProfileOption,
  listAllProfileOptions,
  ProfileOptionInUseError,
} from '../core/profile-options';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `orgstd_${randomUUID().slice(0, 8)}@t.local`;

async function openRow(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    )
    .limit(1);
  return row;
}

async function hireOne() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Org Std', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

describe('1001ff61 — catalog wiring', () => {
  it('registers the eight org/job categories on the profile_option catalog', () => {
    for (const c of ['division', 'branch', 'region', 'line', 'section', 'team', 'base', 'category'] as const) {
      expect(PROFILE_OPTION_CATEGORIES).toContain(c);
      expect(EMPLOYMENT_PROFILE_CATEGORIES).toContain(c);
    }
    // The person-profile categories are still present (additive change).
    expect(PROFILE_OPTION_CATEGORIES).toContain('religion');
  });

  it('listAllProfileOptions returns a bucket for every new category', async () => {
    const all = await listAllProfileOptions(adminCtx(b), { activeOnly: false });
    for (const c of EMPLOYMENT_PROFILE_CATEGORIES) {
      expect(Array.isArray(all[c])).toBe(true);
    }
  });
});

describe('1001ff61 (A) — Business Unit on the assignment', () => {
  it('persists a BU, audits before/after, and surfaces it in assignmentHistory', async () => {
    const hire = await hireOne();
    const bu = await createBusinessUnit(adminCtx(b), { companyId: b.companyId, code: `BU${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Retail Division' });

    const before = await openRow(hire.employmentId);
    expect(before.businessUnitId).toBeNull();

    const res = await setEmploymentAssignment(adminCtx(b), {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      businessUnitId: bu.id,
    });
    expect(res.changed).toBe(true);

    const open = await openRow(hire.employmentId);
    expect(open.id).not.toBe(before.id);
    expect(open.businessUnitId).toBe(bu.id);
    // Unrelated dimensions carried forward.
    expect(open.departmentId).toBe(b.deptA);
    expect(open.positionId).toBe(b.positionId);

    const payload = (await latestEventPayload(b.tenantId, open.id, 'employment.assignment.changed')) as any;
    expect(payload.before.businessUnitId).toBeNull();
    expect(payload.after.businessUnitId).toBe(bu.id);

    const hist = await assignmentHistory(adminCtx(b), hire.employmentId);
    expect(hist[0].businessUnitId).toBe(bu.id);
  });

  it('carries the BU forward on an unrelated edit (status only)', async () => {
    const hire = await hireOne();
    const bu = await createBusinessUnit(adminCtx(b), { companyId: b.companyId, code: `BU${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Ops BU' });
    await setEmploymentAssignment(adminCtx(b), { employmentId: hire.employmentId, effectiveDate: '2026-03-01', businessUnitId: bu.id });
    await setEmploymentAssignment(adminCtx(b), { employmentId: hire.employmentId, effectiveDate: '2026-04-01', status: 'on_leave' });
    const open = await openRow(hire.employmentId);
    expect(open.status).toBe('on_leave');
    expect(open.businessUnitId).toBe(bu.id); // carried forward
  });

  it('is a no-op when the BU is unchanged', async () => {
    const hire = await hireOne();
    const bu = await createBusinessUnit(adminCtx(b), { companyId: b.companyId, code: `BU${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Stable BU' });
    await setEmploymentAssignment(adminCtx(b), { employmentId: hire.employmentId, effectiveDate: '2026-02-01', businessUnitId: bu.id });
    const res = await setEmploymentAssignment(adminCtx(b), { employmentId: hire.employmentId, effectiveDate: '2026-05-01', businessUnitId: bu.id });
    expect(res.changed).toBe(false);
  });

  it('clears the BU when passed null', async () => {
    const hire = await hireOne();
    const bu = await createBusinessUnit(adminCtx(b), { companyId: b.companyId, code: `BU${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Clearable BU' });
    await setEmploymentAssignment(adminCtx(b), { employmentId: hire.employmentId, effectiveDate: '2026-02-01', businessUnitId: bu.id });
    const res = await setEmploymentAssignment(adminCtx(b), { employmentId: hire.employmentId, effectiveDate: '2026-05-01', businessUnitId: null });
    expect(res.changed).toBe(true);
    const open = await openRow(hire.employmentId);
    expect(open.businessUnitId).toBeNull();
  });

  it('rejects an archived BU', async () => {
    const hire = await hireOne();
    const bu = await createBusinessUnit(adminCtx(b), { companyId: b.companyId, code: `BU${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Dead BU' });
    await archiveBusinessUnit(adminCtx(b), { id: bu.id, archived: true });
    await expect(
      setEmploymentAssignment(adminCtx(b), { employmentId: hire.employmentId, effectiveDate: '2026-06-01', businessUnitId: bu.id }),
    ).rejects.toThrow(/not a valid option/i);
  });

  it('rejects a BU from another company (company scope)', async () => {
    const hire = await hireOne();
    // A second company in the same tenant, with its own BU.
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Other Co Sdn Bhd' })
      .returning({ id: schema.company.id });
    const foreignBu = await createBusinessUnit(adminCtx(b), { companyId: c2.id, code: `BU${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Foreign BU' });
    await expect(
      setEmploymentAssignment(adminCtx(b), { employmentId: hire.employmentId, effectiveDate: '2026-06-01', businessUnitId: foreignBu.id }),
    ).rejects.toThrow(/not a valid option/i);
  });

  it("accepts a shared-in BU when the target company's flag is ON (570e3311)", async () => {
    const hire = await hireOne();
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'BU Sharing Co Sdn Bhd' })
      .returning({ id: schema.company.id });
    const sharedBu = await createBusinessUnit(adminCtx(b), { companyId: c2.id, code: `BU${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Shared-In BU' });
    await assignLabelToCompanies(adminCtx(b), { kind: 'business_unit', labelId: sharedBu.id, companyIds: [b.companyId] });
    // Flag ON for the employee's company → the resolver surfaces the shared-in BU as a valid option.
    await setCompanySharedLabels(adminCtx(b), { companyId: b.companyId, enabled: true });
    try {
      const res = await setEmploymentAssignment(adminCtx(b), {
        employmentId: hire.employmentId,
        effectiveDate: '2026-06-01',
        businessUnitId: sharedBu.id,
      });
      expect(res.changed).toBe(true);
      const open = await openRow(hire.employmentId);
      expect(open.businessUnitId).toBe(sharedBu.id);
    } finally {
      // Restore the flag: this suite seeds once (beforeAll), so later strict-scope tests must not
      // observe the opt-in.
      await setCompanySharedLabels(adminCtx(b), { companyId: b.companyId, enabled: false });
    }
  });
});

describe('1001ff61 (B) — org/job fields validate against the catalog', () => {
  it('accepts an ACTIVE catalog value and persists it', async () => {
    const hire = await hireOne();
    const val = `Div ${randomUUID().slice(0, 5)}`;
    await createProfileOption(adminCtx(b), { category: 'division', value: val });
    await setEmploymentInfo(adminCtx(b), { employmentId: hire.employmentId, orgDivision: val });
    const [emp] = await owner.db
      .select({ orgDivision: schema.employment.orgDivision })
      .from(schema.employment)
      .where(eq(schema.employment.id, hire.employmentId))
      .limit(1);
    expect(emp.orgDivision).toBe(val);
    expect(await eventTypesFor(b.tenantId, hire.employmentId)).toContain('employment.info.updated');
  });

  it('rejects a value that is not an active option (once the catalog has options)', async () => {
    const hire = await hireOne();
    await createProfileOption(adminCtx(b), { category: 'branch', value: `HQ ${randomUUID().slice(0, 5)}` });
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: hire.employmentId, orgBranch: 'Totally Made Up Branch' }),
    ).rejects.toThrow(/not an active branch option/i);
  });

  it('rejects a DEACTIVATED option but tolerates re-saving the unchanged legacy value', async () => {
    const hire = await hireOne();
    const val = `Sec ${randomUUID().slice(0, 5)}`;
    const created = await createProfileOption(adminCtx(b), { category: 'section', value: val });
    // A second, always-active option so the catalog is non-empty (else free-text tolerance would apply).
    await createProfileOption(adminCtx(b), { category: 'section', value: `Live ${randomUUID().slice(0, 5)}` });
    // Store it while active.
    await setEmploymentInfo(adminCtx(b), { employmentId: hire.employmentId, orgSection: val });
    // Deactivate it.
    await setProfileOptionActive(adminCtx(b), { id: created.id, isActive: false });
    // Re-saving the SAME (now inactive) stored value is tolerated (no blanking).
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: hire.employmentId, orgSection: val }),
    ).resolves.toBeTruthy();
    // But selecting a *different* value that is inactive/unknown is rejected.
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: hire.employmentId, orgSection: 'Unknown Section' }),
    ).rejects.toThrow(/not an active section option/i);
  });

  it('keeps free-text behaviour while a category has no active options (backward compat)', async () => {
    const hire = await hireOne();
    // `region` catalog is empty for this test path → any value is accepted (legacy tolerance).
    await setEmploymentInfo(adminCtx(b), { employmentId: hire.employmentId, orgRegion: 'Legacy Region Free Text' });
    const [emp] = await owner.db
      .select({ orgRegion: schema.employment.orgRegion })
      .from(schema.employment)
      .where(eq(schema.employment.id, hire.employmentId))
      .limit(1);
    expect(emp.orgRegion).toBe('Legacy Region Free Text');
  });

  it('the delete guard blocks removing a value still stored on an employment column', async () => {
    const hire = await hireOne();
    const val = `Team ${randomUUID().slice(0, 5)}`;
    const created = await createProfileOption(adminCtx(b), { category: 'team', value: val });
    await setEmploymentInfo(adminCtx(b), { employmentId: hire.employmentId, orgTeam: val });
    await expect(deleteProfileOption(adminCtx(b), created.id)).rejects.toBeInstanceOf(ProfileOptionInUseError);
  });
});
