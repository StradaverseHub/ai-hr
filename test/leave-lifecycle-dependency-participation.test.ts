/** Authored source-interval acceptance; UNRUN until the coordinated local runtime window. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, terminateEmployment } from '../core/org';
import { createMovementEvent, createMovementEventTx } from '../core/movement';
import { lockLeaveDependenciesTx } from '../core/leave-dependency-lock';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
afterAll(closeAll);

describe('participating canonical termination and Movement creation', () => {
  it.each(['direct', 'movement', 'movement-caller-tx'] as const)('%s refuses a protected employee interval without lifecycle effects, then commits after release', async path => {
    const ctx = adminCtx(b), today = todayInKualaLumpur();
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Lifecycle Participation',
      primaryEmail: `lifecycle-${randomUUID()}@t.local` }, companyId: b.companyId,
      departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${Number(today.slice(0, 4)) - 2}-01-01` });
    const employmentId = employee.employmentId;
    const input = { employmentId, kind: 'termination' as const, effectiveDate: today, endDate: today,
      terminationReasonCode: 'redundancy', remarks: 'Fictional concurrency acceptance' };
    const mutate = () => path === 'direct'
      ? terminateEmployment(ctx, { employmentId, terminationDate: today, terminationType: 'voluntary', terminationReason: 'Fictional concurrency acceptance' })
      : path === 'movement' ? createMovementEvent(ctx, input) : withTenant(ctx, tx => createMovementEventTx(tx, ctx, input));
    const state = async () => ({
      employment: await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId)),
      assignments: await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, employmentId)).orderBy(schema.assignment.id),
      reporting: await owner.db.select().from(schema.reportingLine).where(eq(schema.reportingLine.tenantId, b.tenantId)).orderBy(schema.reportingLine.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state(); expect(before.employment[0].terminatedOn).toBeNull();
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned lifecycle handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => {
      await lockLeaveDependenciesTx(tx, b.tenantId, [employmentId]); ready(); await finish;
    });
    void holder.catch(failed);
    try {
      await started; await expect(mutate()).rejects.toThrow('Leave source is unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate();
    const after = await state(); expect(after.employment[0].terminatedOn).toBe(today);
    expect(after.assignments).toHaveLength(before.assignments.length);
    expect(after.assignments.filter(row => row.validTo === null)).toHaveLength(0);
    expect(after.events.filter(row => row.aggregateId === employmentId && row.eventType === 'employment.terminated')).toHaveLength(1);
  });
});
