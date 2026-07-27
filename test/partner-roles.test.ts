/**
 * Job-function partner roles (ADR-0049 / migration 0099). Proves the allow / deny / cross-company-deny
 * matrix for the two additive partner roles — payroll_partner and performance_comp_partner — at the
 * RLS layer AND the service/UI gate, plus the assignRole + sub-delegation invariants.
 *
 * RLS allow/deny/scope is the real verification (per the plan). Modeled on test/comp-access.test.ts
 * and the slice0 subtree-scope pattern.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment, assignRole } from '../core/admin';
import { hireEmployee } from '../core/org';
import { employeeDetail } from '../core/read';
import { currentCompensation, setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  createCycle,
  openCycle,
  submitManagerReview,
  enactCompAction,
  closeCycle,
} from '../core/performance';
import {
  canManagePayroll,
  canManagePerfComp,
  hasGrantFor,
  isPayrollPartner,
  isPerfCompPartner,
} from '../lib/authz';
import { resolveEntitlementsTx } from '../core/entitlements';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { roleEnum } from '../db/schema';
import en from '../messages/en.json';
import zh from '../messages/zh.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';

/**
 * The tenant's REAL entitlement snapshot (ADR-0077 slice 3).
 *
 * Every context in this file is hand-built rather than produced by getSession(), because what it tests
 * is a GRANT shape (a company-scoped partner role) that the fixture helpers do not express. Once slice 3
 * moved the payroll gates off `process.env` and onto the session snapshot, a grant-only context stopped
 * being well-formed: `generatePayslips` asks `isModuleEnabled(ctx, 'typed_pay_components')` and a context
 * with neither a snapshot nor an exemption marker raises EntitlementsUnresolvedError.
 *
 * Resolved from the tenant's rows (not marked `entitlementsExempt`) ON PURPOSE. An exemption cannot
 * answer a BILLABLE module question honestly: before slice 3 the marker answered TRUE for every
 * catalogued module, which would silently switch this payroll run from the legacy earnings path to the
 * typed-pay-components one — a different code path from the one the RLS assertions below were written
 * against — and as of slice 3 it THROWS EntitlementsExemptForBillableError instead. seedBase seeds no
 * `typed_pay_components` row under the suite's env, so a real snapshot reproduces exactly the behaviour
 * these tests had when the gate was an (unset) env var.
 *
 * Resolved as the owner, matching `entitledCtx` in the harness: what it fixtures is the snapshot, not the
 * policies that guard the entitlement tables.
 */
async function tenantEntitlements(base: Base) {
  return owner.db.transaction((tx) => resolveEntitlementsTx(tx, base.tenantId));
}

/** Grant a (company-scoped) role to a fresh app_user, returning a SessionContext carrying that grant. */
async function partnerCtx(
  base: Base,
  role: 'payroll_partner' | 'performance_comp_partner' | 'hr_admin',
  companyId: string | null,
  personId: string | null = null,
): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: base.tenantId, appUserId: u.id, companyId, role });
  return {
    tenantId: base.tenantId,
    userId: u.id,
    personId,
    grants: [{ role, companyId }],
    entitlements: await tenantEntitlements(base),
  };
}

async function mkUser(base: Base): Promise<string> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  return u.id;
}

