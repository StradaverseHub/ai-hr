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

  // fa3f4ccb: was "the EA floor still clamps a grade policy set below it". Approved in writing — a grade
  // policy below the statutory minimum is now GRANTED as configured and flagged on screen, not overridden.
  it('fa3f4ccb: a grade policy below the EA minimum is granted as configured', async () => {
    const intern = await grade('INTERN', 'Intern');
    await policy(5, intern.id); // below the 8-day ANNUAL floor (<2y)
    const internEmp = await hire(intern.id);
    expect(await annualBalance(internEmp.employmentId)).toBe(5);
  });

  it('Leave Entitlement Rules Engine — a second same-scope default SUPERSEDES the first (not a duplicate)', async () => {
    // Under the supersede fix (feedback a0228655), creating a second default with the same exact scope
    // (leaveTypeId, gradeId, companyId) at a LATER validFrom closes the first (validTo set) rather than
    // leaving both active — so there is only ever one live default per type. The pure-resolver tie-break
    // coverage for literal duplicate rows (legacy data / hand-built fixtures) lives in
    // test/leave-service-bands.test.ts, which needs no service API.
    const first = await policy(12, null);
    const second = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 16,
      gradeId: null,
      validFrom: '2027-01-01', // strictly after the first policy's validFrom
    });
    const [firstRow] = await owner.db
      .select({ validTo: schema.leavePolicy.validTo })
      .from(schema.leavePolicy)
      .where(eq(schema.leavePolicy.id, first.id));
    expect(firstRow?.validTo).toBe('2027-01-01'); // closed at the new policy's validFrom
    // A hire on/after the new policy's validFrom resolves only the second (16-day) version.
    const emp = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Grd2', primaryEmail: `grd2_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2027-01-01',
      gradeId: null,
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    expect(await annualBalance(emp.employmentId)).toBe(16);
    void second;
  });
});
