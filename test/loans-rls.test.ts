/**
 * 1.2.8 loan RLS + service authority (ADR-0060) — employee_loan / loan_repayment are employment-scoped
 * (subject + administrative manager + admin) via app.can_see_employment; a peer cannot see them. Admin-only
 * WRITES are enforced in the SERVICE layer (RLS would otherwise permit a subject to write their own rows),
 * so a non-admin cannot create/amend/suspend/settle/cancel.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import {
  amendLoan,
  cancelLoan,
  createLoan,
  settleLoan,
  suspendLoan,
} from '../core/loans';
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

const hire = async (b: Base, name: string) => {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  return e;
};

describe('ADR-0060 — loan RLS + service authority', () => {
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

  it('a loan + schedule is visible to subject + manager + admin, not a peer', async () => {
    const a = adminCtx(base);
    const E = await hire(base, 'Subject');
    const M = await hire(base, 'Manager');
    const X = await hire(base, 'Peer');
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const uX = await createAppUser(base.tenantId, X.personId, 'employee');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });

    const { id: loanId } = await createLoan(a, {
      employmentId: E.employmentId, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });

    const seesLoan = (ctx: SessionContext) =>
      withTenant(ctx, (tx) => tx.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id, loanId)));
    const seesSchedule = (ctx: SessionContext) =>
      withTenant(ctx, (tx) => tx.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.loanId, loanId)));

    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'] };
    const mgrCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'] };
    const peerCtx: SessionContext = { tenantId: base.tenantId, userId: uX, roles: ['employee'] };

    expect((await seesLoan(empCtx)).length).toBe(1);
    expect((await seesLoan(mgrCtx)).length).toBe(1);
    expect((await seesLoan(a)).length).toBe(1);
    expect((await seesLoan(peerCtx)).length).toBe(0);
    expect((await seesSchedule(empCtx)).length).toBe(12);
    expect((await seesSchedule(peerCtx)).length).toBe(0);
  });

  it('a different tenant cannot see the loan (tenant isolation)', async () => {
    const other = await seedBase();
    const E = await hire(base, 'Iso');
    await createLoan(adminCtx(base), {
      employmentId: E.employmentId, loanType: 'personal', principal: 500, interestRate: 0, interestMethod: 'none', durationMonths: 5, startDate: '2026-01-01',
    });
    const rows = await withTenant(adminCtx(other), (tx) => tx.select().from(schema.employeeLoan));
    expect(rows.length).toBe(0);
  });

  it('RLS itself blocks a loan SUBJECT (non-admin) from writing their own loan/repayment rows, but allows SELECT', async () => {
    // The subject employee is non-admin. Under RLS, can_see_employment is TRUE for self, so the OLD policy
    // (WITH CHECK = can_see_employment) would let the subject INSERT/UPDATE/DELETE their own rows directly
    // — bypassing the service layer. The fix makes WITH CHECK = can_admin_employment (admin-only writes),
    // while USING stays can_see_employment so the subject can still READ their loan. This test exercises RLS
    // directly (not the service guard) to prove the DB backstop.
    const a = adminCtx(base);
    const E = await hire(base, 'SelfWriter');
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const subjectCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'] };

    const { id: loanId } = await createLoan(a, {
      employmentId: E.employmentId, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    const [repayment] = await owner.db
      .select({ id: schema.loanRepayment.id })
      .from(schema.loanRepayment)
      .where(eq(schema.loanRepayment.loanId, loanId))
      .limit(1);

    // SELECT — the subject CAN read their own loan + repayment rows under RLS.
    const seenLoan = await withTenant(subjectCtx, (tx) =>
      tx.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id, loanId)),
    );
    expect(seenLoan.length).toBe(1);
    const seenRepay = await withTenant(subjectCtx, (tx) =>
      tx.select().from(schema.loanRepayment).where(eq(schema.loanRepayment.id, repayment.id)),
    );
    expect(seenRepay.length).toBe(1);

    // INSERT — the subject CANNOT create a new loan for their own employment under RLS (WITH CHECK rejects).
    await expect(
      withTenant(subjectCtx, (tx) =>
        tx.insert(schema.employeeLoan).values({
          tenantId: base.tenantId, employmentId: E.employmentId, loanType: 'personal',
          principal: '999', durationMonths: 6, startDate: '2026-02-01', monthlyInstalment: '170',
          totalRepayable: '999', outstandingBalance: '999',
        }),
      ),
    ).rejects.toThrow();

    // UPDATE — the subject CANNOT mutate their own loan row under RLS.
    await expect(
      withTenant(subjectCtx, (tx) =>
        tx.update(schema.employeeLoan).set({ outstandingBalance: '0' }).where(eq(schema.employeeLoan.id, loanId)),
      ),
    ).rejects.toThrow();

    // DELETE — the subject CANNOT delete their own loan row under RLS.
    await expect(
      withTenant(subjectCtx, (tx) =>
        tx.delete(schema.employeeLoan).where(eq(schema.employeeLoan.id, loanId)),
      ),
    ).rejects.toThrow();

    // UPDATE on a repayment row is likewise blocked.
    await expect(
      withTenant(subjectCtx, (tx) =>
        tx.update(schema.loanRepayment).set({ appliedAmount: '170' }).where(eq(schema.loanRepayment.id, repayment.id)),
      ),
    ).rejects.toThrow();

    // The loan is unchanged (no write slipped through RLS).
    const [l] = await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id, loanId));
    expect(l.status).toBe('active');
    expect(Number(l.outstandingBalance)).toBeGreaterThan(0);
  });

  it('the service rejects every loan WRITE from a non-admin (service authority, not RLS)', async () => {
    const a = adminCtx(base);
    const E = await hire(base, 'WriteSubject');
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'] };

    // Non-admin cannot create.
    await expect(
      createLoan(empCtx, {
        employmentId: E.employmentId, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
      }),
    ).rejects.toThrow();

    // Admin creates one, then the non-admin cannot amend/suspend/settle/cancel it.
    const { id: loanId } = await createLoan(a, {
      employmentId: E.employmentId, loanType: 'personal', principal: 1200, interestRate: 0, interestMethod: 'none', durationMonths: 12, startDate: '2026-01-01',
    });
    await expect(amendLoan(empCtx, { loanId, durationMonths: 6 })).rejects.toThrow();
    await expect(suspendLoan(empCtx, loanId)).rejects.toThrow();
    await expect(settleLoan(empCtx, loanId)).rejects.toThrow();
    await expect(cancelLoan(empCtx, loanId)).rejects.toThrow();

    // The loan is unchanged (no partial write slipped through).
    const [l] = await owner.db.select().from(schema.employeeLoan).where(eq(schema.employeeLoan.id, loanId));
    expect(l.status).toBe('active');
    expect(l.durationMonths).toBe(12);
  });
});