describe('job-function partner roles (ADR-0049)', () => {
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

  /** Two sibling companies (A, B) each with a department + one hired employee with current comp. */
  async function twoCompanies() {
    const a = adminCtx(base); // group-wide admin, for setup
    const { id: coA } = await createCompany(a, { legalName: 'Co A Sdn Bhd' });
    const { id: coB } = await createCompany(a, { legalName: 'Co B Sdn Bhd' });
    const deptA = await createDepartment(a, { companyId: coA, name: 'A-Dept' });
    const deptB = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    const empA = await hireEmployee(a, {
      person: { fullName: 'Alice A', primaryEmail: 'alice@a.test' },
      companyId: coA,
      departmentId: deptA.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const empB = await hireEmployee(a, {
      person: { fullName: 'Bob B', primaryEmail: 'bob@b.test' },
      companyId: coB,
      departmentId: deptB.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: empA.employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: empB.employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    return { a, coA, coB, empA, empB };
  }

  // ───────────────────────────── Payroll partner ─────────────────────────────

  describe('payroll_partner', () => {
    it('ALLOW: runs payroll_batch + payslips, writes payroll_input & attendance for its company', async () => {
      const { coA, empA } = await twoCompanies();
      const pp = await partnerCtx(base, 'payroll_partner', coA);

      // payroll_batch write (RLS WITH CHECK can_admin_payroll_for) + read-back.
      const { batchId } = await createBatch(pp, { companyId: coA, payPeriod: '2026-05' });
      const batches = await withTenant(pp, (tx) =>
        tx.select({ id: schema.payrollBatch.id }).from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)),
      );
      expect(batches.length).toBe(1);

      // payroll_input write (RLS via batch company).
      const inputs = await withTenant(pp, async (tx) => {
        await tx
          .insert(schema.payrollInput)
          .values({ tenantId: base.tenantId, batchId, employmentId: empA.employmentId, overtimeAmount: '100' });
        return tx
          .select({ id: schema.payrollInput.id })
          .from(schema.payrollInput)
          .where(eq(schema.payrollInput.batchId, batchId));
      });
      expect(inputs.length).toBe(1);

      // payslip generation (the real service path) — exercises payslip RLS WITH CHECK + read.
      await generatePayslips(pp, { batchId });
      const slips = await withTenant(pp, (tx) =>
        tx.select({ id: schema.payslip.id }).from(schema.payslip).where(eq(schema.payslip.batchId, batchId)),
      );
      expect(slips.length).toBe(1);

      // attendance write (RLS can_admin_payroll_employment).
      const att = await withTenant(pp, async (tx) => {
        await tx
          .insert(schema.attendance)
          .values({ tenantId: base.tenantId, employmentId: empA.employmentId, attendanceDate: '2026-05-02', status: 'present' });
        return tx
          .select({ id: schema.attendance.id })
          .from(schema.attendance)
          .where(eq(schema.attendance.employmentId, empA.employmentId));
      });
      expect(att.length).toBe(1);
    });

    it('DENY: cannot write compensation, open a review_cycle, create departments, or assign roles', async () => {
      const { coA, empA } = await twoCompanies();
      const pp = await partnerCtx(base, 'payroll_partner', coA);

      // compensation WITH CHECK excludes payroll partner → the write is rejected by RLS.
      await expect(
        withTenant(pp, (tx) =>
          tx.insert(schema.compensation).values({
            tenantId: base.tenantId,
            employmentId: empA.employmentId,
            basicSalary: '9999',
            currency: 'MYR',
            validFrom: '2026-06-01',
          }),
        ),
      ).rejects.toThrow();

      // review_cycle: service gate rejects a non-perfcomp actor.
      await expect(
        createCycle(pp, { companyId: coA, name: 'FY26', periodStart: '2026-01-01', periodEnd: '2026-12-31' }),
      ).rejects.toThrow();

      // structural write (department) — RLS WITH CHECK is_admin_for excludes the partner.
      await expect(createDepartment(pp, { companyId: coA, name: 'nope' })).rejects.toThrow();

      // assignRole — role_assignment write requires group admin (partner is not).
      const target = await mkUser(base);
      await expect(assignRole(pp, { appUserId: target, role: 'employee' })).rejects.toThrow();
    });

    it('SCOPE: a Company-A payroll partner cannot create a batch for Company B', async () => {
      const { coA, coB } = await twoCompanies();
      const pp = await partnerCtx(base, 'payroll_partner', coA);
      await expect(createBatch(pp, { companyId: coB, payPeriod: '2026-05' })).rejects.toThrow();
    });
  });

  // ───────────────────────────── Performance & Comp partner ─────────────────────────────

  describe('performance_comp_partner', () => {
    it('ALLOW: reads & writes compensation (0060 read-widen regression guard)', async () => {
      const { coA, empA } = await twoCompanies();
      const pc = await partnerCtx(base, 'performance_comp_partner', coA);

      // READ widened (0099) — otherwise the 0060 tighten leaves the partner reading zero rows.
      const comp = await currentCompensation(pc, empA.employmentId);
      expect(Number(comp?.basicSalary)).toBe(5000);

      // WRITE widened — a merit-style raise via the comp service.
      const res = await setCompensation(pc, { employmentId: empA.employmentId, basicSalary: 5500, effectiveFrom: '2026-07-01' });
      expect(res.compensationId).toBeTruthy();
      const after = await currentCompensation(pc, empA.employmentId);
      expect(Number(after?.basicSalary)).toBe(5500);
    });

    it('ALLOW: opens a cycle, finalizes a review, and enacts a MERIT increase', async () => {
      const { coA, empA } = await twoCompanies();
      const pc = await partnerCtx(base, 'performance_comp_partner', coA);

      const { cycleId } = await createCycle(pc, {
        companyId: coA,
        name: 'FY26',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
      });
      await openCycle(pc, { cycleId });
      const [rev] = await withTenant(pc, (tx) =>
        tx
          .select({ id: schema.performanceReview.id })
          .from(schema.performanceReview)
          .where(eq(schema.performanceReview.employmentId, empA.employmentId)),
      );
      expect(rev?.id).toBeTruthy();

      // Finalize with a merit recommendation (perf-comp partner may decide, not being self).
      await submitManagerReview(pc, { reviewId: rev.id, managerRating: 4, overallRating: 4, recommendedMeritPct: 10 });
      // Enact merit → compensation widens. No bonus, so payroll access isn't required.
      const enacted = await enactCompAction(pc, { reviewId: rev.id, meritEffectiveFrom: '2026-08-01' });
      expect(enacted.enactedCompensationId).toBeTruthy();
      const after = await currentCompensation(pc, empA.employmentId);
      expect(Number(after?.basicSalary)).toBe(5500); // 5000 + 10%
    });

    it('DENY: cannot run a payroll_batch, create departments, or assign roles', async () => {
      const { coA } = await twoCompanies();
      const pc = await partnerCtx(base, 'performance_comp_partner', coA);

      // payroll_batch WITH CHECK can_admin_payroll_for excludes the perf-comp partner.
      await expect(createBatch(pc, { companyId: coA, payPeriod: '2026-05' })).rejects.toThrow();
      await expect(createDepartment(pc, { companyId: coA, name: 'nope' })).rejects.toThrow();
      const target = await mkUser(base);
      await expect(assignRole(pc, { appUserId: target, role: 'employee' })).rejects.toThrow();
    });

    it('DENY: cannot enact a BONUS (the payroll_input branch — step 3.3 boundary)', async () => {
      const { coA, empA } = await twoCompanies();
      const pc = await partnerCtx(base, 'performance_comp_partner', coA);
      // A draft batch the bonus would target — created by a group admin so the batch exists.
      const a = adminCtx(base);
      const { batchId } = await createBatch(a, { companyId: coA, payPeriod: '2026-05' });

      const { cycleId } = await createCycle(pc, {
        companyId: coA,
        name: 'FY26',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
      });
      await openCycle(pc, { cycleId });
      const [rev] = await withTenant(pc, (tx) =>
        tx
          .select({ id: schema.performanceReview.id })
          .from(schema.performanceReview)
          .where(eq(schema.performanceReview.employmentId, empA.employmentId)),
      );
      await submitManagerReview(pc, { reviewId: rev.id, managerRating: 4, overallRating: 4, recommendedBonus: 1000 });
      // Enacting bonus-to-pay needs payroll access; the perf-comp partner is rejected.
      await expect(enactCompAction(pc, { reviewId: rev.id, bonusBatchId: batchId })).rejects.toThrow(/payroll/i);
    });

    it('SCOPE (service guard): a Company-A perf-comp partner cannot act on a Company-B cycle', async () => {
      const { coA, coB } = await twoCompanies();
      const pcA = await partnerCtx(base, 'performance_comp_partner', coA);
      // A Company-B cycle, created by a group admin.
      const a = adminCtx(base);
      const { cycleId: cycleB } = await createCycle(a, {
        companyId: coB,
        name: 'B-FY26',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
      });
      // The Co-A partner's service guard resolves against grants (companyId), so Co-B is rejected.
      await expect(openCycle(pcA, { cycleId: cycleB })).rejects.toThrow();
      await expect(closeCycle(pcA, { cycleId: cycleB })).rejects.toThrow();
    });
  });

  // ───────────────────────────── assignRole + sub-delegation ─────────────────────────────

  describe('assignRole scoping & 0023 sub-delegation tightening', () => {
    it('partner roles persist a company scope; employee/manager/super_admin force null', async () => {
      const { coA } = await twoCompanies();
      const a = adminCtx(base); // group-wide admin can mint partners

      const u1 = await mkUser(base);
      const r1 = await assignRole(a, { appUserId: u1, role: 'payroll_partner', companyId: coA });
      const u2 = await mkUser(base);
      const r2 = await assignRole(a, { appUserId: u2, role: 'performance_comp_partner', companyId: coA });
      const u3 = await mkUser(base);
      const r3 = await assignRole(a, { appUserId: u3, role: 'employee', companyId: coA });
      const u4 = await mkUser(base);
      const r4 = await assignRole(a, { appUserId: u4, role: 'super_admin', companyId: coA });

      const rows = await owner.db
        .select({ id: schema.roleAssignment.id, companyId: schema.roleAssignment.companyId })
        .from(schema.roleAssignment);
      const byId = (id: string) => rows.find((x) => x.id === id)!;
      expect(byId(r1.id).companyId).toBe(coA);
      expect(byId(r2.id).companyId).toBe(coA);
      expect(byId(r3.id).companyId).toBeNull(); // employee scoping normalized to null
      expect(byId(r4.id).companyId).toBeNull(); // super_admin always group-wide
    });

    it('0023 invariant: a DELEGATED hr_admin cannot mint a partner, but a GROUP admin can', async () => {
      const { coA } = await twoCompanies();
      const a = adminCtx(base);
      const target = await mkUser(base);

      // A delegated (subtree) hr_admin for Co A — NOT a group admin.
      // Carries the real snapshot (see tenantEntitlements) so the `rejects` below can only be the RLS
      // denial this test is about, never an EntitlementsUnresolvedError from a malformed context.
      const delegated: SessionContext = {
        tenantId: base.tenantId,
        userId: base.adminUserId,
        grants: [{ role: 'hr_admin', companyId: coA }],
        entitlements: await tenantEntitlements(base),
      };
      // Tightened branch only allows minting subtree hr_admin → a partner mint is denied by RLS.
      await expect(
        assignRole(delegated, { appUserId: target, role: 'payroll_partner', companyId: coA }),
      ).rejects.toThrow();
      // But the delegated admin can still appoint a subtree hr_admin (pre-existing invariant preserved).
      await expect(assignRole(delegated, { appUserId: target, role: 'hr_admin', companyId: coA })).resolves.toBeTruthy();
      // A GROUP admin can mint the partner.
      await expect(
        assignRole(a, { appUserId: target, role: 'performance_comp_partner', companyId: coA }),
      ).resolves.toBeTruthy();
    });
  });

  // ───────────────────────────── capability helpers (union + scope + compat) ─────────────────────────────

  describe('capability helpers (lib/authz)', () => {
    it('UNION: a user who is BOTH hr_admin and payroll_partner is never narrower than admin', () => {
      const s: SessionContext = {
        tenantId: base.tenantId,
        userId: 'u',
        grants: [
          { role: 'hr_admin', companyId: null },
          { role: 'payroll_partner', companyId: 'co-a' },
        ],
      };
      // canManage* OR admin in, so admin coverage is preserved for any company.
      expect(canManagePayroll(s, 'co-b')).toBe(true); // via group-wide hr_admin
      expect(canManagePerfComp(s, 'co-b')).toBe(true); // via group-wide hr_admin
    });

    it('SCOPE: a company-scoped payroll partner manages only its company', () => {
      const s: SessionContext = {
        tenantId: base.tenantId,
        userId: 'u',
        grants: [{ role: 'payroll_partner', companyId: 'co-a' }],
      };
      expect(canManagePayroll(s, 'co-a')).toBe(true);
      expect(canManagePayroll(s, 'co-b')).toBe(false);
      expect(canManagePerfComp(s, 'co-a')).toBe(false);
      expect(isPayrollPartner(s, 'co-a')).toBe(true);
      expect(isPayrollPartner(s, 'co-b')).toBe(false);
      expect(hasGrantFor(s, 'payroll_partner', 'co-a')).toBe(true);
    });

    it('COMPAT: an admin keeps full coverage; a plain employee gets none', () => {
      const admin: SessionContext = { tenantId: base.tenantId, userId: 'a', grants: [{ role: 'hr_admin', companyId: null }] };
      expect(canManagePayroll(admin, 'co-a')).toBe(true);
      expect(canManagePerfComp(admin, 'co-a')).toBe(true);
      const emp: SessionContext = { tenantId: base.tenantId, userId: 'e', grants: [{ role: 'employee', companyId: null }] };
      expect(canManagePayroll(emp, 'co-a')).toBe(false);
      expect(canManagePerfComp(emp, 'co-a')).toBe(false);
      expect(isPerfCompPartner(emp)).toBe(false);
    });
  });

  // ───────────────────── Cross-company partner visibility (the actual requirement) ─────────────────────
  // The widened employment/person SELECT policies (0099) and the can_admin_*_for helpers exist to serve
  // ONE requirement: a company-scoped partner CAN read its own company's person/employment to do its job,
  // but CANNOT read another company's. After Fix-2 tightened the read path, assert that REQUIREMENT
  // behaviourally through the read API (employeeDetail = the employment⨝person read), not the helper's
  // raw boolean — a green helper boolean does not prove the partner can actually read the row.

  describe('cross-company partner visibility (read API)', () => {
    it('payroll partner of Co A CAN read Co A employment+person, CANNOT read Co B (cross-company deny)', async () => {
      const { coA, empA, empB } = await twoCompanies();
      const pp = await partnerCtx(base, 'payroll_partner', coA);

      const visibleOwn = await employeeDetail(pp, empA.employmentId);
      expect(visibleOwn, 'payroll partner must see its own company employment').not.toBeNull();
      expect(visibleOwn?.name).toBe('Alice A'); // the person row joined through RLS, not null/a key path

      const crossCompany = await employeeDetail(pp, empB.employmentId);
      expect(crossCompany, 'payroll partner must NOT see another company employment').toBeNull();
    });

    it('perf-comp partner of Co A CAN read Co A employment+person, CANNOT read Co B (cross-company deny)', async () => {
      const { coA, empA, empB } = await twoCompanies();
      const pc = await partnerCtx(base, 'performance_comp_partner', coA);

      const visibleOwn = await employeeDetail(pc, empA.employmentId);
      expect(visibleOwn, 'perf-comp partner must see its own company employment').not.toBeNull();
      expect(visibleOwn?.name).toBe('Alice A');

      const crossCompany = await employeeDetail(pc, empB.employmentId);
      expect(crossCompany, 'perf-comp partner must NOT see another company employment').toBeNull();
    });

    it('a plain employee (no partner grant) sees neither company employment', async () => {
      const { empA, empB } = await twoCompanies();
      const empUserId = await mkUser(base);
      const empCtx: SessionContext = {
        tenantId: base.tenantId,
        userId: empUserId,
        grants: [{ role: 'employee', companyId: null }],
        entitlements: await tenantEntitlements(base),
      };
      expect(await employeeDetail(empCtx, empA.employmentId)).toBeNull();
      expect(await employeeDetail(empCtx, empB.employmentId)).toBeNull();
    });
  });

  // ───────────────────────────── i18n: every role has a translated label in every locale ─────────────────────────────
  // RoleTag's history of dynamic rendering means the structural coverage test alone can give a false
  // green (present-but-English, dynamic keys). This pins: every roleEnum value has a non-empty
  // admin.users.role.<value> in every locale — including the two new partner roles.
  describe('i18n role labels', () => {
    const locales: Record<string, Record<string, unknown>> = { en, zh, ms, ta, th, vi };
    for (const [loc, dict] of Object.entries(locales)) {
      it(`${loc} has a non-empty label for every roleEnum value`, () => {
        const roleMap =
          ((dict as { admin?: { users?: { role?: Record<string, string> } } }).admin?.users?.role) ?? {};
        for (const role of roleEnum.enumValues) {
          expect(roleMap[role], `${loc}.admin.users.role.${role}`).toBeTruthy();
        }
      });
    }
  });
});
