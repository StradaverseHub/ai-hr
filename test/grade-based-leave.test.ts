/**
 * ADR-0041 2E — grade-based leave entitlements. A grade-scoped leave_policy gives an employee of that
 * grade a different entitlement; ungraded employees (or graded employees with no matching policy) fall
 * to the most-generous null-grade (company-default) policy. The EA floor still clamps everything, so a
 * grade policy below the floor never lowers the statutory minimum. With no grades, behaviour is unchanged.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createJobGrade, createLeavePolicy } from '../core/admin';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const annualBalance = async (employmentId: string) => {
  const [r] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId)));
  return Number(r.bal);
};
const grade = (code: string, name: string) => createJobGrade(adminCtx(b), { code, name });
const policy = (annualDays: number, gradeId: string | null) =>
  createLeavePolicy(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays, gradeId, validFrom: '2026-01-01' });
// Hire on 1 Jan so ANNUAL grants in full (no mid-year pro-ration) → the balance IS the entitlement.
const hire = (gradeId: string | null) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Grd', primaryEmail: `grd_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
    gradeId,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
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

describe('ADR-0041 2E — grade-based leave entitlements', () => {
  it('a graded employee gets the grade-specific policy; an ungraded one gets the company default', async () => {
    const exec = await grade('EXEC', 'Executive');
    await policy(12, null); // company default
    await policy(18, exec.id); // executives earn more
    const execEmp = await hire(exec.id);
    const staffEmp = await hire(null);
    expect(await annualBalance(execEmp.employmentId)).toBe(18);
    expect(await annualBalance(staffEmp.employmentId)).toBe(12);
  });

  it('a graded employee with no matching grade policy falls back to the company default', async () => {
    const exec = await grade('EXEC', 'Executive');
    await policy(12, null); // only a default exists
    const execEmp = await hire(exec.id);
    expect(await annualBalance(execEmp.employmentId)).toBe(12);
  });

  it('the EA floor still clamps a grade policy set below it', async () => {
    const intern = await grade('INTERN', 'Intern');
    await policy(5, intern.id); // below the 8-day ANNUAL floor (<2y)
    const internEmp = await hire(intern.id);
    expect(await annualBalance(internEmp.employmentId)).toBe(8); // max(floor 8, policy 5)
  });

  it('with no grades, resolution is unchanged (most-generous default applies)', async () => {
    await policy(12, null);
    await policy(16, null); // a second, more generous default
    const emp = await hire(null);
    expect(await annualBalance(emp.employmentId)).toBe(16);
  });
});
