/** Authored DB regressions; runtime acceptance still required before wiring import fencing. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import { employment, leaveLedger, leaveType } from '../db/schema';
import { hireEmployee } from '../core/org';
import { resolveLeaveBfImportTx, validateLeaveBfImport } from '../core/leave-bf-import';
import { resolveLeaveHistoryImportTx, validateLeaveHistoryImport } from '../core/leave-history-import';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const day = (date: string, offset: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
describe('canonical import resolution joins the supplied row transaction', () => {
  let base: Base, employeeId: string, code: string;
  beforeAll(async () => { await migrateTestDb(); });
  afterAll(async () => { await closeAll(); });
  beforeEach(async () => {
    await resetDb(); base = await seedBase();
    const hired = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Fictional Import Transaction Subject', primaryEmail: `tx-${randomUUID()}@acme.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time',
      hiredOn: day(todayInKualaLumpur(), -1200),
    });
    employeeId = hired.employmentId;
    const [row] = await owner.db.select({ code: employment.employeeCode }).from(employment)
      .where(eq(employment.id, employeeId));
    code = row.code!;
    await owner.db.update(leaveType).set({ carryForwardEnabled: true, carryForwardMax: '30' })
      .where(eq(leaveType.id, base.annualLeaveTypeId));
  });
  const bf = () => [{ employee_id: code, leave_code: 'ANNUAL',
    entitlement_year: String(Number(todayInKualaLumpur().slice(0, 4)) + 1), bf_days: '2', remark: 'Fictional fixture' }];
  const history = () => [{ employee_no: code, leave_reference: `TX/${randomUUID()}`, leave_code: 'ANNUAL',
    leave_start_date: day(todayInKualaLumpur(), -2), leave_end_date: day(todayInKualaLumpur(), -2),
    number_of_day: '1', remark: 'Fictional fixture' }];

  it('preserves the existing public preview for a committed source', async () => {
    const ctx = adminCtx(base), a = bf(), b = history();
    const expectedBf = await validateLeaveBfImport(ctx, { records: a });
    const expectedHistory = await validateLeaveHistoryImport(ctx, { records: b });
    expect(expectedBf.validCount).toBe(1); expect(expectedHistory.validCount).toBe(1);
    await withTenant(ctx, async tx => {
      expect((await resolveLeaveBfImportTx(tx, ctx, a)).preview).toEqual(expectedBf);
      expect((await resolveLeaveHistoryImportTx(tx, ctx, b)).preview).toEqual(expectedHistory);
    });
  });
  it('uses the enclosing uncommitted catalogue and restores previews after rollback', async () => {
    const ctx = adminCtx(base), a = bf(), b = history(), rollback = new Error('rollback fixture catalogue');
    expect((await validateLeaveBfImport(ctx, { records: a })).validCount).toBe(1);
    expect((await validateLeaveHistoryImport(ctx, { records: b })).validCount).toBe(1);
    await expect(withTenant(ctx, async tx => {
      await tx.update(leaveType).set({ code: 'ANNUAL_RENAMED' }).where(eq(leaveType.id, base.annualLeaveTypeId));
      expect((await resolveLeaveBfImportTx(tx, ctx, a)).preview.validCount).toBe(0);
      expect((await resolveLeaveHistoryImportTx(tx, ctx, b)).preview.validCount).toBe(0);
      // Control: the original independently committed read still sees the original catalogue.
      expect((await validateLeaveBfImport(ctx, { records: a })).validCount).toBe(1);
      expect((await validateLeaveHistoryImport(ctx, { records: b })).validCount).toBe(1);
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await validateLeaveBfImport(ctx, { records: a })).validCount).toBe(1);
    expect((await validateLeaveHistoryImport(ctx, { records: b })).validCount).toBe(1);
  });
  it('uses the enclosing uncommitted ledger in both impact readers without committing it', async () => {
    const ctx = adminCtx(base), a = bf(), b = history(), rollback = new Error('rollback fixture ledger');
    const beforeBf = await validateLeaveBfImport(ctx, { records: a });
    const beforeHistory = await validateLeaveHistoryImport(ctx, { records: b });
    expect(beforeBf.balanceImpact).toHaveLength(1); expect(beforeHistory.balanceImpact).toHaveLength(1);
    await expect(withTenant(ctx, async tx => {
      await tx.insert(leaveLedger).values({ tenantId: base.tenantId, employmentId: employeeId,
        leaveTypeId: base.annualLeaveTypeId, entryType: 'adjustment', days: '3.00', effectiveOn: todayInKualaLumpur() });
      const currentBf = (await resolveLeaveBfImportTx(tx, ctx, a)).preview;
      const currentHistory = (await resolveLeaveHistoryImportTx(tx, ctx, b)).preview;
      expect(currentBf.balanceImpact[0].broughtForwardBefore).toBe(beforeBf.balanceImpact[0].broughtForwardBefore + 3);
      expect(currentHistory.balanceImpact[0].balanceBefore).toBe(beforeHistory.balanceImpact[0].balanceBefore + 3);
      expect(await validateLeaveBfImport(ctx, { records: a })).toEqual(beforeBf);
      expect(await validateLeaveHistoryImport(ctx, { records: b })).toEqual(beforeHistory);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await validateLeaveBfImport(ctx, { records: a })).toEqual(beforeBf);
    expect(await validateLeaveHistoryImport(ctx, { records: b })).toEqual(beforeHistory);
  });
});
