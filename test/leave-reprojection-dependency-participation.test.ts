/** Authored actual entitlement correction interleaving, UNRUN pending coordinated local admission. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { reprojectEntitlementForEmployment } from '../core/leave';
import { updateEntitlementTemplate } from '../core/entitlement-template';
import { lockLeaveDependenciesTx } from '../core/leave-dependency-lock';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb); beforeEach(async () => { await resetDb(); b = await seedBase(); }); afterAll(closeAll);

describe('actual entitlement reprojection participant', () => {
  it('keeps ledger/audit/events unchanged while busy, then applies the actual delta exactly once', async () => {
    const ctx = adminCtx(b), today = todayInKualaLumpur(), start = `${today.slice(0, 4)}-01-01`;
    const table = await seedEntitlement(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12,
      validFrom: start, name: 'Fictional guarded reprojection' });
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Reprojection Interval',
      primaryEmail: `reprojection-${randomUUID()}@t.local` }, companyId: b.companyId, departmentId: b.deptA,
      employmentType: 'full_time', hiredOn: start, grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }] });
    const employmentId = employee.employmentId;
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(12);
    await updateEntitlementTemplate(ctx, { lineageId: table.lineageId, validFrom: today,
      serviceBands: [{ fromYears: 0, toYears: null, days: 14 }] });
    const state = async () => ({
      ledger: await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.employmentId, employmentId)).orderBy(schema.leaveLedger.id),
      audit: await owner.db.select().from(schema.leaveEntitlementRecalcAudit).where(eq(schema.leaveEntitlementRecalcAudit.employmentId, employmentId)).orderBy(schema.leaveEntitlementRecalcAudit.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state(), reproject = () => reprojectEntitlementForEmployment(ctx, { employmentId, trigger: 'fictional_source_test' });
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned reprojection handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [employmentId]); ready(); await finish; });
    void holder.catch(failed);
    try {
      await started; await expect(reproject()).rejects.toThrow('Leave source is unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    expect(await reproject()).toEqual({ affected: 1, totalDelta: 2 });
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(14);
    const after = await state(); expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(after.ledger).toHaveLength(before.ledger.length + 1);
    expect(await reproject()).toEqual({ affected: 0, totalDelta: 0 });
    expect(await state()).toEqual(after);
  });
});
