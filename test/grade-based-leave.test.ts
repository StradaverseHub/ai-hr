/**
 * ADR-0041 2E — grade-based leave entitlements. An entitlement scoped to a grade gives an employee of that
 * grade a different entitlement; ungraded employees (and graded employees no grade-scoped entitlement
 * reaches) fall to the unrestricted company-default one. A grade entitlement below the statutory minimum is
 * granted as configured (fa3f4ccb). With no grades, behaviour is unchanged.
 *
 * 6e9a126e RELEASE THREE — REPOINTED, and this file is the clearest case in the release of why "repoint"
 * and not "retire": every number below is unchanged. The grade-scoped `leave_policy` row is gone, but what
 * it MEANT — "employees of this grade get these days from this date" — is an entitlement template plus an
 * eligibility rule narrowed to that grade, which is exactly what `seedEntitlement({ gradeId })` writes.
 *
 * ⚠️ THE PRECEDENCE IS DECIDED SOMEWHERE ELSE NOW, and that is the one thing worth reading closely. A
 * grade-scoped leave_policy row beat a grade-less one by HAVING A GRADE — the resolver tiered on the column.
 * Here BOTH rules match an Executive: the grade rule (criteria `{gradeIds:[exec]}`) and the default rule
 * (criteria `{}`, which means everyone). The grade rule wins because it is MORE SPECIFIC
 * (core/entitlement-template.ts, orgCriteriaSpecificity). Same answer, different mechanism — so these
 * assertions are load-bearing in a way they were not before: they are now the end-to-end proof that
 * specificity reproduces the old tiering rather than merely a restatement of it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createJobGrade } from '../core/admin';
import { updateEntitlementTemplate } from '../core/entitlement-template';
import {
  adminCtx,
  closeAll,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';

let b: Base;
const annualBalance = async (employmentId: string) => {
  const [r] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId)));
  return Number(r.bal);
};
const grade = (code: string, name: string) => createJobGrade(adminCtx(b), { code, name });
/** Was `createLeavePolicy({ annualDays, gradeId })`: a template holding the days + a rule holding the who.
 *  The NAME is passed explicitly because a named table is now a first-class object: one running version per
 *  (tenant, leave type, name) is a partial-unique index, so two fixtures for one leave type must be two
 *  differently-named tables — which is the point of the layer, not an obstacle to it. */
const policy = (annualDays: number, gradeId: string | null) =>
  seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays,
    gradeId,
    validFrom: '2026-01-01',
    name: gradeId ? `Grade table ${annualDays}` : `Default table ${annualDays}`,
  });
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
  it('a graded employee gets the grade-specific entitlement; an ungraded one gets the company default', async () => {
    const exec = await grade('EXEC', 'Executive');
    await policy(12, null); // company default — an unrestricted rule, i.e. everyone
    await policy(18, exec.id); // executives earn more — a rule narrowed to one grade
    const execEmp = await hire(exec.id);
    const staffEmp = await hire(null);
    // BOTH rules match the Executive; the narrower one wins on specificity, not on having a grade column.
    expect(await annualBalance(execEmp.employmentId)).toBe(18);
    expect(await annualBalance(staffEmp.employmentId)).toBe(12);
  });

  it('a graded employee no grade-scoped entitlement reaches falls back to the company default', async () => {
    const exec = await grade('EXEC', 'Executive');
    await policy(12, null); // only a default exists
    const execEmp = await hire(exec.id);
    expect(await annualBalance(execEmp.employmentId)).toBe(12);
  });

  // fa3f4ccb: was "the EA floor still clamps a grade policy set below it". Approved in writing — a grade
  // entitlement below the statutory minimum is now GRANTED as configured and flagged on screen, not
  // overridden. Unchanged by the storage move: the floor stopped clamping in the ENGINE, not in the table.
  it('fa3f4ccb: a grade entitlement below the EA minimum is granted as configured', async () => {
    const intern = await grade('INTERN', 'Intern');
    await policy(5, intern.id); // below the 8-day ANNUAL floor (<2y)
    const internEmp = await hire(intern.id);
    expect(await annualBalance(internEmp.employmentId)).toBe(5);
  });

  it('Leave Entitlement Rules Engine — an edit SUPERSEDES the running version (it is never a duplicate)', async () => {
    // Under the supersede fix (feedback a0228655) a second same-scope default at a LATER validFrom closed
    // the first rather than leaving both active. The template layer keeps that model exactly — see
    // updateEntitlementTemplate, whose own note calls itself "identical shape to createLeavePolicy's
    // supersede loop" — with one difference worth stating: a lineage makes it explicit. The successor is an
    // edit of the SAME named table, so the eligibility rule pointing at the lineage needs no re-save, where
    // before "same scope" was inferred from three columns matching. The pure-resolver tie-break coverage
    // for literal duplicate rows lives in test/leave-service-bands.test.ts, which needs no service API.
    const first = await policy(12, null);
    await updateEntitlementTemplate(adminCtx(b), {
      lineageId: first.lineageId,
      serviceBands: [{ fromYears: 0, toYears: null, days: 16 }],
      validFrom: '2027-01-01', // strictly after the running version's validFrom
    });
    const [firstRow] = await owner.db
      .select({ validTo: schema.entitlementTemplate.validTo })
      .from(schema.entitlementTemplate)
      .where(eq(schema.entitlementTemplate.id, first.id));
    expect(firstRow?.validTo).toBe('2027-01-01'); // closed at the successor's validFrom
    // Exactly one version is running — the supersede, not a second live row beside the first.
    const live = await owner.db
      .select({ id: schema.entitlementTemplate.id })
      .from(schema.entitlementTemplate)
      .where(
        and(
          eq(schema.entitlementTemplate.lineageId, first.lineageId),
          sql`${schema.entitlementTemplate.validTo} is null`,
        ),
      );
    expect(live.length).toBe(1);
    // A hire on/after the successor's validFrom resolves only the second (16-day) version.
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
  });
});
