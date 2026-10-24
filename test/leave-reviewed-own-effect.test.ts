import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { domainEvent, employment, leaveLedger, leaveRequest, leaveType } from '../db/schema';
import { hireEmployee } from '../core/org';
import { LeaveReviewedEffectError, requestLeave, type ReviewedOwnLeaveEffect } from '../packs/leave/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('reviewed own-leave precondition at the canonical write', () => {
  let base: Base;
  let ctx: SessionContext;
  let args: { employmentId: string; leaveTypeId: string; startDate: string; endDate: string; durationType: 'full_day' };
  let reviewed: ReviewedOwnLeaveEffect;
  beforeAll(async () => { await migrateTestDb(); });
  afterAll(async () => { await closeAll(); });
  beforeEach(async () => {
    await resetDb(); base = await seedBase();
    const date = todayInKualaLumpur();
    const employee = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Fictional Reviewed Applicant', primaryEmail: 'reviewed-own@acme.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: date,
    });
    const userId = await createAppUser(base.tenantId, employee.personId, 'hr_admin');
    ctx = { ...adminCtx(base), userId, personId: employee.personId, grants: [{ role: 'hr_admin', companyId: null }] };
    await owner.db.insert(leaveLedger).values({ tenantId: base.tenantId, employmentId: employee.employmentId,
      leaveTypeId: base.annualLeaveTypeId, entryType: 'accrual', days: '10.00', effectiveOn: date });
    args = { employmentId: employee.employmentId, leaveTypeId: base.annualLeaveTypeId,
      startDate: date, endDate: date, durationType: 'full_day' };
    reviewed = { employmentId: employee.employmentId, companyId: base.companyId,
      leaveTypeId: base.annualLeaveTypeId, date, days: 1, availableBalance: 10 };
  });
  const counts = (tx: Tx) => Promise.all([
    tx.select({ count: count() }).from(leaveRequest).where(eq(leaveRequest.tenantId, base.tenantId)),
    tx.select({ count: count() }).from(domainEvent).where(eq(domainEvent.tenantId, base.tenantId)),
  ]);

  it('records one canonical pending request, without claiming an approval or action receipt', async () => {
    await withTenant(ctx, async tx => {
      const result = await requestLeave(ctx, args, tx, reviewed);
      expect(result.days).toBe(1); expect(result.parentGroupId).toBeNull();
      expect(result.children).toHaveLength(1);
      expect(await tx.select({ status: leaveRequest.status }).from(leaveRequest).where(eq(leaveRequest.id, result.leaveRequestId)))
        .toEqual([{ status: 'pending' }]);
    });
  });

  it.each([{ days: 0.5 }, { availableBalance: 9 }, { companyId: '00000000-0000-4000-8000-000000000099' }])(
    'refuses a changed effect before any write in the still-open transaction: %j', async change => {
      await withTenant(ctx, async tx => {
        const before = await counts(tx);
        await expect(requestLeave(ctx, args, tx, { ...reviewed, ...change }))
          .rejects.toMatchObject({ name: 'LeaveReviewedEffectError', reason: 'changed' });
        // Catch inside the same transaction: rollback alone could conceal a too-late guard.
        expect(await counts(tx)).toEqual(before);
      });
    },
  );

  it('requires an enclosing command transaction', async () => {
    await expect(requestLeave(ctx, args, undefined, reviewed)).rejects.toThrow(LeaveReviewedEffectError);
  });

  it('refuses an HR own-request that would require an advance-notice bypass', async () => {
    await owner.db.update(leaveType).set({ minAdvanceDays: 30 }).where(eq(leaveType.id, base.annualLeaveTypeId));
    await withTenant(ctx, async tx => {
      const before = await counts(tx);
      await expect(requestLeave(ctx, args, tx, reviewed))
        .rejects.toMatchObject({ name: 'LeaveReviewedEffectError', reason: 'unsupported' });
      expect(await counts(tx)).toEqual(before);
    });
  });

  it('does not turn HR visibility/on-behalf authority into confirmed own-leave authority', async () => {
    const other = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Fictional Other Reviewed Applicant', primaryEmail: 'reviewed-other@acme.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: reviewed.date,
    });
    await withTenant(ctx, async tx => {
      expect(await tx.select({ id: employment.id }).from(employment).where(eq(employment.id, other.employmentId)))
        .toHaveLength(1);
      const before = await counts(tx);
      await expect(requestLeave(ctx, { ...args, employmentId: other.employmentId }, tx,
        { ...reviewed, employmentId: other.employmentId })).rejects.toThrow(LeaveReviewedEffectError);
      expect(await counts(tx)).toEqual(before);
    });
  });
});
