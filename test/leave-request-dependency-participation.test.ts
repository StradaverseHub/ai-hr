/** Canonical request participation acceptance; authored and UNRUN pending local runtime admission. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { lockLeaveDependenciesTx, lockLeaveDependencyConfigurationTx } from '../core/leave-dependency-lock';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb); beforeEach(async () => { await resetDb(); b = await seedBase(); }); afterAll(closeAll);

describe('canonical leave request source interval', () => {
  it.each(['employment', 'configuration'] as const)('refuses a held %s without request/debit/events, then submits after release', async kind => {
    const ctx = adminCtx(b), today = todayInKualaLumpur(), year = today.slice(0, 4);
    await seedEntitlement(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: `${year}-01-01`, name: 'Fictional request entitlement' });
    await owner.db.update(schema.leaveType).set({ counting: 'calendar_days' }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Request Ownership',
      primaryEmail: `request-${randomUUID()}@t.local` }, companyId: b.companyId, departmentId: b.deptA,
      employmentType: 'full_time', hiredOn: `${year}-01-01`, grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }] });
    const employmentId = employee.employmentId;
    const state = async () => ({
      requests: await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.employmentId, employmentId)).orderBy(schema.leaveRequest.id),
      ledger: await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.employmentId, employmentId)).orderBy(schema.leaveLedger.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    const submit = () => requestLeave(ctx, { employmentId, leaveTypeId: b.annualLeaveTypeId,
      startDate: today, endDate: today, durationType: 'full_day', reason: 'Fictional canonical request', today });
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned request handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => {
      if (kind === 'employment') await lockLeaveDependenciesTx(tx, b.tenantId, [employmentId]);
      else await lockLeaveDependencyConfigurationTx(tx, b.tenantId);
      ready(); await finish;
    });
    void holder.catch(failed);
    try {
      await started; await expect(submit()).rejects.toThrow('Leave source is unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    const result = await submit(), after = await state();
    expect(after.requests).toHaveLength(before.requests.length + 1);
    expect(after.requests.find(row => row.id === result.leaveRequestId)?.employmentId).toBe(employmentId);
    expect(after.events.filter(row => row.aggregateId === result.leaveRequestId && row.eventType === 'leave-request.submitted')).toHaveLength(1);
  });
});
