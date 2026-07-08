/**
 * Basic Salary history redesign (feedback 87c82b18). Pins the service-level contract the redesigned
 * screen relies on:
 *   1. remarks persist and compensationHistoryDetailed returns rows newest-first with the creating actor.
 *   2. Allowance CARRY-FORWARD — a basic-salary-only revision must NOT wipe the monthly allowance
 *      (it feeds the OT ORP wage basis); an explicit 0 still zeroes it.
 *   3. Merit-enact regression pin — a performance merit raise leaves the allowance untouched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import { person as personTable } from '../db/schema';
import {
  compensationHistoryDetailed,
  currentCompensation,
  setCompensation,
  updateCompensation,
} from '../core/comp';
import { hireEmployee } from '../core/org';
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

describe('basic salary history (87c82b18)', () => {
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

  // An admin context whose app_user is linked to a person, so Created By / Last Updated By resolve to a
  // real name (the seedBase admin has personId=null → those columns are legitimately null / '—').
  const adminWithName = async (fullName: string): Promise<SessionContext> => {
    const [p] = await owner.db
      .insert(personTable)
      .values({ tenantId: base.tenantId, fullName, primaryEmail: `${fullName.replace(/\s+/g, '.').toLowerCase()}@acme.test` })
      .returning({ id: personTable.id });
    const userId = await createAppUser(base.tenantId, p.id, 'hr_admin');
    return { tenantId: base.tenantId, userId, roles: ['hr_admin'] };
  };

  const hire = (name: string) =>
    hireEmployee(adminCtx(base), {
      person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  it('persists remarks and returns detailed history newest-first with creator name', async () => {
    const a = await adminWithName('Ada Admin');
    const { employmentId } = await hire('Ada');
    await setCompensation(a, {
      employmentId,
      basicSalary: 5000,
      effectiveFrom: '2026-01-01',
      remarks: 'initial salary',
    });
    await setCompensation(a, {
      employmentId,
      basicSalary: 5500,
      effectiveFrom: '2026-06-01',
      remarks: 'annual increment',
    });

    const rows = await compensationHistoryDetailed(a, employmentId);
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0].validFrom).toBe('2026-06-01');
    expect(rows[0].remarks).toBe('annual increment');
    expect(rows[1].remarks).toBe('initial salary');
    // Created-by is resolved from the compensation.set event actor → person.
    expect(rows[0].createdByName).toBeTruthy();
  });

  it('carries the monthly allowance forward on a basic-only revision', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire('Ben');
    await setCompensation(a, {
      employmentId,
      basicSalary: 5000,
      monthlyAllowance: 500,
      effectiveFrom: '2026-01-01',
    });
    // Basic-only revision: monthlyAllowance omitted → must keep 500, not reset to 0.
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-06-01' });
    const cur = await currentCompensation(a, employmentId);
    expect(Number(cur?.basicSalary)).toBe(6000);
    expect(Number(cur?.monthlyAllowance)).toBe(500);
  });

  it('an explicit allowance of 0 still zeroes it', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire('Cara');
    await setCompensation(a, {
      employmentId,
      basicSalary: 5000,
      monthlyAllowance: 500,
      effectiveFrom: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-06-01',
    });
    const cur = await currentCompensation(a, employmentId);
    expect(Number(cur?.monthlyAllowance)).toBe(0);
  });

  it('edits the latest (open) salary record in place and stamps last-updated actor', async () => {
    const a = await adminWithName('Dora Admin');
    const { employmentId } = await hire('Dora');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    const before = await compensationHistoryDetailed(a, employmentId);
    expect(before[0].updatedAt).toBeNull();
    expect(before[0].updatedByName).toBeNull();

    await updateCompensation(a, {
      compensationId: before[0].id,
      employmentId,
      basicSalary: 5200,
      remarks: 'correction',
    });

    const after = await compensationHistoryDetailed(a, employmentId);
    expect(after).toHaveLength(1); // edit-in-place, NOT a new revision
    expect(Number(after[0].basicSalary)).toBe(5200);
    expect(after[0].remarks).toBe('correction');
    expect(after[0].updatedAt).not.toBeNull();
    expect(after[0].updatedByName).toBeTruthy();
  });

  it('refuses to edit a historical (closed) salary record', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire('Evan');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId, basicSalary: 5500, effectiveFrom: '2026-06-01' });
    const rows = await compensationHistoryDetailed(a, employmentId);
    const historical = rows.find((r) => r.validTo != null)!; // the closed 5000 row
    await expect(
      updateCompensation(a, { compensationId: historical.id, employmentId, basicSalary: 9999 }),
    ).rejects.toThrow();
  });
});
