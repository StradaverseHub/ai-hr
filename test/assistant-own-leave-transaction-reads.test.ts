import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import { assistantGrant, leaveLedger, leaveType } from '../db/schema';
import {
  AssistantNotGrantedError, assertMayUseAssistant, grantAssistant, mayUseAssistant,
} from '../core/assistant-grant';
import { previewLeaveDeduction } from '../core/leave';
import { hireEmployee } from '../core/org';
import { listEligibleLeaveTypesFor } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, resetDb, seedBase,
  setModule, type Base,
} from './harness';

describe('own-leave confirmation prerequisites share the caller transaction', () => {
  let base: Base;
  beforeAll(async () => { await migrateTestDb(); });
  afterAll(async () => { await closeAll(); });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'assistant', 'active');
  });

  it('sees an uncommitted own-grant revocation even when another user still holds a grant', async () => {
    const ctx = await entitledCtx(base);
    const other = await hireEmployee(ctx, {
      person: { fullName: 'Fictional Other Grant Holder', primaryEmail: 'other-grant@acme.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time',
      hiredOn: todayInKualaLumpur(),
    });
    const otherUserId = await createAppUser(base.tenantId, other.personId, 'employee');
    await grantAssistant(ctx, { appUserId: base.adminUserId });
    await grantAssistant(ctx, { appUserId: otherUserId });
    expect(await mayUseAssistant(ctx)).toEqual({ allowed: true });
    const rollback = new Error('rollback fictional revocation');

    await expect(withTenant(ctx, async tx => {
      const changed = await tx.update(assistantGrant).set({ revokedAt: new Date() })
        .where(eq(assistantGrant.appUserId, base.adminUserId)).returning({ id: assistantGrant.id });
      expect(changed).toHaveLength(1);
      // A nested transaction would read the still-committed live grant and incorrectly allow this.
      // RLS alone is insufficient: this admin can read the other user's live grant too.
      expect(await mayUseAssistant(ctx, tx)).toEqual({ allowed: false, reason: 'no_grant' });
      await expect(assertMayUseAssistant(ctx, tx)).rejects.toThrow(AssistantNotGrantedError);
      throw rollback;
    })).rejects.toBe(rollback);

    // The deliberately aborted command did not revoke the original grant.
    expect(await mayUseAssistant(ctx)).toEqual({ allowed: true });
  });

  it('retains the module and login gates on the transaction path', async () => {
    await grantAssistant(adminCtx(base), { appUserId: base.adminUserId });
    await setModule(base.tenantId, 'assistant', 'disabled');
    const disabled = await entitledCtx(base);
    await withTenant(disabled, async tx => {
      expect(await mayUseAssistant(disabled, tx)).toEqual({ allowed: false, reason: 'module_off' });
      await expect(assertMayUseAssistant(disabled, tx)).rejects.toThrow();
    });
    await setModule(base.tenantId, 'assistant', 'active');
    const enabled = await entitledCtx(base);
    await withTenant(enabled, async tx => {
      expect(await mayUseAssistant({ ...enabled, userId: undefined }, tx))
        .toEqual({ allowed: false, reason: 'no_user' });
    });
  });

  it('previews the enclosing transaction balance and leaves no change after rollback', async () => {
    const ctx = await entitledCtx(base);
    const date = todayInKualaLumpur();
    const employee = await hireEmployee(ctx, {
      person: { fullName: 'Fictional Assistant Applicant', primaryEmail: 'own-leave-tx@acme.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: date,
    });
    await withTenant(ctx, tx => tx.update(leaveType).set({ counting: 'calendar_days' })
      .where(eq(leaveType.id, base.annualLeaveTypeId)));
    const args = { employmentId: employee.employmentId, leaveTypeId: base.annualLeaveTypeId,
      startDate: date, endDate: date, durationType: 'full_day' as const, today: date };
    const before = await previewLeaveDeduction(ctx, args);
    const rollback = new Error('rollback fictional balance');

    await expect(withTenant(ctx, async tx => {
      await tx.insert(leaveLedger).values({ tenantId: base.tenantId, employmentId: employee.employmentId,
        leaveTypeId: base.annualLeaveTypeId, entryType: 'adjustment', days: '3.00', effectiveOn: date });
      const during = await previewLeaveDeduction(ctx, args, tx);
      expect(during.days).toBe(before.days);
      expect(during.balanceAvailable).toBe(before.balanceAvailable + 3);
      expect(during.balanceAfter).toBe(before.balanceAfter + 3);
      throw rollback;
    })).rejects.toBe(rollback);

    expect(await previewLeaveDeduction(ctx, args)).toEqual(before);
  });

  it('sees an uncommitted catalogue refusal and preserves the original menu after rollback', async () => {
    const ctx = await entitledCtx(base);
    const employee = await hireEmployee(ctx, {
      person: { fullName: 'Fictional Catalogue Applicant', primaryEmail: 'own-leave-menu@acme.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time',
      hiredOn: todayInKualaLumpur(),
    });
    expect((await listEligibleLeaveTypesFor(ctx, employee.employmentId)).some(row => row.id === base.annualLeaveTypeId))
      .toBe(true);
    const rollback = new Error('rollback fictional catalogue');
    await expect(withTenant(ctx, async tx => {
      await tx.update(leaveType).set({ employeeCanApply: false }).where(eq(leaveType.id, base.annualLeaveTypeId));
      expect((await listEligibleLeaveTypesFor(ctx, employee.employmentId, undefined, tx))
        .some(row => row.id === base.annualLeaveTypeId)).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await listEligibleLeaveTypesFor(ctx, employee.employmentId)).some(row => row.id === base.annualLeaveTypeId))
      .toBe(true);
  });
});
